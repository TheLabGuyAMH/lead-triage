// Client-side adapter that goes through /api/extract (the Ember path).
// The server decides what actually runs: real Ember only when it is
// enabled there AND this browser presents the demo key (kept in
// sessionStorage, sent as `x-demo-key`); otherwise a mock result with a
// visible note. The status is checked before the body is trusted as
// JSON — a platform 504 page is HTML, not JSON.

import type { ExtractionResult, LeadAdapter } from "./schema";

export const DEMO_KEY_STORAGE = "lead-triage-demo-key";

export const ApiAdapter: LeadAdapter = {
  async extract(rawText, config): Promise<ExtractionResult> {
    let demoKey: string | null = null;
    try {
      demoKey = sessionStorage.getItem(DEMO_KEY_STORAGE);
    } catch {
      /* storage blocked — server will answer with the mock note */
    }
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(demoKey ? { "x-demo-key": demoKey } : {}),
      },
      body: JSON.stringify({ raw_text: rawText, config, mode: "ember" }),
    });
    const text = await res.text();
    let data: (ExtractionResult & { error?: string }) | null = null;
    try {
      data = JSON.parse(text) as ExtractionResult & { error?: string };
    } catch {
      /* non-JSON body, e.g. a platform 504 page */
    }
    if (!res.ok || !data) {
      throw new Error(data?.error || `Extraction failed (${res.status})`);
    }
    return data;
  },
};
