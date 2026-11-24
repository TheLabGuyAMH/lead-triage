// Lead Triage UI controller: input zone -> ranked board -> meter + trace.
// All AI goes through the adapter boundary (schema.ts): MockAdapter runs
// locally at $0; ApiAdapter goes through /api/extract to Muse Ember.

import { ApiAdapter } from "./lib/api-adapter";
import { MockAdapter } from "./lib/mock";
import { isFiltered, rankLeads, splitBatch } from "./lib/ranking";
import { SAMPLE_CONFIG, SAMPLE_PASTE } from "./lib/sample";
import {
  extractionSystemPrompt,
  type AdapterMode,
  type BusinessConfig,
  type ExtractionResult,
  type LeadAdapter,
  type LeadRecord,
} from "./lib/schema";

const BATCH_CAP = 25;
const CONFIG_KEY = "lead-triage-config-v1";

interface UiConfig extends BusinessConfig {
  mode: AdapterMode;
  capUsd: number;
}

interface TraceEntry {
  ts: string;
  mode: AdapterMode;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  estimated: boolean;
  category: string;
  urgency: string;
  name: string | null;
  note?: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const pasteEl = $<HTMLTextAreaElement>("paste");
const runBtn = $<HTMLButtonElement>("run");
const runStatus = $<HTMLSpanElement>("run-status");
const runNote = $<HTMLParagraphElement>("run-note");
const boardEl = $<HTMLDivElement>("board");
const boardEmpty = $<HTMLDivElement>("board-empty");
const spamBox = $<HTMLDetailsElement>("spam-box");
const spamList = $<HTMLDivElement>("spam-list");
const spamSummary = $<HTMLElement>("spam-summary");
const traceView = $<HTMLPreElement>("trace-view");
const modeBadge = $<HTMLDivElement>("mode-badge");

let config: UiConfig = loadConfig();
let results: ExtractionResult[] = [];
let trace: TraceEntry[] = [];
let totals = { tokensIn: 0, tokensOut: 0, cost: 0, costKnown: true };

function loadConfig(): UiConfig {
  const fallback: UiConfig = { ...SAMPLE_CONFIG, mode: "mock", capUsd: 10 };
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<UiConfig>) };
  } catch {
    return fallback;
  }
}

