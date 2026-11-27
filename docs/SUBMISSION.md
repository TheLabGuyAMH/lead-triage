# Submission text (Cerebral Valley portal)

Aimed at the **Scale the Real World** prize: "solving a real, messy problem at a scale, speed, or unit cost that only works because of Ember."

## One-paragraph pitch

The morning after a hard freeze, a small plumbing shop wakes up to hundreds of messages, and many of them are the same job: a wife and husband reporting one burst pipe, five houses on one street with no water from one broken main. Lead Triage is a Morning Dispatcher. Muse Ember reads every message, then reads the whole pile for messages that belong together, quoting the exact words that prove each link and writing the one question that would settle a doubtful one. Code checks every quote against the original message, merges only what is proven or what the owner confirms, fills today's truck slots, and gives everyone who misses a truck a fixed shut-off-your-water or stay-warm-safely script or an honest "not today". On a 1,000-message Freeze Day it merged 99 pairs with zero wrong merges and found 85% of the true links, for about 46 cents for the whole morning.

## Bullets for judges

- **Ember reads the pile, not just the message:** a second Ember pass links duplicates and shared causes across 1,000 messages in 122 calls, with quotes and a deciding question for each doubtful link.
- **Measured, with an answer key:** Freeze Day (1,000 messages): 0 wrong merges, 174/187 suggested pairs right, 174/205 true pairs found; hand-written 20-message morning: 6/6. Per-message reading on 40 held-out leads: 9/9 emergencies, 40/40 urgency and category.
- **Ember reads; code decides what's safe:** every quote must really be in the message; auto-merge needs a shared phone, house number + street or full name; hazards get code-owned 911 scripts, never AI text.
- **Unit cost only Ember makes trivial:** $0.39 to read 1,000 messages plus $0.07 to link them.
- **Honest limits:** synthetic data (the 1,000 are template-generated), no contractor has used it, the link prompt was tightened once after the first Freeze Day run (both runs committed), total build spend $0.64 of the $10 cap.

## Links

- Repo: https://github.com/TheLabGuyAMH/lead-triage
- Live: https://lead-triage-nine.vercel.app (opens on the recorded Freeze Day run)
- Token traces: `traces/ember-dispatch-freeze1000-2026-11-27.json` and the other files in `traces/`; results in `evals/`
