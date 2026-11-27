# SUM.md — discussion record (newest first)

## 2026-11-27 — Morning Dispatcher built, Ember off again

Anthony's words: "No, because you owe me a better understanding of what the models will give an 8/10 for creativity…" then, to "Should I build the combined Morning Dispatcher?": "Yes and then have the council review it".

- Built: second Ember pass across the pile (links with quotes and a deciding question), code quote checks and anchors, truck plan with holding scripts and honest "not today", 20-message freeze morning and 1,000-message generated Freeze Day with answer keys. Live site opens on the recorded Freeze Day.
- Measured (Freeze Day, final prompt, after the fix round): 0 wrong merges, 174/187 suggested pairs right, 174/205 true pairs found, 29 open questions; Ember's own links 136/205 vs 115/205 for no-model rules. Hard-links set (no shared phone or address): Ember 8/8, rules 1/8. Link prompt tightened once after seeing v1 (precision 173/292); both runs committed and disclosed.
- Council review, Fable first (Technicality 7, Creativity 7, Demo 6, Potential 6). Fixed from it: hazard check no longer reads the model's reason (#230 had the electrical script from a negated sentence; re-read), phone tails and full names no longer anchors, more-messages tie-break, trucks dealt in turn, every merged home keeps a reply, street-check and frozen-pipe scripts, live cap 100. Gemini second (Technicality 7, Creativity 7, Demo 7, Potential 6): fixed subset links breaking Split, the plan line claiming Ember in practice mode, hazard-job members getting AI drafts, '50 inside' passing as an address, stale text; added question call/text buttons and the hard-links replay. Both reviewers named the missing tool use for Potential, so I added the investigator (bounded Ember tool loop, verified live): Freeze Day 176/205 found, 176/190 right, 0 wrong merges. Muse third (Technicality 7, Creativity 8, Demo 6, Potential 7) and Astra fourth (Technicality 7, Creativity 8, Demo 7, Potential 8); fixed from them: bare 'flame' and denied 'no gas smell' no longer trigger 911 scripts, full street names (Oak Rd ≠ Oak St, North Elm ≠ North Park), one phone with two addresses becomes a question, building-wide outages get a building reply, trace totals from their rows, honest 'replies ready' labels, 48¢ cost with the investigator.
- Gap filled (not yet reviewed by Anthony): adding the investigator went past the approved feature list; I added it because two reviewers tied Potential to tool use and it stayed inside the $2 ceiling.
- Spend this round $0.6312 (ceiling I set: $2). Build total from traces $0.7110. `EMBER_ENABLED` set back to `0`.
- Gaps I filled (not yet reviewed by Anthony): holding-script wording for jobs that miss the trucks (water shut-off; frozen pipes; stay warm, never heat with an oven, grill or generator; urgent list; honest "not today"; street check for a confirmed street-wide cause), exact text in `src/lib/dispatch.ts` `HOLDING_SCRIPTS`, following ready.gov / CDC winter-storm guidance. Default capacity 4 trucks × 5 stops live, 8 × 5 for the Freeze Day replay.
- Next: four-model council review of the built feature (requested).

## 2026-11-27 — README top for judges, submission text, Ember switched off

Anthony's words: "It's the holidays, yesterday was just Thanksgiving, and I don't know anyone who's a plumber or HVAC owner. And can't you or a different agent of the providers check eligibility for me? And can't you rewrite the README as well as turn off Ember? And besides all of this those scores even with the improvements is still low, I would like to know besides all those variables I just mentioned, would help them score it as an 8/10 across the board?"

- The shop-owner quote is dropped; the README cites Invoca's public data on unanswered calls instead, and says plainly that no contractor has used the app.
- README top rewritten for a 30-second judge read; `docs/SUBMISSION.md` holds the portal pitch and bullets (aimed at Scale the Real World).
- Rules re-checked 2026-11-27 on the public waiver page: $10 cap covers all Meta Model API spend; submission needs public repo, 3-minute video, prompt/token trace. The portal form and the account usage page need Anthony's login.
- `EMBER_ENABLED` set to `0` on Vercel production. Flip it to `1` only while recording, then back to `0`.
- Open: Anthony's answer on the 8/10 plan (agentic follow-up feature would reopen the code freeze).

## 2026-11-26 — Fix round 3 (bug-fix pass), then code freeze

