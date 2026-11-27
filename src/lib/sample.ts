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

// Freeze morning (fictional demo data): 20 messages from the morning
// after a hard freeze, written so some belong together. Used for live
// Ember runs of the Morning Dispatcher (fits one link call).
// FREEZE_GROUPS is the answer key the eval scores links against
// (0-based positions in FREEZE_LEADS).
export const FREEZE_LEADS: string[] = [
  // 0 — A: burst pipe, wife
  "Pipe burst in the hall bathroom wall, water coming out under the baseboard. I shut the main off but the floor is soaked. Linda Garza, 418 Mesquite St, 361-555-0110",
  // 1 — B: no heat, elderly
  "our heater stopped working overnight and my mom is 81, house is down to 52 degrees. please call 361-555-0142",
  // 2 — C: street with no water
  "No water at all since about 6am at 1207 Laguna Dr. My neighbor says hers is out too. Is it the city or our pipes? - Gabe 361-555-0121",
  // 3 — hard negative: frozen pipes, different street
  "Pipes froze I think, no water in the kitchen or bathroom. 77 Holly Rd, Flour Bluff. Maria Reyes 361-555-0131",
  // 4 — spam
  "WINTER STORM BLOWOUT! Portable generators 50% off today only. Reply YES to reserve yours before they're gone!!!",
  // 5 — D: duplex, unit B leak
  "Leak under the kitchen sink in unit B of the duplex on Ocean Dr, it's dripping into the cabinet pretty steady. Tina 361-555-0163",
  // 6 — A: husband follow-up
  "This is Ray, Linda's husband, about the burst pipe at 418 Mesquite. Any idea when someone can come? My cell is 361-555-0186",
  // 7 — C: same street
  "Whole street on Laguna has no water?? 1215 Laguna Dr. nothing from any faucet. Dave 361-555-0124",
  // 8 — hazard: CO alarm
  "CO alarm going off, we had a space heater running all night. Everybody is outside now. 909 Yorktown Blvd, Sam Ortiz 361-555-0157",
  // 9 — routine quote
  "Can I get a quote to insulate the pipes under my house before the next freeze? No rush. Ken Bauer, Padre Island, 361-555-0168",
  // 10 — B: same phone follow-up
  "Still no heat here, she's wrapped up in blankets. Can you send someone this morning? 361-555-0142",
  // 11 — same-day water heater
  "Water heater won't light since the power came back. No hot water. Carlos Mendez, Calallen, 361-555-0179",
  // 12 — C: Spanish, same street
  "Hola, no tenemos agua desde la mañana en la calle Laguna, 1230 Laguna Dr. Mis vecinos tampoco. Rosa 361-555-0135",
  // 13 — hard negative: a different Maria
  "Hi it's Maria, outside faucet cracked from the cold and drips a little. Not urgent, whenever you can. 5521 Weber Rd, 361-555-0148",
  // 14 — D: duplex, landlord, unit A
  "Landlord here. Tenant in unit A says water is coming through the shared wall from next door. 2240 Ocean Dr. Marcus 361-555-0175",
  // 15 — wrong number
  "hey is this Rick? you left your jacket at my place lol",
  // 16 — hard negative: frozen pipes, another street
  "No water this morning, I think our pipes froze overnight. 3310 Staples St. Jen 361-555-0193",
  // 17 — emergency burst, unrelated
  "HELP water pouring through the ceiling from the attic, a pipe must have burst. 612 Alameda St, Anne Price 361-555-0102",
  // 18 — routine
  "Our kitchen faucet is loose and wobbles. Could someone take a look next week? Priya, Southside, 361-555-0159",
  // 19 — spam robocall
  "This is an urgent message about your vehicle's extended warranty. Press 1 to speak to a specialist now.",
];

/** Messages that truly belong together (answer key for the link eval). */
export const FREEZE_GROUPS: Array<{ kind: "same_job" | "shared_cause"; members: number[]; note: string }> = [
  { kind: "same_job", members: [0, 6], note: "Linda and her husband Ray, same address" },
  { kind: "same_job", members: [1, 10], note: "same phone, second message" },
  { kind: "shared_cause", members: [2, 7, 12], note: "three homes on Laguna Dr, no water since morning" },
  { kind: "same_job", members: [5, 14], note: "duplex on Ocean Dr: unit B leak may be what comes through unit A's wall" },
];

