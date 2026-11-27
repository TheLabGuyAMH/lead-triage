# Lead Triage: the Morning Dispatcher for plumbing and HVAC shops, built on Muse Ember

**Live:** https://lead-triage-nine.vercel.app (opens on a recorded 1,000-message Freeze Day run, $0 to view) · Built solo for the Meta Muse Ember Hackathon by Anthony Hinojosa / Alchemist Labs.

The morning after a hard freeze, a 1–10 truck plumbing shop wakes up to hundreds of voicemails, texts and web forms, in English and Spanish. Some are the same burst pipe reported three times by three family members. Some are five houses on one street with no water, which is one problem at the city main, not five truck rolls. Lead Triage reads the whole pile and hands the owner a truck plan:

1. **Ember reads every message** into a strict schema (urgency, service, phone, area, language, a reply draft).
2. **Ember reads the pile.** A second pass looks across messages for ones that belong together, quotes the exact words that prove it, and writes the one question that would settle a doubtful link ("Is the leak in unit B what's coming through unit A's wall?").
3. **Code decides what's safe.** A link survives only if every quote is really in the message it cites, and it merges automatically only when code finds a shared phone or the same house number and street. Anything weaker waits for the owner's answer. Code then fills today's truck slots in priority order.
4. **Nobody is left guessing.** Urgent jobs that miss the trucks get a fixed shut-off-your-water or stay-warm-safely script; routine ones get an honest "we can't come today". Gas, carbon-monoxide and electrical hazards always get a truck and a fixed "leave now, call 911" script, never AI text.

Answer a question or change the number of trucks and the plan re-flows on screen. The owner reviews and sends everything; nothing is sent automatically.

**Why Ember.** One message costs about **$0.0004** to read (measured: $0.3907 for 1,000 Freeze Day messages; $0.000347 per lead on the 40 held-out leads). Reading the pile for links cost **$0.0694** for the same 1,000 messages (122 calls of up to 30 messages each). The whole 1,000-message morning, both passes, is about **46 cents**, and took 297 s + 76 s (six per-message calls at a time, four link calls at a time). That is what makes "read everything, twice, every morning" a normal thing for a small shop to do.

**Why it matters.** Invoca's platform data found that [27% of calls to home services businesses go unanswered, and fewer than 3% of callers sent to voicemail leave a message](https://www.invoca.com/blog/how-much-missed-sales-calls-cost-home-services-businesses) (May 2024). During the February 2021 Texas freeze, an Austin plumbing company had [triple its normal number of calls and more than 2,500 customers awaiting service](https://www.texastribune.org/2021/02/26/texas-plumber-shortage-winter-storm).

| Freeze Day: 1,000 fictional messages, answer key by construction | Result |
|---|---|
| Message pairs merged automatically / merged wrongly | 96 / **0** |
| True linked pairs found, Ember + same-phone code (recall) | 174 of 205 (85%) |
| Suggested pairs that were right (precision) | 174 of 187 (93%) |
| Found by Ember's own links / no-model rules on the same messages | 136 of 205 / 115 of 205 |
| Shared-cause pairs: Ember / no-model rules | 76 of 87 / 24 of 87 |
| Questions left for the owner | 29 |
| Category matches the generator's label | 999 of 1,000 |
| Calls failed / quotes that weren't really in the message | 0 / 0 |
| Cost, both passes | $0.3907 + $0.0694 |

**Where rules can't reach.** A hand-written 23-message set where the messages that belong together share no phone and no house number: a son calling for his mother, a grandmother in Spanish and her grandson in English, a tenant and the property manager, "Bobby" and "Robert Nguyen" at the same duplex, a building with no hot water, a street with no house numbers. Ember found **8 of 8** linked pairs with no wrong suggestions; the no-model rules found **1 of 8**. Because code can't anchor those same-job links, none merged on its own: each became a question for the owner, such as "Is this the Bayview Apartments unit 12 toilet overflow Kim reported?". On the 20-message freeze morning, Ember found 6 of 6 (rules: 5 of 6).

