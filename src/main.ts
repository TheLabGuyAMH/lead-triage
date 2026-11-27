// Lead Triage UI controller: paste/config → per-lead pass → cross-message
// pass → morning dispatch plan (lanes) → folded cost & trace. All AI goes through the adapter boundary
// (schema.ts): MockAdapter runs locally at $0; ApiAdapter goes through
// /api/extract to Muse Ember (passcode-gated on the server). The board
// is a work queue: call/text links with the draft prefilled, and a
// "Called" toggle remembered in localStorage. On first load the board
// shows a clearly labeled replay of a recorded Ember run ($0 to view).

import { ApiAdapter, DEMO_KEY_STORAGE, dispatchBlock, failureResult, investigateMessage } from "./lib/api-adapter";
import { pickOrphans } from "./lib/investigate";
import {
  parseAddresses,
  buildPlan,
  codeLinks,
  isSubsumed,
  linkIsActive,
  resolveAnswers,
  mergeLinks,
  mockLinks,
  planBlocks,
  toDispatchLead,
  type Answers,
  type DispatchPlan,
  type Job,
  type Lane,
  type LeadLink,
} from "./lib/dispatch";
import { MockAdapter } from "./lib/mock";
import { isFiltered, rankResults, splitBatch } from "./lib/ranking";
import { REPLAY } from "./lib/replay-data";
import { FREEZE_LEADS, SAMPLE_CONFIG, SAMPLE_LEADS, SAMPLE_PASTE } from "./lib/sample";
import { buildTraceExport, type LinkTraceEntry, type TraceEntry } from "./lib/trace-export";
import type {
  AdapterMode,
  BusinessConfig,
  ExtractionResult,
  LeadAdapter,
  LeadRecord,
} from "./lib/schema";

// Live runs: up to 100 messages (about $0.05 on Ember); over 30 the
// cross-message pass splits into blocks. The 1,000-message Freeze Day
// is a recorded run.
const BATCH_CAP = 100;
const CONCURRENCY = 4;
const CONFIG_KEY = "lead-triage-config-v1";
const CALLED_KEY = "lead-triage-called-v1";

interface UiConfig extends BusinessConfig {
  mode: AdapterMode;
  capUsd: number;
  trucks: number;
  stopsPerTruck: number;
}

/** A recorded run with its cross-message pass (scripts/record-dispatch.mjs). */
interface DispatchReplay {
  label: string;
  recorded_at: string;
  model: string | null;
  capacity: { trucks: number; stopsPerTruck: number };
  results: ExtractionResult[];
  links: LeadLink[];
  link_calls: LinkTraceEntry[];
  summary: Record<string, unknown> | null;
}

// Measured on the same 40 held-out leads (mock: local $0 runs of the
// round-1 mock at 77d77f2 and of the current mock; Ember: committed eval).
// The current mock's keywords were widened after seeing these leads, so
// its own score on them is not a fair test; the pre-tuning score is.
const MOCK_VS_EMBER_LINE =
  "Practice mode is simple keyword rules. Before its rules were tuned on the 40 test leads it caught 4/9 emergencies and 27/40 urgency overall; Ember caught 9/9 and 40/40 on the same leads. (Tuned on those leads, practice mode now scores 9/9 and 32/40, which overstates it.)";

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
const planSummary = $<HTMLDivElement>("plan-summary");
const questionsEl = $<HTMLDivElement>("questions");
const heroPreview = $<HTMLAnchorElement>("hero-preview");
const traceView = $<HTMLPreElement>("trace-view");
const modeBadge = $<HTMLDivElement>("mode-badge");
const costPill = $<HTMLDivElement>("cost-pill");
const costTraceSummary = $<HTMLElement>("cost-trace-summary");

interface Totals {
  tokensIn: number;
  tokensOut: number;
  cost: number;
  costKnown: boolean;
  /** Calls that returned no cost (failed or unreported). */
  unknownCostCalls: number;
}
const emptyTotals = (): Totals => ({ tokensIn: 0, tokensOut: 0, cost: 0, costKnown: true, unknownCostCalls: 0 });

// A call that reports no cost still may have been billed. The cap check
// counts each one at this deliberately high figure (about 6x the
// measured $0.000347/lead) so an unknown cost never switches the cap off.
const UNKNOWN_CALL_COST_USD = 0.002;
const capSpend = (t: Totals) => t.cost + t.unknownCostCalls * UNKNOWN_CALL_COST_USD;

let config: UiConfig = loadConfig();
let results: ExtractionResult[] = [];
let trace: TraceEntry[] = [];
// Session spend (live runs in this browser session) and the replay's
// recorded cost are kept apart: the header pill and budget meter show
// session spend only; the replay shows its recorded cost in its label.
let sessionTotals = emptyTotals();
let replayTotals = emptyTotals();
let running = false;
let showingReplay = false;
// Cross-message pass: links found across the pile, the owner's answers to
// deciding questions, and the link calls for the trace.
let links: LeadLink[] = [];
let answers: Answers = {};
let linkTrace: LinkTraceEntry[] = [];
let replayLabel = "";
let replayLinkTotals = emptyTotals();
// Answers as they apply to every link (a "no" on a link also covers the links inside it); refreshed each render.
let resolved: Answers = {};
let linkFallbackSeen = false;
let lastChange = "";
// Reply text per paste index as last rendered (AI draft or code script).
const replyByIndex = new Map<number, string>();
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
  const fallback: UiConfig = { ...SAMPLE_CONFIG, mode: "mock", capUsd: 10, trucks: 4, stopsPerTruck: 5 };
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
  $<HTMLInputElement>("cfg-trucks").value = String(config.trucks);
  $<HTMLInputElement>("cfg-stops").value = String(config.stopsPerTruck);
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
    trucks: Math.min(50, Math.max(1, Math.floor(Number($<HTMLInputElement>("cfg-trucks").value) || 4))),
    stopsPerTruck: Math.min(20, Math.max(1, Math.floor(Number($<HTMLInputElement>("cfg-stops").value) || 5))),
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
  runBtn.textContent = config.mode === "mock" ? "Plan these messages (practice, free)" : "Plan these messages with Ember";
  for (const [id, label] of [["view-freeze", "freeze"], ["view-hard", "hard"], ["view-replay", "sample12"]] as const)
    $<HTMLButtonElement>(id).setAttribute("aria-pressed", String(showingReplay && replayLabel === label));
  if (showingReplay && !fallbackNote) {
    modeBadge.className = "mode-badge replay";
    modeBadge.textContent = "Recorded Ember run, $0 to view";
    return;
  }
  modeBadge.className = "mode-badge " + (fallbackNote ? "fallback" : config.mode);
  modeBadge.textContent = fallbackNote
    ? "The server fell back to practice mode; see the note"
    : config.mode === "mock"
      ? "Practice mode, no Ember spend"
      : "Ember mode, live calls";
}

