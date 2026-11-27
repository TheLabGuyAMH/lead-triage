// Re-scores the recorded Freeze Day without re-running it:
// - re-reads listed messages through the live gated /api/extract
//   (--patch=230,... 1-based; one Ember call each) when a code fix
//   changed how a stored record would be normalized;
// - re-applies today's anchor rule to the stored links (downgrade only);
// - scores the no-model rules (same-phone + practice-mode keyword links)
//   on the same records, so Ember's share is measured, not assumed.
// Writes src/lib/replay-freeze.json and the final results file.
//
// Run: node scripts/rescore-freeze.mjs --base=https://lead-triage-nine.vercel.app [--patch=230] [--budget=0.01]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, Spend, costFromUsage, endpointExtract, loadEnvFile, loadLib, scoreLinks } from "./_harness.mjs";

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || d;
const base = arg("base", "").replace(/\/$/, "");
const patch = arg("patch", "").split(",").filter(Boolean).map((n) => Number(n) - 1);
const spend = new Spend(Number(arg("budget", "0.01")));
loadEnvFile();

const { lib, cleanup } = await loadLib();
try {
  // --set=hard re-scores the hard-links replay instead.
  const hard = arg("set", "freeze") === "hard";
  const replayPath = join(REPO, hard ? "src/lib/replay-hard.json" : "src/lib/replay-freeze.json");
  const resultsPath = join(REPO, hard ? "evals/results-dispatch-hard23-2026-11-27.json" : "evals/results-dispatch-freeze1000-2026-11-27.json");
  const replay = JSON.parse(readFileSync(replayPath, "utf8"));
  const rows = hard
    ? lib.HARD_LEADS.map((text) => ({ text, group: null }))
    : readFileSync(join(REPO, "evals/freeze-day.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const groups = new Map();
  rows.forEach((r, i) => {
    if (!r.group) return;
    const g = groups.get(r.group) ?? { kind: r.kind, members: [] };
    g.members.push(i);
    groups.set(r.group, g);
  });
  const truth = hard ? lib.HARD_GROUPS.map((g) => ({ kind: g.kind, members: g.members })) : [...groups.values()].filter((g) => g.members.length >= 2);

  const patched = [];
  for (const i of patch) {
    if (!base || !process.env.EMBER_DEMO_KEY) throw new Error("--base and EMBER_DEMO_KEY are needed to re-read a message");
    if (!spend.canAffordNext()) throw new Error("budget guard");
    const pos = replay.results.findIndex((r) => r.index === i);
    const r = await endpointExtract(`${base}/api/extract`, process.env.EMBER_DEMO_KEY, rows[i].text, lib.SAMPLE_CONFIG);
    spend.add(costFromUsage(r.usage));
    if (r.error) throw new Error(`re-read #${i + 1} failed: ${r.error}`);
    const before = replay.results[pos].record;
    replay.results[pos] = { ...replay.results[pos], record: r.record, usage: r.usage, model: r.model, prompt_hash: r.promptHash, output_mode: r.outputMode, request_variant: r.requestVariant, finish_reason: r.finishReason ?? null, latency_ms: r.latency_ms ?? null };
    patched.push({ message: i + 1, before: { urgency: before.urgency, safety_script: before.safety_script ?? null }, after: { urgency: r.record.urgency, safety_script: r.record.safety_script ?? null }, cost_usd: costFromUsage(r.usage) });
    console.log(`re-read #${i + 1}: ${before.urgency}/${before.safety_script} -> ${r.record.urgency}/${r.record.safety_script}`);
  }

  const real = replay.results.filter((r) => r.record.category === "real").map(lib.toDispatchLead);
  // Same-phone links are re-derived (today's rule asks when one phone gives two addresses); the rest are re-checked.
  const fresh = lib.codeLinks(real);
  const kept = lib.recheckAnchors(replay.links.filter((l) => l.source !== "code"), real);
  const links = lib.mergeLinks([fresh, kept]);
  const before = new Map(replay.links.map((l) => [l.key, l.confidence]));
  const downgradedNow = links.filter((l) => before.get(l.key) === "likely" && l.confidence === "possible").length;
  const baseline = lib.mergeLinks([lib.codeLinks(real), lib.mockLinks(real)]);
  const final = scoreLinks(lib, links, truth);
  const noModel = scoreLinks(lib, baseline, truth);
  const plan = lib.buildPlan(replay.results, links, {}, replay.capacity);

  const prev = JSON.parse(readFileSync(resultsPath, "utf8"));
  const summary = {
    ...prev.summary,
    ...final,
    plan_at_capacity: { trucks: plan.lanes.trucks.length, made_safe: plan.lanes.made_safe.length, not_today: plan.lanes.not_today.length, read_first: plan.lanes.read_first.length, filtered: plan.filtered.length, merged_links: plan.merged, open_questions: plan.pending },
    no_model_rules: {
      what: "codeLinks (same phone) + mockLinks (same house number + street; same street with neighbors/whole-street wording) on the same 1,000 Ember-read records, $0",
      ...noModel,
    },
    rescore: {
      at: new Date().toISOString(),
      why: "Fable review 2026-11-27: a phone's last digits passed for a house number, a shared full name counted as an anchor, and hazard detection read the model's urgency_reason (message #230 got the electrical script from a negated sentence).",
      anchor_rule: "same phone, or same house number + street (phones removed first)",
      stored_likely_links_downgraded: downgradedNow,
      // Earlier re-reads stay on record when a later rescore re-reads nothing.
      re_read_messages: patched.length ? patched : prev.summary.rescore?.re_read_messages ?? [],
      spend_usd: Number(spend.total.toFixed(6)),
    },
  };
  replay.links = links;
  replay.summary = summary;
  writeFileSync(replayPath, JSON.stringify(replay) + "\n");
  writeFileSync(resultsPath, JSON.stringify({ ...prev, summary, links }, null, 2) + "\n");
  console.log(JSON.stringify({ final, no_model_rules: noModel, downgradedNow, patched, plan: summary.plan_at_capacity }, null, 2));
  console.log(`SPEND: ${spend.summary()}`);
} finally {
  cleanup();
}
