// Client-side adapter that goes through /api/extract (the Ember path).
// The server decides what actually runs: real Ember when MODEL_API_KEY
// is configured, mock-with-a-note when it is not.

import type { ExtractionResult, LeadAdapter } from "./schema";

export const ApiAdapter: LeadAdapter = {
  async extract(rawText, config): Promise<ExtractionResult> {
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw_text: rawText, config, mode: "ember" }),
    });
    const data = (await res.json()) as ExtractionResult & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || `Extraction failed (${res.status})`);
    }
    return data;
  },
};
