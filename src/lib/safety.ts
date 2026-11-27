// Hazard safety scripts (code-owned, never model text).
//
// When a lead describes a gas, carbon-monoxide, or electrical/fire
// hazard, the model's follow-up draft is NOT safe to send ("we'll reach
// out shortly" is the wrong answer to a gas leak). Code detects the
// hazard from the raw lead (English + Spanish keywords) and from the
// model's own service/urgency fields, forces urgency to emergency,
// forces the lead visible (category real), and replaces the draft with
// one of the fixed scripts below, in the lead's language. The card
// shows a "Safety script, not AI text" badge off `safety_script`.
//
// Wording follows the shape of US federal guidance (PHMSA for gas:
// leave immediately, call 911 or the gas utility from a safe place).
// Anthony accepted it as hackathon demo wording (SUM.md, 2026-11-26);
// a licensed professional should review it before real-customer use.
//
// Detection reads the raw lead first. The model's service/urgency
// fields are consulted only when the raw text names no hazard, so a
// generated reason that lists several hazards can't pick the script.

import type { HazardKind, Language, LeadRecord } from "./schema.js";

export const SAFETY_SCRIPTS: Record<HazardKind, Record<Language, string>> = {
  gas: {
    en: "If you smell gas, leave the building now. Don't use light switches, phones or flames inside. Call 911 or your gas company from outside. We'll call you as soon as you're safe.",
    es: "Si huele a gas, salga del edificio ahora. No use interruptores de luz, teléfonos ni llamas adentro. Llame al 911 o a su compañía de gas desde afuera. Le llamaremos en cuanto esté a salvo.",
  },
  co: {
    en: "If your carbon monoxide alarm is sounding or you feel dizzy, sick or get a headache indoors, leave the building now and get fresh air. Call 911 from outside. Don't go back in until responders say it's safe. We'll call you as soon as you're safe.",
    es: "Si suena su alarma de monóxido de carbono o se siente mareado, enfermo o con dolor de cabeza adentro, salga del edificio ahora y respire aire fresco. Llame al 911 desde afuera. No vuelva a entrar hasta que los servicios de emergencia digan que es seguro. Le llamaremos en cuanto esté a salvo.",
  },
  electrical: {
    en: "If you see sparking, smoke or fire, or smell burning wiring, leave the building now if it's not safe to stay. Don't touch the panel, outlet or appliance, and don't use water on an electrical fire. Call 911 from a safe place. We'll call you as soon as you're safe.",
    es: "Si ve chispas, humo o fuego, o huele a cableado quemado, salga del edificio ahora si no es seguro quedarse. No toque el panel, el enchufe ni el aparato, y no use agua en un fuego eléctrico. Llame al 911 desde un lugar seguro. Le llamaremos en cuanto esté a salvo.",
  },
};

// Phrase-level patterns, not single loose words: a quote to install a
// gas water heater or swap a smoke detector must not trigger a script.
const GAS_PATTERNS: RegExp[] = [
  /smell(s|ing)?\s+(of\s+)?gas/,
  /gas\s+(smell|leak|leaking|odor)/,
  /rotten[-\s]?egg/,
  /olor\s+a\s+gas/,
  /huele\s+a\s+gas/,
  /huel[eo]\s+.*\bgas\b/,
  /fuga\s+de\s+gas/,
  /huevos?\s+podridos?/,
];

// Carbon monoxide: an alarm that is actually going off, a named CO
// leak/poisoning, or CO-type symptoms tied to a fuel-burning appliance.
// "Install a CO detector next month" is routine work, not an emergency.
const CO_NAME = String.raw`(carbon\s+monoxide|\bco\b|mon[óo]xido(\s+de\s+carbono)?)`;
const CO_DEVICE = String.raw`(alarms?|detectors?|sensors?|alarma|detector)`;
const CO_FIRING = String.raw`(going\s+off|went\s+off|goes\s+off|sounding|beeping|alarming|triggered|reading|est[áa]\s+sonando|sonando|suena|son[óo]|pitando)`;
const CO_LINK = String.raw`(\s+(is|keeps|has\s+been|started|just|keeps\s+on))?\s+`;
const CO_ACTIVE_PATTERNS: RegExp[] = [
  new RegExp(`${CO_NAME}\\s*${CO_DEVICE}?${CO_LINK}${CO_FIRING}`),
  new RegExp(`${CO_DEVICE}\\s+(de\\s+|for\\s+)?${CO_NAME}${CO_LINK}${CO_FIRING}`),
  new RegExp(`${CO_NAME}\\s*(leak|leaking|poisoning|fuga|intoxicaci[óo]n|envenenamiento)`),
];
const CO_SYMPTOM = /\b(dizzy|dizziness|headaches?|nause(a|ous|ated)|light-?headed|mareado|mareada|mareos?|dolor(es)?\s+de\s+cabeza|n[áa]useas?)\b/;
const CO_SOURCE = /\b(furnace|heater|boiler|heat\s+(came|come|comes|turned|kicked)\s+on|gas\s+(stove|range|dryer|fireplace)|generator|calefacci[óo]n|calentador|estufa|caldera|generador)\b/;