function saveConfig() {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

function syncConfigInputs() {
  $<HTMLInputElement>("cfg-name").value = config.businessName;
  $<HTMLInputElement>("cfg-trade").value = config.trade;
  $<HTMLSelectElement>("cfg-tone").value = config.tone;
  $<HTMLSelectElement>("cfg-mode").value = config.mode;
  $<HTMLInputElement>("cfg-cap").value = String(config.capUsd);
  updateBadge();
}

function readConfigInputs() {
  config = {
    businessName: $<HTMLInputElement>("cfg-name").value.trim() || SAMPLE_CONFIG.businessName,
    trade: $<HTMLInputElement>("cfg-trade").value.trim() || SAMPLE_CONFIG.trade,
    tone: $<HTMLSelectElement>("cfg-tone").value as BusinessConfig["tone"],
    mode: $<HTMLSelectElement>("cfg-mode").value as AdapterMode,
    capUsd: Math.max(1, Number($<HTMLInputElement>("cfg-cap").value) || 10),
  };
  saveConfig();
  updateBadge();
}

function updateBadge(fallbackNote = false) {
  modeBadge.className = "mode-badge " + (fallbackNote ? "fallback" : config.mode);
  modeBadge.textContent = fallbackNote
    ? "SERVER FELL BACK TO MOCK — no API key"
    : config.mode === "mock"
      ? "MOCK MODE — no Ember spend"
      : "EMBER MODE — live API calls";
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtCost(v: number | null): string {
  return v === null ? "rates not set" : `$${v.toFixed(4)}`;
}

function fieldHtml(label: string, value: string | null): string {
  return value
    ? `<div><span class="k">${label}</span>${esc(value)}</div>`
    : `<div><span class="k">${label}</span><span class="missing">missing</span></div>`;
}

function cardHtml(record: LeadRecord, rank: number, result: ExtractionResult): string {
  const langBadge = record.language === "es" ? `<span class="badge lang">ES → EN card</span>` : "";
  const cost =
    result.usage.cost_usd === null
      ? "cost: rates not set"
      : `cost: $${result.usage.cost_usd.toFixed(4)}${result.usage.estimated ? " (simulated)" : ""}`;
  return `
  <article class="card ${record.urgency}">
    <div class="card-head">
      <span class="rank">#${rank}</span>
      <span class="card-name">${esc(record.name ?? "Unknown caller")}</span>
      <span class="badge ${record.urgency}">${record.urgency.toUpperCase()}</span>
      ${langBadge}
    </div>
    <p class="reason">${esc(record.urgency_reason)}</p>
    <div class="fields">
      ${fieldHtml("Phone", record.phone)}
      ${fieldHtml("Service", record.service_needed)}
      ${fieldHtml("Area", record.area)}
      ${fieldHtml("Language", record.language === "es" ? "Spanish" : "English")}
    </div>
    <div class="summary"><strong>For the owner:</strong> ${esc(record.owner_summary)}</div>
    <div class="followup">
      <blockquote>${esc(record.followup_draft)}</blockquote>
      <button type="button" class="btn small" data-copy="${rank}">Copy follow-up</button>
    </div>
    <div class="card-foot">
      <span>engine: ${result.mode}${result.usage.estimated ? " (estimated tokens)" : ""}</span>
      <span>tokens: ${result.usage.tokens_in} in / ${result.usage.tokens_out} out</span>
      <span>${cost}</span>
    </div>
    <details class="raw"><summary>Original message</summary><pre>${esc(record.raw_text)}</pre></details>
  </article>`;
}

function render() {
  const ranked = rankLeads(results.map((r) => r.record));
  const byRaw = new Map(results.map((r) => [r.record.raw_text + r.record.owner_summary, r]));
  const real = ranked.filter((r) => !isFiltered(r));
  const filtered = ranked.filter(isFiltered);

  boardEmpty.hidden = results.length > 0;
  boardEl.innerHTML = real
    .map((record, i) => cardHtml(record, i + 1, byRaw.get(record.raw_text + record.owner_summary)!))
    .join("");

  spamBox.hidden = filtered.length === 0;
  spamSummary.textContent = `Filtered — spam / not-a-lead (${filtered.length})`;
  spamList.innerHTML = filtered
    .map(
      (r) => `<div class="spam-item"><strong>${esc(r.category)}</strong> — ${esc(r.category_reason)}<br><span class="hint">${esc(r.raw_text.slice(0, 140))}${r.raw_text.length > 140 ? "…" : ""}</span></div>`,
    )
    .join("");

  const realCount = real.length;
  $<HTMLSpanElement>("m-processed").textContent = String(results.length);
  $<HTMLSpanElement>("m-real").textContent = String(realCount);
  $<HTMLSpanElement>("m-spam").textContent = String(filtered.length);
  $<HTMLSpanElement>("m-tokens").textContent = String(totals.tokensIn + totals.tokensOut);
  $<HTMLSpanElement>("m-cost").textContent = totals.costKnown ? `$${totals.cost.toFixed(4)}` : "rates not set";
  const pct = config.capUsd > 0 ? Math.min(100, (totals.cost / config.capUsd) * 100) : 0;
  const fill = $<HTMLDivElement>("budget-fill");
  fill.style.width = `${pct}%`;
  fill.className = "budget-fill" + (pct >= 90 ? " over" : pct >= 60 ? " warn" : "");
  $<HTMLSpanElement>("m-budget").textContent =
    `Budget: $${totals.cost.toFixed(2)} of $${config.capUsd.toFixed(2)} cap`;

  traceView.textContent =
    trace.length === 0
      ? "No calls yet."
      : trace
          .map(
            (t, i) =>
              `#${i + 1} ${t.mode} · ${t.tokens_in}in/${t.tokens_out}out · ${fmtCost(t.cost_usd)} · ${t.category}/${t.urgency}${t.note ? " · NOTE: " + t.note : ""}`,
          )
          .join("\n");
}

async function runTriage() {
  readConfigInputs();
  const leads = splitBatch(pasteEl.value);
  if (leads.length === 0) {
    runStatus.textContent = "Paste at least one lead first.";
    return;
  }
  if (leads.length > BATCH_CAP) {
    runStatus.textContent = `Batch capped at ${BATCH_CAP} leads per run (budget discipline). Split the paste and run again.`;
    return;
  }
  if (config.mode === "ember") {
    const ok = window.confirm(
      `Ember mode makes one paid API call per lead: ${leads.length} call(s). Session spend so far: $${totals.cost.toFixed(4)} of your $${config.capUsd.toFixed(2)} cap. Continue?`,
    );
    if (!ok) return;
  }

  const adapter: LeadAdapter = config.mode === "mock" ? MockAdapter : ApiAdapter;
  runBtn.disabled = true;
  runNote.hidden = true;
  let fallbackSeen = false;

  try {
    for (let i = 0; i < leads.length; i++) {
      if (totals.costKnown && totals.cost >= config.capUsd) {
        runStatus.textContent = `Stopped: session cost reached the $${config.capUsd.toFixed(2)} cap.`;
        break;
      }
      runStatus.textContent = `Triaging lead ${i + 1} of ${leads.length}…`;
      const result = await adapter.extract(leads[i], config);
      results.push(result);
      trace.push({
        ts: new Date().toISOString(),
        mode: result.mode,
        tokens_in: result.usage.tokens_in,
        tokens_out: result.usage.tokens_out,
        cost_usd: result.usage.cost_usd,
        estimated: result.usage.estimated,
        category: result.record.category,
        urgency: result.record.urgency,
        name: result.record.name,
        note: result.note,
      });
      totals.tokensIn += result.usage.tokens_in;
      totals.tokensOut += result.usage.tokens_out;
      if (result.usage.cost_usd === null) totals.costKnown = false;
      else totals.cost += result.usage.cost_usd;
      if (result.note) {
        fallbackSeen = true;
        runNote.textContent = result.note;
        runNote.hidden = false;
      }
      render();
    }
    runStatus.textContent = `Done. ${leads.length} lead(s) triaged.`;
  } catch (err) {
    runStatus.textContent = `Error: ${err instanceof Error ? err.message : "extraction failed"}. Results so far are kept.`;
  } finally {
    if (config.mode === "ember") updateBadge(fallbackSeen);
    runBtn.disabled = false;
  }
}

function exportTrace() {
  const payload = {
    exported_at: new Date().toISOString(),
    app: "lead-triage",
    model: "muse-ember-1.0 (when mode=ember)",
    system_prompt: extractionSystemPrompt(config),
    budget_cap_usd: config.capUsd,
    totals: {
      calls: trace.length,
      tokens_in: totals.tokensIn,
      tokens_out: totals.tokensOut,
      cost_usd: totals.costKnown ? Number(totals.cost.toFixed(4)) : null,
      cost_note: totals.costKnown
        ? "Computed from API usage + configured rates (mock calls are $0, estimated)."
        : "Rates not configured for one or more calls; token counts are exact, dollar total unavailable.",
    },
    calls: trace.map((t, i) => ({ call: i + 1, ...t, raw_text: results[i]?.record.raw_text ?? "" })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `lead-triage-trace-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function clearSession() {
  results = [];
  trace = [];
  totals = { tokensIn: 0, tokensOut: 0, cost: 0, costKnown: true };
  runStatus.textContent = "";
  runNote.hidden = true;
  updateBadge();
  render();
}

// Wiring
$<HTMLButtonElement>("load-sample").addEventListener("click", () => {
  pasteEl.value = SAMPLE_PASTE;
  runStatus.textContent = "Sample set loaded: 12 fictional demo leads.";
});
$<HTMLButtonElement>("clear-input").addEventListener("click", () => {
  pasteEl.value = "";
  pasteEl.focus();
});
runBtn.addEventListener("click", () => void runTriage());
$<HTMLButtonElement>("export-trace").addEventListener("click", exportTrace);
$<HTMLButtonElement>("clear-session").addEventListener("click", clearSession);
for (const id of ["cfg-name", "cfg-trade", "cfg-tone", "cfg-mode", "cfg-cap"]) {
  document.getElementById(id)?.addEventListener("change", readConfigInputs);
}
boardEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
  if (!btn) return;
  const ranked = rankLeads(results.map((r) => r.record)).filter((r) => !isFiltered(r));
  const record = ranked[Number(btn.dataset.copy) - 1];
  if (!record) return;
  void navigator.clipboard.writeText(record.followup_draft).then(() => {
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy follow-up"), 1200);
  });
});

syncConfigInputs();
render();
