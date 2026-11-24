# Lead Triage — Lead Intake Assistant for Local Service Businesses

Built for the **Meta Muse Ember Hackathon** (Cerebral Valley). Solo build by Anthony Hinojosa / COHEGEN.

A local service business owner pastes the day's pile of raw leads (voicemail transcripts, web form submissions, messages) and gets back a **ranked call-back list**: every lead structured, emergencies first, spam filtered, and a follow-up draft ready for each real lead — in the customer's own language (English or Spanish). The owner reviews and sends everything; nothing is auto-sent.

## How it works

- **One page, three zones:** paste/config → ranked lead board → session meter + trace.
- **One extraction call per lead** through a single adapter boundary (`src/lib/schema.ts` defines the lead record + the `record_lead` tool schema + the extraction prompt).
  - **Mock adapter** (`src/lib/mock.ts`): deterministic heuristics, $0, works offline. Used for development and as the demo fallback.
  - **Ember adapter** (`api/_lib/ember.ts`, server-side only): calls Muse Ember (`muse-ember-1.0`) on the Meta Model API with the `record_lead` tool forced. The API key never reaches the browser.
- **Ranking is code, not model** (`src/lib/ranking.ts`): category → urgency, stable within a tier. Deterministic and explainable.
- **Budget discipline:** batch cap of 25 leads per run, a confirm step before paid Ember runs, a live cost meter against a configurable cap (default $10 — the hackathon's hard Ember budget), and a full per-call trace (mode, tokens, cost) exportable as JSON for the submission's prompt/token evidence.
- **Honesty by construction:** fields not stated in a lead come back `null` and are flagged "missing" in the UI — never invented. If Ember mode is requested but no API key is configured, the server returns a mock result *with a visible note* rather than faking Ember usage.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173 — full app incl. /api/extract (mock until a key is set)
npm run verify     # ground-truth checks vs the 12-lead sample set
npm run build      # typecheck + production build
```

## Going live with Ember

1. Copy `.env.example` to `.env` and set `MODEL_API_KEY` (Meta Model API key).
2. Set `EMBER_INPUT_RATE_PER_MTOK` / `EMBER_OUTPUT_RATE_PER_MTOK` from the official Muse Ember pricing page so the cost meter shows real dollars. (Left blank on purpose until then — the meter shows exact token counts and marks cost "rates not set" instead of inventing a figure.)
3. In the app's config panel, switch Engine to "Muse Ember".
4. **Day-1 verification item:** confirm the Chat Completions request/response shape in `api/_lib/ember.ts` against the participant API docs — everything Ember-shaped is isolated in that one file.

## Deploy (Vercel)

Import the repo, set the same env vars in project settings. `api/extract.ts` is the serverless function; the Vite build is the static front end. No database, no login.

## Sample set

"Load sample set" fills the paste box with 12 fictional demo leads (mixed trades, 2 in Spanish, 2 spam, 2 emergencies). Ground truth: emergencies (1–2) → same-day (3–5) → routine (6–10) → spam collapsed (11–12). Lead 6 deliberately has **no phone number** — it must come back flagged missing. `npm run verify` checks all of this, including running the batch in reverse to prove the ranking re-tiers.

## Layout

```
index.html            the single page
src/main.ts           UI controller (board, meter, trace, config)
src/styles.css
src/lib/schema.ts     lead record types, record_lead tool, extraction prompt
src/lib/mock.ts       mock adapter (heuristics, $0)
src/lib/ranking.ts    batch splitting + deterministic ranking
src/lib/sample.ts     the 12-lead fictional sample set
src/lib/api-adapter.ts  client adapter -> POST /api/extract
api/extract.ts        Vercel function (thin wrapper)
api/_lib/extract-core.ts  shared request handling (mock / ember / fallback)
api/_lib/ember.ts     the real Ember call — the only Ember-shaped file
scripts/verify.mjs    ground-truth verification
```

## Rules this build lives by (from the hackathon)

- All AI in the product is Muse Ember via the Meta Model API. Total Ember spend (dev + demo + submission) must stay ≤ $10 — hence mock-first development and the trace.
- Submission: public repo link + 3-minute demo video + prompt/token trace, via the Cerebral Valley portal, by **Dec 2, 2026, 9 PM ET / 8 PM CT**.
