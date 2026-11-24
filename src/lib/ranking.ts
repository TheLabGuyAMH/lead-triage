// Batch splitting + ranking. Ranking lives in code, not in the model
// (build spec section 6): the model judges each lead on its own; the app
// sorts deterministically by category, then urgency. Sort is stable, so
// leads in the same tier keep the order they were pasted in — which is
// what the sample set's expected ranking assumes.

import type { LeadRecord } from "./schema";

/** Split a pasted batch into individual leads on blank lines. */
export function splitBatch(paste: string): string[] {
  return paste
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

export function rankLeads(records: LeadRecord[]): LeadRecord[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
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
