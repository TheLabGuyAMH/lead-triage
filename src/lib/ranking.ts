// Batch splitting + ranking. The model classifies each lead (category,
// urgency); code orders the results deterministically: critically
// untrusted records first (extraction failure, unknown urgency or
// category — a human must look before anything else), then category,
// then urgency, then paste position. Softer needs_review flags (phone
// grounding, draft content, truncation, mock heuristics) keep their
// urgency tier and show their banner there. Nothing about the order
// is left to the model.

import type { ExtractionResult, LeadRecord } from "./schema";

/**
 * Split a pasted batch into individual leads. Each lead is its own
 * paragraph: blank lines separate leads, and a line of three or more
 * dashes (`---`) also separates, exactly where it appears. A `---`
 * line does not switch blank-line splitting off for the rest of the
 * paste; both separators apply everywhere.
 */
export function splitBatch(paste: string): string[] {
  const text = paste
    .replace(/\r\n/g, "\n")
    .replace(/^\s*-{3,}\s*$/gm, "\n");
  return text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
