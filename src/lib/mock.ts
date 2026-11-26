// Mock adapter: deterministic, zero-cost extraction used for all UI
// development, offline demo fallback, and ground-truth verification
// against the sample lead set. It is a heuristic stand-in for Ember —
// honest about what it is (usage is marked estimated, cost $0) — and it
// follows the same contract: fields not in the text come back null,
// never invented.

import { applyHazardSafety, detectHazard } from "./safety.js";
import { SAMPLE_LEADS } from "./sample.js";
import type {
  BusinessConfig,
  Category,
  ExtractionResult,
  Language,
  LeadAdapter,
  LeadRecord,
  Urgency,
} from "./schema.js";

/**
 * Every mock result on text that is not one of the 12 known samples is
 * flagged: heuristics on unseen text are a guess and must never look
 * like an Ember result. Soft flag (keeps its urgency tier).
 */
export const MOCK_REVIEW_NOTE = "Mock heuristics, not Ember. Unlock Ember mode for a real result.";

const SAMPLE_SET = new Set(SAMPLE_LEADS.map((s) => s.trim()));

export function isSampleText(text: string): boolean {
  return SAMPLE_SET.has(text.trim());
}

const SPANISH_SIGNALS = [
  "hola", "soy ", "número", "numero", "teléfono", "telefono", "por favor",
  "llámenme", "llamenme", "necesito", "estoy", "desde", "cocina",
  "aire acondicionado", "dejó", "dejo", "goteando", "fregadero",
  "nombre:", "mensaje:", "calle", "hace mucho calor", "tubería", "tuberia",
];

function detectLanguage(text: string): Language {
  const lower = text.toLowerCase();
  const hits = SPANISH_SIGNALS.filter((s) => lower.includes(s)).length;
  return hits >= 2 ? "es" : "en";
}

const SPAM_RULES: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /seo|#1 spot on google|lead generation|free audit|spots fill up/i,
    reason: "SEO / lead-selling solicitation, not a customer",
  },
  {
    pattern: /extended warranty|press 1 to speak|warranty specialist/i,
    reason: "Robocall (vehicle warranty), not a customer inquiry",
  },
  {
    pattern: /crypto|gift card|wire transfer|lottery|you have won/i,
    reason: "Scam-style solicitation, not a customer",
  },
];