| Per-message reading, 40 held-out synthetic leads | Result |
|---|---|
| Emergencies caught | 9 of 9 |
| Urgency and category correct | 40 of 40 each |
| Language detected (English / Spanish) | 40 of 40 |
| Phone numbers exact | 39 of 40 (the miss was spelled out in words; it was flagged, not invented) |
| Prompt-injection attempts that worked | 0 of 3 |
| Cost per lead / median time per lead | $0.000347 / 1.64 s |

**Honest limits.**
- All messages are synthetic. The Freeze Day set comes from templates in `scripts/gen-freeze.mjs`, so it is more repetitive than real texts; the 20-message set and the 40 held-out leads were written by AI models that also helped build the app. No contractor has used it yet.
- The link prompt was tightened once **after** seeing the first Freeze Day results (v1: precision 173/292, mostly "possible shared cause" guesses between same-street homes with ordinary freeze damage; still 0 wrong merges). Both runs are committed (`*-v1-*` and the final files).
- Urgency agreed with the generator's labels on 771 of 884 labeled messages. Of the 113 disagreements, 75 are same-day read as routine (mostly "kitchen pipes frozen, bathroom still works" and "toilet won't fill"), 32 are emergency read lower, 6 routine read as same-day.
- A review found and we fixed: a phone's last four digits could pass for a house number, a shared full name counted as proof, and one Spanish no-water message got the electrical safety script because hazard detection read the model's explanation ("no ... electrical hazard is stated"). That message was re-read on fixed code, and the stored links were re-checked under the stricter rule (2 lowered to "possible"); numbers above are after the fix.
- Stops are filled in priority order, not routed by geography. The safety and holding scripts are demo wording; a licensed professional should review them before real use.
- Ember spend for this build is in the committed traces and on the account's usage page, far under the $10 cap (see Evaluation).

**Try it:** the live link opens on the recorded Freeze Day run; change "Trucks today", or answer a question, and watch the plan move. "Load freeze morning" plus "Run Triage" runs the 20-message set in free practice mode (keyword rules, clearly labeled as not Ember). Live Ember runs need the private demo key, which keeps strangers from spending the budget.

## How the Morning Dispatcher works

- **Blocks** (`src/lib/dispatch.ts` `planBlocks`): a pile of 30 or fewer is one block. A bigger pile is grouped so related messages meet: by street (a house-number street, or a bare street name seen elsewhere with a house number), by sender name for messages that point back at someone ("Linda's husband", "calling for my mom"), else by area. Blocks are capped at 30 messages. The 1,000-message Freeze Day became 122 blocks.
- **Ember link call** (`api/_lib/ember.ts` `emberLink`, endpoint `POST /api/dispatch`, same three gates as `/api/extract`): strict JSON-schema output of links, each with kind (`same_job` / `shared_cause`), confidence, exact quotes per message, a one-line explanation and one deciding question.
- **Code checks** (`validateLinks`): every member needs a quote that is really in its own message, or it is removed; "likely" `same_job` stays "likely" only if code finds a shared phone or house number + street (phone numbers are removed first, so a phone's last digits can't pass for a house number); the same phone alone is linked by code with no model at all (`codeLinks`).
- **Plan** (`buildPlan`): merges only anchored "likely" same-job links and links the owner confirms; ranks jobs (hazards, urgency, more messages, paste order); deals them to trucks in turn (truck 1, 2, 3...), so stops count per truck; urgent overflow gets the water shut-off, frozen-pipe, stay-warm (with the carbon-monoxide warning) or urgent-list script; routine overflow gets an honest "not today". A confirmed street-wide cause on a truck becomes one stop with a street-check reply for every home, each in its own language, each with its own call and text buttons. Hazards always get a truck, even past capacity. Answers and capacity changes re-plan instantly in the browser and the board says who moved.

## How it works

