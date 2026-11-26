// The fixed sample lead set (fictional demo data — no real customers).
// Source of truth: sample-lead-set.md in the hackathon goal workspace.
// Business config for the set: Demo Plumbing & AC, plumbing / HVAC,
// friendly and direct. Expected extraction ground truth lives in
// scripts/verify.mjs.

import type { BusinessConfig } from "./schema";

export const SAMPLE_CONFIG: BusinessConfig = {
  businessName: "Demo Plumbing & AC",
  trade: "plumbing / HVAC",
  tone: "friendly-direct",
};

export const SAMPLE_LEADS: string[] = [
  // 1 — Emergency, English, voicemail
  "uh hi this is Maria Delgado, my water heater burst and there's water all over my garage, it's still leaking, I shut off the main but I need somebody today please, I'm over on Saratoga near Everhart, call me back at 361-555-0147",
  // 2 — Emergency, English, web form
  "Name: James Okafor. Phone: (361) 555-0193. Message: No AC since last night, house is 91 degrees, my mother in law is 78 and staying with us, baby too. Need someone ASAP. Address area: Calallen.",
  // 3 — Same-day, Spanish, voicemail
  "Hola, soy Carmen Ruiz, mi aire acondicionado dejó de funcionar anoche y hace mucho calor en la casa. Vivo por la calle Staples, cerca de la SPID. Mi número es 361-555-0118, por favor llámenme hoy si pueden.",
  // 4 — Same-day, English, Facebook message
  "Hey, our kitchen sink is backing up and draining real slow, getting worse since yesterday. Smells bad too. Can y'all come look this week, today if possible? - Derek P., Flour Bluff, 361-555-0172",
  // 5 — Same-day, Spanish, web form
  "Nombre: Luis Herrera. Teléfono: 361-555-0129. Mensaje: La tubería debajo del fregadero de la cocina está goteando desde el lunes y el gabinete ya huele a humedad. Estoy en el Southside. Necesito que lo revisen esta semana por favor.",
  // 6 — Routine, English, voicemail (phone genuinely missing — must stay missing)
  "Hi, this is Sarah, I got your number from my neighbor. I'd like a quote on replacing our water softener sometime in the next few weeks, no rush at all. We're out in Annaville. Oh, and my number is... actually just call the number I left with my neighbor, thanks!",
  // 7 — Routine, English, web form
  "Name: Tom Becker, 361-555-0155. Looking for an annual AC tune-up before summer. Any weekday morning works. Padre Island.",
  // 8 — Routine, English, text message
  "Hi! Do you guys install ceiling fans? Need two put in, already bought them. What do you charge? - Priya, Bay Area, 361-555-0134",
  // 9 — Routine, English, voicemail
  "Hello, this is Robert Nguyen, calling about a bathroom remodel estimate, mainly the shower retile and a new vanity. Not urgent, just planning for early next year. My number is 361-555-0161, I'm downtown.",
  // 10 — Routine / scheduling question, English, web form
  "Name: Angela Torres. Phone: 361-555-0188. Message: Do you offer any maintenance plans for rental properties? I have three units near Del Mar College and I'd like pricing for quarterly checks.",
  // 11 — Spam, English, web form
  "Name: SEO Growth Team. Message: We can get your plumbing company to the #1 spot on Google in 30 days guaranteed! Our lead generation packages start at just $499/month. Reply now to claim your free audit before spots fill up!!!",
  // 12 — Spam / not-a-lead, English, robocall transcript
  "This is an urgent message regarding your vehicle's extended warranty. Our records show your coverage is about to expire. Press 1 to speak to a warranty specialist now.",
];

// Pasted in a deliberately shuffled order (the burst-heater emergency is
// last) so a run visibly re-orders the board instead of confirming the
// paste order. Ground truth in scripts/verify.mjs keys off SAMPLE_LEADS.
const SAMPLE_PASTE_ORDER = [5, 10, 2, 8, 11, 4, 6, 9, 3, 7, 1, 0];
export const SAMPLE_PASTE = SAMPLE_PASTE_ORDER.map((i) => SAMPLE_LEADS[i]).join("\n\n");
