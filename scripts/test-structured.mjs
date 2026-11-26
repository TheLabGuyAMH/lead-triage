// One-lead probe of Meta API behaviors the review marked VERIFY:
//   T1  response_format json_schema (strict, ["string","null"] types)
//   T2  record_lead tool path, same lead (token comparison)
//   T3  structured + max_completion_tokens (falls back to max_tokens on 400)
//   T4  structured + token cap + reasoning_effort:"low"
// Prints a JSON verdict per probe plus total spend from API usage.
// Run: node scripts/test-structured.mjs [--budget=0.30]

import { Spend, costOf, loadEnvFile, loadLib } from "./_harness.mjs";

const budget = Number((process.argv.find((a) => a.startsWith("--budget=")) ?? "--budget=0.30").split("=")[1]);
loadEnvFile();
const { lib, cleanup } = await loadLib();
const env = lib.emberEnvFromProcess();
const spend = new Spend(budget);
const lead = lib.SAMPLE_LEADS[0];
const config = lib.SAMPLE_CONFIG;
const verdicts = {};

async function probe(name, opts) {
  if (!spend.canAffordNext()) {
    verdicts[name] = { skipped: "budget guard" };
    return null;
  }
  const t0 = Date.now();
  try {
    const r = await lib.emberExtract(lead, config, env, opts);
    const cost = costOf(lib, env, r.usage);
    spend.add(cost);
    verdicts[name] = {
      ok: true,
      ms: Date.now() - t0,
      output_mode: r.outputMode,
      model: r.model,
      tokens_in: r.usage.tokens_in,
      tokens_out: r.usage.tokens_out,
      cost_usd: cost,
      record_checks: {
        name: r.record.name,
        phone: r.record.phone,
        urgency: r.record.urgency,
        category: r.record.category,
        language: r.record.language,
        needs_review: r.record.needs_review,
      },
    };
    return r;
  } catch (err) {
    verdicts[name] = { ok: false, error: String(err?.message ?? err).slice(0, 400) };
    return null;
  }
}

try {
  if (!env.apiKey) throw new Error("MODEL_API_KEY not loaded (pull env first, see _harness.mjs).");
  await probe("T1_structured_strict", { outputMode: "structured", maxTokensParam: null, reasoningEffort: null });
  await probe("T2_tool_auto", { outputMode: "tool", maxTokensParam: null, reasoningEffort: null });
  let capParam = "max_completion_tokens";
  const t3 = await probe("T3_structured_max_completion_tokens", {
    outputMode: "structured", maxTokensParam: "max_completion_tokens", maxTokens: 1500, reasoningEffort: null,
  });
  if (!t3) {
    capParam = "max_tokens";
    const t3b = await probe("T3b_structured_max_tokens", {
      outputMode: "structured", maxTokensParam: "max_tokens", maxTokens: 1500, reasoningEffort: null,
    });
    if (!t3b) capParam = null;
  }
  await probe("T4_reasoning_effort_low", {
    outputMode: "structured", maxTokensParam: capParam, maxTokens: 1500, reasoningEffort: "low",
  });
  verdicts._chosen_max_tokens_param = capParam;
  verdicts._spend = spend.summary();
  console.log(JSON.stringify(verdicts, null, 2));
} finally {
  cleanup();
}
