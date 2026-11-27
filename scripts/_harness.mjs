// Shared harness for the Ember scripts (test / eval / replay).
// Bundles the TS lib once with esbuild, loads the pulled production env
// from a gitignored file WITHOUT printing it, and tracks spend from API
// usage so a run can stop before crossing its dollar budget.

import { build } from "esbuild";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const REPO = process.cwd();
export const ENV_FILE = join(REPO, ".env.ember.local");
export const FALLBACK_RATES = { inPerMTok: 0.1, outPerMTok: 0.5 };

/** Load KEY=value pairs from the pulled env file into process.env (never prints values). */
export function loadEnvFile() {
  if (!existsSync(ENV_FILE)) return false;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}

export async function loadLib() {
  const dir = mkdtempSync(join(tmpdir(), "lead-triage-harness-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `
export { emberExtract, emberEnvFromProcess, emberOptionsFromProcess, computeCostUsd } from ${JSON.stringify(join(REPO, "api/_lib/ember.ts"))};
export { mockExtract } from ${JSON.stringify(join(REPO, "src/lib/mock.ts"))};
export { extractionSystemPrompt } from ${JSON.stringify(join(REPO, "src/lib/schema.ts"))};
export { SAMPLE_LEADS, SAMPLE_CONFIG, FREEZE_LEADS, FREEZE_GROUPS, HARD_LEADS, HARD_GROUPS } from ${JSON.stringify(join(REPO, "src/lib/sample.ts"))};
export { pickOrphans } from ${JSON.stringify(join(REPO, "src/lib/investigate.ts"))};
export { planBlocks, codeLinks, mockLinks, mergeLinks, recheckAnchors, buildPlan, linkIsActive, toDispatchLead, linkSystemPrompt } from ${JSON.stringify(join(REPO, "src/lib/dispatch.ts"))};
`,
  );
  const out = join(dir, "bundle.mjs");
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  const lib = await import(pathToFileURL(out).href);
  return { lib, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Cost from real usage; falls back to the published rates only for spend accounting. */
export function costOf(lib, env, usage) {
  const c = lib.computeCostUsd(usage.tokens_in, usage.tokens_out, env);
  if (c !== null) return c;
  if (!usage.tokens_in && !usage.tokens_out) return null; // usage missing: unknown, not $0
  return (usage.tokens_in * FALLBACK_RATES.inPerMTok + usage.tokens_out * FALLBACK_RATES.outPerMTok) / 1_000_000;
}

export class Spend {
  constructor(budgetUsd) {
    this.budget = budgetUsd;
    this.total = 0;
    this.calls = 0;
    this.unknown = 0;
  }
  add(cost) {
    this.calls++;
    if (cost === null) this.unknown++;
    else this.total += cost;
  }
  /** Conservative pre-call guard: assume the next call could cost $0.002. */
  canAffordNext() {
    return this.total + 0.002 <= this.budget;
  }
  summary() {
    return `$${this.total.toFixed(6)} over ${this.calls} billed call(s)` +
      (this.unknown ? ` (+${this.unknown} with unreported usage)` : "");
  }
}

/** Simple worker pool; fn receives (item, index). */
export async function pooled(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

export const digits = (s) => (s ?? "").replace(/\D/g, "");

/** Cost from an endpoint response's usage at the published rates. */
export function costFromUsage(usage) {
  if (!usage) return null;
  if (typeof usage.cost_usd === "number") return usage.cost_usd;
  if (!usage.tokens_in && !usage.tokens_out) return null;
  return (usage.tokens_in * FALLBACK_RATES.inPerMTok + usage.tokens_out * FALLBACK_RATES.outPerMTok) / 1_000_000;
}

/**
 * One lead through the deployed, passcode-gated POST /api/extract
 * (mode "ember"). Used when MODEL_API_KEY cannot leave the host
 * (Vercel Secret) but EMBER_DEMO_KEY is readable. One retry on 502
 * or timeout/network failure. A 200 whose mode is not "ember" means
 * a server gate fell back to mock and is reported as an error, never
 * scored as an Ember result.
 */
export async function endpointExtract(endpoint, demoKey, rawText, config, { timeoutMs = 60_000 } = {}) {
  const t0 = Date.now();
  let lastError = null;
  let lastRaw = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "x-demo-key": demoKey },
        body: JSON.stringify({ mode: "ember", raw_text: rawText, config }),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* keep raw text below */ }
      lastRaw = json ?? text.slice(0, 500);
      if (res.status === 502 && attempt === 1) {
        lastError = `HTTP 502 (attempt 1)`;
        continue;
      }
      if (!res.ok) {
        // The server returns upstream-reported usage on a 502 when it
        // has it (cost null when unknown, never $0) — keep it for spend.
        return { record: null, usage: json?.usage ?? null, model: null, promptHash: null, outputMode: null, requestVariant: null, finishReason: null, endpointResponse: lastRaw, httpStatus: res.status, attempts: attempt, latency_ms: Date.now() - t0, error: `HTTP ${res.status}: ${String(json?.error ?? text).slice(0, 200)}` };
      }
      if (!json || json.mode !== "ember" || !json.record) {
        return { record: null, usage: json?.usage ?? null, model: json?.model ?? null, promptHash: json?.prompt_hash ?? null, outputMode: json?.output_mode ?? null, requestVariant: json?.request_variant ?? null, finishReason: json?.finish_reason ?? null, endpointResponse: lastRaw, httpStatus: res.status, attempts: attempt, latency_ms: Date.now() - t0, error: `gate fallback: mode=${String(json?.mode)} note=${String(json?.note ?? "").slice(0, 160)}` };
      }
      return { record: json.record, usage: json.usage ?? null, model: json.model ?? null, promptHash: json.prompt_hash ?? null, outputMode: json.output_mode ?? null, requestVariant: json.request_variant ?? null, finishReason: json.finish_reason ?? null, endpointResponse: json, httpStatus: res.status, attempts: attempt, latency_ms: Date.now() - t0, error: null };
    } catch (err) {
      lastError = err?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(err?.message ?? err).slice(0, 200);
      if (attempt === 2) break;
    } finally {
      clearTimeout(timer);
    }
  }
  return { record: null, usage: null, model: null, promptHash: null, outputMode: null, requestVariant: null, finishReason: null, endpointResponse: lastRaw, httpStatus: null, attempts: 2, latency_ms: Date.now() - t0, error: lastError ?? "endpoint call failed" };
}

/** Trace file in the same shape the UI exports (fictional data only — safe to commit). */
export function toTraceFile({ label, model, systemPrompt, promptHash, items, spend }) {
  return {
    recorded_at: new Date().toISOString(),
    app: "lead-triage",
    label,
    fictional_data_only: true,
    redacted: false,
    contains_customer_data: false,
    model,
    prompt_hash: promptHash,
    system_prompt: systemPrompt,
    totals: {
      calls: items.length,
      tokens_in: items.reduce((a, i) => a + (i.usage?.tokens_in ?? 0), 0),
      tokens_out: items.reduce((a, i) => a + (i.usage?.tokens_out ?? 0), 0),
      cost_usd: Number(spend.total.toFixed(6)),
    },
    calls: items.map((i, n) => ({
      call: n + 1,
      id: i.id ?? n + 1,
      mode: "ember",
      model: i.model ?? model,
      prompt_hash: i.promptHash ?? promptHash,
      output_mode: i.outputMode ?? null,
      request_variant: i.requestVariant ?? null,
      finish_reason: i.finishReason ?? null,
      latency_ms: i.latency_ms ?? null,
      attempts: i.attempts ?? null,
      tokens_in: i.usage?.tokens_in ?? 0,
      tokens_out: i.usage?.tokens_out ?? 0,
      cost_usd: i.usage?.cost_usd ?? null,
      estimated: false,
      error: i.error ?? null,
      record: i.record ?? null,
    })),
  };
}

/**
 * One block through the deployed, passcode-gated POST /api/dispatch
 * (mode "ember"). One retry on 502 or timeout. A 200 whose mode is not
 * "ember" means a gate fell back and is an error, never an Ember result.
 */
export async function endpointDispatch(endpoint, demoKey, leads, config, { timeoutMs = 90_000 } = {}) {
  const t0 = Date.now();
  let lastError = null;
  // Usage of a failed first attempt (it may have billed); the caller adds it to spend.
  let failedUsage = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "x-demo-key": demoKey },
        body: JSON.stringify({ mode: "ember", leads, config }),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* raw below */ }
      if (res.status === 502 && attempt === 1) {
        lastError = "HTTP 502 (attempt 1)";
        failedUsage = json?.usage ?? { tokens_in: 0, tokens_out: 0, cost_usd: null };
        continue;
      }
      if (!res.ok) return { ...emptyDispatch(json?.usage ?? null), httpStatus: res.status, attempts: attempt, latency_ms: Date.now() - t0, error: `HTTP ${res.status}: ${String(json?.error ?? text).slice(0, 200)}`, failedUsage };
      if (!json || json.mode !== "ember") return { ...emptyDispatch(json?.usage ?? null), httpStatus: res.status, attempts: attempt, latency_ms: Date.now() - t0, error: `gate fallback: mode=${String(json?.mode)} note=${String(json?.note ?? "").slice(0, 160)}`, failedUsage };
      return { links: json.links, dropped: json.dropped ?? [], usage: json.usage ?? null, model: json.model ?? null, promptHash: json.prompt_hash ?? null, requestVariant: json.request_variant ?? null, finishReason: json.finish_reason ?? null, httpStatus: res.status, attempts: attempt, latency_ms: Date.now() - t0, error: null, failedUsage };
    } catch (err) {
      lastError = err?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(err?.message ?? err).slice(0, 200);
      if (attempt === 2) break;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ...emptyDispatch(null), httpStatus: null, attempts: 2, latency_ms: Date.now() - t0, error: lastError ?? "endpoint call failed", failedUsage };
}

/** One orphan through the deployed, passcode-gated POST /api/investigate. No retry (a loop may have billed several calls). */
export async function endpointInvestigate(endpoint, demoKey, target, pile, config, { timeoutMs = 120_000 } = {}) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-demo-key": demoKey },
      body: JSON.stringify({ mode: "ember", leads: pile, target_index: target.index, config }),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* raw below */ }
    if (!res.ok) return { links: [], dropped: [], steps: [], turns: 0, outcome: "error", usage: json?.usage ?? null, latency_ms: Date.now() - t0, error: `HTTP ${res.status}: ${String(json?.error ?? text).slice(0, 200)}` };
    if (!json || json.mode !== "ember") return { links: [], dropped: [], steps: [], turns: 0, outcome: "error", usage: json?.usage ?? null, latency_ms: Date.now() - t0, error: `gate fallback: ${String(json?.note ?? "").slice(0, 160)}` };
    return { ...json, latency_ms: Date.now() - t0, error: null };
  } catch (err) {
    return { links: [], dropped: [], steps: [], turns: 0, outcome: "error", usage: null, latency_ms: Date.now() - t0, error: err?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(err?.message ?? err).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

function emptyDispatch(usage) {
  return { links: [], dropped: [], usage, model: null, promptHash: null, requestVariant: null, finishReason: null };
}

/**
 * Score links against an answer key (groups of 0-based positions).
 * "Pairs" = every pair of messages inside a link or group. Reports all
 * links, Ember-proposed links only, and what merges by default.
 */
export function scoreLinks(lib, links, truth) {
  const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const pairsOf = (m) => {
    const out = [];
    for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) out.push(pairKey(m[i], m[j]));
    return out;
  };
  const truthPairs = new Map();
  for (const g of truth) for (const p of pairsOf(g.members)) truthPairs.set(p, g.kind);
  const covered = (ls) => new Set(ls.flatMap((l) => pairsOf(l.indices)));
  const anyPairs = covered(links);
  const emberPairs = covered(links.filter((l) => l.source === "ember"));
  const parent = new Map();
  const find = (i) => ((parent.get(i) ?? i) === i ? i : find(parent.get(i)));
  const active = links.filter((l) => lib.linkIsActive(l, {}));
  for (const l of active) for (const i of l.indices.slice(1)) parent.set(find(i), find(l.indices[0]));
  const comps = new Map();
  for (const l of active) for (const i of l.indices) {
    const r = find(i);
    (comps.get(r) ?? comps.set(r, new Set()).get(r)).add(i);
  }
  const autoPairs = new Set([...comps.values()].flatMap((c) => pairsOf([...c])));
  const hit = (set) => [...set].filter((p) => truthPairs.has(p)).length;
  const byKind = (set, kind) => [...truthPairs].filter(([p, k]) => k === kind && set.has(p)).length;
  const nKind = (kind) => [...truthPairs.values()].filter((k) => k === kind).length;
  const wrongAuto = [...autoPairs].filter((p) => !truthPairs.has(p));
  return {
    true_link_pairs: truthPairs.size,
    true_groups: truth.length,
    links_found: links.length,
    pairs_suggested: anyPairs.size,
    pairs_suggested_correct: hit(anyPairs),
    recall_any_link: `${hit(anyPairs)}/${truthPairs.size}`,
    recall_same_job: `${byKind(anyPairs, "same_job")}/${nKind("same_job")}`,
    recall_shared_cause: `${byKind(anyPairs, "shared_cause")}/${nKind("shared_cause")}`,
    precision_any_link: `${hit(anyPairs)}/${anyPairs.size}`,
    ember_links: links.filter((l) => l.source === "ember").length,
    ember_recall: `${hit(emberPairs)}/${truthPairs.size}`,
    ember_recall_same_job: `${byKind(emberPairs, "same_job")}/${nKind("same_job")}`,
    ember_recall_shared_cause: `${byKind(emberPairs, "shared_cause")}/${nKind("shared_cause")}`,
    ember_precision: `${hit(emberPairs)}/${emberPairs.size}`,
    auto_merged_pairs: autoPairs.size,
    auto_merged_correct: hit(autoPairs),
    wrong_auto_merges: wrongAuto.length,
    wrong_auto_merge_examples: wrongAuto.slice(0, 5).map((p) => p.split("-").map((n) => `#${Number(n) + 1}`).join(" + ")),
    likely_downgraded_by_code: links.filter((l) => l.downgraded).length,
  };
}