/** While workers run, the board-changing controls stay disabled. */
function setControlsDisabled(disabled: boolean) {
  runBtn.disabled = disabled;
  $<HTMLButtonElement>("view-replay").disabled = disabled;
  $<HTMLButtonElement>("view-freeze").disabled = disabled;
  $<HTMLButtonElement>("view-hard").disabled = disabled;
  $<HTMLButtonElement>("clear-session").disabled = disabled;
  $<HTMLButtonElement>("clear-input").disabled = disabled;
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

const REPLY_KIND: Record<Job["replyKind"], string> = {
  ai: "Reply drafted by Ember, for you to send",
  safety: "Fixed safety script, not AI text",
  water: "Fixed water shut-off script, not AI text",
  cold: "Fixed stay-warm script, not AI text",
  frozen: "Fixed frozen-pipe script, not AI text",
  street: "Fixed street-check script, not AI text",
  building: "Fixed building-check script, not AI text",
  urgent: "Fixed urgent-list script, not AI text",
  not_today: "Fixed honest \"not today\" script, not AI text",
};
const URGENCY_LABEL: Record<LeadRecord["urgency"], string> = { emergency: "Emergency", "same-day": "Same day", routine: "Routine" };
// Tickets that changed lane on the last answer or capacity change, highlighted once.
let recentlyMoved = new Set<number>();

function contactButtons(record: LeadRecord, reply: string, index: number): string {
  const digits = record.phone?.replace(/\D/g, "") ?? "";
  const call = digits
    ? `<a class="btn small" href="tel:${digits}">Call</a>
       <a class="btn small" href="sms:${digits}?&body=${encodeURIComponent(reply)}">Text reply</a>`
    : "";
  const called = isCalled(record.raw_text);
  return `${call}<button type="button" class="btn small" data-copy="${index}">Copy reply</button>
    <button type="button" class="btn small" data-called="${index}">${called ? "Called ✓" : "Mark called"}</button>`;
}

/** Where the job is: the street address in the message, else the area Ember read, else a plain note. */
function whereOf(record: LeadRecord): string {
  const a = parseAddresses(record.raw_text).find((x) => x.suffix) ?? parseAddresses(record.raw_text)[0];
  const street = a ? a.label.replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(St|Dr|Rd|Ave|Blvd|Ln|Ct|Pl|Pkwy|Hwy|Cir|Trl)\b/g, "$1.") : null;
  return [street, record.area && (!street || !street.toLowerCase().includes(record.area.toLowerCase())) ? record.area : null].filter(Boolean).join(", ") || "No address given";
}

/** One job as a carbon ticket: the summary is the stop; opening it shows the reply, proof and actions. */
function ticketHtml(job: Job, stopLabel: string): string {
  const result = job.primary;
  const record = result.record;
  const index = result.index ?? 0;
  replyByIndex.set(index, job.reply);
  const called = isCalled(record.raw_text);
  const moved = job.members.some((m) => recentlyMoved.has(m.index ?? 0));
  const what = record.service_needed ?? "Service not stated";
  const tags = [
    record.urgency === "emergency" ? "" : `<span class="tag ${esc(record.urgency)}">${URGENCY_LABEL[record.urgency]}</span>`,
    record.safety_script ? `<span class="tag safety">Safety script</span>` : "",
    job.members.length > 1 ? `<span class="tag merged" title="${job.members.length} ${job.sharedCause ? "homes" : "messages"}, one stop">${job.members.length} ${job.sharedCause ? "homes" : "messages"}</span>` : "",
    record.language === "es" ? `<span class="tag">Spanish</span>` : "",
    called ? `<span class="tag">Called</span>` : "",
  ].join("");
  const cost =
    result.usage.cost_usd === null
      ? "cost unknown (usage not reported)"
      : `$${result.usage.cost_usd.toFixed(4)}${result.usage.estimated ? " (simulated)" : ""}`;
  return `<details class="ticket ${esc(record.urgency)}${called ? " called" : ""}${moved ? " moved" : ""}">
    <summary>
      <span class="stop-no" aria-label="${esc(stopLabel)}">${esc(stopLabel)}</span>
      <span class="t-name">${esc(record.name ?? "Unknown caller")}</span>
      <span class="t-what">${esc(what)}</span>
      <span class="t-where">${esc(whereOf(record))}</span>
      ${tags.trim() ? `<span class="t-tags">${tags}</span>` : ""}
    </summary>
    <div class="ticket-body">
      ${record.needs_review ? `<div class="review-banner">Needs review: ${esc(record.needs_review)}</div>` : ""}
      <p class="reason">${esc(record.urgency_reason)}</p>
      <div class="fields">
        ${fieldHtml("Phone", record.phone)}
        <div><span class="k">Where</span>${esc(whereOf(record))}</div>
        ${fieldHtml("Language", record.language === "es" ? "Spanish" : "English")}
      </div>
      <p class="summary">${esc(record.owner_summary)}</p>
      <div class="reply">${esc(job.reply)}<span class="reply-kind">${REPLY_KIND[job.replyKind]}</span></div>
      <div class="row">${contactButtons(record, job.reply, index)}</div>
      ${membersHtml(job)}
      <div class="card-foot"><span>Message #${index + 1}</span><span>Read by ${result.mode === "ember" ? "Ember" : "practice mode"}</span><span>${result.usage.tokens_in} tokens in, ${result.usage.tokens_out} out</span><span>${cost}</span></div>
      <details class="raw"><summary>Original message</summary><pre>${esc(record.raw_text)}</pre></details>
    </div>
  </details>`;
}

function who(i: number): string {
  const r = results[i]?.record;
  return `#${i + 1} ${r?.name ?? "unknown"}`;
}

const FILLER = new Set(["that", "this", "with", "from", "have", "about", "your", "they", "there", "their", "since", "still", "nobody", "called", "back", "morning", "please", "house", "home", "water"]);