// Hard links (fictional demo data): 23 messages where the messages that
// belong together share no phone number and no house number + street, so
// code rules alone can't connect them. Written 2026-11-27, after the
// Freeze Day run, to measure what Ember adds over rules. HARD_GROUPS is
// the answer key (0-based positions in HARD_LEADS).
export const HARD_LEADS: string[] = [
  // 0 — G1a
  "Water heater flooded the garage at my mom's place on Holly, she's 79 and can't get to the shut-off. I'm her son Victor, 512-555-0181",
  // 1 — negative: same first name as 13, different person
  "Maria here, kitchen faucet dripping on Weber, no rush. 361-555-0113",
  // 2 — G5a
  "No hot water in the whole building at Seaside Villas this morning, the other tenants are complaining too. Unit 4, Ana 361-555-0151",
  // 3 — G3a
  "Tenant at Bayview Apartments unit 12, toilet overflowing and water going under the door into the hall. Kim 956-555-0144",
  // 4 — negative: same street as G1, different house and problem
  "Pipes froze at my place on Holly Rd, the blue house on the corner. 979-555-0101",
  // 5 — G4a
  "Hey it's Bobby, heater died overnight at the duplex on Purdue, left side. 830-555-0105",
  // 6 — G2a
  "Hola, soy Alma Treviño, se reventó un tubo debajo del lavabo y está mojado todo el piso. Estoy en Gollihar cerca de la escuela. 361-555-0127",
  // 7 — G6a
  "Nobody on Tiger Lane has water, my whole cul-de-sac is dry. Carla 361-555-0109",
  // 8 — negative: another building
  "Furnace not working at my apartment, unit 7 at Harbor Point. 254-555-0168",
  // 9 — G1b
  "This is Gloria Salinas, my son Victor said he called you about my garage flooding. I'm at home on Holly Rd, the white house by the church. 361-555-0119",
  // 10 — spam
  "Storm damage restoration leads for contractors! Exclusive zip codes, call now.",
  // 11 — G5b
  "Seaside Villas unit 9, no hot water since 6am, my neighbor across the hall has none either. Omar 713-555-0177",
  // 12 — negative: same street as G4, different building
  "Heater out at the Purdue Street fourplex, unit C. Lena 979-555-0139",
  // 13 — negative: another Maria
  "Maria Lopez, burst pipe in the attic, water coming through the ceiling, Calallen. 281-555-0164",
  // 14 — G3b
  "Property manager for Bayview Apartments. Unit 12 called me about an overflowing toilet leaking into the hallway, please send someone, bill us. Hector 361-555-0162",
  // 15 — negative: says only their house
  "No water at my house on Airline Rd this morning, I think my pipes froze. Just my house, neighbors are fine. 432-555-0119",
  // 16 — G2b
  "Hi, calling for my grandma Alma Treviño, she doesn't speak much English. Pipe under her sink burst, she's near the school on Gollihar. I'm Daniel, 210-555-0188",
  // 17 — negative: similar problem, different place
  "Toilet overflowing at my house in Flour Bluff. Sam 361-555-0171",
  // 18 — G6b
  "Water's off at our house on Tiger Ln and the neighbors say theirs too, is it the main? Ray 409-555-0123",
  // 19 — routine
  "Quote for a water softener next month. Tim, Padre Island, 361-555-0185",
  // 20 — G4b
  "Robert Nguyen here, left side of the Purdue duplex. Wrote earlier, still no heat and it's 50 inside. 830-555-0192",
  // 21 — negative: a store, not the apartments
  "Hot water heater leaking at Seaside Market (the store, not the apartments). 361-555-0147",
  // 22 — G5c
  "Hola, en Seaside Villas no hay agua caliente, apartamento 2. Rosa 956-555-0133",
];

export const HARD_GROUPS: Array<{ kind: "same_job" | "shared_cause"; members: number[]; note: string }> = [
  { kind: "same_job", members: [0, 9], note: "son calls for his mother; she writes herself; no shared phone or house number" },
  { kind: "same_job", members: [6, 16], note: "grandmother in Spanish, grandson in English" },
  { kind: "same_job", members: [3, 14], note: "tenant and property manager, same unit" },
  { kind: "same_job", members: [5, 20], note: "Bobby and Robert, left side of the Purdue duplex, different phones" },
  { kind: "shared_cause", members: [2, 11, 22], note: "whole building without hot water" },
  { kind: "shared_cause", members: [7, 18], note: "Tiger Lane without water, no house numbers" },
];
