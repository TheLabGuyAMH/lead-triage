# Lead Triage — Lead Intake Assistant for Local Service Businesses

Built for the **Meta Muse Ember Hackathon** (Cerebral Valley) by Anthony Hinojosa / **Alchemist Labs**. Live: https://lead-triage-nine.vercel.app

The owner of a 1–10 truck plumbing or HVAC shop pastes the day's pile of raw leads (voicemail transcripts, web form submissions, messages) and gets back a **ranked call-back queue**: every lead structured, emergencies first, spam folded away in plain sight, a follow-up draft ready in the customer's own language (English or Spanish), and Call / Text actions on every card. The owner reviews and sends everything; nothing is auto-sent.

## How it works

- **One page, two columns on desktop:** paste/config on the left, the call-back board on the right. Cost and trace data live in a collapsed "Cost & trace" section below the board — the first screen is the work, not a dashboard.
- **One extraction call per lead** through a single adapter boundary (`src/lib/schema.ts` defines the lead record, the `record_lead` schema, and the extraction prompt). Leads run through a 4-worker pool with per-lead error isolation: one failure becomes a flagged emergency card, never a dropped batch.
  - **Ember adapter** (`api/_lib/ember.ts`, server-side only): Muse Ember (`muse-ember-1.0`) on the Meta Model API. Primary path is **strict JSON-schema structured output** (`response_format`), proved live on 2026-11-26: request variant `structured+max_completion_tokens` answered 200 with a schema-valid record (see [traces/ember-live-smoke-2026-11-26.json](traces/ember-live-smoke-2026-11-26.json)). The `record_lead` tool path (`tool_choice: "auto"` — forced choice returns 400, verified live 2026-11-25) plus a plain-text JSON fallback remain as the negotiated fallbacks. Parameters the docs disagree on are settled by a 400-only negotiation ladder that stamps the accepted `request_variant` on every result.
  - **Mock adapter** (`src/lib/mock.ts`): deterministic heuristics, $0, works offline. A labeled fallback, never passed off as Ember.
  - **Replay:** the public board is built to open on a clearly labeled replay of a recorded Ember run (`src/lib/replay-data.ts`, recorded by `scripts/record-replay.mjs`) so viewing proof costs $0. Until that recording exists the board opens empty with the replay button present.
- **The model classifies; code orders.** Ember judges each lead's category and urgency; `src/lib/ranking.ts` sorts deterministically — `needs_review` first, then category, then urgency, then paste position.
- **Fail-closed by construction:**
  - An unknown urgency becomes *emergency* and an unknown category *real*, both flagged `needs_review` — never silently sunk.
  - A phone number is trusted only when its digits literally appear in the lead (phone grounding); otherwise null and flagged. Known gap: numbers spelled out in words fail grounding and go to review, by design.
  - Missing API usage means cost *unknown* (null), never $0.
  - Lead text is wrapped in `<lead>…</lead>` and treated as data, not instructions; drafts may not contain URLs, prices, discounts, or unlisted phone numbers.
- **The endpoint cannot be drained.** `POST /api/extract` makes a paid call only when all three server gates pass: `EMBER_ENABLED=1` (kill switch), `MODEL_API_KEY` set, and the request's `x-demo-key` matching `EMBER_DEMO_KEY` (timing-safe compare). Everyone else gets a mock result with a visible note at $0. One lead over 4,000 characters is a 413; business name/trade are stripped of control characters and capped at 80 before reaching the prompt; upstream errors return a generic 502 with detail in server logs only; calls time out at 20 s with a 1,500-token output cap. **The server enforces the limits; the browser's budget meter is advisory.** Switching Ember off for the public site = unset `EMBER_ENABLED` and redeploy.
- **Traces that prove claims.** Every Ember result carries the API-reported model, a SHA-256 of the prompt actually sent, the output mode, and the accepted request variant. Trace export includes the extracted records and is **redacted by default** (customer text/names/phones become lengths). Fictional traces are committed under [traces/](traces/); never commit a real one.

## Evaluation

Ground rules: the 40-lead held-out set ([evals/heldout.jsonl](evals/heldout.jsonl)) was written **before** any Ember output was seen for it — 8 emergencies, 8 same-day, 10 routine, 6 spam/not-a-lead, 5 Spanish/Spanglish, 3 prompt-injection attempts, with typos, word-spelled phone numbers, multi-paragraph email, and electrical/roofing leads. The original 12 ([evals/sample12.jsonl](evals/sample12.jsonl)) are a **calibration set**: the early prompt was tuned against them, so their line is regression only, not accuracy.

| Set | Setting | Emergency recall | Emergency precision | Urgency acc. | Category acc. | Phone exact | Hallucinated phones | Language acc. | Injection wins | Cost/lead |
|---|---|---|---|---|---|---|---|---|---|---|
| Held-out 40 | structured (final prompt) | — pending — | | | | | | | | |

**Status (2026-11-26): the held-out run is ready but not yet executed.** Local eval calls need `MODEL_API_KEY` available to the script; on Vercel the key is stored as a pull-proof Secret (both `vercel env pull` and `vercel env run` return it redacted), and the task budget allowed exactly one live call through the public endpoint, used for the smoke trace above. To run the full table, from a machine with the key in the environment:

