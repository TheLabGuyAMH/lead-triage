// Batch splitting + ranking. The model classifies each lead (category,
// urgency); code orders the results deterministically: critically
// untrusted records first (extraction failure, unknown urgency or
// category — a human must look before anything else), then category,
// then urgency, then paste position. Softer needs_review flags (phone
// grounding, draft content, truncation, mock heuristics) keep their
// urgency tier and show their banner there. Nothing about the order
// is left to the model.

import type { ExtractionResult, LeadRecord } from "./schema";

// An email pasted whole has blank lines inside it. A paragraph that opens
// like an email (Subject: line or a bare greeting) starts a block that
// runs through its sign-off, if one appears within EMAIL_MAX_PARAS.
const EMAIL_OPEN = /^(subject|asunto|re|fwd?)\s*:|^(hi|hello|hey|dear|good (morning|afternoon|evening)|hola|buen(os|as) (d[ií]as|tardes|noches)|estimad[oa]s?)(\s+[\p{L}.'-]+){0,2}\s*[,!:.]?\s*$/iu;
const EMAIL_CLOSE = /^(thanks|thank you|thx|regards|best|sincerely|cheers|respectfully|sent from my|gracias|saludos|atentamente|cordialmente)\b/im;
const EMAIL_MAX_PARAS = 8;

/**
 * Split a pasted batch into individual leads. Each lead is its own
 * paragraph: blank lines separate leads, and a line of three or more
 * dashes (`---`) also separates, exactly where it appears. A `---`
 * line does not switch blank-line splitting off for the rest of the
 * paste. Exception: a multi-paragraph email (Subject:/greeting through
 * sign-off, with no `---` inside) stays one lead.
 */
export function splitBatch(paste: string): string[] {
  const chunks = paste
    .replace(/\r\n/g, "\n")
    .split(/^\s*-{3,}\s*$/m);
  const out: string[] = [];
  for (const chunk of chunks) {
    const paras = chunk
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (let i = 0; i < paras.length; i++) {
      // A greeting opens an email only when it stands alone as its own
      // paragraph line ("Hi team,"), not "Hi, my AC is out".
      const first = paras[i].split("\n")[0];
      const isHeader = /^(subject|asunto|re|fwd?)\s*:/i.test(first);
      if (EMAIL_OPEN.test(first) && (isHeader || !paras[i].includes("\n"))) {
        let end = -1;
        for (let j = i; j < paras.length && j < i + EMAIL_MAX_PARAS; j++) {
          if (EMAIL_CLOSE.test(paras[j])) { end = j; break; }
        }
        // No sign-off found: still keep a lone header/greeting with its body.
        if (end === -1 && paras[i].split(/\s+/).length <= 8 && i + 1 < paras.length) end = i + 1;
        if (end > i) {
          out.push(paras.slice(i, end + 1).join("\n\n"));
          i = end;
          continue;
        }
      }
      out.push(paras[i]);
    }
  }
  return out;
}

const CATEGORY_ORDER: Record<LeadRecord["category"], number> = {
  real: 0,
  spam: 1,
  "not-a-lead": 1,
};

const URGENCY_ORDER: Record<LeadRecord["urgency"], number> = {
  emergency: 0,
  "same-day": 1,
  routine: 2,
};

function isCritical(record: LeadRecord): boolean {
  return record.needs_review !== null && record.needs_review_critical === true;
}

/** Rank extraction results for the board. Keyed by paste index, never by text. */
export function rankResults(items: ExtractionResult[]): ExtractionResult[] {
  return [...items].sort(
    (a, b) =>
      Number(isCritical(b.record)) - Number(isCritical(a.record)) ||
      CATEGORY_ORDER[a.record.category] - CATEGORY_ORDER[b.record.category] ||
      URGENCY_ORDER[a.record.urgency] - URGENCY_ORDER[b.record.urgency] ||
      (a.index ?? 0) - (b.index ?? 0),
  );
}

export function rankLeads(records: LeadRecord[]): LeadRecord[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const byReview = Number(isCritical(b.record)) - Number(isCritical(a.record));
      if (byReview !== 0) return byReview;
      const byCategory = CATEGORY_ORDER[a.record.category] - CATEGORY_ORDER[b.record.category];
      if (byCategory !== 0) return byCategory;
      const byUrgency = URGENCY_ORDER[a.record.urgency] - URGENCY_ORDER[b.record.urgency];
      if (byUrgency !== 0) return byUrgency;
      return a.index - b.index;
    })
    .map(({ record }) => record);
}

export function isFiltered(record: LeadRecord): boolean {
  return record.category !== "real";
}