- **One page, two columns on desktop:** paste/config on the left, the call-back board on the right. Cost and trace data live in a collapsed "Cost & trace" section below the board — the first screen is the work, not a dashboard.
- **One extraction call per lead** through a single adapter boundary (`src/lib/schema.ts` defines the lead record, the `record_lead` schema, and the extraction prompt). Leads run through a 4-worker pool with per-lead error isolation: one failure becomes a flagged emergency card, never a dropped batch.
  - **Ember adapter** (`api/_lib/ember.ts`, server-side only): Muse Ember (`muse-ember-1.0`) on the Meta Model API. Primary path is **strict JSON-schema structured output** (`response_format`), proved live on 2026-11-26: request variant `structured+max_completion_tokens` answered 200 with a schema-valid record (see [traces/ember-live-smoke-2026-11-26.json](traces/ember-live-smoke-2026-11-26.json)). The `record_lead` tool path (`tool_choice: "auto"` — forced choice returns 400, verified live 2026-11-25) plus a plain-text JSON fallback remain as the negotiated fallbacks. Parameters the docs disagree on are settled by a 400-only negotiation ladder that stamps the accepted `request_variant` on every result; every rung keeps an output-token cap (the ladder may rename the cap parameter, never drop it), `reasoning_effort` survives every cap/mode change and is dropped only on the last rungs, and nothing is remembered across requests, so a downgrade can never stick.
  - **Mock adapter** (`src/lib/mock.ts`): deterministic heuristics, $0, works offline. A labeled fallback, never passed off as Ember.
  - **Replays:** the public board opens on the recorded Freeze Day run (`src/lib/replay-freeze.json`, loaded on demand); "View recorded 12-lead run" shows a labeled replay of a real Ember run of the 12-lead sample on the final prompt and settings (`src/lib/replay-data.ts`, recorded 2026-11-26 by `scripts/record-replay.mjs` through the gated production endpoint; trace in [traces/ember-sample12-replay-2026-11-26.json](traces/ember-sample12-replay-2026-11-26.json)), so viewing proof costs $0.
