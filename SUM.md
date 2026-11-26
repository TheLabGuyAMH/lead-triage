# SUM.md — discussion record (newest first)

## 2026-11-26 — Scope item 4 "Prove it" completed via the live gated endpoint

Follow-up to the review-fixes session below: with `MODEL_API_KEY` still a pull-proof Vercel Secret, the eval and replay ran through the live passcode-gated production endpoint (`--endpoint` mode in `scripts/eval-ember.mjs` / `scripts/record-replay.mjs`, `x-demo-key` from a freshly pulled production env file, concurrency 3, one retry on 502/timeout, hard spend guard).

- **Truncation found and fixed first**: at the old 1,500-token cap, held-out leads 1–5 used 1,217–1,454 completion tokens and one needed a 502 retry. Cap raised to 3,000 (`EMBER_MAX_TOKENS`), `finish_reason` now returned on every result, and `EMBER_REASONING_EFFORT=low` set in production. Same 5 leads after: max 766 tokens, all `finish_reason=stop`, 5/5 accuracy both ways.
- **Held-out 40 (final settings)**: urgency 40/40, category 40/40, emergency recall/precision 9/9, phone 39/40 (lead 19: word-spelled number grounded out to `needs_review`, as designed), language 40/40, structured compliance 40/40, injection 0/3, $0.000360/lead, p50 1.58s. **Default-effort sweep**: identical accuracy at $0.000822/lead, so `low` stayed. **Calibration set**: 12/12 across the board. No expected labels changed; no disputed labels. Results and traces committed under `evals/` and `traces/`; README table filled.
- **Replay**: the 12-lead sample recorded on final settings and bundled in `src/lib/replay-data.ts`; live bundle verified to contain the recorded run (model draft text, `effort=low` variant), so the public default now shows a real Ember board at $0 per view.
- **Exact Ember spend this session: $0.061006 over 114 billed calls** (from per-response usage at $0.10/$0.50 per MTok), plus 2 retried 502 attempts whose usage the server does not expose. Task cap was $0.25.

Gaps I filled (not yet reviewed by Anthony):

- **Two empty redeploy commits** (`38d545a`, `91d61f0`) exist only to flip `EMBER_REASONING_EFFORT` off for the sweep and back on after; Vercel applies env changes only on a new deployment. Marked: not yet reviewed by Anthony.
- **`EMBER_REASONING_EFFORT` stored as a Secret-type variable** (CLI default) although its value `low` is not sensitive; it only means the value cannot be read back from a pull. Marked: not yet reviewed by Anthony.

Open points:

- Anthony: copy `EMBER_DEMO_KEY` from the Vercel dashboard (project `lead-triage`, Production) into the app's config panel to use live Ember mode for recording.
- Video and portal items remain Anthony's schedule (submission by Dec 2, 9 PM ET) — untouched by this task.
- Post-submission: keep `EMBER_ENABLED` discipline through judging; rotate or remove keys per the review's submission checklist.

## 2026-11-26 — Review fixes implemented by Muse Wonder Full

Anthony's request, verbatim: "Can we actually just have Muse Wonder Full High from Meta make the fixes and then have the same council (minus Muse) review the fixes and grade the project?"

Implemented the merged four-model review's patches (endpoint lock, fail-closed reliability, prompt cleanup, eval harness, workbench UI, docs) on top of commit `2841fce`, pushed to `main`, deployed, and verified live with free probes plus one gated Ember smoke call (held-out lead 2: emergency correct, $0.000751; strictly structured output accepted — see `traces/ember-live-smoke-2026-11-26.json`).

Gaps I filled (not yet reviewed by Anthony):

- **Local eval could not run**: `MODEL_API_KEY` is stored as a pull-proof Vercel Secret (`vercel env pull` and `vercel env run` both return it redacted) and no local copy exists on this machine, so instead of running the 40-lead eval/replay/sweep here I shipped budget-guarded scripts (`scripts/eval-ember.mjs`, `scripts/record-replay.mjs`, `scripts/test-structured.mjs`), the pre-registered `evals/heldout.jsonl`, and published the blocker plus exact commands in the README. Marked: not yet reviewed by Anthony.
- **Negotiation ladder**: to still settle the structured-output question inside the single allowed live call, the Ember adapter negotiates uncertain parameters on HTTP 400 only and stamps `request_variant` on results. Marked: not yet reviewed by Anthony.
- **Demo key variable type**: `EMBER_DEMO_KEY` was created as a readable Config-type variable (not a write-only Secret) so Anthony can copy it from the Vercel dashboard — otherwise nobody could ever use Ember mode. Reason recorded in `docs/adr/README.md`. Marked: not yet reviewed by Anthony.
- **Sample paste order**: "Load sample set" now pastes the 12 leads shuffled with an emergency last, per the review's demo note, so runs visibly reorder. Marked: not yet reviewed by Anthony.

Open points:

- ~~Run the held-out eval + calibration line + replay recording, then fill the metrics table; sweep `reasoning_effort`.~~ Done 2026-11-26 via the gated endpoint — see the entry above.
- Anthony: copy `EMBER_DEMO_KEY` from the Vercel dashboard (project `lead-triage`, Production) into the app's config panel to use live Ember mode for recording.
- Video and portal items remain Anthony's schedule (safety cut, final Dec 1 recording, submission by Dec 2, 9 PM ET) — untouched by this task.
- Post-submission: keep `EMBER_ENABLED` discipline through judging; rotate or remove keys per the review's submission checklist.
