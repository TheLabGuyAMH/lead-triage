// Ground-truth verification for the mock adapter + ranking + /api/extract
// core, against the fixed sample lead set (sample-lead-set.md).
// Run: npm run verify   (after npm install)
//
// The honesty checks matter most: lead 6 has NO phone number in its text
// and must come back null; spam leads must come back with no name/phone.

import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "lead-triage-verify-"));
const entry = join(dir, "entry.ts");
writeFileSync(
  entry,
  `
export { mockExtract } from ${JSON.stringify(join(process.cwd(), "src/lib/mock.ts"))};
export { rankLeads, splitBatch } from ${JSON.stringify(join(process.cwd(), "src/lib/ranking.ts"))};
export { SAMPLE_LEADS, SAMPLE_PASTE, SAMPLE_CONFIG } from ${JSON.stringify(join(process.cwd(), "src/lib/sample.ts"))};
export { handleExtract } from ${JSON.stringify(join(process.cwd(), "api/_lib/extract-core.ts"))};
`,
);
const out = join(dir, "bundle.mjs");
await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
const lib = await import(pathToFileURL(out).href);
const { mockExtract, rankLeads, splitBatch, SAMPLE_LEADS, SAMPLE_PASTE, SAMPLE_CONFIG, handleExtract } = lib;

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
  { apiKey: null, model: "muse-ember-1.0", base: "https://api.meta.ai/v1", inputRatePerMTok: null, outputRatePerMTok: null },
);
check("ember without key falls back to mock WITH note", noKeyRes.status === 200 && noKeyRes.json.mode === "mock" && typeof noKeyRes.json.note === "string");
check("fallback keeps lead 6 phone null", noKeyRes.json.record?.phone === null, `got ${noKeyRes.json.record?.phone}`);
const emptyRes = await handleExtract({ raw_text: "  ", mode: "mock" });
check("empty raw_text is a 400", emptyRes.status === 400);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
