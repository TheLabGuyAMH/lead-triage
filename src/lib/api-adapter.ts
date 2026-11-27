// Client-side adapter that goes through /api/extract (the Ember path).
// The server decides what actually runs: real Ember only when it is
// enabled there AND this browser presents the demo key (kept in
// sessionStorage, sent as `x-demo-key`); otherwise a mock result with a
// visible note. The status is checked before the body is trusted as
// JSON — a platform 504 page is HTML, not JSON.

import type { DispatchLead, LeadLink } from "./dispatch";
import type { AdapterMode, BusinessConfig, ExtractionResult, LeadAdapter, Usage } from "./schema";

export const DEMO_KEY_STORAGE = "lead-triage-demo-key";

/** An extraction failure that may carry the usage the server reported. */
export class ExtractionError extends Error {
  usage: Usage | null;
  constructor(message: string, usage: Usage | null = null) {
    super(message);
    this.usage = usage;
  }
}

/**
 * The board card for a lead whose extraction failed: flagged critical
 * so it floats to the top for a human. Cost is null (unknown) unless
 * the server reported usage for the failed call — a timed-out call
 * may still bill upstream, so it is never recorded as $0.
 */
export function failureResult(raw: string, index: number, mode: AdapterMode, err: unknown): ExtractionResult {
  const reported = err instanceof ExtractionError ? err.usage : null;
  return {
    index,
    mode,
    usage: reported ?? { tokens_in: 0, tokens_out: 0, cost_usd: null, estimated: false },
    record: {
      raw_text: raw,
      name: null,
      phone: null,
      service_needed: null,
      urgency: "emergency",
      urgency_reason: "Not read automatically. Open the original message.",
      area: null,
      language: "en",
      category: "real",
      category_reason: "",
      owner_summary: "Could not process this lead. Read the original.",
      followup_draft: "",
      needs_review: err instanceof Error ? err.message : "extraction failed",
      needs_review_critical: true,
      safety_script: null,
    },
  };
}

export const ApiAdapter: LeadAdapter = {
  async extract(rawText, config): Promise<ExtractionResult> {
    let demoKey: string | null = null;
    try {
      demoKey = sessionStorage.getItem(DEMO_KEY_STORAGE);
    } catch {
      /* storage blocked — server will answer with the mock note */
    }
    const t0 = Date.now();
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
      throw new ExtractionError(data?.error || `Extraction failed (${res.status})`, data?.usage ?? null);
    }
    return { ...data, latency_ms: Date.now() - t0 };
  },
};

export interface DispatchResult {
  links: LeadLink[];
  dropped: string[];
  usage: Usage;
  mode: AdapterMode;
  note?: string;
  model?: string;
  prompt_hash?: string;
  request_variant?: string;
  finish_reason?: string | null;
  latency_ms?: number;
}

/** One block through POST /api/dispatch (the cross-message pass). */
export async function dispatchBlock(block: DispatchLead[], config: BusinessConfig): Promise<DispatchResult> {
  let demoKey: string | null = null;
  try {
    demoKey = sessionStorage.getItem(DEMO_KEY_STORAGE);
  } catch {
    /* storage blocked: the server answers with practice-mode links and a note */
  }
  const t0 = Date.now();
  const res = await fetch("/api/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(demoKey ? { "x-demo-key": demoKey } : {}) },
    body: JSON.stringify({ leads: block, config, mode: "ember" }),
  });
  const text = await res.text();
  let data: (DispatchResult & { error?: string }) | null = null;
  try {
    data = JSON.parse(text) as DispatchResult & { error?: string };
  } catch {
    /* non-JSON body */
  }
  if (!res.ok || !data) throw new ExtractionError(data?.error || `Link pass failed (${res.status})`, data?.usage ?? null);
  return { ...data, latency_ms: Date.now() - t0 };
}
