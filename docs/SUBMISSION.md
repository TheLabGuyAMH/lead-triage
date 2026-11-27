# Submission text (Cerebral Valley portal)

Aimed at the **Scale the Real World** prize: "solving a real, messy problem at a scale, speed, or unit cost that only works because of Ember."

## One-paragraph pitch

The morning after a hard freeze, a small plumbing shop wakes up to hundreds of messages, and many of them are the same job: a wife and husband reporting one burst pipe, five houses on one street with no water from one broken main. Lead Triage is a Morning Dispatcher. Muse Ember reads every message, then reads the whole pile for messages that belong together, quoting the exact words that prove each link and writing the one question that would settle a doubtful one. Code checks every quote against the original message, merges only what is proven or what the owner confirms, fills today's truck slots, and prepares a fixed shut-off-your-water or stay-warm-safely reply, or an honest "not today", for everyone who misses a truck, for the owner to send. On a 1,000-message Freeze Day it merged 96 pairs with zero wrong merges and found 85% of the true links, for about 48 cents for the whole morning, investigator included. On messages that share no phone or address (a son calling for his mother, a tenant and the property manager), Ember found 8 of 8 links where code rules found 1.

## Bullets for judges

- **An Ember agent for the loose ends:** follow-ups the pass can't place get a bounded tool loop (search, read, propose; at most five turns); every step is shown and the proposal still has to pass code's quote check and the owner's yes.
- **Ember reads the pile, not just the message:** a second Ember pass links duplicates and shared causes across 1,000 messages in 122 calls, with quotes and a deciding question for each doubtful link.
- **Measured, with an answer key:** Freeze Day (1,000 messages): 0 wrong merges, 176/190 suggested pairs right, 176/205 true pairs found; Ember's own links 138/205 vs 106/205 for no-model rules, and 76/87 vs 24/87 on shared causes. Hard-links set (no shared phone or address): Ember 8/8, rules 1/8. Per-message reading on 40 held-out leads: 9/9 emergencies, 40/40 urgency and category.
- **Ember reads; code decides what's safe:** every quote must really be in the message; auto-merge needs a shared phone (with no conflicting address) or the same full address; hazards get code-owned 911 scripts, never AI text.
- **Unit cost only Ember makes trivial:** $0.39 to read 1,000 messages, $0.07 to link them, $0.02 for the investigator.
- **Honest limits:** synthetic data (the 1,000 are template-generated), no contractor has used it, the link prompt was tightened once after the first Freeze Day run (both runs committed), a review found three bugs (fixed, re-measured, disclosed); total build spend $0.71 of the $10 cap.

## Links

- Repo: https://github.com/TheLabGuyAMH/lead-triage
- Live: https://lead-triage-nine.vercel.app (opens on the recorded Freeze Day run)
- Token traces: `traces/ember-dispatch-freeze1000-2026-11-27.json` and the other files in `traces/`; results in `evals/`
