// Lead Triage UI controller: paste/config → ranked call-back board →
// folded cost & trace. All AI goes through the adapter boundary
// (schema.ts): MockAdapter runs locally at $0; ApiAdapter goes through
// /api/extract to Muse Ember (passcode-gated on the server). The board
// is a work queue: call/text links with the draft prefilled, and a
// "Called" toggle remembered in localStorage. On first load the board
// shows a clearly labeled replay of a recorded Ember run ($0 to view).

import { ApiAdapter, DEMO_KEY_STORAGE } from "./lib/api-adapter";
import { MockAdapter } from "./lib/mock";
import { isFiltered, rankResults, splitBatch } from "./lib/ranking";
import { REPLAY } from "./lib/replay-data";
import { SAMPLE_CONFIG, SAMPLE_LEADS, SAMPLE_PASTE } from "./lib/sample";
import type {
  AdapterMode,
  BusinessConfig,
  ExtractionResult,
  LeadAdapter,
  LeadRecord,
} from "./lib/schema";

const BATCH_CAP = 25;
const CONCURRENCY = 4;
const CONFIG_KEY = "lead-triage-config-v1";
const CALLED_KEY = "lead-triage-called-v1";

interface UiConfig extends BusinessConfig {
  mode: AdapterMode;
  capUsd: number;
}

interface TraceEntry {
  index: number;
  ts: string;
  mode: AdapterMode;
  model: string | null;
  prompt_hash: string | null;
  output_mode: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  estimated: boolean;
  category: string;
  urgency: string;
  language: string;
  name: string | null;
  phone: string | null;
  needs_review: string | null;
  note?: string;
  record: LeadRecord;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const pasteEl = $<HTMLTextAreaElement>("paste");
const runBtn = $<HTMLButtonElement>("run");
const runStatus = $<HTMLSpanElement>("run-status");
const runNote = $<HTMLParagraphElement>("run-note");
const boardEl = $<HTMLDivElement>("board");
const boardEmpty = $<HTMLDivElement>("board-empty");
const boardNote = $<HTMLParagraphElement>("board-note");
const spamBox = $<HTMLDetailsElement>("spam-box");
const spamList = $<HTMLDivElement>("spam-list");
const spamSummary = $<HTMLElement>("spam-summary");
const traceView = $<HTMLPreElement>("trace-view");
const modeBadge = $<HTMLDivElement>("mode-badge");
const costPill = $<HTMLDivElement>("cost-pill");
const costTraceSummary = $<HTMLElement>("cost-trace-summary");

let config: UiConfig = loadConfig();
let results: ExtractionResult[] = [];
let trace: TraceEntry[] = [];
let totals = { tokensIn: 0, tokensOut: 0, cost: 0, costKnown: true };
let running = false;
let showingReplay = false;
// Prompt actually used by the current board, recorded at run/replay time
// (server-reported hash + model ride along on each result). Never rebuilt
// at export time; the prompt text itself is kept only for the replay,
// whose recording script captured what the server sent.
let boardPrompt: { system_prompt: string | null; prompt_hash: string | null; model: string | null } = {
  system_prompt: null,
  prompt_hash: null,
  model: null,
};

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
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* storage blocked — config just won't persist */
  }
}

function syncConfigInputs() {
  $<HTMLInputElement>("cfg-name").value = config.businessName;
  $<HTMLInputElement>("cfg-trade").value = config.trade;
  $<HTMLSelectElement>("cfg-tone").value = config.tone;
  $<HTMLSelectElement>("cfg-mode").value = config.mode;
  $<HTMLInputElement>("cfg-cap").value = String(config.capUsd);
  try {
    $<HTMLInputElement>("cfg-demo-key").value = sessionStorage.getItem(DEMO_KEY_STORAGE) ?? "";
  } catch {
    /* ignore */
  }
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
  try {
    const key = $<HTMLInputElement>("cfg-demo-key").value;
    if (key) sessionStorage.setItem(DEMO_KEY_STORAGE, key);
    else sessionStorage.removeItem(DEMO_KEY_STORAGE);
  } catch {
    /* ignore */
  }
  updateBadge();
}

