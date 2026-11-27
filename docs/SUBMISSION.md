# Submission text (Cerebral Valley portal)

Aimed at the **Scale the Real World** prize: "solving a real, messy problem at a scale, speed, or unit cost that only works because of Ember."

## One-paragraph pitch

Small plumbing and HVAC shops lose jobs in the gap between a message arriving and someone calling back. Lead Triage turns a morning's pile of voicemails, texts and web forms, in English and Spanish, into a ranked call-back list in seconds: emergencies first, spam folded away, missing phone numbers flagged instead of invented, and a reply drafted in each customer's language. Muse Ember reads every lead into a strict schema; plain code does the ranking, checks every phone number against the original text, and replaces any gas, carbon-monoxide or electrical lead's reply with a fixed "leave now, call 911" script. At $0.000347 per lead, about 35 cents per 1,000, a shop can run every message it gets, every day.

## Bullets for judges

- **Unit cost only Ember makes trivial:** $0.000347 per lead (40 held-out leads, committed results), about 35 cents per 1,000 leads; the full $10 budget covers roughly 28,000.
- **Measured, not claimed:** 9/9 emergencies, 40/40 urgency, category and language, 39/40 exact phone numbers, 0/3 prompt injections worked. Per-lead results and token traces are in the repo.
- **Ember reads; code decides what's safe:** strict structured output, deterministic ranking, phone numbers checked against the lead, hazard leads get code-owned safety scripts, never AI text.
- **Real, messy input:** Spanish and Spanglish, typos, numbers spelled out in words, multi-paragraph emails, spam and injection attempts.
- **Honest limits:** synthetic test leads, no contractor has used it yet; total build spend about $0.08 of the $10 cap.

## Links

- Repo: https://github.com/TheLabGuyAMH/lead-triage
- Live: https://lead-triage-nine.vercel.app
- Token trace: `traces/` (for example `traces/ember-sample12-replay-2026-11-26.json`) and per-lead results in `evals/`