/** Quotes, with the words they share marked, so the link is visible at a glance. */
function evidenceHtml(link: LeadLink): string {
  const words = (q: string) => new Set(q.toLowerCase().match(/[a-z\u00e0-\u00ff0-9]{4,}/g) ?? []);
  const sets = link.evidence.map((e) => words(e.quote));
  const shared = new Set([...new Set(sets.flatMap((x) => [...x]))].filter((w) => !FILLER.has(w) && sets.filter((x) => x.has(w)).length >= 2));
  const mark = (q: string) =>
    esc(q).replace(/[A-Za-z\u00c0-\u00ff0-9]{4,}/g, (w) => (shared.has(w.toLowerCase()) ? `<mark>${w}</mark>` : w));
  return `<ul class="evidence">${link.evidence
    .map((e) => `<li><span class="k">#${e.index + 1}</span> “${mark(e.quote)}”</li>`)
    .join("")}</ul>`;
}

/** The other messages merged into this job: each keeps its own reply and contact buttons, with the proof and an undo. */
function membersHtml(job: Job): string {
  if (job.members.length < 2) return "";
  const active = job.links.filter((l) => linkIsActive(l, resolved) && !isSubsumed(l, job.links.filter((o) => linkIsActive(o, resolved))));
  const others = job.members.slice(1);
  return `<div class="linked">
    <strong>${job.sharedCause ? `One stop covers ${job.members.length} homes: check the shared supply first, then go house to house.` : "Also on this stop"}</strong>
    ${others
      .map((m) => {
        const i = m.index ?? 0;
        const reply = job.memberReplies.get(i) ?? { text: m.record.followup_draft, kind: "ai" as const };
        replyByIndex.set(i, reply.text);
        return `<div class="member">
          <div><strong>${esc(who(i))}</strong>${m.record.phone ? `, ${esc(m.record.phone)}` : ""}. ${esc(m.record.owner_summary)}</div>
          <div class="reply">${esc(reply.text)}<span class="reply-kind">${REPLY_KIND[reply.kind]}</span></div>
          <div class="row">${contactButtons(m.record, reply.text, i)}</div>
        </div>`;
      })
      .join("")}
    ${active
      .map(
        (l) => `<div class="link-proof"><span class="hint">Why ${l.source === "code" ? "code" : "Ember"} put them together: ${esc(l.explanation)}</span>${evidenceHtml(l)}
        <button type="button" class="btn small" data-answer="${esc(l.key)}|no">Split: ${l.kind === "shared_cause" ? "separate problems" : "different jobs"}</button></div>`,
      )
      .join("")}
  </div>`;
}

function rowHtml(job: Job): string {
  return ticketHtml(job, "");
}

const ANSWER_LABELS = {
  same_job: { badge: "Same job?", yes: "Yes, same job", no: "No, different jobs" },
  shared_cause: { badge: "Same cause?", yes: "Yes, same cause", no: "No, separate problems" },
} as const;

function questionHtml(link: LeadLink, openProof = false): string {
  const labels = ANSWER_LABELS[link.kind];
  const answer = answers[link.key];
  const auto = !answer && linkIsActive(link, resolved);
  const ask = link.ask_index !== null && link.question
    ? `<p class="ask">Ask ${esc(who(link.ask_index))}${results[link.ask_index]?.record.phone ? ` (${esc(results[link.ask_index]!.record.phone!)})` : ""}: “${esc(link.question)}”</p>`
    : "";
  const buttons = answer
    ? `<span class="answered">Answered: ${answer === "yes" ? labels.yes : labels.no}</span>
       <button type="button" class="btn small ghost" data-answer="${esc(link.key)}|clear">Undo</button>`
    : `<button type="button" class="btn small" data-answer="${esc(link.key)}|yes">${labels.yes}</button>
       <button type="button" class="btn small" data-answer="${esc(link.key)}|no">${labels.no}</button>`;
  return `<div class="q-item${answer ? " done" : ""}">
    <div class="q-head"><span class="q-kind">${labels.badge}</span>
      <span class="q-who">${link.indices.map((i) => esc(who(i))).join(", ")}</span></div>
    ${ask}
    <div class="row answer-row">${buttons}</div>
    ${askButtons(link)}
    <details class="proof"${openProof ? " open" : ""}><summary>Ember's proof</summary>
      <p>${esc(link.explanation)}</p>
      ${evidenceHtml(link)}
      <p class="q-source">${link.confidence === "likely" ? "Likely" : "Possible"}${auto ? ", merged until you say no" : ""}. ${link.source === "code" ? "Found by code" : link.source === "mock" ? "Practice-mode rule" : link.investigation ? "Found by Ember's investigator; every quote checked by code" : "Found by Ember; every quote checked by code"}.</p>
      ${link.downgraded ? `<p class="q-source">Code kept this at "possible": ${esc(link.downgraded)}.</p>` : ""}
      ${investigationHtml(link)}
    </details>
  </div>`;
}

/** The investigator's tool steps, so the owner sees how Ember found the link. */
function investigationHtml(link: LeadLink): string {
  const inv = link.investigation;
  if (!inv) return "";
  const step = (s: { tool: string; args: Record<string, unknown>; found: number[] }) =>
    s.tool === "search_messages"
      ? `searched “${esc(String(s.args.query ?? ""))}” → ${s.found.length ? s.found.slice(0, 4).map((i) => `#${i + 1}`).join(", ") : "nothing"}`
      : s.tool === "read_message"
        ? `read ${s.found.map((i) => `#${i + 1}`).join(", ")}`
        : s.tool === "propose_link"
          ? "proposed this link"
          : esc(s.tool);
  const used = inv.steps.filter((s) => s.tool === "search_messages" || s.tool === "read_message").length;
  return `<p class="hint investigation">Ember investigated in ${inv.turns} turn${inv.turns === 1 ? "" : "s"} (${used} tool call${used === 1 ? "" : "s"}) over the whole pile: ${inv.steps.filter((s) => !s.args.unknown && s.tool !== "(text answer)").map(step).join("; ")}.</p>`;
}

/** Call / text / copy the deciding question to the customer it names. */
function askButtons(link: LeadLink): string {
  if (link.ask_index === null || !link.question) return "";
  const rec = results[link.ask_index]?.record;
  if (!rec) return "";
  const digits = rec.phone?.replace(/\D/g, "") ?? "";
  replyByIndex.set(-1 - link.ask_index, link.question);
  return `<div class="row contact-row">${
    digits
      ? `<a class="btn small" href="tel:${digits}">Call ${esc(rec.name ?? "them")}</a>
         <a class="btn small" href="sms:${digits}?&body=${encodeURIComponent(link.question)}">Text the question</a>`
      : ""
  }<button type="button" class="btn small" data-copy="${-1 - link.ask_index}">Copy the question</button></div>`;
}

function laneMap(plan: DispatchPlan): Map<number, Lane> {
  const m = new Map<number, Lane>();
  for (const lane of Object.keys(plan.lanes) as Lane[])
    for (const job of plan.lanes[lane]) for (const r of job.members) m.set(r.index ?? 0, lane);
  return m;
}

const LANE_NAMES: Record<Lane, string> = {
  read_first: "read first",
  trucks: "a truck",
  made_safe: "the urgent replies",
  not_today: "not today",
};

function currentPlan(): DispatchPlan {
  return buildPlan(results.filter(Boolean), links, answers, { trucks: config.trucks, stopsPerTruck: config.stopsPerTruck });
}

/** Apply an answer and describe how the plan moved. */
function answerLink(key: string, value: "yes" | "no" | "clear") {
  const before = laneMap(currentPlan());
  if (value === "clear") delete answers[key];
  else answers[key] = value;
  const after = laneMap(currentPlan());
  const moves: string[] = [];
  recentlyMoved = new Set();
  for (const [i, lane] of after) {
    const was = before.get(i);
    if (was && was !== lane) {
      moves.push(`${who(i)} moved from ${LANE_NAMES[was]} to ${LANE_NAMES[lane]}`);
      recentlyMoved.add(i);
    }
  }
  lastChange = moves.length
    ? `${moves.slice(0, 4).join(". ")}${moves.length > 4 ? `. ${moves.length - 4} more moved` : ""}.`
    : value === "clear"
      ? "Answer cleared; no message changed lanes."
      : "Recorded. No message changed lanes (the jobs were already in the same lane).";
  render();
}

function toTraceEntry(result: ExtractionResult, ts?: string): TraceEntry {
  return {
    index: result.index ?? 0,
    ts: ts ?? new Date().toISOString(),
    mode: result.mode,
    model: result.model ?? null,
    prompt_hash: result.prompt_hash ?? null,
    output_mode: result.output_mode ?? null,
    request_variant: result.request_variant ?? null,
    finish_reason: result.finish_reason ?? null,
    latency_ms: result.latency_ms ?? null,
    tokens_in: result.usage.tokens_in,
    tokens_out: result.usage.tokens_out,
    cost_usd: result.usage.cost_usd,
    estimated: result.usage.estimated,
    category: result.record.category,
    urgency: result.record.urgency,
    language: result.record.language,
    needs_review: result.record.needs_review,
    note: result.note,
    record: result.record,
  };
}

function addUsage(t: Totals, usage: ExtractionResult["usage"]) {
  t.tokensIn += usage.tokens_in;
  t.tokensOut += usage.tokens_out;
  if (usage.cost_usd === null) {
    t.costKnown = false;
    t.unknownCostCalls++;
  } else t.cost += usage.cost_usd;
}

function addToTotals(t: Totals, result: ExtractionResult) {
  addUsage(t, result.usage);
}

/** The hero shows the real product: the first open question with its proof, and truck 1's first stops. */
function renderHeroPreview(open: LeadLink[], byTruck: Map<number, Job[]>) {
  const q = open[0];
  const t1 = byTruck.get(1) ?? [];
  if (!showingReplay || (!q && !t1.length)) {
    heroPreview.hidden = true;
    return;
  }
  const qHtml = q
    ? `<p class="pv-label">A question Ember found this morning</p>
       <div class="q-item"><div class="q-head"><span class="q-kind">${ANSWER_LABELS[q.kind].badge}</span><span class="q-who">${q.indices.map((i) => esc(who(i))).join(", ")}</span></div>
       ${q.ask_index !== null && q.question ? `<p class="ask">Ask ${esc(who(q.ask_index))}: “${esc(q.question)}”</p>` : ""}${evidenceHtml(q)}</div>`
    : "";
  const tHtml = t1.length
    ? `<p class="pv-truck">Truck 1</p><ol class="stops">${t1
        .slice(0, 3)
        .map((j) => {
          const r = j.primary.record;
          // Plain, non-interactive copies of the first tickets: the whole preview is one link to the plan.
          return `<li><div class="ticket ${esc(r.urgency)}"><div class="pv-sum"><span class="stop-no">${j.stop}</span><span class="t-name">${esc(r.name ?? "Unknown caller")}</span><span class="t-what">${esc(r.service_needed ?? "")}</span></div></div></li>`;
        })
        .join("")}</ol>`
    : "";
  heroPreview.innerHTML = qHtml + tHtml;
  heroPreview.hidden = false;
}

/** What actually produced this board, in one sentence (never claims Ember for a practice run). */
function planHowLine(): string {
  const present = results.filter(Boolean);
  const ember = present.length > 0 && present.every((r) => r.mode === "ember");
  const emberLinks = linkTrace.some((t) => t.mode === "ember");
  const reader = ember ? "Ember read every message" : present.some((r) => r.mode === "ember") ? "Ember read some messages and practice mode the rest" : "Practice mode (keyword rules, not Ember) read every message";
  const linker = emberLinks ? "then Ember read the pile for messages that belong together" : ember && showingReplay ? "no cross-message pass was recorded for this set, so only same-phone links (found by code) apply" : "then code and practice-mode rules looked for messages that belong together";
  return `${reader}; ${linker}. Code checked every quote, merged only what is proven or what you confirm, and filled the truck slots in order.`;
}

function render() {
  const present = results.filter(Boolean);
  resolved = resolveAnswers(links, answers);
  const plan = currentPlan();
  const ranked = rankResults(present);
  const real = ranked.filter((r) => !isFiltered(r.record));
  const filtered = ranked.filter((r) => isFiltered(r.record));
  replyByIndex.clear();

  boardEmpty.hidden = present.length > 0;
  const L = plan.lanes;
  const trucksUsed = L.trucks.length;
  const jobCount = L.read_first.length + L.trucks.length + L.made_safe.length + L.not_today.length;
  planSummary.hidden = present.length === 0;
  planSummary.innerHTML = present.length
    ? `<p class="funnel">${present.length.toLocaleString()} messages<span class="arrow">→</span>${real.length.toLocaleString()} real<span class="arrow">→</span>${jobCount.toLocaleString()} jobs<span class="arrow">→</span><span class="end">${trucksUsed} on today's trucks</span></p>
      <ul class="legend">
        <li class="canary"><strong>${L.made_safe.length}</strong> urgent, no truck today: a safety reply is ready for each</li>
        <li class="pink"><strong>${L.not_today.length}</strong> routine: an honest “not today” is ready for each</li>
        <li class="plain"><strong>${plan.pending}</strong> question${plan.pending === 1 ? "" : "s"} for you</li>
        <li class="plain"><strong>${plan.merged}</strong> stops carry more than one message</li>
      </ul>
      ${replayLabel === "hard" && showingReplay ? `<div class="versus" aria-label="Linked pairs found"><div><span>Muse Ember</span><span class="bar"><span style="width:100%"></span></span><span>8 of 8</span></div><div><span>Keyword rules</span><span class="bar"><span style="width:12.5%"></span></span><span>1 of 8</span></div></div><p class="how">The 6 questions below cover all 8 linked pairs (one building has three tenants, one street two homes).</p>` : ""}
      <p class="how">${planHowLine()}</p>
      ${lastChange ? `<p class="change" role="status">${esc(lastChange)}</p>` : ""}`
    : "";

  const shownLinks = links.filter((l) => l.indices.filter((i) => results[i] && results[i].record.category === "real").length >= 2);
  const open = shownLinks.filter((l) => !resolved[l.key] && !linkIsActive(l, resolved) && !isSubsumed(l, shownLinks));
  const answered = shownLinks.filter((l) => answers[l.key]);
  const auto = shownLinks.filter((l) => !resolved[l.key] && linkIsActive(l, resolved) && !isSubsumed(l, shownLinks.filter((o) => linkIsActive(o, resolved))));
  questionsEl.hidden = shownLinks.length === 0;
  questionsEl.innerHTML = shownLinks.length
    ? `<h3>${open.length ? `${open.length} question${open.length === 1 ? "" : "s"} that change the plan` : "No open questions"}</h3>
      <p class="sub">Ember found these messages may belong together but code can't prove it. Ask the customer, tap the answer, and the trucks re-plan.</p>
      ${open.slice(0, 3).map((l, n) => questionHtml(l, n === 0)).join("")}
      ${open.length > 3 ? `<details class="q-group"><summary>${open.length - 3} more question${open.length - 3 === 1 ? "" : "s"}</summary>${open.slice(3).map((l) => questionHtml(l)).join("")}</details>` : ""}
      ${answered.length ? `<details class="q-group"><summary>Answered (${answered.length})</summary>${answered.map((l) => questionHtml(l)).join("")}</details>` : ""}
      ${auto.length ? `<details class="q-group"><summary>Merged automatically because code found the same phone or address (${auto.length})</summary>${auto.map((l) => questionHtml(l)).join("")}</details>` : ""}`
    : "";

  // Trucks are rows of white tickets, dealt in turn (truck 1, 2, 3...).
  const byTruck = new Map<number, Job[]>();
  for (const j of L.trucks) (byTruck.get(j.truck ?? 1) ?? byTruck.set(j.truck ?? 1, []).get(j.truck ?? 1)!).push(j);
  const trucksHtml = [...byTruck.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, jobs]) => {
      const msgs = jobs.reduce((a, j) => a + j.members.length, 0);
      return `<section class="truck" aria-label="Truck ${t}">
        <div class="truck-id"><span class="truck-name">Truck ${t}</span><span class="truck-load">${jobs.length} stop${jobs.length === 1 ? "" : "s"}, ${msgs} message${msgs === 1 ? "" : "s"}</span></div>
        <ol class="stops">${jobs.map((j) => `<li>${ticketHtml(j, j.stop! > config.stopsPerTruck ? "+" : String(j.stop))}</li>`).join("")}</ol>
      </section>`;
    })
    .join("");
  const stack = (lane: "made_safe" | "not_today", cls: string, title: string, sub: string) =>
    L[lane].length
      ? `<details class="stack ${cls}"${L[lane].length <= 12 ? " open" : ""}><summary><h3>${title} (${L[lane].length})</h3><span class="sub">${sub}</span><span class="show show-closed">Show all ${L[lane].length}</span><span class="show show-open">Hide</span></summary>${L[lane].map(rowHtml).join("")}</details>`
      : "";
  boardEl.innerHTML =
    (L.read_first.length
      ? `<section><div class="section-head"><h3>Read these first (${L.read_first.length})</h3><span class="sub">They couldn't be read automatically.</span></div><ol class="stops">${L.read_first.map((j) => `<li>${ticketHtml(j, "!")}</li>`).join("")}</ol></section>`
      : "") +
    (L.trucks.length
      ? `<section><div class="section-head"><h3>On the trucks</h3><span class="sub">${L.trucks.length} of ${plan.slots} stops used. Tap a ticket for the reply and the proof.</span></div><div class="trucks">${trucksHtml}</div></section>`
      : "") +
    stack("made_safe", "canary", "Urgent, no truck today", "A fixed safety reply for each, ready for you to send.") +
    stack("not_today", "pink", "Not today", "An honest reply for each instead of silence, ready for you to send.");
  recentlyMoved = new Set();
  renderHeroPreview(open, byTruck);

  // The filtered fold opens whenever it holds anything, so a real lead
  // misread as spam stays visible instead of disappearing.
  spamBox.hidden = filtered.length === 0;
  spamBox.open = false;
  spamSummary.textContent = `Spam and wrong numbers, set aside (${filtered.length})`;
  spamList.innerHTML = filtered
    .map((r) => {
      const rec = r.record;
      return `<div class="spam-item"><strong>${rec.category === "spam" ? "Spam" : "Not a lead"}.</strong> ${esc(rec.category_reason)}<br><span class="hint">${esc(rec.raw_text.slice(0, 140))}${rec.raw_text.length > 140 ? "…" : ""}</span></div>`;
    })
    .join("");

  $<HTMLSpanElement>("m-processed").textContent = String(present.length);
  $<HTMLSpanElement>("m-real").textContent = String(real.length);
  $<HTMLSpanElement>("m-spam").textContent = String(filtered.length);
  // Session spend only: the replay's recorded cost lives in its label.
  $<HTMLSpanElement>("m-tokens").textContent = String(sessionTotals.tokensIn + sessionTotals.tokensOut);
  $<HTMLSpanElement>("m-cost").textContent = sessionTotals.costKnown ? `$${sessionTotals.cost.toFixed(4)}` : "unknown";
  const pct = config.capUsd > 0 ? Math.min(100, (sessionTotals.cost / config.capUsd) * 100) : 0;
  const fill = $<HTMLDivElement>("budget-fill");
  fill.style.width = `${pct}%`;
  fill.className = "budget-fill" + (pct >= 90 ? " over" : pct >= 60 ? " warn" : "");
  $<HTMLSpanElement>("m-budget").textContent =
    `Budget: $${sessionTotals.cost.toFixed(2)} of $${config.capUsd.toFixed(2)} cap (browser-side stop)`;

  const calls = trace.filter(Boolean).length + linkTrace.length;
  // The header pill is this browser's own spend; a replay's recorded calls are not session calls.
  const spent = sessionTotals.costKnown ? `$${sessionTotals.cost.toFixed(4)}` : "cost unknown";
  costPill.textContent = `${spent} spent this session`;
  costTraceSummary.textContent = showingReplay
    ? `Cost and trace of this recording (${calls.toLocaleString()} recorded calls)`
    : `Cost and trace (${calls} call${calls === 1 ? "" : "s"}, ${spent} this session)`;

  const shown = trace.filter(Boolean).sort((a, b) => a.index - b.index);
  const linkLines = linkTrace.map(
    (t) =>
      t.kind === "investigate"
        ? `investigator · ${t.mode}${t.model ? ` (${t.model})` : ""} · ${t.turns ?? 0} turn(s) · ${t.outcome ?? "?"} · ${t.tokens_in}in/${t.tokens_out}out · ${fmtCost(t.cost_usd)} · ${t.links.length} link(s) kept${t.dropped.length ? ` · ${t.dropped.length} dropped by code` : ""}${t.note ? " · NOTE: " + t.note : ""}`
        : `link pass block ${t.block + 1} · ${t.messages} messages · ${t.mode}${t.model ? ` (${t.model})` : ""} · ${t.tokens_in}in/${t.tokens_out}out · ${fmtCost(t.cost_usd)} · ${t.links.length} link(s) kept${t.dropped.length ? ` · ${t.dropped.length} dropped by code: ${t.dropped.slice(0, 3).join("; ")}` : ""}${t.note ? " · NOTE: " + t.note : ""}`,
  );
  traceView.textContent =
    shown.length === 0 && linkLines.length === 0
      ? "No calls yet."
      : [
          ...shown.map(
            (t) =>
              `#${t.index + 1} ${t.mode}${t.model ? ` (${t.model})` : ""} · ${t.tokens_in}in/${t.tokens_out}out · ${fmtCost(t.cost_usd)} · ${t.category}/${t.urgency}${t.needs_review ? " · REVIEW: " + t.needs_review : ""}${t.note ? " · NOTE: " + t.note : ""}`,
          ),
          ...linkLines,
        ].join("\n");
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
      `Ember mode makes one paid API call per lead (${leads.length}), then ${leads.length <= 30 ? "one more call" : "about one call per group of up to 30 related messages"} to find messages that belong together. Session spend so far: $${sessionTotals.cost.toFixed(4)} of your $${config.capUsd.toFixed(2)} cap. Continue?`,
    );
    if (!ok) return;
  }

  const adapter: LeadAdapter = config.mode === "mock" ? MockAdapter : ApiAdapter;
  // A run replaces the board; session totals keep accumulating.
  results = [];
  trace = [];
  links = [];
  answers = {};
  linkTrace = [];
  lastChange = "";
  linkFallbackSeen = false;
  showingReplay = false;
  boardNote.hidden = true;
  boardPrompt = { system_prompt: null, prompt_hash: null, model: null };
  updateBadge();
  render();
  running = true;
  setControlsDisabled(true);
  runNote.hidden = true;
  let fallbackSeen = false;
  let next = 0;
  let done = 0;
  let failed = 0;
  let flagged = 0;
  let stoppedForCap = false;

  const worker = async () => {
    while (next < leads.length) {
      if (capSpend(sessionTotals) >= config.capUsd) {
        stoppedForCap = true;
        return;
      }
      const i = next++;
      let result: ExtractionResult;
      const t0 = Date.now();
      try {
        result = { ...(await adapter.extract(leads[i], config)), index: i };
        result.latency_ms = result.latency_ms ?? Date.now() - t0;
        if (result.record.needs_review) flagged++;
      } catch (err) {
        failed++;
        result = { ...failureResult(leads[i], i, config.mode, err), latency_ms: Date.now() - t0 };
      }
      results[i] = result;
      trace[i] = toTraceEntry(result);
      addToTotals(sessionTotals, result);
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

  let linkSummary = "";
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, leads.length) }, worker));
    if (!stoppedForCap) {
      runStatus.textContent = `Triaged ${done} of ${leads.length}. Reading the pile for messages that belong together…`;
      linkSummary = await runLinkPass();
    }
  } finally {
    running = false;
    setControlsDisabled(false);
    if (config.mode === "ember") updateBadge(fallbackSeen || linkFallbackSeen);
  }
  const notRun = leads.length - done;
  runStatus.textContent = stoppedForCap
    ? `Stopped at the $${config.capUsd.toFixed(2)} cap: ${done} triaged (${failed} failed, ${flagged} flagged for review), ${notRun} not processed. The cross-message pass did not run.`
    : `Done: ${done - failed} triaged, ${failed} failed, ${flagged} flagged for review. ${linkSummary}`;
  render();
}

