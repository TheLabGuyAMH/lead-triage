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
  export { mockExtract } from ${JSON.stringify(join(process.cwd(), "src/lib/mock.ts"))};
  export { rankLeads, rankResults, splitBatch } from ${JSON.stringify(join(process.cwd(), "src/lib/ranking.ts"))};
  export { SAMPLE_LEADS, SAMPLE_PASTE, SAMPLE_CONFIG } from ${JSON.stringify(join(process.cwd(), "src/lib/sample.ts"))};
  export { handleExtract } from ${JSON.stringify(join(process.cwd(), "api/_lib/extract-core.ts"))};
  export { normalizeRecord, phoneIsGrounded } from ${JSON.stringify(join(process.cwd(), "api/_lib/ember.ts"))};
  `,
  );
  const out = join(dir, "bundle.mjs");
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  const lib = await import(pathToFileURL(out).href);
  const { mockExtract, rankLeads, rankResults, splitBatch, SAMPLE_LEADS, SAMPLE_PASTE, SAMPLE_CONFIG, handleExtract, normalizeRecord, phoneIsGrounded } = lib;

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

  console.log("Splitter (--- separator):");
  const formLead = "Name: Test Person\n\nPhone: 361-555-0100\n\nMessage: sink leaking";
  const dashed = splitBatch(formLead + "\n---\nsecond lead here, call 361-555-0101");
  check("web form with blank lines stays one lead under ---", dashed.length === 2 && dashed[0].includes("Phone:"), `got ${dashed.length}`);
  check("blank-line split still works without ---", splitBatch("one lead\n\ntwo lead").length === 2);

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

  console.log("Ranking puts needs_review first:");
  const fake = (needs_review, urgency, index) => ({ index, record: { needs_review, urgency, category: "real" } });
  const reviewFirst = rankResults([fake(null, "emergency", 0), fake("check me", "routine", 1)]);
  check("needs_review sorts ahead of a clean emergency", reviewFirst[0].index === 1);

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
