// Batch splitting + ranking. The model classifies each lead (category,
// urgency); code orders the results deterministically: needs_review
// first (a human must look), then category, then urgency, then paste
// position. Nothing about the order is left to the model.

import type { ExtractionResult, LeadRecord } from "./schema";

/**
 * Split a pasted batch into individual leads. An explicit line of three
 * or more dashes (`---`) is the reliable separator and wins when present
 * (a web form with blank lines between its fields stays one lead);
 * otherwise blank lines separate leads, as before.
 */
export function splitBatch(paste: string): string[] {
  const text = paste.replace(/\r\n/g, "\n");
  const sep = /^\s*-{3,}\s*$/m;
  const parts = sep.test(text) ? text.split(sep) : text.split(/\n\s*\n/);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
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

/** Rank extraction results for the board. Keyed by paste index, never by text. */
export function rankResults(items: ExtractionResult[]): ExtractionResult[] {
  return [...items].sort(
    (a, b) =>
      Number(b.record.needs_review !== null) - Number(a.record.needs_review !== null) ||
      CATEGORY_ORDER[a.record.category] - CATEGORY_ORDER[b.record.category] ||
      URGENCY_ORDER[a.record.urgency] - URGENCY_ORDER[b.record.urgency] ||
      (a.index ?? 0) - (b.index ?? 0),
  );
}

export function rankLeads(records: LeadRecord[]): LeadRecord[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const byReview =
        Number(b.record.needs_review !== null) - Number(a.record.needs_review !== null);
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