/**
 * The cross-message pass. Code links (same phone) always run. Mock mode
 * adds the practice-mode keyword links locally at $0; Ember mode sends
 * each block of related messages to /api/dispatch, where the quotes are
 * checked before the links come back.
 */
async function runLinkPass(): Promise<string> {
  const real = results.filter((r) => r && r.record.category === "real").map(toDispatchLead);
  const found: LeadLink[][] = [codeLinks(real)];
  if (config.mode === "mock") {
    found.push(mockLinks(real));
    links = mergeLinks(found);
    return `Practice-mode linking (keyword rules): ${links.length} link(s).`;
  }
  const blocks = planBlocks(real);
  let next = 0;
  let failedBlocks = 0;
  let stopped = false;
  const worker = async () => {
    while (next < blocks.length) {
      if (capSpend(sessionTotals) >= config.capUsd) {
        stopped = true;
        return;
      }
      const b = next++;
      const t0 = Date.now();
      try {
        const r = await dispatchBlock(blocks[b], config);
        found.push(r.links);
        const entry: LinkTraceEntry = {
          block: b, ts: new Date().toISOString(), mode: r.mode, model: r.model ?? null, prompt_hash: r.prompt_hash ?? null,
          request_variant: r.request_variant ?? null, finish_reason: r.finish_reason ?? null, latency_ms: r.latency_ms ?? Date.now() - t0,
          tokens_in: r.usage.tokens_in, tokens_out: r.usage.tokens_out, cost_usd: r.usage.cost_usd, estimated: r.usage.estimated,
          messages: blocks[b].length, links: r.links, dropped: r.dropped, note: r.note,
        };
        linkTrace.push(entry);
        addUsage(sessionTotals, r.usage);
        if (r.note) {
          linkFallbackSeen = true;
          runNote.textContent = r.note;
          runNote.hidden = false;
        }
      } catch (err) {
        failedBlocks++;
        const usage = (err as { usage?: ExtractionResult["usage"] | null }).usage ?? { tokens_in: 0, tokens_out: 0, cost_usd: null, estimated: false };
        linkTrace.push({
          block: b, ts: new Date().toISOString(), mode: "ember", model: null, prompt_hash: null, request_variant: null, finish_reason: null,
          latency_ms: Date.now() - t0, tokens_in: usage.tokens_in, tokens_out: usage.tokens_out, cost_usd: usage.cost_usd, estimated: false,
          messages: blocks[b].length, links: [], dropped: [], note: err instanceof Error ? err.message : "link pass failed",
        });
        addUsage(sessionTotals, usage);
      }
      links = mergeLinks(found);
      render();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, blocks.length) }, worker));
  links = mergeLinks(found);
  // The investigator: messages that point back at someone but found no link.
  const orphans = stopped ? [] : pickOrphans(real, links);
  let investigated = 0;
  let agentLinks = 0;
  let nextO = 0;
  const investigator = async () => {
    while (nextO < orphans.length) {
      if (capSpend(sessionTotals) >= config.capUsd) return;
      const o = orphans[nextO++];
      runStatus.textContent = `Investigating message #${o.index + 1} (Ember with search tools)…`;
      const t0 = Date.now();
      try {
        const r = await investigateMessage(o, real, config);
        investigated++;
        agentLinks += r.links.length;
        found.push(r.links);
        linkTrace.push({
          block: linkTrace.length, ts: new Date().toISOString(), mode: r.mode, model: r.model ?? null, prompt_hash: r.prompt_hash ?? null,
          request_variant: r.request_variant ?? null, finish_reason: null, latency_ms: r.latency_ms ?? Date.now() - t0,
          tokens_in: r.usage.tokens_in, tokens_out: r.usage.tokens_out, cost_usd: r.usage.cost_usd, estimated: r.usage.estimated,
          messages: 1, links: r.links, dropped: r.dropped, note: r.note, kind: "investigate", turns: r.turns, outcome: r.outcome,
        });
        addUsage(sessionTotals, r.usage);
        if (r.note) linkFallbackSeen = true;
      } catch (err) {
        const usage = (err as { usage?: ExtractionResult["usage"] | null }).usage ?? { tokens_in: 0, tokens_out: 0, cost_usd: null, estimated: false };
        linkTrace.push({
          block: linkTrace.length, ts: new Date().toISOString(), mode: "ember", model: null, prompt_hash: null, request_variant: null, finish_reason: null,
          latency_ms: Date.now() - t0, tokens_in: usage.tokens_in, tokens_out: usage.tokens_out, cost_usd: usage.cost_usd, estimated: false,
          messages: 1, links: [], dropped: [], note: err instanceof Error ? err.message : "investigation failed", kind: "investigate",
        });
        addUsage(sessionTotals, usage);
      }
      links = mergeLinks(found);
      render();
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, orphans.length) }, investigator));
  links = mergeLinks(found);
  return `Cross-message pass: ${blocks.length} call(s), ${links.length} link(s)${failedBlocks ? `, ${failedBlocks} call(s) failed` : ""}${stopped ? ", stopped at the cap" : ""}. Investigator: ${investigated} message(s), ${agentLinks} link(s).`;
}

