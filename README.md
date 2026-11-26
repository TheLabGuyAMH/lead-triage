# Lead Triage — Lead Intake Assistant for Local Service Businesses

Built for the **Meta Muse Ember Hackathon** (Cerebral Valley) by Anthony Hinojosa / **Alchemist Labs**. Live: https://lead-triage-nine.vercel.app

The owner of a 1–10 truck plumbing or HVAC shop pastes the day's pile of raw leads (voicemail transcripts, web form submissions, messages) and gets back a **ranked call-back queue**: every lead structured, emergencies first, spam folded away in plain sight, a follow-up draft ready in the customer's own language (English or Spanish), and Call / Text actions on every card. The owner reviews and sends everything; nothing is auto-sent.

## How it works

- **One page, two columns on desktop:** paste/config on the left, the call-back board on the right. Cost and trace data live in a collapsed "Cost & trace" section below the board — the first screen is the work, not a dashboard.
- **One extraction call per lead** through a single adapter boundary (`src/lib/schema.ts` defines the lead record, the `record_lead` schema, and the extraction prompt). Leads run through a 4-worker pool with per-lead error isolation: one failure becomes a flagged emergency card, never a dropped batch.
  - **Ember adapter** (`api/_lib/ember.ts`, server-side only): Muse Ember (`muse-ember-1.0`) on the Meta Model API. Primary path is **strict JSON-schema structured output** (`response_format`), proved live on 2026-11-26: request variant `structured+max_completion_tokens` answered 200 with a schema-valid record (see [traces/ember-live-smoke-2026-11-26.json](traces/ember-live-smoke-2026-11-26.json)). The `record_lead` tool path (`tool_choice: "auto"` — forced choice returns 400, verified live 2026-11-25) plus a plain-text JSON fallback remain as the negotiated fallbacks. Parameters the docs disagree on are settled by a 400-only negotiation ladder that stamps the accepted `request_variant` on every result; every rung keeps an output-token cap (the ladder may rename the cap parameter, never drop it), `reasoning_effort` survives every cap/mode change and is dropped only on the last rungs, and nothing is remembered across requests, so a downgrade can never stick.
  - **Mock adapter** (`src/lib/mock.ts`): deterministic heuristics, $0, works offline. A labeled fallback, never passed off as Ember.
  - **Replay:** the public board opens on a clearly labeled replay of a real Ember run of the 12-lead sample on the final prompt and settings (`src/lib/replay-data.ts`, recorded 2026-11-26 by `scripts/record-replay.mjs` through the gated production endpoint; trace in [traces/ember-sample12-replay-2026-11-26.json](traces/ember-sample12-replay-2026-11-26.json)), so viewing proof costs $0.
