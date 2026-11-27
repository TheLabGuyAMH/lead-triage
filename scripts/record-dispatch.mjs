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
import { REPO, Spend, costFromUsage, endpointDispatch, endpointExtract, endpointInvestigate, loadEnvFile, loadLib, pooled, scoreLinks } from "./_harness.mjs";

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
  } else if (set === "hard23") {
    texts = lib.HARD_LEADS;
    truth = lib.HARD_GROUPS.map((g) => ({ kind: g.kind, members: g.members }));
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
  // --reuse-links: take the block pass from the --reuse file (its links and link calls) and run only the investigator.
  const reuseLinks = reuse && arg("reuse-links", "") === "1" ? JSON.parse(readFileSync(reuse, "utf8")) : null;
  const blocks = reuseLinks ? [] : lib.planBlocks(real);
  const t1 = Date.now();
  const linkCalls = reuseLinks ? (reuseLinks.link_calls ?? []).filter((c) => c.kind !== "investigate").map((c) => ({ ...c, promptHash: c.prompt_hash, requestVariant: c.request_variant, finishReason: c.finish_reason, usage: { tokens_in: c.tokens_in, tokens_out: c.tokens_out, cost_usd: c.cost_usd } })) : await pooled(blocks, Math.min(concurrency, 4), async (block, b) => {
    if (!spend.canAffordNext()) return { block: b, error: "budget guard: not sent", links: [], dropped: [], usage: null, messages: block.length };
    const r = await endpointDispatch(`${base}/api/dispatch`, demoKey, block, config);
    spend.add(costFromUsage(r.usage));
    if (r.failedUsage) spend.add(costFromUsage(r.failedUsage) ?? RETRY_COST);
    return { block: b, messages: block.length, ...r };
  });
  const linkMs = Date.now() - t1;
  const linkFailed = linkCalls.filter((c) => c.error);
  const blockLinks = reuseLinks ? reuseLinks.links.filter((l) => !l.investigation) : lib.mergeLinks([lib.codeLinks(real), ...linkCalls.map((c) => c.links)]);
  // ---- 2b. investigator: bounded Ember tool loop on orphan follow-ups ----
  const orphans = lib.pickOrphans(real, blockLinks, Number(arg("investigate", "12")));
  const t2 = Date.now();
  const invCalls = await pooled(orphans, 3, async (o, n) => {
    if (!spend.canAffordNext()) return { target: o.index, error: "budget guard: not sent", links: [], steps: [], turns: 0, usage: null };
    const r = await endpointInvestigate(`${base}/api/investigate`, demoKey, o, real, config);
    spend.add(costFromUsage(r.usage));
    return { target: o.index, ...r };
  });
  const invMs = Date.now() - t2;
  const links = lib.mergeLinks([blockLinks, ...invCalls.map((c) => c.links)]);
  console.log(`investigator: ${orphans.length} orphan(s), ${invCalls.filter((c) => c.error).length} failed, ${invCalls.reduce((a, c) => a + c.links.length, 0)} link(s), turns ${invCalls.map((c) => c.turns).join(",")} in ${(invMs / 1000).toFixed(0)}s · ${spend.summary()}`);
  for (const c of invCalls.filter((c) => c.error).slice(0, 3)) console.log(`  investigator failure #${c.target + 1}: ${c.error}`);
  console.log(`cross-message pass: ${blocks.length} block(s), ${linkFailed.length} failed, ${links.length} links in ${(linkMs / 1000).toFixed(0)}s · ${spend.summary()}`);
  if (linkFailed.length) console.log(`  failures: ${linkFailed.slice(0, 5).map((f) => `block ${f.block + 1} ${f.error}`).join(" | ")}`);

  // ---- 3. score ----
  const sc = scoreLinks(lib, links, truth);
  const scBlocks = scoreLinks(lib, blockLinks, truth);
  // The same records through the no-model rules, for comparison ($0).
  const noModel = scoreLinks(lib, lib.mergeLinks([lib.codeLinks(real), lib.mockLinks(real)]), truth);
  const dropped = linkCalls.flatMap((c) => c.dropped ?? []);
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
    ...sc,
    no_model_rules: { what: "same phone + practice-mode keyword links on the same records, $0", recall: noModel.recall_any_link, precision: noModel.precision_any_link, wrong_auto_merges: noModel.wrong_auto_merges },
    before_investigator: { recall: scBlocks.recall_any_link, precision: scBlocks.precision_any_link },
    investigator: {
      orphans: orphans.length,
      failed: invCalls.filter((c) => c.error).length,
      links_kept: invCalls.reduce((a, c) => a + c.links.length, 0),
      outcomes: invCalls.map((c) => c.outcome ?? "error"),
      turns: invCalls.map((c) => c.turns ?? 0),
      quotes_dropped_by_code: invCalls.reduce((a, c) => a + (c.dropped?.length ?? 0), 0),
      wall_clock_seconds: Math.round(invMs / 1000),
    },
    member_quotes_dropped_by_code: dropped.length,
    link_calls: reuseLinks ? linkCalls.length : blocks.length,
    block_pass_reused: Boolean(reuseLinks),
    link_calls_failed: linkFailed.length,
    extraction_failures: failed.length,
    extraction,
    plan_at_capacity: { trucks: plan.lanes.trucks.length, made_safe: plan.lanes.made_safe.length, not_today: plan.lanes.not_today.length, read_first: plan.lanes.read_first.length, filtered: plan.filtered.length, merged_links: plan.merged, open_questions: plan.pending },
    wall_clock_seconds: { per_message_pass: Math.round(extractMs / 1000), cross_message_pass: Math.round(linkMs / 1000), concurrency },
    spend_usd: Number(spend.total.toFixed(6)),
    per_message_pass_reused_from: reuse ? reuse.split("/").pop() : null,
    spend_detail: spend.summary(),
  };
  console.log(JSON.stringify(summary, null, 2));

  const date = new Date().toISOString().slice(0, 10);
  const recordedAt = new Date().toISOString();
  const invTrace = invCalls.map((c, n) => ({
    block: linkCalls.length + n, ts: recordedAt, mode: "ember", kind: "investigate", model: c.model ?? null, prompt_hash: c.prompt_hash ?? null,
    request_variant: c.request_variant ?? null, finish_reason: null, latency_ms: c.latency_ms ?? null, tokens_in: c.usage?.tokens_in ?? 0, tokens_out: c.usage?.tokens_out ?? 0,
    cost_usd: c.usage ? costFromUsage(c.usage) : null, estimated: false, messages: 1, links: c.links ?? [], dropped: c.dropped ?? [], turns: c.turns ?? 0, outcome: c.outcome ?? "error",
    steps: c.steps ?? [], target: c.target, ...(c.error ? { note: c.error } : {}),
  }));
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
    link_calls: [...linkTrace, ...invTrace],
  }, null, 2) + "\n");
  if (set === "freeze1000" || set === "hard23") {
    writeFileSync(join(REPO, set === "freeze1000" ? "src/lib/replay-freeze.json" : "src/lib/replay-hard.json"), JSON.stringify({
      label: set,
      recorded_at: recordedAt,
      model: results.find(Boolean)?.model ?? null,
      capacity: { trucks: Number(arg("trucks", "8")), stopsPerTruck: Number(arg("stops", "5")) },
      results: results.filter(Boolean),
      links,
      link_calls: [...linkTrace, ...invTrace],
      summary,
    }) + "\n");
  }
  console.log(`SPEND: ${spend.summary()}`);
} finally {
  cleanup();
}