```bash
MODEL_API_KEY=… node scripts/eval-ember.mjs --set=heldout --name=heldout-structured-2026-11-26 --budget=0.20
MODEL_API_KEY=… node scripts/eval-ember.mjs --set=sample  --name=sample12-calibration-2026-11-26 --budget=0.05
MODEL_API_KEY=… node scripts/record-replay.mjs --budget=0.05   # refreshes src/lib/replay-data.ts + traces/
# optional reasoning sweep, once support is confirmed by scripts/test-structured.mjs:
MODEL_API_KEY=… node scripts/eval-ember.mjs --set=heldout --effort=minimal --name=heldout-minimal --budget=0.10
```

Each run writes `evals/results-<name>.json` (every record, usage, latency, misses) and `traces/ember-<name>.json`, and stops itself before crossing its budget. What *is* measured today: one live gated call on an unseen held-out emergency — correct tier, grounded phone, Spanish-safe pipeline — 682 in / 1,365 out tokens, **$0.000751** ([trace](traces/ember-live-smoke-2026-11-26.json)). At the earlier 12-lead calibration runs' rate (~$0.00058/lead) $10 covers roughly 17,000 leads; treat that as calibration arithmetic until the held-out table lands.

`reasoning_effort` remains **unverified**: no call has sent it yet. `scripts/test-structured.mjs` settles it (4 one-lead probes) wherever the key is available locally; the production ladder drops the parameter automatically if the API rejects it with a 400.

## Run it locally

```bash
npm ci
npm run dev        # http://localhost:5173 — full app incl. /api/extract (mock until key + gates are set)
npm run verify     # mock ground truth (12 leads) + splitter, fail-closed normalization, phone grounding, endpoint gates/413 — $0, no network
npm run build      # typecheck + production build
```

## Going live with Ember

1. Copy `.env.example` to `.env`; set `MODEL_API_KEY`, `EMBER_INPUT_RATE_PER_MTOK` / `EMBER_OUTPUT_RATE_PER_MTOK` (official muse-ember-1.0 rates under 200K context, confirmed 2026-11-24: $0.10 in / $0.50 out per 1M tokens), `EMBER_ENABLED=1`, and `EMBER_DEMO_KEY` (any long random string).
2. In the config panel choose Engine "Muse Ember" and paste the same demo key (kept in session storage, sent as `x-demo-key`). Without it you get mock results with a note — by design.
3. Optional request shaping: `EMBER_OUTPUT_MODE=structured|tool`, `EMBER_REASONING_EFFORT=<value>`, `EMBER_MAX_TOKENS_PARAM=max_completion_tokens|max_tokens|none`. Defaults match the live-verified variant.

## Deploy (Vercel)

Import the repo and set the same env vars in project settings (Production). `api/extract.ts` is the serverless function; the Vite build is the static front end. No database, no login, nothing stored server-side.

## Sample set

"Load sample set" pastes 12 fictional demo leads in a deliberately shuffled order (the burst-heater emergency arrives last, so ranking visibly reorders). Ground truth: emergencies {1,2} → same-day {3,4,5} → routine {6–10} → spam {11,12}. Lead 6 deliberately has **no phone number** — it must come back flagged missing. Lead text separates on blank lines, or on a `---` line when a single lead contains blank lines; the paste box shows a live "N leads detected" count before you pay for a run.

## Layout

```
index.html                  the single page (workbench, folded cost & trace)
src/main.ts                 UI controller (4-worker runner, board, called state, replay, trace export)
src/styles.css
src/lib/schema.ts           lead record types, record_lead tool + JSON schema, extraction prompt
src/lib/mock.ts             mock adapter (heuristics, $0, labeled)
src/lib/ranking.ts          batch splitting (blank line or ---) + deterministic ordering
src/lib/sample.ts           the 12-lead fictional sample set
src/lib/api-adapter.ts      client adapter -> POST /api/extract (sends x-demo-key, status before JSON)
src/lib/replay-data.ts      recorded Ember run shown as the $0 public default (generated)
api/extract.ts              Vercel function (thin wrapper)
api/_lib/extract-core.ts    gates (kill switch + passcode), 413, config caps, generic 502
api/_lib/ember.ts           the Ember call: structured-first, negotiation ladder, grounding, honest cost
scripts/verify.mjs          $0 ground-truth + gate verification
scripts/test-structured.mjs one-lead probes for structured output / token cap / reasoning_effort
scripts/eval-ember.mjs      held-out / calibration eval harness (direct calls, budget-guarded)
scripts/record-replay.mjs   records the replay + sample trace
evals/                      heldout.jsonl (40, pre-registered), sample12.jsonl (calibration), results-*.json
traces/                     committed fictional prompt/token traces
docs/adr/README.md          decision log
SUM.md                      request, gap fills, open points
```

## Rules this build lives by (from the hackathon)

- All AI in the product is Muse Ember via the Meta Model API. Total Ember spend (dev + demo + submission) must stay ≤ $10 — hence mock-first development, the passcode gate, and the trace on every run.
- Submission: public repo link + 3-minute demo video + prompt/token trace, via the Cerebral Valley portal, by **Dec 2, 2026, 9 PM ET / 8 PM CT**.