function hasCo(hay: string): boolean {
  if (CO_ACTIVE_PATTERNS.some((p) => p.test(hay))) return true;
  return CO_SYMPTOM.test(hay) && CO_SOURCE.test(hay);
}

// Electrical / fire: sparks, smoke or flames tied to something that
// can actually be on fire. Bare "fire" or "smoke" is not enough:
// "furnace won't fire up", "FIRE SALE" and "sewer smoke test" are not
// emergencies.
const ELEC_THING = String.raw`(panel|outlet|breaker|wires?|wiring|switch|plug|socket|cord|appliance|fixture|light|meter|box|wall|ceiling|fan|dryer|microwave|oven|stove|tv|electrical|electric)`;
const ELEC_BAD = String.raw`(spark(ing|s|ed)?|smok(e|ing)|burning|on\s+fire|caught\s+fire|melt(ed|ing)|scorch(ed|ing))`;
const ES_THING = String.raw`(panel|enchufe|tomacorriente|cables?|breaker|interruptor|caja|medidor|el[ée]ctric[oa])`;
const ELECTRICAL_PATTERNS: RegExp[] = [
  new RegExp(String.raw`spark(ing|s|ed)?\b(?!\s*plug)[^.]{0,60}\b${ELEC_THING}\b`),
  new RegExp(String.raw`\b${ELEC_THING}\b[^.]{0,60}\b${ELEC_BAD}\b`),
  /burning\s+(smell|wiring|wire|plastic|electrical)/,
  /smell(s|ing)?\s+(like\s+)?(burning|smoke)/,
  /electrical\s+(hazard|fire)/,
  /\bsmoke\s+(is\s+)?(coming|pouring|filling|billowing)\b/,
  /\b(on|caught|catching)\s+fire\b/,
  /\b(house|kitchen|garage|attic|electrical|grease)\s+fire\b/,
  /\bthere'?s\s+(a\s+)?fire\b/,
  /\bflames?\b/,
  /echando\s+chispas/,
  new RegExp(String.raw`\bchispas\b[^.]{0,60}\b${ES_THING}\b`),
  new RegExp(String.raw`\b${ES_THING}\b[^.]{0,60}\b(chispas|humo|quemando|quemado|fuego)\b`),
  /olor\s+a\s+(quemado|cable|humo)/,
  /huele\s+a\s+(quemado|cable|humo)/,
  /cableado\s+quemado/,
  /\b(sale|saliendo|hay)\s+humo\b/,
  /\bincendio\b/,
  /\b(se\s+est[áa]\s+quemando|en\s+llamas|llamas)\b/,
  /riesgo\s+el[ée]ctrico/,
];

/**
 * Detect a life-safety hazard in any of the given texts (the raw lead,
 * or the model's short service label). Gas wins over CO wins
 * over electrical when several match: each script starts with "leave
 * now, call 911", so the order only picks the most specific wording.
 */
export function detectHazard(texts: Array<string | null | undefined>): HazardKind | null {
  const hay = texts.filter(Boolean).join("\n").toLowerCase();
  if (!hay.trim()) return null;
  if (GAS_PATTERNS.some((p) => p.test(hay))) return "gas";
  if (hasCo(hay)) return "co";
  // "Install a smoke detector / fireplace" is routine work, not a fire.
  const elecHay = hay.replace(/smoke\s+(detectors?|alarms?|test(ing|s)?)|fireplace|fire\s+pit|fire\s+extinguishers?|fire\s+sale|detectores?\s+de\s+humo/g, " ");
  if (ELECTRICAL_PATTERNS.some((p) => p.test(elecHay))) return "electrical";
  return null;
}

/**
 * Force a hazard lead to the fixed safety script. Mutates and returns
 * the record (callers own it). Non-hazard records just get
 * `safety_script: null` stamped so the field is always present on
 * freshly produced records.
 */
export function applyHazardSafety(record: LeadRecord): LeadRecord {
  // The model's urgency_reason is never read here: it can explain why a
  // message is NOT a hazard ("no gas or electrical hazard is stated"),
  // and a pattern can't tell that negation from a report. The short
  // service label is consulted only when the raw text names no hazard.
  const kind = detectHazard([record.raw_text]) ?? detectHazard([record.service_needed]);
  if (!kind) {
    record.safety_script = record.safety_script ?? null;
    return record;
  }
  record.safety_script = kind;
  record.urgency = "emergency";
  // A hazard folded into spam is a hazard nobody sees.
  record.category = "real";
  record.followup_draft = SAFETY_SCRIPTS[kind][record.language];
  return record;
}