function updateBadge(fallbackNote = false) {
  if (showingReplay && !fallbackNote) {
    modeBadge.className = "mode-badge replay";
    modeBadge.textContent = "REPLAY — recorded Ember run, $0 to view";
    return;
  }
  modeBadge.className = "mode-badge " + (fallbackNote ? "fallback" : config.mode);
  modeBadge.textContent = fallbackNote
    ? "SERVER FELL BACK TO MOCK — see note"
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
  return v === null ? "cost unknown" : `$${v.toFixed(4)}`;
}

function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function loadCalled(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(CALLED_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

function setCalled(rawText: string, value: boolean) {
  try {
    const state = loadCalled();
    const key = hashText(rawText);
    if (value) state[key] = true;
    else delete state[key];
    localStorage.setItem(CALLED_KEY, JSON.stringify(state));
  } catch {
    /* storage blocked — the toggle just won't persist */
  }
}

function isCalled(rawText: string): boolean {
  return loadCalled()[hashText(rawText)] === true;
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
      ? "cost: unknown (usage not reported)"
      : `cost: $${result.usage.cost_usd.toFixed(4)}${result.usage.estimated ? " (simulated)" : ""}`;
  const reviewBanner = record.needs_review
    ? `<div class="review-banner">Needs review: ${esc(record.needs_review)}</div>`
    : "";
  const digits = record.phone?.replace(/\D/g, "") ?? "";
  const actions = digits
    ? `<a class="btn small" href="tel:${digits}">Call</a>
       <a class="btn small" href="sms:${digits}?&body=${encodeURIComponent(record.followup_draft)}">Text draft</a>`
    : "";
  const called = isCalled(record.raw_text);
  return `
  <article class="card ${esc(record.urgency)}${called ? " called" : ""}">
    ${reviewBanner}
    <div class="card-head">
      <span class="rank">#${rank}</span>
      <span class="card-name">${esc(record.name ?? "Unknown caller")}</span>
      <span class="badge ${esc(record.urgency)}">${esc(record.urgency.toUpperCase())}</span>
      ${langBadge}
      ${called ? `<span class="badge lang">CALLED</span>` : ""}
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
    <div class="row card-actions">
      ${actions}
      <button type="button" class="btn small" data-called="${rank}">${called ? "Called ✓" : "Mark called"}</button>
    </div>
    <div class="card-foot">
      <span>engine: ${result.mode}${result.usage.estimated ? " (estimated tokens)" : ""}</span>
      <span>tokens: ${result.usage.tokens_in} in / ${result.usage.tokens_out} out</span>
      <span>${cost}</span>
    </div>
    <details class="raw"><summary>Original message</summary><pre>${esc(record.raw_text)}</pre></details>
  </article>`;
}

function toTraceEntry(result: ExtractionResult): TraceEntry {
  return {
    index: result.index ?? 0,
    ts: new Date().toISOString(),
    mode: result.mode,
    model: result.model ?? null,
    prompt_hash: result.prompt_hash ?? null,
    output_mode: result.output_mode ?? null,
    tokens_in: result.usage.tokens_in,
    tokens_out: result.usage.tokens_out,
    cost_usd: result.usage.cost_usd,
    estimated: result.usage.estimated,
    category: result.record.category,
    urgency: result.record.urgency,
    language: result.record.language,
    name: result.record.name,
    phone: result.record.phone,
    needs_review: result.record.needs_review,
    note: result.note,
    record: result.record,
  };
}

function addToTotals(result: ExtractionResult) {
  totals.tokensIn += result.usage.tokens_in;
  totals.tokensOut += result.usage.tokens_out;
  if (result.usage.cost_usd === null) totals.costKnown = false;
  else totals.cost += result.usage.cost_usd;
}

function render() {
  const present = results.filter(Boolean);
  const ranked = rankResults(present);
  const real = ranked.filter((r) => !isFiltered(r.record));
  const filtered = ranked.filter((r) => isFiltered(r.record));

  boardEmpty.hidden = present.length > 0;
  boardEl.innerHTML = real.map((r, i) => cardHtml(r.record, i + 1, r)).join("");

  // The filtered fold opens whenever it holds anything, so a real lead
  // misread as spam stays visible instead of disappearing.
  spamBox.hidden = filtered.length === 0;
  spamBox.open = filtered.length > 0;
  spamSummary.textContent = `Filtered — spam / not-a-lead (${filtered.length})`;
  spamList.innerHTML = filtered
    .map((r) => {
      const rec = r.record;
      return `<div class="spam-item"><strong>${esc(rec.category)}</strong> — ${esc(rec.category_reason)}<br><span class="hint">${esc(rec.raw_text.slice(0, 140))}${rec.raw_text.length > 140 ? "…" : ""}</span></div>`;
    })
    .join("");

  $<HTMLSpanElement>("m-processed").textContent = String(present.length);
  $<HTMLSpanElement>("m-real").textContent = String(real.length);
  $<HTMLSpanElement>("m-spam").textContent = String(filtered.length);
  $<HTMLSpanElement>("m-tokens").textContent = String(totals.tokensIn + totals.tokensOut);
  $<HTMLSpanElement>("m-cost").textContent = totals.costKnown ? `$${totals.cost.toFixed(4)}` : "unknown";
  const pct = config.capUsd > 0 ? Math.min(100, (totals.cost / config.capUsd) * 100) : 0;
  const fill = $<HTMLDivElement>("budget-fill");
  fill.style.width = `${pct}%`;
  fill.className = "budget-fill" + (pct >= 90 ? " over" : pct >= 60 ? " warn" : "");
  $<HTMLSpanElement>("m-budget").textContent =
    `Budget: $${totals.cost.toFixed(2)} of $${config.capUsd.toFixed(2)} cap (advisory — server enforces)`;

  const calls = trace.filter(Boolean).length;
  costPill.textContent = `${totals.costKnown ? `$${totals.cost.toFixed(4)}` : "cost unknown"} · ${calls} call${calls === 1 ? "" : "s"}`;
  costTraceSummary.textContent = `Cost & trace · ${totals.costKnown ? `$${totals.cost.toFixed(4)}` : "cost unknown"} · ${calls} call${calls === 1 ? "" : "s"}`;

  const shown = trace.filter(Boolean).sort((a, b) => a.index - b.index);
  traceView.textContent =
    shown.length === 0
      ? "No calls yet."
      : shown
          .map(
            (t) =>
              `#${t.index + 1} ${t.mode}${t.model ? ` (${t.model})` : ""} · ${t.tokens_in}in/${t.tokens_out}out · ${fmtCost(t.cost_usd)} · ${t.category}/${t.urgency}${t.needs_review ? " · REVIEW: " + t.needs_review : ""}${t.note ? " · NOTE: " + t.note : ""}`,
          )
          .join("\n");
}

function failureResult(raw: string, index: number, err: unknown): ExtractionResult {
  return {
    index,
    mode: config.mode,
    // A timed-out call may still bill upstream; the server guard is the real cap.
    usage: { tokens_in: 0, tokens_out: 0, cost_usd: 0, estimated: true },
    record: {
      raw_text: raw,
      name: null,
      phone: null,
      service_needed: null,
      urgency: "emergency",
      urgency_reason: "Not read automatically. Open the original message.",
      area: null,
      language: "en",
      category: "real",
      category_reason: "",
      owner_summary: "Could not process this lead. Read the original.",
      followup_draft: "",
      needs_review: err instanceof Error ? err.message : "extraction failed",
    },
  };
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
      `Ember mode makes one paid API call per lead: ${leads.length} call(s). Session spend so far: $${totals.cost.toFixed(4)} of your $${config.capUsd.toFixed(2)} advisory cap. Continue?`,
    );
    if (!ok) return;
  }

  const adapter: LeadAdapter = config.mode === "mock" ? MockAdapter : ApiAdapter;
  // A run replaces the board; session totals keep accumulating.
  results = [];
  trace = [];
  showingReplay = false;
  boardNote.hidden = true;
  boardPrompt = { system_prompt: null, prompt_hash: null, model: null };
  updateBadge();
  render();
  running = true;
  runBtn.disabled = true;
  runNote.hidden = true;
  let fallbackSeen = false;
  let next = 0;
  let done = 0;
  let failed = 0;
  let stoppedForCap = false;

  const worker = async () => {
    while (next < leads.length) {
      if (totals.costKnown && totals.cost >= config.capUsd) {
        stoppedForCap = true;
        return;
      }
      const i = next++;
      let result: ExtractionResult;
      try {
        result = { ...(await adapter.extract(leads[i], config)), index: i };
      } catch (err) {
        failed++;
        result = failureResult(leads[i], i, err);
      }
      results[i] = result;
      trace[i] = toTraceEntry(result);
      addToTotals(result);
      if (result.model) boardPrompt.model = result.model;
      if (result.prompt_hash) boardPrompt.prompt_hash = result.prompt_hash;
      if (result.note) {
        fallbackSeen = true;
        runNote.textContent = result.note;
        runNote.hidden = false;
      }
      done++;
      runStatus.textContent = `Triaged ${done} of ${leads.length}…`;
      render();
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, leads.length) }, worker));
  } finally {
    running = false;
    runBtn.disabled = false;
    if (config.mode === "ember") updateBadge(fallbackSeen);
  }
  const notRun = leads.length - done;
  runStatus.textContent = stoppedForCap
    ? `Stopped at the $${config.capUsd.toFixed(2)} advisory cap: ${done} triaged, ${notRun} not processed.`
    : `Done: ${done - failed} triaged, ${failed} need review.`;
}