- **The model classifies; code orders.** Ember judges each lead's category and urgency; `src/lib/ranking.ts` sorts deterministically — critically untrusted records first (extraction failure, unknown urgency/category), then category, then urgency, then paste position; softer `needs_review` flags (phone grounding, draft content, truncation, mock heuristics) keep their urgency tier and show their banner there.
- **Fail-closed by construction:**
  - An unknown urgency becomes *emergency* and an unknown category *real*, both flagged `needs_review` — never silently sunk.
  - A phone number is trusted only when its digits literally appear in the lead (phone grounding); otherwise null and flagged. Known gap: numbers spelled out in words fail grounding and go to review, by design.
  - Missing API usage means cost *unknown* (null), never $0.
  - Lead text is wrapped in `<lead>…</lead>` and treated as data, not instructions; drafts may not contain URLs, prices, discounts, or unlisted phone numbers — enforced in code, which strips URLs and phones not grounded in the lead from any draft and flags the card, and empties drafts for spam and not-a-lead outright. A truncated call (`finish_reason: "length"`) is flagged too.
  - **Hazard leads never get a model-written reply.** Code detects gas / rotten-egg smell, carbon-monoxide alarms, and sparking / burning-smell / smoke / fire electrical hazards (English and Spanish, in the raw lead and the model's own fields), forces emergency, and replaces the draft with a fixed safety script in the lead's language (`src/lib/safety.ts`; exact wording in [docs/adr/README.md](docs/adr/README.md), pending Anthony's/professional approval). The card carries a "Safety script, not AI text" badge.
- **The paid path requires the demo key; there is no server-side cumulative spend ceiling, so keep the key private and disable Ember after recording.** `POST /api/extract` makes a paid call only when all three server gates pass: `EMBER_ENABLED=1` (kill switch), `MODEL_API_KEY` set, and the request's `x-demo-key` matching `EMBER_DEMO_KEY` (timing-safe compare). Everyone else gets a mock result with a visible note at $0. One lead over 4,000 characters is a 413; business name/trade are stripped of control characters and capped at 80 before reaching the prompt; upstream errors return a generic 502 with detail in server logs only; calls time out at 20 s with a 3,000-token output cap (raised from 1,500 after the truncation probe in Evaluation below). **The server enforces the limits; the browser's budget meter is advisory.** Switching Ember off for the public site = unset `EMBER_ENABLED` and redeploy.
- **Traces that prove claims.** Every Ember result carries the API-reported model, a SHA-256 of the prompt actually sent, the output mode, and the accepted request variant. Trace export is **redacted by default and contains only operational fields** (index, category, urgency, a boolean needs_review, tokens, cost, latency, request_variant, finish_reason, model, mode, timestamps — no customer text at all); the unredacted export with full records is opt-in behind a customer-data warning and sets `contains_customer_data: true`. Export totals are computed from the exported rows, the header pill and budget meter show session spend only (the replay's recorded cost stays in its own label), and a replay export is marked `replay: true` with its original recorded timestamps. Fictional traces are committed under [traces/](traces/); never commit a real one.

## Evaluation

Ground rules: the 40-lead held-out set ([evals/heldout.jsonl](evals/heldout.jsonl)) was written by the builder model, Muse, **before** any Ember output was seen for it; it is a synthetic benchmark of fictional leads, not field data. By the set's labels: — 9 emergencies, 11 same-day, 20 routine by expected urgency; 34 real, 4 spam, 2 not-a-lead by category; 5 Spanish/Spanglish; 3 prompt-injection attempts; with typos, word-spelled phone numbers, multi-paragraph email, and electrical/roofing leads. The original 12 ([evals/sample12.jsonl](evals/sample12.jsonl)) are a **calibration set**: the early prompt was tuned against them, so their line is regression only, not accuracy. Expected labels were not changed after seeing outputs.

Runs went through the deployed, passcode-gated production endpoint on 2026-11-26 (`scripts/eval-ember.mjs --endpoint=…`, concurrency 3, one retry on 502/timeout), because `MODEL_API_KEY` is a pull-proof Vercel Secret while `EMBER_DEMO_KEY` is readable. Final production settings: strict structured output, `max_completion_tokens=3000`, `reasoning_effort=low` (variant `structured+max_completion_tokens+effort=low`). Full per-lead results: [held-out, low, fix round 2](evals/results-heldout-fix2-2026-11-26.json) · [held-out, low, round 1](evals/results-heldout-structured-low-2026-11-26.json) · [held-out, default effort (sweep)](evals/results-heldout-structured-default-2026-11-26.json) · [calibration, fix round 2](evals/results-sample12-calibration-fix2-2026-11-26.json), with matching traces under [traces/](traces/). The same 40 through the free mock (`--mock`, [results](evals/results-heldout-mock-2026-11-26.json), re-run after the round-2 keyword widening): 9/9 emergencies caught but urgency 32/40 and category 37/40, with every result flagged `needs_review` as heuristics — the board's replay label carries this comparison. (The pre-widening mock measured 4/9 and 27/40 in the round-1 external review.)

| Set | Setting | Emergency recall | Emergency precision | Urgency acc. | Category acc. | Phone exact | Hallucinated phones | Language acc. | Structured compliance | Injection wins | needs_review | Tokens in/out per lead | Cost/lead | Latency p50/p95 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Held-out 40 | structured + effort=low (final, fix round 2) | 9/9 | 9/9 | 40/40 | 40/40 | 39/40 | 0 | 40/40 | 40/40 | 0/3 | 1/40 | 702 / 554 | $0.000347 | 1.64s / 2.83s |
| Held-out 40 | structured + default effort (sweep) | 9/9 | 9/9 | 40/40 | 40/40 | 39/40 | 0 | 40/40 | 40/40 | 0/3 | 1/40 | 692 / 1,506 | $0.000822 | 2.90s / 4.92s |
| Calibration set (12) | structured + effort=low (final, fix round 2) | 2/2 | 2/2 | 12/12 | 12/12 | 12/12 | 0 | 12/12 | 12/12 | — (0 attempts) | 0/12 | 716 / 554 | $0.000349 | 1.46s / 2.92s |

**The one miss, both settings:** held-out lead 19 spells its phone number out in words. The model returned the words as the phone; phone grounding (digits must appear verbatim) nulled it and flagged `needs_review` — the documented fail-closed gap working as designed, counted here as a phone miss, not relabeled. **Disputed labels: none.**

**Truncation, found and fixed.** At the original 1,500-token output cap, a 5-lead probe showed successful records using 1,217–1,454 completion tokens (reasoning included) and one lead needing a retry after a 502 ([probe](evals/results-probe5-baseline.json)). The cap is now 3,000 (`EMBER_MAX_TOKENS`) and every result carries the API `finish_reason`: all 69 first-round final-settings calls ended `stop` (max output 1,053 tokens), as did all 64 fix-round-2 regression calls (max 867). `reasoning_effort=low` is accepted by the API (it survives in `request_variant`; the ladder would have dropped it on a 400) and cut output tokens 2.6× at identical accuracy, so it is the production default. At the measured final rate of $0.000347/lead, the $10 hackathon cap covers roughly 28,000 leads. Total measured spend for everything on this page plus both replay recordings: **$0.083 over 178 billed calls** (two first-round retried 502 attempts returned no usage; their upstream cost is unreported).

To reproduce (endpoint route needs only the demo key in a pulled env file; the direct route needs `MODEL_API_KEY` locally):

```bash
node scripts/eval-ember.mjs --set=heldout --name=<slug> --endpoint=https://lead-triage-nine.vercel.app/api/extract --budget=0.05
node scripts/eval-ember.mjs --set=sample  --name=<slug> --endpoint=https://lead-triage-nine.vercel.app/api/extract --budget=0.02
node scripts/record-replay.mjs --endpoint=https://lead-triage-nine.vercel.app/api/extract --budget=0.02
```

Each run writes `evals/results-<name>.json` (every record, the endpoint response JSON as received, usage, `request_variant`, `finish_reason`, latency, misses) and `traces/ember-<name>.json`, and stops itself before crossing its budget. In endpoint mode `meta.settings` records the server-reported variants, and the compliance metric counts only the exact requested output mode.

## Run it locally

```bash
npm ci
npm run dev        # http://localhost:5173 — full app incl. /api/extract (mock until key + gates are set)
npm run verify     # mock ground truth (12 leads) + splitter, hazard scripts, capped ladder, failed-call cost, ranking tiers, draft safety, trace privacy, endpoint gates/413 — $0, no network
npm run build      # typecheck + production build
```

## Going live with Ember

1. Copy `.env.example` to `.env`; set `MODEL_API_KEY`, `EMBER_INPUT_RATE_PER_MTOK` / `EMBER_OUTPUT_RATE_PER_MTOK` (official muse-ember-1.0 rates under 200K context, confirmed 2026-11-24: $0.10 in / $0.50 out per 1M tokens), `EMBER_ENABLED=1`, and `EMBER_DEMO_KEY` (any long random string).
2. In the config panel choose Engine "Muse Ember" and paste the same demo key (kept in session storage, sent as `x-demo-key`). Without it you get mock results with a note — by design.
3. Optional request shaping: `EMBER_OUTPUT_MODE=structured|tool`, `EMBER_REASONING_EFFORT=<value>` (production: `low`, the measured sweep winner), `EMBER_MAX_TOKENS_PARAM=max_completion_tokens|max_tokens` (requests are always capped — there is no uncapped mode), `EMBER_MAX_TOKENS=<n>` (default 3000). Defaults match the live-verified variant.

## Deploy (Vercel)

Import the repo and set the same env vars in project settings (Production). `api/extract.ts` is the serverless function; the Vite build is the static front end. No database, no login, nothing stored server-side.

## Sample set

"Load sample set" pastes 12 fictional demo leads in a deliberately shuffled order (the burst-heater emergency arrives last, so ranking visibly reorders). Ground truth: emergencies {1,2} → same-day {3,4,5} → routine {6–10} → spam {11,12}. Lead 6 deliberately has **no phone number** — it must come back flagged missing. Put each lead in its own paragraph: blank lines separate leads, and a `---` line also separates exactly where it appears (it does not switch blank-line splitting off elsewhere); the paste box shows a live "N leads detected" count before you pay for a run.

## Layout

```
index.html                  the single page (workbench, folded cost & trace)
src/main.ts                 UI controller (4-worker runner, board, called state, replay, trace export)
src/styles.css
src/lib/schema.ts           lead record types, record_lead tool + JSON schema, extraction prompt
src/lib/mock.ts             mock adapter (heuristics, $0, labeled)
src/lib/safety.ts           hazard detection + fixed gas/CO/electrical safety scripts (code-owned)
src/lib/trace-export.ts     trace export builder (operational-only redaction, row-computed totals)
src/lib/ranking.ts          batch splitting (blank line or ---) + deterministic ordering
src/lib/sample.ts           the 12-lead fictional sample set
src/lib/api-adapter.ts      client adapter -> POST /api/extract (sends x-demo-key, status before JSON)
src/lib/replay-data.ts      recorded Ember run shown as the $0 public default (generated)
api/extract.ts              Vercel function (thin wrapper)
api/_lib/extract-core.ts    gates (kill switch + passcode), 413, config caps, generic 502
api/_lib/ember.ts           the Ember call: structured-first, negotiation ladder, grounding, honest cost
scripts/verify.mjs          $0 ground-truth + gate verification
scripts/test-structured.mjs one-lead probes for structured output / token cap / reasoning_effort
scripts/eval-ember.mjs      held-out / calibration eval harness (direct or --endpoint, budget-guarded)
scripts/record-replay.mjs   records the replay + sample trace (direct or --endpoint)
evals/                      heldout.jsonl (40, pre-registered), sample12.jsonl (calibration), results-*.json
traces/                     committed fictional prompt/token traces
docs/adr/README.md          decision log
SUM.md                      request, gap fills, open points
```

## Rules this build lives by (from the hackathon)

- All AI in the product is Muse Ember via the Meta Model API. Total Ember spend (dev + demo + submission) must stay ≤ $10 — hence mock-first development, the passcode gate, and the trace on every run.
- Submission: public repo link + 3-minute demo video + prompt/token trace, via the Cerebral Valley portal, by **Dec 2, 2026, 9 PM ET / 8 PM CT**.
