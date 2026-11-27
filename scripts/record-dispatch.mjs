// Runs a message set through the deployed, passcode-gated endpoints
// (per-message POST /api/extract, then the cross-message POST
// /api/dispatch per block), scores the links against the answer key,
// and writes the results, a trace, and (for the 1,000-message Freeze
// Day) the public replay src/lib/replay-freeze.json.
//
// Spend: a hard guard stops new calls before the running total could
// pass --budget. Every call's cost comes from the usage the server
// reports; a retried attempt is counted at $0.002 (about 6x a lead).
//
// Run: node scripts/record-dispatch.mjs --set=freeze20|freeze1000
//        --base=https://lead-triage-nine.vercel.app [--budget=0.50]
//        [--concurrency=6] [--trucks=8 --stops=5] [--limit=N]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, Spend, costFromUsage, endpointDispatch, endpointExtract, loadEnvFile, loadLib, pooled } from "./_harness.mjs";

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || d;
const set = arg("set", "freeze20");
const base = arg("base", "").replace(/\/$/, "");
const spend = new Spend(Number(arg("budget", "0.50")));
const concurrency = Number(arg("concurrency", "6"));
const RETRY_COST = 0.002;

loadEnvFile();
const demoKey = process.env.EMBER_DEMO_KEY || "";
if (!base) throw new Error("--base is required");
if (!demoKey) throw new Error("EMBER_DEMO_KEY not loaded (pull production env into .env.ember.local first).");