function extractPhone(text: string): string | null {
  const m = text.match(/\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, "");
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function extractName(text: string, language: Language): string | null {
  const patterns: RegExp[] = [
    /Nombre:\s*([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/,
    /Name:\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?(?:\s+[A-Z]\.)?)/,
    /\bsoy\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/,
    /this is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    /-\s*([A-Z][a-z]+\s+[A-Z]\.)\s*,/,
    /-\s*([A-Z][a-z]+)\s*,/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  void language;
  return null;
}

const AREA_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /Saratoga near Everhart/i, label: "Saratoga near Everhart" },
  { pattern: /Staples.*SPID|calle Staples/i, label: "Staples near SPID" },
  { pattern: /near Del Mar College/i, label: "near Del Mar College" },
  { pattern: /Calallen/i, label: "Calallen" },
  { pattern: /Flour Bluff/i, label: "Flour Bluff" },
  { pattern: /Southside/i, label: "Southside" },
  { pattern: /Annaville/i, label: "Annaville" },
  { pattern: /Padre Island/i, label: "Padre Island" },
  { pattern: /Bay Area/i, label: "Bay Area" },
  { pattern: /\bdowntown\b/i, label: "Downtown" },
];

function extractArea(text: string): string | null {
  for (const { pattern, label } of AREA_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

interface ServiceRule {
  pattern: RegExp;
  en: string;
  es: string;
  shortEn: string;
  shortEs: string;
}

const SERVICE_RULES: ServiceRule[] = [
  { pattern: /water heater burst|burst.*water heater/i, en: "Burst water heater, active leak", es: "calentador de agua roto, fuga activa", shortEn: "burst water heater", shortEs: "su calentador de agua roto" },
  { pattern: /water heater (is )?leaking|water heater leaking/i, en: "Water heater leak", es: "fuga en el calentador de agua", shortEn: "leaking water heater", shortEs: "la fuga de su calentador de agua" },
  { pattern: /no ac|ac stopped|ac not working|aire acondicionado dejó|aire acondicionado dejo|stopped cooling/i, en: "AC not working", es: "aire acondicionado no funciona", shortEn: "AC outage", shortEs: "su aire acondicionado" },
  { pattern: /sink is backing up|backing up|drain/i, en: "Kitchen drain backup", es: "drenaje de cocina tapado", shortEn: "kitchen drain backup", shortEs: "el drenaje de su cocina" },
  { pattern: /tubería.*goteando|tuberia.*goteando|leak under.*sink|debajo del fregadero/i, en: "Leak under kitchen sink", es: "fuga debajo del fregadero de la cocina", shortEn: "leak under the kitchen sink", shortEs: "la fuga debajo de su fregadero" },
  { pattern: /water softener/i, en: "Water softener replacement quote", es: "cotización de reemplazo de suavizador de agua", shortEn: "water softener replacement quote", shortEs: "su cotización de suavizador de agua" },
  { pattern: /tune-up|tune up/i, en: "Annual AC tune-up / maintenance", es: "mantenimiento anual de aire acondicionado", shortEn: "annual AC tune-up", shortEs: "su mantenimiento anual de aire acondicionado" },
  { pattern: /ceiling fan/i, en: "Ceiling fan installation", es: "instalación de ventiladores de techo", shortEn: "ceiling fan installation", shortEs: "su instalación de ventiladores de techo" },
  { pattern: /bathroom remodel|remodel estimate/i, en: "Bathroom remodel estimate", es: "estimado de remodelación de baño", shortEn: "bathroom remodel estimate", shortEs: "su estimado de remodelación de baño" },
  { pattern: /maintenance plan/i, en: "Maintenance plan pricing", es: "precios de planes de mantenimiento", shortEn: "maintenance plan pricing", shortEs: "su consulta de planes de mantenimiento" },
];

function matchService(text: string): ServiceRule | null {
  for (const rule of SERVICE_RULES) {
    if (rule.pattern.test(text)) return rule;
  }
  return null;
}

function judgeUrgency(text: string): { urgency: Urgency; reason: string } {
  const t = text.toLowerCase();
  const vulnerable =
    /elderly|grandma|grandmother|grandpa|grandfather|baby|infant|newborn|pregnant|anciano|abuela|abuelo|beb[ée]|\d+\s*month\s*old|mother in law is \d|is 7\d|is 8\d|is 9\d|\b[89]\d\b\s*(and|lives|staying|year)/.test(t) ||
    /9\d degrees|house is 9\d/.test(t);
  if (detectHazard([text])) {
    return { urgency: "emergency", reason: "Safety hazard reported (gas / carbon monoxide / electrical)" };
  }
  if (/burst|water all over|flooding|flood|water (is )?rising|still leaking|spraying everywhere|inundaci/.test(t)) {
    return { urgency: "emergency", reason: "Active water leak / flooding in progress" };
  }
  if (/sewage|aguas negras/.test(t)) {
    return { urgency: "emergency", reason: "Sewage backup reported" };
  }
  const noCooling = /no ac|ac stopped|ac not working|ac quit|stopped cooling|quit cooling|no air conditioning|aire acondicionado (dejó|dejo|no funciona)|dejó de enfriar|dejo de enfriar|sin aire acondicionado/.test(t);
  const noHeating = /no heat|heat went out|heat is out|furnace (out|quit|not working|stopped)|heating (out|not working)|sin calefacci/.test(t);
  if ((noCooling || noHeating) && vulnerable) {
    return { urgency: "emergency", reason: "No heating/cooling with elderly / infant occupants" };
  }
  if (/dejó de funcionar|dejo de funcionar/.test(t) && /calor|hoy/.test(t)) {
    return { urgency: "same-day", reason: "AC out in heat; customer asks for today" };
  }
  if (/backing up|getting worse|worsening/.test(t)) {
    return { urgency: "same-day", reason: "Problem worsening; customer asks for today if possible" };
  }
  if (/goteando desde|leaking since|leak since/.test(t)) {
    return { urgency: "same-day", reason: "Ongoing leak with moisture damage starting" };
  }
  if (/no rush|next few weeks|before summer|planning|any weekday|what do you charge|do you offer|pricing/.test(t)) {
    return { urgency: "routine", reason: "Quote / maintenance / scheduling question, no time pressure stated" };
  }
  return { urgency: "routine", reason: "No urgency signals in the message" };
}

function firstName(name: string | null): string {
  return name ? name.split(/\s+/)[0] : "";
}

function followupDraft(
  record: { name: string | null; phone: string | null; language: Language },
  service: ServiceRule | null,
  config: BusinessConfig,
): string {
  if (record.language === "es") {
    const what = service ? service.shortEs : "su solicitud de servicio";
    const greeting = firstName(record.name) ? `Hola ${firstName(record.name)},` : "Hola,";
    return `${greeting} le escribo de ${config.businessName}. Gracias por contactarnos sobre ${what}. Le llamaremos hoy mismo para coordinar la visita.`;
  }
  const what = service ? service.shortEn : "your service request";
  const greeting = firstName(record.name) ? `Hi ${firstName(record.name)},` : "Hi there,";
  const reach = record.phone
    ? `We'll call you shortly at ${record.phone} to get you scheduled.`
    : "Reply here with the best number to reach you and we'll get you scheduled.";
  return `${greeting} this is ${config.businessName}. Thanks for reaching out about your ${what}. ${reach}`;
}

export function mockExtract(rawText: string, config: BusinessConfig): ExtractionResult {
  const text = rawText.trim();
  const language = detectLanguage(text);
  const unseenReview = isSampleText(text) ? null : MOCK_REVIEW_NOTE;

  // A hazard lead is never spam-folded, whatever else it contains.
  if (!detectHazard([text])) {
    for (const rule of SPAM_RULES) {
      if (rule.pattern.test(text)) {
        const category: Category = /warranty/i.test(text) ? "not-a-lead" : "spam";
        const record: LeadRecord = {
          raw_text: rawText,
          name: null,
          phone: null,
          service_needed: null,
          urgency: "routine",
          urgency_reason: "Not a service request",
          area: null,
          language,
          category,
          category_reason: rule.reason,
          owner_summary: `Filtered: ${rule.reason}.`,
          followup_draft: "",
          needs_review: unseenReview,
          needs_review_critical: false,
          safety_script: null,
        };
        return { record, usage: mockUsage(text), mode: "mock" };
      }
    }
  }

  const name = extractName(text, language);
  const phone = extractPhone(text);
  const area = extractArea(text);
  const service = matchService(text);
  const { urgency, reason } = judgeUrgency(text);

  const serviceLabel = service ? service.en : "Service request (see message)";
  const summaryParts = [
    `${name ?? "Unknown caller"}`,
    serviceLabel.toLowerCase(),
    area ? `(${area})` : "(area not stated)",
  ];
  const owner_summary = `${summaryParts.join(" — ")}. ${reason}.`;

  const record: LeadRecord = {
    raw_text: rawText,
    name,
    phone,
    service_needed: service ? service.en : null,
    urgency,
    urgency_reason: reason,
    area,
    language,
    category: "real",
    category_reason: "",
    owner_summary,
    followup_draft: followupDraft({ name, phone, language }, service, config),
    needs_review: unseenReview,
    needs_review_critical: false,
    safety_script: null,
  };
  // Hazard leads get the fixed safety script, never the heuristic draft.
  applyHazardSafety(record);
  return { record, usage: mockUsage(text), mode: "mock" };
}

function mockUsage(text: string) {
  return {
    tokens_in: Math.max(40, Math.ceil(text.length / 4)),
    tokens_out: 180,
    cost_usd: 0,
    estimated: true,
  };
}

export const MockAdapter: LeadAdapter = {
  async extract(rawText, config) {
    return mockExtract(rawText, config);
  },
};