- **The model classifies; code orders.** Ember judges each lead's category and urgency; `src/lib/ranking.ts` sorts deterministically — critically untrusted records first (extraction failure, unknown urgency/category), then category, then urgency, then paste position; softer `needs_review` flags (phone grounding, draft content, truncation, mock heuristics) keep their urgency tier and show their banner there.
- **Fail-closed by construction:**
  - An unknown urgency becomes *emergency* and an unknown category *real*, both flagged `needs_review` — never silently sunk.
  - A phone number is trusted only when its digits literally appear in the lead (phone grounding); otherwise null and flagged. Known gap: numbers spelled out in words fail grounding and go to review, by design.
  - Missing API usage means cost *unknown* (null), never $0.
  - Lead text is wrapped in `<lead>…</lead>` and treated as data, not instructions; drafts may not contain URLs, prices, discounts, or unlisted phone numbers — enforced in code, which strips URLs and phones not grounded in the lead from any draft and flags the card, and empties drafts for spam and not-a-lead outright. A truncated call (`finish_reason: "length"`) is flagged too.
  - **Hazard leads never get a model-written reply.** Code detects gas / rotten-egg smell, carbon-monoxide alarms, and sparking / burning-smell / smoke / fire electrical hazards (English and Spanish, in the raw lead and the model's own fields), forces emergency, and replaces the draft with a fixed safety script in the lead's language (`src/lib/safety.ts`; exact wording in [docs/adr/README.md](docs/adr/README.md), hackathon demo wording; a professional should review it before any real-customer use). The card carries a "Safety script, not AI text" badge.
- **The paid path requires the demo key; there is no server-side cumulative spend ceiling, so keep the key private and disable Ember after recording.** `POST /api/extract` makes a paid call only when all three server gates pass: `EMBER_ENABLED=1` (kill switch), `MODEL_API_KEY` set, and the request's `x-demo-key` matching `EMBER_DEMO_KEY` (timing-safe compare). Everyone else gets a mock result with a visible note at $0. One lead over 4,000 characters is a 413; business name/trade are stripped of control characters and capped at 80 before reaching the prompt; upstream errors return a generic 502 with detail in server logs only; calls time out at 20 s with a 3,000-token output cap (raised from 1,500 after the truncation probe in Evaluation below). **The server enforces the gates, not total spend. The browser's budget cap stops a batch in that browser and counts any call with unknown cost at a deliberately high $0.002.** Switching Ember off for the public site = unset `EMBER_ENABLED` and redeploy.
- **Traces that prove claims.** Every Ember result carries the API-reported model, a SHA-256 of the prompt actually sent, the output mode, and the accepted request variant. Trace export is **redacted by default and contains only operational fields** (index, category, urgency, a boolean needs_review, tokens, cost, latency, request_variant, finish_reason, model, mode, timestamps — no customer text at all); the unredacted export with full records is opt-in behind a customer-data warning and sets `contains_customer_data: true`. Export totals are computed from the exported rows, the header pill and budget meter show session spend only (the replay's recorded cost stays in its own label), and a replay export is marked `replay: true` with its original recorded timestamps. Fictional traces are committed under [traces/](traces/); never commit a real one.

## Evaluation

Ground rules: the 40-lead held-out set ([evals/heldout.jsonl](evals/heldout.jsonl)) was written by the builder model, Muse, **before** any Ember output was seen for it; it is a synthetic benchmark of fictional leads, not field data. By the set's labels: — 9 emergencies, 11 same-day, 20 routine by expected urgency; 34 real, 4 spam, 2 not-a-lead by category; 5 Spanish/Spanglish; 3 prompt-injection attempts; with typos, word-spelled phone numbers, multi-paragraph email, and electrical/roofing leads. The original 12 ([evals/sample12.jsonl](evals/sample12.jsonl)) are a **calibration set**: the early prompt was tuned against them, so their line is regression only, not accuracy. Expected labels were not changed after seeing outputs.

Runs went through the deployed, passcode-gated production endpoint on 2026-11-26 (`scripts/eval-ember.mjs --endpoint=…`, concurrency 3, one retry on 502/timeout), because `MODEL_API_KEY` is a pull-proof Vercel Secret while `EMBER_DEMO_KEY` is readable. Final production settings: strict structured output, `max_completion_tokens=3000`, `reasoning_effort=low` (variant `structured+max_completion_tokens+effort=low`). Full per-lead results: [held-out, low, fix round 2](evals/results-heldout-fix2-2026-11-26.json) · [held-out, low, round 1](evals/results-heldout-structured-low-2026-11-26.json) · [held-out, default effort (sweep)](evals/results-heldout-structured-default-2026-11-26.json) · [calibration, fix round 2](evals/results-sample12-calibration-fix2-2026-11-26.json), with matching traces under [traces/](traces/). The same 40 through the free mock: the round-1 mock (before its keywords were widened with these leads in view) caught 4/9 emergencies, urgency 27/40, category 37/40 — re-measured locally at $0 on 2026-11-26 from commit `77d77f2`. The current, tuned mock ([results](evals/results-heldout-mock-2026-11-26.json)) scores 9/9 and 32/40, but since it was tuned on these leads that is not a fair test; the board quotes the pre-tuning numbers. Every mock result is flagged `needs_review` as heuristics.

| Set | Setting | Emergency recall | Emergency precision | Urgency acc. | Category acc. | Phone exact | Hallucinated phones | Language acc. | Structured compliance | Injection wins | needs_review | Tokens in/out per lead | Cost/lead | Latency p50/p95 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Held-out 40 | structured + effort=low (final, fix round 2) | 9/9 | 9/9 | 40/40 | 40/40 | 39/40 | 0 | 40/40 | 40/40 | 0/3 | 1/40 | 702 / 554 | $0.000347 | 1.64s / 2.83s |
| Held-out 40 | structured + default effort (sweep) | 9/9 | 9/9 | 40/40 | 40/40 | 39/40 | 0 | 40/40 | 40/40 | 0/3 | 1/40 | 692 / 1,506 | $0.000822 | 2.90s / 4.92s |
| Calibration set (12) | structured + effort=low (final, fix round 2) | 2/2 | 2/2 | 12/12 | 12/12 | 12/12 | 0 | 12/12 | 12/12 | — (0 attempts) | 0/12 | 716 / 554 | $0.000349 | 1.46s / 2.92s |

**The one miss, both settings:** held-out lead 19 spells its phone number out in words. The model returned the words as the phone; phone grounding (digits must appear verbatim) nulled it and flagged `needs_review` — the documented fail-closed gap working as designed, counted here as a phone miss, not relabeled. **Disputed labels: none.**

**Truncation, found and fixed.** At the original 1,500-token output cap, a 5-lead probe showed successful records using 1,217–1,454 completion tokens (reasoning included) and one lead needing a retry after a 502 ([probe](evals/results-probe5-baseline.json)). The cap is now 3,000 (`EMBER_MAX_TOKENS`) and every result carries the API `finish_reason`: all 69 first-round final-settings calls ended `stop` (max output 1,053 tokens), as did all 64 fix-round-2 regression calls (max 867). `reasoning_effort=low` is accepted by the API (it survives in `request_variant`; the ladder would have dropped it on a 400) and cut output tokens 2.6× at identical accuracy, so it is the production default. At the measured final rate of $0.000347/lead, the $10 hackathon cap covers roughly 28,000 leads. The committed traces under [traces/](traces/) record **$0.0798 over 167 billed calls**. The builder's running tally, which also counts an earlier replay recording and runs whose traces were not kept, was $0.083 over 178 calls; two first-round retried 502 attempts returned no usage, so their upstream cost is unreported. The account's usage page is the authority for the submission screenshot.

To reproduce (endpoint route needs only the demo key in a pulled env file; the direct route needs `MODEL_API_KEY` locally):

```bash
node scripts/eval-ember.mjs --set=heldout --name=<slug> --endpoint=https://lead-triage-nine.vercel.app/api/extract --budget=0.05
node scripts/eval-ember.mjs --set=sample  --name=<slug> --endpoint=https://lead-triage-nine.vercel.app/api/extract --budget=0.02
node scripts/record-replay.mjs --endpoint=https://lead-triage-nine.vercel.app/api/extract --budget=0.02
```

Each run writes `evals/results-<name>.json` (every record, the endpoint response JSON as received, usage, `request_variant`, `finish_reason`, latency, misses) and `traces/ember-<name>.json`, and stops itself before crossing its budget. In endpoint mode `meta.settings` records the server-reported variants, and the compliance metric counts only the exact requested output mode.

### Morning Dispatcher evaluation (2026-11-27)

Run through the deployed, passcode-gated endpoints with `scripts/record-dispatch.mjs` (per-message `/api/extract`, then `/api/dispatch` per block; six per-message and four link calls at a time; hard spend guard). The answer key for the 1,000-message Freeze Day comes from the generator itself (`scripts/gen-freeze.mjs`, fixed seed): 72 households that wrote more than once, 12 streets where several homes lost water together, 12 hazards, 55 spam / not-a-lead, and singles, including same-street homes with unrelated damage as traps. The 20-message freeze morning has a hand-written answer key (`FREEZE_GROUPS` in `src/lib/sample.ts`).

| Set | Link prompt | Pairs suggested (right / total) | True pairs found | Auto-merged (wrong) | Open questions | Link calls | Spend |
|---|---|---|---|---|---|---|---|
| Freeze Day 1,000 | v1 | 173 / 292 | 173 / 205 | 100 (0) | 49 | 122 | $0.3907 extract + $0.0857 links |
| Freeze Day 1,000 | final (shared cause needs a message saying it goes beyond one home) | 174 / 187 | 174 / 205 | 96 (0) | 29 | 122 | $0.0694 links (per-message pass reused) + $0.0006 re-read of #230 |
| Freeze Day 1,000 | no-model rules (same phone + keyword links), $0 | 115 / 145 | 115 / 205 | 96 (0) | — | 0 | $0 |
| Hard links 23 | final | 8 / 8 | 8 / 8 | 0 (0): all became questions | 4 | 1 | $0.0098 |
| Hard links 23 | no-model rules, $0 | 1 / 1 | 1 / 8 | 0 (0) | — | 0 | $0 |
| Freeze morning 20 | v1 | 6 / 6 | 6 / 6 | 2 (0) | 2 | 1 | $0.0091 |
| Freeze morning 20 | final | 6 / 6 | 6 / 6 | 2 (0) | 2 | 1 | $0.0087 (re-run after the fix round) |
| Freeze morning 20 | no-model rules, $0 | 5 / 5 | 5 / 6 | 2 (0) | — | 0 | $0 |

Results: [Freeze Day final](evals/results-dispatch-freeze1000-2026-11-27.json) · [Freeze Day v1](evals/results-dispatch-freeze1000-v1-2026-11-27.json) · [freeze morning final](evals/results-dispatch-freeze20-2026-11-27.json) · [freeze morning v1](evals/results-dispatch-freeze20-v1-2026-11-27.json), traces with every call's tokens and cost under [traces/](traces/) (`ember-dispatch-*`). Per-message pass on the Freeze Day: 1,000 of 1,000 calls succeeded in 297 s, category agreed with the generator's label on 999 of 1,000, urgency on 771 of 884 labeled. "Pairs" counts every pair of messages inside a link, so a three-home street is three pairs. Spend for this round, from the traces and run logs: **$0.5831 over 1,332 billed calls** (two freeze-morning runs, the Freeze Day run and its v2 link pass, the fix-round re-read of #230, the hard-links set, and a third freeze-morning run after the fixes); with the earlier rounds' committed traces ($0.0798 over 167 calls) the build total is **$0.6629**, far under the $10 cap. The account's usage page is the authority for the submission.

## Run it locally

```bash
npm ci
npm run dev        # http://localhost:5173 — full app incl. /api/extract (mock until key + gates are set)
npm run verify     # mock ground truth (12 leads) + dispatcher (quote checks, anchors, blocks, plan lanes, answers re-flow) + splitter, hazard scripts, capped ladder, failed-call cost, ranking tiers, draft safety, trace privacy, endpoint gates/413 — $0, no network
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
src/lib/sample.ts           the 12-lead sample, the 20-message freeze morning and the 23-message hard-links set (with answer keys)
src/lib/dispatch.ts         Morning Dispatcher: blocks, link prompt + schema, quote/anchor checks, code links, the truck plan and holding scripts
src/lib/replay-freeze.json  recorded 1,000-message Freeze Day run (generated)
src/lib/api-adapter.ts      client adapter -> POST /api/extract (sends x-demo-key, status before JSON)
src/lib/replay-data.ts      recorded Ember run shown as the $0 public default (generated)
api/extract.ts              Vercel function (thin wrapper)
api/_lib/extract-core.ts    gates (kill switch + passcode), 413, config caps, generic 502
api/_lib/ember.ts           the Ember calls: per-message (structured-first, negotiation ladder, grounding, honest cost) and emberLink
api/dispatch.ts, api/_lib/dispatch-core.ts  POST /api/dispatch: one block, same gates, links quote-checked before they leave
scripts/verify.mjs          $0 ground-truth + gate verification
scripts/test-structured.mjs one-lead probes for structured output / token cap / reasoning_effort
scripts/eval-ember.mjs      held-out / calibration eval harness (direct or --endpoint, budget-guarded)
scripts/record-replay.mjs   records the replay + sample trace (direct or --endpoint)
scripts/gen-freeze.mjs      generates the 1,000-message Freeze Day set with its answer key (fixed seed, no model)
scripts/record-dispatch.mjs runs a set through both passes on the live endpoints, scores links, writes results/trace/replay
scripts/rescore-freeze.mjs  re-scores the recorded Freeze Day after a code fix (re-reads named messages, re-checks anchors, no-model baseline)
evals/                      heldout.jsonl (40, pre-registered), sample12.jsonl (calibration), results-*.json
traces/                     committed fictional prompt/token traces
docs/adr/README.md          decision log
SUM.md                      request, gap fills, open points
```

## Rules this build lives by (from the hackathon)

- All AI in the product is Muse Ember via the Meta Model API. Total Ember spend (dev + demo + submission) must stay ≤ $10 — hence mock-first development, the passcode gate, and the trace on every run.
- Submission: public repo link + 3-minute demo video + prompt/token trace, via the Cerebral Valley portal, by **Dec 2, 2026, 9 PM ET / 8 PM CT**.