const { lib, cleanup } = await loadLib();
try {
  const config = lib.SAMPLE_CONFIG;
  // Messages + answer key: groups of 0-based positions that truly belong together.
  let texts;
  let truth; // [{ kind, members }]
  let labels = null; // per message { category, urgency }
  if (set === "freeze20") {
    texts = lib.FREEZE_LEADS;
    truth = lib.FREEZE_GROUPS.map((g) => ({ kind: g.kind, members: g.members }));
  } else if (set === "freeze1000") {
    const rows = readFileSync(join(REPO, "evals/freeze-day.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const limit = Number(arg("limit", String(rows.length)));
    const used = rows.slice(0, limit);
    texts = used.map((r) => r.text);
    labels = used.map((r) => ({ category: r.category, urgency: r.urgency }));
    const groups = new Map();
    used.forEach((r, i) => {
      if (!r.group) return;
      const g = groups.get(r.group) ?? { kind: r.kind, members: [] };
      g.members.push(i);
      groups.set(r.group, g);
    });
    truth = [...groups.values()].filter((g) => g.members.length >= 2);
  } else throw new Error(`unknown set ${set}`);

  // ---- 1. per-message pass (or reuse a saved one: --reuse=<replay or results JSON with results[]>) ----
  const t0 = Date.now();
  let stoppedForBudget = false;
  const reuse = arg("reuse", "");
  const reused = reuse ? JSON.parse(readFileSync(reuse, "utf8")).results : null;
  const items = reused
    ? reused.map((r) => ({ index: r.index, record: r.record, usage: r.usage, model: r.model, promptHash: r.prompt_hash, outputMode: r.output_mode, requestVariant: r.request_variant, finishReason: r.finish_reason, latency_ms: r.latency_ms, attempts: 1, error: null, reused: true }))
    : await pooled(texts, concurrency, async (raw, index) => {
    if (!spend.canAffordNext()) {
      stoppedForBudget = true;
      return { index, error: "budget guard: not sent", record: null, usage: null };
    }
    const r = await endpointExtract(`${base}/api/extract`, demoKey, raw, config);
    spend.add(costFromUsage(r.usage));
    if (r.attempts > 1) spend.add(RETRY_COST);
    if (index % 100 === 0) console.log(`  extract ${index}/${texts.length} · ${spend.summary()}`);
    return { index, ...r };
  });
  if (reused) console.log(`per-message pass reused from ${reuse} (no new extraction spend)`);
  const extractMs = Date.now() - t0;
  const failed = items.filter((i) => i.error);
  console.log(`per-message pass: ${items.length - failed.length}/${items.length} ok in ${(extractMs / 1000).toFixed(0)}s · ${spend.summary()}`);
  if (failed.length) console.log(`  failures: ${failed.slice(0, 5).map((f) => `#${f.index + 1} ${f.error}`).join(" | ")}`);
  if (stoppedForBudget) throw new Error("budget guard stopped the per-message pass; nothing written");

  const results = items.map((i) => (i.record ? {
    record: i.record, usage: i.usage, mode: "ember", index: i.index, model: i.model, prompt_hash: i.promptHash,
    output_mode: i.outputMode, request_variant: i.requestVariant, finish_reason: i.finishReason ?? null, latency_ms: i.latency_ms ?? null,
  } : null));

  // ---- 2. cross-message pass ----
  const real = results.filter((r) => r && r.record.category === "real").map(lib.toDispatchLead);
  const blocks = lib.planBlocks(real);
  const t1 = Date.now();
  const linkCalls = await pooled(blocks, Math.min(concurrency, 4), async (block, b) => {
    if (!spend.canAffordNext()) return { block: b, error: "budget guard: not sent", links: [], dropped: [], usage: null, messages: block.length };
    const r = await endpointDispatch(`${base}/api/dispatch`, demoKey, block, config);
    spend.add(costFromUsage(r.usage));
    if (r.failedUsage) spend.add(costFromUsage(r.failedUsage) ?? RETRY_COST);
    return { block: b, messages: block.length, ...r };
  });
  const linkMs = Date.now() - t1;
  const linkFailed = linkCalls.filter((c) => c.error);
  const links = lib.mergeLinks([lib.codeLinks(real), ...linkCalls.map((c) => c.links)]);
  console.log(`cross-message pass: ${blocks.length} block(s), ${linkFailed.length} failed, ${links.length} links in ${(linkMs / 1000).toFixed(0)}s · ${spend.summary()}`);
  if (linkFailed.length) console.log(`  failures: ${linkFailed.slice(0, 5).map((f) => `block ${f.block + 1} ${f.error}`).join(" | ")}`);

  // ---- 3. score ----
  const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const pairsOf = (members) => {
    const out = [];
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) out.push(pairKey(members[i], members[j]));
    return out;
  };
  const truthPairs = new Map();
  for (const g of truth) for (const p of pairsOf(g.members)) truthPairs.set(p, g.kind);
  const anyPairs = new Set(links.flatMap((l) => pairsOf(l.indices)));
  const activeLinks = links.filter((l) => lib.linkIsActive(l, {}));
  // Pairs merged by default = pairs inside the same component of active links.
  const parent = new Map();
  const find = (i) => (parent.get(i) ?? i) === i ? i : find(parent.get(i));
  for (const l of activeLinks) for (const i of l.indices.slice(1)) parent.set(find(i), find(l.indices[0]));
  const comps = new Map();
  for (const l of activeLinks) for (const i of l.indices) {
    const r = find(i);
    (comps.get(r) ?? comps.set(r, new Set()).get(r)).add(i);
  }
  const autoPairs = new Set([...comps.values()].flatMap((c) => pairsOf([...c])));
  const hit = (set) => [...set].filter((p) => truthPairs.has(p)).length;
  const sameJobTruth = [...truthPairs.values()].filter((k) => k === "same_job").length;
  const causeTruth = truthPairs.size - sameJobTruth;
  const coveredByKind = (kind) => [...truthPairs].filter(([p, k]) => k === kind && anyPairs.has(p)).length;
  const wrongAuto = [...autoPairs].filter((p) => !truthPairs.has(p));
  const dropped = linkCalls.flatMap((c) => c.dropped ?? []);
  const downgraded = links.filter((l) => l.downgraded).length;

  let extraction = null;
  if (labels) {
    const scored = items.filter((i) => i.record);
    const catOk = scored.filter((i) => i.record.category === labels[i.index].category || (labels[i.index].category !== "real" && i.record.category !== "real")).length;
    const urgLabeled = scored.filter((i) => labels[i.index].urgency);
    const urgOk = urgLabeled.filter((i) => i.record.urgency === labels[i.index].urgency).length;
    extraction = {
      scored: scored.length,
      category_agreement: `${catOk}/${scored.length}`,
      urgency_agreement_on_labeled: `${urgOk}/${urgLabeled.length}`,
      note: "Labels come from the generator's templates (scripts/gen-freeze.mjs), not from a human; urgency is labeled only where the template is unambiguous.",
    };
  }

  const plan = lib.buildPlan(results.filter(Boolean), links, {}, { trucks: Number(arg("trucks", "8")), stopsPerTruck: Number(arg("stops", "5")) });
  const summary = {
    set,
    messages: texts.length,
    true_link_pairs: truthPairs.size,
    true_groups: truth.length,
    links_found: links.length,
    pairs_suggested: anyPairs.size,
    pairs_suggested_correct: hit(anyPairs),
    recall_any_link: `${hit(anyPairs)}/${truthPairs.size}`,
    recall_same_job: `${coveredByKind("same_job")}/${sameJobTruth}`,
    recall_shared_cause: `${coveredByKind("shared_cause")}/${causeTruth}`,
    precision_any_link: `${hit(anyPairs)}/${anyPairs.size}`,
    auto_merged_pairs: autoPairs.size,
    auto_merged_correct: hit(autoPairs),
    wrong_auto_merges: wrongAuto.length,
    wrong_auto_merge_examples: wrongAuto.slice(0, 5).map((p) => p.split("-").map((n) => `#${Number(n) + 1}`).join(" + ")),
    likely_downgraded_by_code: downgraded,
    member_quotes_dropped_by_code: dropped.length,
    link_calls: blocks.length,
    link_calls_failed: linkFailed.length,
    extraction_failures: failed.length,
    extraction,
    plan_at_capacity: { trucks: plan.lanes.trucks.length, made_safe: plan.lanes.made_safe.length, not_today: plan.lanes.not_today.length, read_first: plan.lanes.read_first.length, filtered: plan.filtered.length, merged_links: plan.merged, open_questions: plan.pending },
    wall_clock_seconds: { per_message_pass: Math.round(extractMs / 1000), cross_message_pass: Math.round(linkMs / 1000), concurrency },
    spend_usd: Number(spend.total.toFixed(6)),
    per_message_pass_reused_from: reuse || null,
    spend_detail: spend.summary(),
  };
  console.log(JSON.stringify(summary, null, 2));

  const date = new Date().toISOString().slice(0, 10);
  const recordedAt = new Date().toISOString();
  const linkTrace = linkCalls.map((c) => ({
    block: c.block, ts: recordedAt, mode: "ember", model: c.model ?? null, prompt_hash: c.promptHash ?? null, request_variant: c.requestVariant ?? null,
    finish_reason: c.finishReason ?? null, latency_ms: c.latency_ms ?? null, tokens_in: c.usage?.tokens_in ?? 0, tokens_out: c.usage?.tokens_out ?? 0,
    cost_usd: c.usage ? costFromUsage(c.usage) : null, estimated: false, messages: c.messages, links: c.links ?? [], dropped: c.dropped ?? [], ...(c.error ? { note: c.error } : {}),
  }));
  writeFileSync(join(REPO, "evals", `results-dispatch-${set}-${date}.json`), JSON.stringify({ recorded_at: recordedAt, summary, links }, null, 2) + "\n");
  writeFileSync(join(REPO, "traces", `ember-dispatch-${set}-${date}.json`), JSON.stringify({
    recorded_at: recordedAt, app: "lead-triage", label: `dispatch-${set}`, fictional_data_only: true, contains_customer_data: false,
    extract_prompt_hash: results.find(Boolean)?.prompt_hash ?? null,
    link_system_prompt: lib.linkSystemPrompt(config),
    link_prompt_hash: linkCalls.find((c) => c.promptHash)?.promptHash ?? null,
    totals: { extract_calls: items.length, link_calls: linkCalls.length, spend_usd: summary.spend_usd },
    extract_calls: items.map((i) => ({ call: i.index + 1, model: i.model ?? null, request_variant: i.requestVariant ?? null, finish_reason: i.finishReason ?? null, latency_ms: i.latency_ms ?? null, attempts: i.attempts ?? null, tokens_in: i.usage?.tokens_in ?? 0, tokens_out: i.usage?.tokens_out ?? 0, cost_usd: i.usage?.cost_usd ?? null, error: i.error ?? null })),
    link_calls: linkTrace,
  }, null, 2) + "\n");
  if (set === "freeze1000") {
    writeFileSync(join(REPO, "src/lib/replay-freeze.json"), JSON.stringify({
      label: "freeze1000",
      recorded_at: recordedAt,
      model: results.find(Boolean)?.model ?? null,
      capacity: { trucks: Number(arg("trucks", "8")), stopsPerTruck: Number(arg("stops", "5")) },
      results: results.filter(Boolean),
      links,
      link_calls: linkTrace,
      summary,
    }) + "\n");
  }
  console.log(`SPEND: ${spend.summary()}`);
} finally {
  cleanup();
}