function loadReplay() {
  if (!REPLAY.results.length) {
    runStatus.textContent = "No recorded Ember run is bundled in this build.";
    return;
  }
  results = REPLAY.results.map((r, i) => ({ ...r, index: r.index ?? i }));
  trace = [];
  links = codeLinks(results.filter((r) => r.record.category === "real").map(toDispatchLead));
  answers = {};
  linkTrace = [];
  lastChange = "";
  replayLabel = "sample12";
  // Replay cost is tracked apart from session spend, and replay trace
  // entries keep the original recorded timestamp.
  replayTotals = emptyTotals();
  for (const r of results) {
    trace[r.index ?? 0] = toTraceEntry(r, REPLAY.recorded_at);
    addToTotals(replayTotals, r);
  }
  boardPrompt = {
    system_prompt: REPLAY.system_prompt || null,
    prompt_hash: REPLAY.prompt_hash,
    model: REPLAY.model,
  };
  showingReplay = true;
  boardNote.textContent = `Replay: recorded Muse Ember run of the 12-lead sample, no messages to link (${REPLAY.recorded_at.slice(0, 10)} · model ${REPLAY.model ?? "muse-ember-1.0"} · recorded cost ${replayTotals.costKnown ? `$${replayTotals.cost.toFixed(4)}` : "unknown"}). Viewing it spends $0. Run Triage to process the pasted leads (mock is $0; live Ember needs the demo key). ${MOCK_VS_EMBER_LINE}`;
  boardNote.hidden = false;
  runNote.hidden = true;
  if (!pasteEl.value) pasteEl.value = SAMPLE_PASTE;
  updateBadge();
  render();
}

