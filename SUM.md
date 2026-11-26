# SUM.md — discussion record (newest first)

## 2026-11-26 — Review fixes implemented by Muse Wonder Full

Anthony's request, verbatim: "Can we actually just have Muse Wonder Full High from Meta make the fixes and then have the same council (minus Muse) review the fixes and grade the project?"

Implemented the merged four-model review's patches (endpoint lock, fail-closed reliability, prompt cleanup, eval harness, workbench UI, docs) on top of commit `2841fce`, pushed to `main`, deployed, and verified live with free probes plus one gated Ember smoke call (held-out lead 2: emergency correct, $0.000751; strictly structured output accepted — see `traces/ember-live-smoke-2026-11-26.json`).

Gaps I filled (not yet reviewed by Anthony):

- **Local eval could not run**: `MODEL_API_KEY` is stored as a pull-proof Vercel Secret (`vercel env pull` and `vercel env run` both return it redacted) and no local copy exists on this machine, so instead of running the 40-lead eval/replay/sweep here I shipped budget-guarded scripts (`scripts/eval-ember.mjs`, `scripts/record-replay.mjs`, `scripts/test-structured.mjs`), the pre-registered `evals/heldout.jsonl`, and published the blocker plus exact commands in the README. Marked: not yet reviewed by Anthony.
- **Negotiation ladder**: to still settle the structured-output question inside the single allowed live call, the Ember adapter negotiates uncertain parameters on HTTP 400 only and stamps `request_variant` on results. Marked: not yet reviewed by Anthony.
- **Demo key variable type**: `EMBER_DEMO_KEY` was created as a readable Config-type variable (not a write-only Secret) so Anthony can copy it from the Vercel dashboard — otherwise nobody could ever use Ember mode. Reason recorded in `docs/adr/README.md`. Marked: not yet reviewed by Anthony.
- **Sample paste order**: "Load sample set" now pastes the 12 leads shuffled with an emergency last, per the review's demo note, so runs visibly reorder. Marked: not yet reviewed by Anthony.

Open points:

- Run the held-out eval + calibration line + replay recording from a machine/session with `MODEL_API_KEY` in the environment (commands in README), then fill the metrics table; sweep `reasoning_effort` only if `scripts/test-structured.mjs` shows it is accepted.
- Anthony: copy `EMBER_DEMO_KEY` from the Vercel dashboard (project `lead-triage`, Production) into the app's config panel to use live Ember mode for recording.
- Video and portal items remain Anthony's schedule (safety cut, final Dec 1 recording, submission by Dec 2, 9 PM ET) — untouched by this task.
- Post-submission: keep `EMBER_ENABLED` discipline through judging; rotate or remove keys per the review's submission checklist.
