// Ground-truth verification for the mock adapter + ranking + /api/extract
// core, against the fixed sample lead set (sample-lead-set.md).
// Run: npm run verify   (after npm install)
//
// The honesty checks matter most: lead 6 has NO phone number in its text
// and must come back null; spam leads must come back with no name/phone.

import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "lead-triage-verify-"));

async function main() {
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `
  export { mockExtract, MOCK_REVIEW_NOTE } from ${JSON.stringify(join(process.cwd(), "src/lib/mock.ts"))};
  export { rankLeads, rankResults, splitBatch } from ${JSON.stringify(join(process.cwd(), "src/lib/ranking.ts"))};
  export { SAMPLE_LEADS, SAMPLE_PASTE, SAMPLE_CONFIG } from ${JSON.stringify(join(process.cwd(), "src/lib/sample.ts"))};
  export { handleExtract, cleanConfigField } from ${JSON.stringify(join(process.cwd(), "api/_lib/extract-core.ts"))};
  export { normalizeRecord, phoneIsGrounded, buildVariants, sanitizeDraft } from ${JSON.stringify(join(process.cwd(), "api/_lib/ember.ts"))};
  export { SAFETY_SCRIPTS, detectHazard } from ${JSON.stringify(join(process.cwd(), "src/lib/safety.ts"))};
  export { buildTraceExport } from ${JSON.stringify(join(process.cwd(), "src/lib/trace-export.ts"))};
  export { failureResult, ExtractionError } from ${JSON.stringify(join(process.cwd(), "src/lib/api-adapter.ts"))};
  `,
  );
  const out = join(dir, "bundle.mjs");
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  const lib = await import(pathToFileURL(out).href);
  const { mockExtract, MOCK_REVIEW_NOTE, rankLeads, rankResults, splitBatch, SAMPLE_LEADS, SAMPLE_PASTE, SAMPLE_CONFIG, handleExtract, cleanConfigField, normalizeRecord, phoneIsGrounded, buildVariants, sanitizeDraft, SAFETY_SCRIPTS, detectHazard, buildTraceExport, failureResult, ExtractionError } = lib;

  let failures = 0;
  function check(label, cond, detail = "") {
    if (cond) {
      console.log(`  ok  ${label}`);
    } else {
      failures++;
      console.log(`FAIL  ${label}${detail ? " — " + detail : ""}`);
    }
  }

  // index is 1-based, matching sample-lead-set.md numbering
  const EXPECTED = [
    null,
    { category: "real", urgency: "emergency", language: "en", phone: "(361) 555-0147", name: "Maria Delgado", area: "Saratoga near Everhart" },
    { category: "real", urgency: "emergency", language: "en", phone: "(361) 555-0193", name: "James Okafor", area: "Calallen" },
    { category: "real", urgency: "same-day", language: "es", phone: "(361) 555-0118", name: "Carmen Ruiz", spanishFollowup: true },
    { category: "real", urgency: "same-day", language: "en", phone: "(361) 555-0172", nameStarts: "Derek", area: "Flour Bluff" },
    { category: "real", urgency: "same-day", language: "es", phone: "(361) 555-0129", name: "Luis Herrera", spanishFollowup: true },
    { category: "real", urgency: "routine", language: "en", phone: null, name: "Sarah", area: "Annaville" },
    { category: "real", urgency: "routine", language: "en", phone: "(361) 555-0155", name: "Tom Becker", area: "Padre Island" },
    { category: "real", urgency: "routine", language: "en", phone: "(361) 555-0134", name: "Priya", area: "Bay Area" },
    { category: "real", urgency: "routine", language: "en", phone: "(361) 555-0161", name: "Robert Nguyen", area: "Downtown" },
    { category: "real", urgency: "routine", language: "en", phone: "(361) 555-0188", name: "Angela Torres", area: "near Del Mar College" },
    { category: "spam", phone: null, name: null },
    { category: "spam|not-a-lead", phone: null, name: null },
  ];

  console.log("Per-lead extraction (mock adapter):");
  const records = SAMPLE_LEADS.map((raw) => mockExtract(raw, SAMPLE_CONFIG).record);
  records.forEach((rec, i) => {
    const n = i + 1;
    const exp = EXPECTED[n];
    const cats = exp.category.split("|");
    check(`lead ${n} category`, cats.includes(rec.category), `got ${rec.category}`);
    if (exp.urgency) check(`lead ${n} urgency`, rec.urgency === exp.urgency, `got ${rec.urgency}`);
    if (exp.language) check(`lead ${n} language`, rec.language === exp.language, `got ${rec.language}`);
    check(`lead ${n} phone`, rec.phone === exp.phone, `got ${rec.phone}, want ${exp.phone}`);
    if (exp.name) check(`lead ${n} name`, rec.name === exp.name, `got ${rec.name}`);
    if (exp.nameStarts) check(`lead ${n} name`, (rec.name ?? "").startsWith(exp.nameStarts), `got ${rec.name}`);
    if (exp.name === null) check(`lead ${n} name null`, rec.name === null, `got ${rec.name}`);
    if (exp.area) check(`lead ${n} area`, rec.area === exp.area, `got ${rec.area}`);
    if (exp.spanishFollowup) {
      check(`lead ${n} follow-up in Spanish`, /^Hola /.test(rec.followup_draft) && /llamaremos|Le escribo/.test(rec.followup_draft), rec.followup_draft);
      check(`lead ${n} owner summary in English`, !/^Hola/.test(rec.owner_summary) && rec.owner_summary.length > 0, rec.owner_summary);
    }
    if (exp.category === "real") check(`lead ${n} has follow-up draft`, rec.followup_draft.length > 10);
    check(`lead ${n} needs_review null (mock)`, rec.needs_review === null);
  });

  console.log("Batch splitting:");
  const split = splitBatch(SAMPLE_PASTE);
  check("sample paste splits into 12", split.length === 12, `got ${split.length}`);

  console.log("Ranking (input fed in reverse, output must re-tier):");
  const reversed = [...records].reverse();
  const ranked = rankLeads(reversed);
  const idOf = (rec) => SAMPLE_LEADS.indexOf(rec.raw_text) + 1;
  const tiers = [
    ranked.slice(0, 2).map(idOf).sort((a, b) => a - b),
    ranked.slice(2, 5).map(idOf).sort((a, b) => a - b),
    ranked.slice(5, 10).map(idOf).sort((a, b) => a - b),
    ranked.slice(10).map(idOf).sort((a, b) => a - b),
  ];
  check("emergencies first {1,2}", JSON.stringify(tiers[0]) === "[1,2]", JSON.stringify(tiers[0]));
  check("same-day next {3,4,5}", JSON.stringify(tiers[1]) === "[3,4,5]", JSON.stringify(tiers[1]));
  check("routine next {6,7,8,9,10}", JSON.stringify(tiers[2]) === "[6,7,8,9,10]", JSON.stringify(tiers[2]));
  check("spam last {11,12}", JSON.stringify(tiers[3]) === "[11,12]", JSON.stringify(tiers[3]));

  console.log("/api/extract core:");
  const mockRes = await handleExtract({ raw_text: SAMPLE_LEADS[0], config: SAMPLE_CONFIG, mode: "mock" });
  check("mock mode returns 200 + record", mockRes.status === 200 && mockRes.json.record?.name === "Maria Delgado");
  const noKeyRes = await handleExtract(
    { raw_text: SAMPLE_LEADS[5], config: SAMPLE_CONFIG, mode: "ember" },
    { demoKey: null },
    { apiKey: null, model: "muse-ember-1.0", base: "https://api.meta.ai/v1", inputRatePerMTok: null, outputRatePerMTok: null },
  );
  check("ember without key falls back to mock WITH note", noKeyRes.status === 200 && noKeyRes.json.mode === "mock" && typeof noKeyRes.json.note === "string");
  check("fallback keeps lead 6 phone null", noKeyRes.json.record?.phone === null, `got ${noKeyRes.json.record?.phone}`);
  const emptyRes = await handleExtract({ raw_text: "  ", mode: "mock" });
  check("empty raw_text is a 400", emptyRes.status === 400);

  console.log("Splitter (--- splits only where it appears; blank lines always split):");
  check("blank-line split works without ---", splitBatch("one lead\n\ntwo lead").length === 2);
  check("--- separates adjacent lines with no blank line", splitBatch("one line lead\n---\nsecond line lead").length === 2);
  const mixed = splitBatch("first lead\n\nsecond lead\n---\nthird lead\n\nfourth lead");
  check("--- does not disable blank-line splitting elsewhere", mixed.length === 4, `got ${mixed.length}: ${JSON.stringify(mixed)}`);

  console.log("Fail-closed normalization + phone grounding:");
  const bad = normalizeRecord(
    { urgency: "whenever", category: "maybe", language: "en", phone: "361-555-9999", name: "X" },
    "call me maybe, no digits in this message at all",
  );
  check("unknown urgency -> emergency + needs_review", bad.urgency === "emergency" && bad.needs_review !== null, bad.needs_review);
  check("unknown category -> real (visible, not spam fold)", bad.category === "real");
  check("invented phone -> null", bad.phone === null, `got ${bad.phone}`);
  check("grounded phone kept", phoneIsGrounded("(361) 555-0147", SAMPLE_LEADS[0]));
  check("+1-prefixed phone grounded against 10-digit source", phoneIsGrounded("1-361-555-0147", SAMPLE_LEADS[0]));
  check("spelled-out phone fails grounding (documented gap)", !phoneIsGrounded("361-555-0229", "my number is three six one five five five zero two two nine"));
  const good = normalizeRecord(
    { urgency: "routine", category: "real", language: "en", phone: "361-555-0147" },
    SAMPLE_LEADS[0],
  );
  check("clean record -> needs_review null", good.needs_review === null && good.phone === "361-555-0147");

  console.log("Ranking: only critical needs_review floats above everything:");
  const fake = (needs_review, critical, urgency, index) => ({ index, record: { needs_review, needs_review_critical: critical, urgency, category: "real" } });
  const criticalFirst = rankResults([fake(null, false, "emergency", 0), fake("extraction failed", true, "routine", 1)]);
  check("critical needs_review sorts ahead of a clean emergency", criticalFirst[0].index === 1);
  const spelled = normalizeRecord(
    { urgency: "routine", category: "real", language: "en", phone: "361-555-0229", followup_draft: "Hi, thanks for reaching out." },
    "Bathroom exhaust fan quit, replace whenever. My number is three six one five five five zero two two nine. - Colleen",
  );
  check("word-spelled phone is a soft (non-critical) flag", spelled.needs_review !== null && spelled.needs_review_critical === false && spelled.phone === null, spelled.needs_review);
  const cleanEmergency = normalizeRecord(
    { urgency: "emergency", category: "real", language: "en", phone: "361-555-0147", followup_draft: "Hi, we will call shortly." },
    SAMPLE_LEADS[0],
  );
  const tierKept = rankResults([
    { index: 0, record: spelled },
    { index: 1, record: cleanEmergency },
  ]);
  check("routine with word-spelled phone ranks BELOW a clean emergency", tierKept[0].index === 1 && tierKept[1].index === 0);

  console.log("Endpoint lock (no network — gates answer first):");
  const bigRes = await handleExtract({ raw_text: "x".repeat(4001), mode: "mock" });
  check("over 4000 chars is a 413", bigRes.status === 413);
  process.env.EMBER_ENABLED = "1";
  process.env.EMBER_DEMO_KEY = "verify-key";
  const fakeEnv = { apiKey: "unused-because-gate-answers-first", model: "muse-ember-1.0", base: "https://invalid.example/v1", inputRatePerMTok: null, outputRatePerMTok: null };
  const wrongKey = await handleExtract({ raw_text: SAMPLE_LEADS[0], config: SAMPLE_CONFIG, mode: "ember" }, { demoKey: "wrong" }, fakeEnv);
  check("ember + wrong demo key -> 200 mock WITH note, no paid call", wrongKey.status === 200 && wrongKey.json.mode === "mock" && typeof wrongKey.json.note === "string");
  const noKeyGate = await handleExtract({ raw_text: SAMPLE_LEADS[0], config: SAMPLE_CONFIG, mode: "ember" }, { demoKey: null }, fakeEnv);
  check("ember + no demo key -> 200 mock WITH note", noKeyGate.status === 200 && noKeyGate.json.mode === "mock");
  delete process.env.EMBER_ENABLED;
  const offRes = await handleExtract({ raw_text: SAMPLE_LEADS[0], config: SAMPLE_CONFIG, mode: "ember" }, { demoKey: "verify-key" }, fakeEnv);
  check("EMBER_ENABLED unset (kill switch) -> mock even with the right key", offRes.status === 200 && offRes.json.mode === "mock");
  delete process.env.EMBER_DEMO_KEY;

  console.log("Hazard safety scripts replace model drafts (item 1):");
  const gasModel = normalizeRecord(
    { urgency: "routine", category: "real", language: "en", phone: "361-555-0201", service_needed: "gas smell", urgency_reason: "unhurried", followup_draft: "Hi, we'll reach out shortly. Maybe ventilate the kitchen." },
    "smell gas bad in kitchen since this morning getting headache, 361-555-0201, this is Dana",
  );
  check("gas lead forced to emergency", gasModel.urgency === "emergency");
  check("gas lead gets badge field safety_script=gas", gasModel.safety_script === "gas");
  check("gas draft is exactly the EN safety script", gasModel.followup_draft === SAFETY_SCRIPTS.gas.en, gasModel.followup_draft);
  const gasEs = normalizeRecord(
    { urgency: "same-day", category: "real", language: "es", followup_draft: "Hola, le llamaremos pronto." },
    "Hola, huele mucho a gas en la cocina desde hoy, mi número es 361-555-0301",
  );
  check("Spanish gas lead gets the ES safety script", gasEs.safety_script === "gas" && gasEs.followup_draft === SAFETY_SCRIPTS.gas.es);
  const coModel = normalizeRecord(
    { urgency: "routine", category: "real", language: "en", service_needed: "carbon monoxide alarm beeping", followup_draft: "Hi, we will be in touch." },
    "the alarm upstairs keeps beeping since last night, call me at 361-555-0302",
  );
  check("CO detected from model service_needed", coModel.safety_script === "co" && coModel.urgency === "emergency" && coModel.followup_draft === SAFETY_SCRIPTS.co.en);
  const elecModel = normalizeRecord(
    { urgency: "same-day", category: "spam", language: "en", followup_draft: "promo text" },
    "breaker panel is sparking and buzzing, burning smell in laundry room, need electrician urgent 361-555-0205",
  );
  check("electrical hazard script + forced visible (real)", elecModel.safety_script === "electrical" && elecModel.category === "real" && elecModel.followup_draft === SAFETY_SCRIPTS.electrical.en);
  check("routine smoke-detector install is not a hazard", detectHazard(["quote to install smoke detectors and a fireplace insert next month"]) === null);
  const mockGas = mockExtract("smell gas in the kitchen, call me 361-555-0201 please", SAMPLE_CONFIG).record;
  check("mock gas lead: emergency + safety script + badge field", mockGas.urgency === "emergency" && mockGas.safety_script === "gas" && mockGas.followup_draft === SAFETY_SCRIPTS.gas.en, `${mockGas.urgency}/${mockGas.safety_script}: ${mockGas.followup_draft}`);
  const mockNew = mockExtract("need a quote to move a sink next month, no rush, 361-555-0310", SAMPLE_CONFIG).record;
  check("mock on unseen text is flagged as heuristics", mockNew.needs_review === MOCK_REVIEW_NOTE, String(mockNew.needs_review));
  check("mock unseen greeting uses Hi there (no name)", mockNew.followup_draft.startsWith("Hi there,"), mockNew.followup_draft);

  console.log("Negotiation ladder: every rung capped, effort kept (item 3):");
  const ladder = buildVariants({ outputMode: "structured", maxTokensParam: null, reasoningEffort: "low", maxTokens: 3000 });
  check("explicit null cap becomes the default capped name", ladder[0].maxTokensParam === "max_completion_tokens");
  check("no uncapped rung exists", ladder.every((v) => v.maxTokensParam === "max_completion_tokens" || v.maxTokensParam === "max_tokens"), JSON.stringify(ladder));
  check("effort kept through cap/mode rungs, dropped only last", ladder[1].reasoningEffort === "low" && ladder[2].reasoningEffort === "low" && ladder[ladder.length - 1].reasoningEffort === null);
  check("explicit max_tokens is the first rung", buildVariants({ maxTokensParam: "max_tokens" })[0].maxTokensParam === "max_tokens");
  const truncated = normalizeRecord(
    { urgency: "routine", category: "real", language: "en", phone: "361-555-0147" },
    SAMPLE_LEADS[0],
    { finishReason: "length" },
  );
  check("finish_reason length flags output truncated (soft)", (truncated.needs_review ?? "").includes("output truncated") && truncated.needs_review_critical === false, String(truncated.needs_review));
  check("unknown enums are critical", bad.needs_review_critical === true);

  console.log("Failed-call cost is unknown, never $0 (item 4):");
  const clientFail = failureResult("any lead", 0, "ember", new Error("boom"));
  check("client failureResult cost_usd is null + critical", clientFail.usage.cost_usd === null && clientFail.record.needs_review_critical === true);
  const clientFailUsage = failureResult("any lead", 0, "ember", new ExtractionError("HTTP 502", { tokens_in: 10, tokens_out: 20, cost_usd: 0.000011, estimated: false }));
  check("client failureResult keeps server-reported usage", clientFailUsage.usage.cost_usd === 0.000011 && clientFailUsage.usage.tokens_out === 20);
  process.env.EMBER_ENABLED = "1";
  process.env.EMBER_DEMO_KEY = "verify-key";
  const deadEnv = { apiKey: "unused", model: "muse-ember-1.0", base: "http://127.0.0.1:1/v1", inputRatePerMTok: 0.1, outputRatePerMTok: 0.5 };
  const errRes = await handleExtract({ raw_text: SAMPLE_LEADS[6], config: SAMPLE_CONFIG, mode: "ember" }, { demoKey: "verify-key" }, deadEnv);
  check("server 502 carries usage with cost_usd null", errRes.status === 502 && errRes.json.usage && errRes.json.usage.cost_usd === null, JSON.stringify(errRes.json).slice(0, 160));
  delete process.env.EMBER_ENABLED;
  delete process.env.EMBER_DEMO_KEY;

  console.log("Draft safety in code (item 7):");
  const dirty = normalizeRecord(
    { urgency: "routine", category: "real", language: "en", followup_draft: "Hi! See http://cheap-deals.example.com or call 361-555-9999 for $200 off today." },
    "need an AC tune-up this month please, no phone in this message",
  );
  check("URL stripped from draft + flagged", !/https?:\/\//.test(dirty.followup_draft) && (dirty.needs_review ?? "").includes("URL"), dirty.followup_draft);
  check("unlisted phone stripped from draft + flagged, rest kept", !dirty.followup_draft.includes("555-9999") && dirty.followup_draft.includes("Hi!") && (dirty.needs_review ?? "").includes("phone"), dirty.followup_draft);
  const groundedDraft = normalizeRecord(
    { urgency: "routine", category: "real", language: "en", phone: "361-555-0147", followup_draft: "Hi, we will call you at 361-555-0147 shortly." },
    SAMPLE_LEADS[0],
  );
  check("grounded phone in draft is kept unflagged", groundedDraft.followup_draft.includes("361-555-0147") && groundedDraft.needs_review === null, groundedDraft.followup_draft);
  const notLead = normalizeRecord({ urgency: "routine", category: "not-a-lead", language: "en", followup_draft: "Hi there!" }, "hello?? anyone there");
  check("not-a-lead draft emptied in code", notLead.followup_draft === "");
  const spamRec = normalizeRecord({ urgency: "routine", category: "spam", language: "en", followup_draft: "Buy now!" }, "SEO free audit act now");
  check("spam draft emptied in code", spamRec.followup_draft === "");
  const cleanedCfg = cleanConfigField('A "quoted" name\u2028with\u0085\u2029seps', 80);
  check("config fields escape quotes + strip U+2028/U+0085", cleanedCfg.includes('\\"') && !cleanedCfg.includes("\u2028") && !cleanedCfg.includes("\u0085") && !cleanedCfg.includes("\u2029"), JSON.stringify(cleanedCfg));
  check("sanitizeDraft is direct-testable", sanitizeDraft("go to www.example.com now", "plain lead").problems.length === 1);

  console.log("Fix round 3: hazard false positives / negatives, email split, escapes:");
  const notHazard = [
    "my furnace won't fire up this morning, can someone come look this week 361-555-0401",
    "FIRE SALE!!! 50% off all water heaters this weekend only, click here",
    "city is doing a sewer smoke test on our street tomorrow, do I need to do anything?",
    "please install a CO detector and two smoke detectors next month, no rush",
    "quote to replace the spark plug on our generator",
    "need a carbon monoxide detector installed in the hallway",
  ];
  for (const t of notHazard) check(`not a hazard: ${t.slice(0, 40)}`, detectHazard([t]) === null, String(detectHazard([t])));
  const hazards = [
    ["breaker panel is sparking and buzzing, burning smell in laundry room", "electrical"],
    ["outlet in the bedroom is smoking and the wall is warm", "electrical"],
    ["the dryer caught fire, it's out now but there's smoke everywhere", "electrical"],
    ["el enchufe está echando chispas y huele a quemado", "electrical"],
    ["our CO alarm is going off in the basement", "co"],
    ["carbon monoxide detector keeps beeping and won't stop", "co"],
    ["my wife and I have been dizzy with headaches since the furnace came on yesterday", "co"],
    ["la alarma de monóxido de carbono está sonando", "co"],
    ["smell gas in the kitchen", "gas"],
  ];
  for (const [t, k] of hazards) check(`hazard ${k}: ${t.slice(0, 40)}`, detectHazard([t]) === k, String(detectHazard([t])));
  const mockElec = mockExtract("breaker panel is sparking, burning smell, 361-555-0205", SAMPLE_CONFIG).record;
  check("mock electrical lead gets the electrical script (not CO)", mockElec.safety_script === "electrical" && mockElec.followup_draft === SAFETY_SCRIPTS.electrical.en, `${mockElec.safety_script}`);
  const rawWins = normalizeRecord(
    { urgency: "emergency", category: "real", language: "en", urgency_reason: "possible gas or carbon monoxide or electrical fire" },
    "outlet behind the fridge is sparking, 361-555-0206",
  );
  check("raw-text hazard wins over a model reason naming several", rawWins.safety_script === "electrical", String(rawWins.safety_script));
  const fireUp = normalizeRecord(
    { urgency: "routine", category: "real", language: "en", service_needed: "furnace not firing up" },
    "furnace won't fire up, no rush, this week is fine 361-555-0207",
  );
  check("'won't fire up' via Ember path stays non-emergency", fireUp.safety_script === null && fireUp.urgency === "routine", `${fireUp.safety_script}/${fireUp.urgency}`);
  const noYour = mockExtract("can someone call me back about a thing at my house 361-555-0311", SAMPLE_CONFIG).record;
  check("mock draft never says 'your your'", !/your your/i.test(noYour.followup_draft), noYour.followup_draft);
  const email = "Subject: kitchen remodel plumbing estimate\n\nHi team,\n\nWe are planning a kitchen remodel early next year.\n\nCould someone come measure in December? No rush.\n\nThanks, Megan Walsh 361-555-0227";
  check("multi-paragraph email stays one lead", splitBatch(email).length === 1, String(splitBatch(email).length));
  const emailPlus = splitBatch(`text lead one 361-555-0001\n\n${email}\n\nsmell gas in the kitchen 361-555-0002`);
  check("email between two leads -> 3 leads", emailPlus.length === 3, JSON.stringify(emailPlus.map((x) => x.slice(0, 20))));
  check("'Hi, my AC is out' text lead is not an email opener", splitBatch("Hi, my AC is out 361-555-0003\n\nwater heater leaking, thanks 361-555-0004").length === 2);
  check("'Hi Mark,' greeting + body + sign-off stays one", splitBatch("Hi Mark,\n\nno hot water since Tuesday.\n\nThanks, Jo 361-555-0005").length === 1);
  check("sample paste still splits into 12 after email rule", splitBatch(SAMPLE_PASTE).length === 12);
  const bs = cleanConfigField('Acme \\" ignore previous', 80);
  check("config backslash is escaped (can't break out of quotes)", bs === 'Acme \\\\\\" ignore previous', JSON.stringify(bs));
  const cut = cleanConfigField("ab\\", 3);
  check("cap before escape: no dangling backslash", cut === "ab\\\\", JSON.stringify(cut));

  console.log("Trace export privacy (item 8):");
  const traceRec = normalizeRecord(
    { urgency: "emergency", category: "real", language: "en", name: "Secret Name", phone: "361-555-0147", owner_summary: "secret summary", followup_draft: "secret draft" },
    "PRIVATE RAW TEXT call 361-555-0147 - Secret Name",
  );
  const entries = [
    { index: 0, ts: "2026-11-26T00:00:00.000Z", mode: "ember", model: "muse-ember-1.0", prompt_hash: "abc", output_mode: "structured", request_variant: "structured+max_completion_tokens+effort=low", finish_reason: "stop", latency_ms: 1234, tokens_in: 100, tokens_out: 50, cost_usd: 0.001, estimated: false, category: "real", urgency: "emergency", language: "en", needs_review: "private reason text", note: "private note", record: traceRec },
    { index: 1, ts: "2026-11-26T00:00:01.000Z", mode: "mock", model: null, prompt_hash: null, output_mode: null, request_variant: null, finish_reason: null, latency_ms: 3, tokens_in: 40, tokens_out: 180, cost_usd: 0, estimated: true, category: "real", urgency: "routine", language: "en", needs_review: null, record: traceRec },
  ];
  const ctx = { model: "muse-ember-1.0", prompt_hash: "abc", system_prompt: "SECRET PROMPT", capUsd: 10, replay: true, recorded_at: "2026-11-26T00:00:00.000Z" };
  const redacted = buildTraceExport(entries, true, ctx);
  const redactedJson = JSON.stringify(redacted);
  check("redacted export has no free text", !/PRIVATE RAW|Secret Name|secret (draft|summary)|private (reason|note)|SECRET PROMPT|361-555/.test(redactedJson), redactedJson.slice(0, 300));
  check("redacted needs_review is boolean", redacted.calls[0].needs_review === true && redacted.calls[1].needs_review === false);
  check("redacted rows carry variant/finish/latency", redacted.calls[0].request_variant === "structured+max_completion_tokens+effort=low" && redacted.calls[0].finish_reason === "stop" && redacted.calls[0].latency_ms === 1234);
  check("export totals computed from exported rows", redacted.totals.tokens_in === 140 && redacted.totals.tokens_out === 230 && redacted.totals.cost_usd === 0.001, JSON.stringify(redacted.totals));
  check("replay export marked with original timestamps", redacted.replay === true && redacted.recorded_at === "2026-11-26T00:00:00.000Z" && redacted.calls[0].ts === "2026-11-26T00:00:00.000Z");
  const unredacted = buildTraceExport(entries, false, ctx);
  check("unredacted export sets contains_customer_data + full record", unredacted.contains_customer_data === true && unredacted.calls[0].record.raw_text.includes("PRIVATE RAW") && unredacted.calls[0].request_variant !== null);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  return failures === 0 ? 0 : 1;

}

let code = 1;
try {
  code = await main();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
