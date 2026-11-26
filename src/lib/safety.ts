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
// Anthony / a licensed professional should approve the exact wording;
// it is recorded verbatim in docs/adr/README.md and SUM.md as a gap
// fill not yet reviewed by Anthony.

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

const CO_PATTERNS: RegExp[] = [
  /carbon\s+monoxide/,
  /mon[óo]xido\s+de\s+carbono/,
  /\bco\b\s*(alarm|detector|sensor)/,
  /(alarm|detector|alarma)\s*(de\s+)?(co|mon[óo]xido)/,
  /alarma\s+de\s+mon[óo]xido/,
];

const ELECTRICAL_PATTERNS: RegExp[] = [
  /spark(ing|s|ed)?\b/,
  /burning\s+(smell|wiring|wire|plastic|electrical)/,
  /smell(s|ing)?\s+(like\s+)?burning/,
  /electrical\s+(hazard|fire)/,
  /\bsmoke\b.*\b(panel|outlet|breaker|wire|wiring|appliance|wall)\b/,
  /\b(panel|outlet|breaker)\b.*\b(smoke|smoking|fire|burning)\b/,
  /\bon\s+fire\b/,
  /\bsmok(e|ing)\b/,
  /\bfire\b/,
  /echando\s+chispas/,
  /\bchispas\b/,
  /olor\s+a\s+(quemado|cable)/,
  /huele\s+a\s+(quemado|cable)/,
  /cableado\s+quemado/,
  /\bhumo\b/,
  /\bfuego\b/,
  /riesgo\s+el[ée]ctrico/,
];

/**
 * Detect a life-safety hazard in any of the given texts (raw lead,
 * model service_needed, model urgency_reason). Gas wins over CO wins
 * over electrical when several match: each script starts with "leave
 * now, call 911", so the order only picks the most specific wording.
 */
export function detectHazard(texts: Array<string | null | undefined>): HazardKind | null {
  const hay = texts.filter(Boolean).join("\n").toLowerCase();
  if (!hay.trim()) return null;
  if (GAS_PATTERNS.some((p) => p.test(hay))) return "gas";
  if (CO_PATTERNS.some((p) => p.test(hay))) return "co";
  // "Install a smoke detector / fireplace" is routine work, not a fire.
  const elecHay = hay.replace(/smoke\s+(detector|alarm)|fireplace|fire\s+pit|fire\s+extinguisher|detector\s+de\s+humo/g, " ");
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
  const kind = detectHazard([record.raw_text, record.service_needed, record.urgency_reason]);
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