function loadReplay() {
  if (!REPLAY.results.length) {
    runStatus.textContent = "No recorded Ember run is bundled in this build.";
    return;
  }
  results = REPLAY.results.map((r, i) => ({ ...r, index: r.index ?? i }));
  trace = [];
  totals = { tokensIn: 0, tokensOut: 0, cost: 0, costKnown: true };
  for (const r of results) {
    trace[r.index ?? 0] = toTraceEntry(r);
    addToTotals(r);
  }
  boardPrompt = {
    system_prompt: REPLAY.system_prompt || null,
    prompt_hash: REPLAY.prompt_hash,
    model: REPLAY.model,
  };
  showingReplay = true;
  boardNote.textContent = `Replay: recorded Muse Ember run of the 12-lead sample (${REPLAY.recorded_at.slice(0, 10)} · model ${REPLAY.model ?? "muse-ember-1.0"} · recorded cost ${totals.costKnown ? `$${totals.cost.toFixed(4)}` : "unknown"}). Viewing it spends $0. Run Triage to process the pasted leads (mock is $0; live Ember needs the demo key).`;
  boardNote.hidden = false;
  runNote.hidden = true;
  if (!pasteEl.value) pasteEl.value = SAMPLE_PASTE;
  updateBadge();
  render();
}

function redactedRecord(rec: LeadRecord) {
  return {
    ...rec,
    raw_text: `[redacted: ${rec.raw_text.length} chars]`,
    name: rec.name === null ? null : `[redacted: ${rec.name.length} chars]`,
    phone: rec.phone === null ? null : `[redacted: ${rec.phone.replace(/\D/g, "").length} digits]`,
  };
}