interface ReplayCounts { n: number; date: string; cost: string; blocks: number; blockCost: string; inv: number; invCost: string }
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
const REPLAY_NOTES: Record<"freeze" | "hard", (c: ReplayCounts) => string> = {
  freeze: (c) =>
    `${c.n.toLocaleString()} fictional messages from the morning after a hard freeze, run through Muse Ember on ${c.date}. Viewing the recording costs nothing; the run's own cost is under Cost and trace.`,
  hard: (c) =>
    `${c.n} fictional messages where the ones that belong together share no phone and no house number: a son calling for his mother, a tenant and the property manager, "Bobby" and "Robert". Ember found 8 of 8 linked pairs; plain rules find 1. Code can't prove any of them, so each one is a question for you. Recorded ${c.date}.`,
};

/** A recorded run with its cross-message pass, loaded on demand. */
async function loadDispatchReplay(which: "freeze" | "hard"): Promise<boolean> {
  runStatus.textContent = which === "freeze" ? "Loading the recorded Freeze Day run…" : "Loading the recorded hard-links run…";
  const data = (
    which === "freeze" ? (await import("./lib/replay-freeze.json")).default : (await import("./lib/replay-hard.json")).default
  ) as unknown as DispatchReplay;
  if (!data.results.length) {
    runStatus.textContent = "That recorded run is not bundled in this build.";
    return false;
  }
  results = data.results.map((r, i) => ({ ...r, index: r.index ?? i }));
  trace = [];
  replayTotals = emptyTotals();
  replayLinkTotals = emptyTotals();
  for (const r of results) {
    trace[r.index ?? 0] = toTraceEntry(r, data.recorded_at);
    addToTotals(replayTotals, r);
  }
  linkTrace = data.link_calls;
  for (const t of linkTrace) addUsage(replayLinkTotals, { tokens_in: t.tokens_in, tokens_out: t.tokens_out, cost_usd: t.cost_usd, estimated: t.estimated });
  links = data.links;
  answers = {};
  lastChange = "";
  replayLabel = which;
  config.trucks = data.capacity.trucks;
  config.stopsPerTruck = data.capacity.stopsPerTruck;
  syncConfigInputs();
  boardPrompt = { system_prompt: null, prompt_hash: results[0]?.prompt_hash ?? null, model: data.model };
  showingReplay = true;
  const cost = (t: Totals) => (t.costKnown ? `$${t.cost.toFixed(4)}` : "unknown");
  const blockT = emptyTotals();
  const invT = emptyTotals();
  for (const t of linkTrace) addUsage(t.kind === "investigate" ? invT : blockT, { tokens_in: t.tokens_in, tokens_out: t.tokens_out, cost_usd: t.cost_usd, estimated: t.estimated });
  boardNote.textContent = REPLAY_NOTES[which]({
    n: results.length, date: data.recorded_at.slice(0, 10), cost: cost(replayTotals),
    blocks: linkTrace.filter((t) => t.kind !== "investigate").length, blockCost: cost(blockT),
    inv: linkTrace.filter((t) => t.kind === "investigate").length, invCost: cost(invT),
  });
  boardNote.hidden = false;
  runNote.hidden = true;
  runStatus.textContent = "";
  updateBadge();
  render();
  return true;
}