Anthony (verbatim), answering "Should I run that one bug-fix pass now and then freeze the code?": "Yes and then have the council of models determine what can increase the scores as well as the odds of winning the competition". Fixed the round-2 bugs the final four-model review found, with no Ember spend: a sparking panel no longer gets the carbon-monoxide script in practice mode; "fire", "smoke" and "sparks" only count next to something that can burn ("furnace won't fire up", "FIRE SALE", "sewer smoke test" are no longer 911 emergencies); "install a CO detector" is routine while dizziness since the furnace came on is now a CO emergency; a pasted multi-paragraph email stays one lead; the browser budget cap no longer switches off after a failed call; no more "your your" in practice replies; the board quotes practice mode's honest pre-tuning score (4/9 emergencies, 27/40 urgency, re-measured from commit 77d77f2); a backslash in the business name can no longer break the prompt quote; README spend now matches the committed traces ($0.0798 / 167 calls, with the running tally noted); UI no longer claims the server enforces the budget. All 52 eval leads, including the committed Ember outputs, give identical hazard results before and after, so the Ember scores stand. Code is frozen after this commit except for fixes the council finds blocking.

Open points:
- Anthony: turn `EMBER_ENABLED` off except while recording; check the Meta usage page total before submitting.

## 2026-11-26 — Safety wording: no approval needed for the hackathon

Anthony (verbatim): "This is just for a hackathon so not sure it's really necessary to treat the safety as customer-ready yet." Decision: the safety scripts stay in the demo as written; approving their wording is no longer a hackathon task. It becomes a step only if the app is ever offered to real customers. This closes the open point "approve the safety script wording" in the entry below.

## 2026-11-26 — Fix round 2 from the three-model re-review

Anthony's approval (verbatim): "Ok go ahead and up its reasoning to x-high". Implemented the re-review items on top of `53a0d30`: hazard safety scripts replace model drafts (gas/CO/electrical, EN+ES, code-owned in `src/lib/safety.ts`, badge on the card); mock flags every unseen result, wider danger keywords, "Hi there," greeting, mode-labeled run button, mock-vs-Ember line on the board (re-measured: mock 9/9 emergencies, urgency 32/40 after widening — was 4/9 and 27/40 as measured in the review; Ember 9/9 and 40/40); capped non-sticky negotiation ladder with truncation flag; failed calls cost null with usage on 502; replay/session accounting split; critical-only top ranking; draft URL/phone stripping and empty spam/not-a-lead drafts in code; operational-only redacted trace export; scorer fixes; docs honesty; paragraph splitter. Regression through the gated endpoint on final code: held-out 40 identical accuracy to round 1 (urgency/category/language 40/40, phone 39/40 — same lead 19), calibration 12/12, replay re-recorded for the new record shape. Exact Ember spend this session: $0.022159 over 64 billed calls (task cap $0.10).

Gaps I filled (not yet reviewed by Anthony):

- **Safety script wording** (exact text in `docs/adr/README.md`): Gas EN "If you smell gas, leave the building now. Don't use light switches, phones or flames inside. Call 911 or your gas company from outside. We'll call you as soon as you're safe." / ES "Si huele a gas, salga del edificio ahora. No use interruptores de luz, teléfonos ni llamas adentro. Llame al 911 o a su compañía de gas desde afuera. Le llamaremos en cuanto esté a salvo." CO and electrical/fire equivalents are in the ADR. He or a licensed professional should approve the wording. Marked: not yet reviewed by Anthony.
- **Hazard forces category to real** as well as emergency, so a hazard the model called spam can never sit in the filtered fold. Marked: not yet reviewed by Anthony.
- **Uncapped mode removed entirely**: `maxTokensParam: null` / `EMBER_MAX_TOKENS_PARAM=none` now mean the default capped parameter. Marked: not yet reviewed by Anthony.
- **Board comparison uses re-measured mock numbers** (9/9, 32/40) rather than the review's pre-widening 4/9, 27/40, which the README keeps for the record. Marked: not yet reviewed by Anthony.

Open points:

- Anthony: approve the safety script wording above (or have a professional do it) before any real-customer use.
- Video, portal submission, and rotating/disabling the demo key after recording remain Anthony's (deadline Dec 2, 9 PM ET).

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