function exportTrace() {
  const redact = $<HTMLInputElement>("redact-trace").checked;
  const shown = trace.filter(Boolean).sort((a, b) => a.index - b.index);
  const payload = {
    exported_at: new Date().toISOString(),
    app: "lead-triage",
    redacted: redact,
    contains_customer_data: !redact,
    // Server-reported for Ember calls; null for mock. Recorded when the
    // calls happened — never rebuilt at export time.
    model: boardPrompt.model,
    prompt_hash: boardPrompt.prompt_hash,
    system_prompt: boardPrompt.system_prompt,
    system_prompt_note:
      boardPrompt.system_prompt === null
        ? "Prompt text is held server-side; prompt_hash identifies exactly what was sent. The replay/eval recordings in the repo carry the full text."
        : "Captured verbatim from the recording of this run.",
    budget_cap_usd_advisory: config.capUsd,
    totals: {
      calls: shown.length,
      tokens_in: totals.tokensIn,
      tokens_out: totals.tokensOut,
      cost_usd: totals.costKnown ? Number(totals.cost.toFixed(4)) : null,
      cost_note: totals.costKnown
        ? "Computed from API usage + configured rates (mock calls are $0, estimated)."
        : "Usage missing for one or more calls; token counts are exact, dollar total unavailable (never shown as $0).",
    },
    calls: shown.map((t) => ({
      call: t.index + 1,
      ts: t.ts,
      mode: t.mode,
      model: t.model,
      prompt_hash: t.prompt_hash,
      output_mode: t.output_mode,
      tokens_in: t.tokens_in,
      tokens_out: t.tokens_out,
      cost_usd: t.cost_usd,
      estimated: t.estimated,
      note: t.note ?? null,
      record: redact ? redactedRecord(t.record) : t.record,
    })),
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
  showingReplay = false;
  boardNote.hidden = true;
  boardPrompt = { system_prompt: null, prompt_hash: null, model: null };
  runStatus.textContent = "";
  runNote.hidden = true;
  updateBadge();
  render();
}

// Wiring
$<HTMLButtonElement>("load-sample").addEventListener("click", () => {
  pasteEl.value = SAMPLE_PASTE;
  runStatus.textContent = `Sample set loaded: ${SAMPLE_LEADS.length} fictional demo leads, shuffled.`;
});
$<HTMLButtonElement>("view-replay").addEventListener("click", loadReplay);
$<HTMLButtonElement>("clear-input").addEventListener("click", () => {
  pasteEl.value = "";
  pasteEl.focus();
});
runBtn.addEventListener("click", () => void runTriage());
$<HTMLButtonElement>("export-trace").addEventListener("click", exportTrace);
$<HTMLButtonElement>("clear-session").addEventListener("click", clearSession);
for (const id of ["cfg-name", "cfg-trade", "cfg-tone", "cfg-mode", "cfg-cap", "cfg-demo-key"]) {
  document.getElementById(id)?.addEventListener("change", readConfigInputs);
}
pasteEl.addEventListener("input", () => {
  if (running) return;
  const n = splitBatch(pasteEl.value).length;
  runStatus.textContent = n ? `${n} lead${n === 1 ? "" : "s"} detected` : "";
});
boardEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const rankedReal = rankResults(results.filter(Boolean)).filter((r) => !isFiltered(r.record));
  const copyBtn = target.closest<HTMLButtonElement>("[data-copy]");
  if (copyBtn) {
    const result = rankedReal[Number(copyBtn.dataset.copy) - 1];
    if (!result) return;
    void navigator.clipboard.writeText(result.record.followup_draft).then(() => {
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = "Copy follow-up"), 1200);
    });
    return;
  }
  const calledBtn = target.closest<HTMLButtonElement>("[data-called]");
  if (calledBtn) {
    const result = rankedReal[Number(calledBtn.dataset.called) - 1];
    if (!result) return;
    setCalled(result.record.raw_text, !isCalled(result.record.raw_text));
    render();
  }
});

syncConfigInputs();
// Public default: the labeled replay of a recorded Ember run. Mock stays
// the labeled $0 fallback; live Ember stays behind the demo key.
if (REPLAY.results.length) loadReplay();
else render();