function exportTrace() {
  const redact = $<HTMLInputElement>("redact-trace").checked;
  if (!redact) {
    const ok = window.confirm(
      "Contains customer data: this unredacted export includes lead text, names, phone numbers and drafts, and will be marked contains_customer_data: true. Export it only where customer data is allowed, and never commit a real one. Continue?",
    );
    if (!ok) return;
  }
  const payload = buildTraceExport(trace.filter(Boolean), redact, {
    model: boardPrompt.model,
    prompt_hash: boardPrompt.prompt_hash,
    system_prompt: boardPrompt.system_prompt,
    capUsd: config.capUsd,
    replay: showingReplay,
    recorded_at: showingReplay ? (replayLabel === "freeze" || replayLabel === "hard" ? trace.find(Boolean)?.ts ?? null : REPLAY.recorded_at) : null,
  }, linkTrace);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `lead-triage-trace-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function clearSession() {
  replayLinkTotals = emptyTotals();
  results = [];
  trace = [];
  links = [];
  answers = {};
  linkTrace = [];
  lastChange = "";
  sessionTotals = emptyTotals();
  replayTotals = emptyTotals();
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
$<HTMLButtonElement>("view-freeze").addEventListener("click", () => void loadDispatchReplay("freeze"));
$<HTMLButtonElement>("view-hard").addEventListener("click", () => void loadDispatchReplay("hard"));
$<HTMLButtonElement>("load-freeze").addEventListener("click", () => {
  pasteEl.value = FREEZE_LEADS.join("\n\n");
  runStatus.textContent = `Freeze morning loaded: ${FREEZE_LEADS.length} fictional messages, some about the same job.`;
});
$<HTMLButtonElement>("clear-input").addEventListener("click", () => {
  pasteEl.value = "";
  runStatus.textContent = "";
  pasteEl.focus();
});
runBtn.addEventListener("click", () => void runTriage());
$<HTMLButtonElement>("export-trace").addEventListener("click", exportTrace);
$<HTMLButtonElement>("clear-session").addEventListener("click", clearSession);
for (const id of ["cfg-name", "cfg-trade", "cfg-tone", "cfg-mode", "cfg-cap", "cfg-demo-key"]) {
  document.getElementById(id)?.addEventListener("change", readConfigInputs);
}
for (const id of ["cfg-trucks", "cfg-stops"]) {
  document.getElementById(id)?.addEventListener("change", () => {
    const before = laneMap(currentPlan());
    readConfigInputs();
    const after = laneMap(currentPlan());
    let on = 0;
    let off = 0;
    for (const [i, lane] of after) {
      const was = before.get(i);
      if (was !== lane && lane === "trucks") on++;
      if (was === "trucks" && lane !== "trucks") off++;
    }
    lastChange = `Capacity now ${config.trucks} × ${config.stopsPerTruck}: ${on} message(s) moved onto the trucks, ${off} moved off.`;
    render();
  });
}
pasteEl.addEventListener("input", () => {
  if (running) return;
  const n = splitBatch(pasteEl.value).length;
  runStatus.textContent = n ? `${n} lead${n === 1 ? "" : "s"} detected` : "";
});
function onPlanClick(e: Event) {
  const target = e.target as HTMLElement;
  const answerBtn = target.closest<HTMLButtonElement>("[data-answer]");
  if (answerBtn) {
    const raw = answerBtn.dataset.answer ?? "";
    const cut = raw.lastIndexOf("|");
    answerLink(raw.slice(0, cut), raw.slice(cut + 1) as "yes" | "no" | "clear");
    return;
  }
  const copyBtn = target.closest<HTMLButtonElement>("[data-copy]");
  if (copyBtn) {
    const text = replyByIndex.get(Number(copyBtn.dataset.copy));
    if (text === undefined) return;
    const label = copyBtn.textContent;
    void navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = label), 1200);
    });
    return;
  }
  const calledBtn = target.closest<HTMLButtonElement>("[data-called]");
  if (calledBtn) {
    const result = results[Number(calledBtn.dataset.called)];
    if (!result) return;
    setCalled(result.record.raw_text, !isCalled(result.record.raw_text));
    render();
  }
}
boardEl.addEventListener("click", onPlanClick);
questionsEl.addEventListener("click", onPlanClick);

syncConfigInputs();
// Public default: the labeled replay of a recorded Ember run. Mock stays
// the labeled $0 fallback; live Ember stays behind the demo key.
// The public default is the recorded Freeze Day run when this build has
// one, else the 12-lead replay; both are labeled and spend $0 to view.
void loadDispatchReplay("freeze").then((ok) => {
  if (ok) return;
  if (REPLAY.results.length) loadReplay();
  else render();
});
