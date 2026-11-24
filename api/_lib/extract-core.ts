// Framework-free core of POST /api/extract, shared by the Vercel
// function (api/extract.ts) and the Vite dev middleware (vite.config.ts)
// so local dev exercises exactly the code that deploys.
//
// Behavior:
// - mode "mock" (or no mode): heuristic mock adapter, $0, always works.
// - mode "ember" with MODEL_API_KEY set: real Ember call. Errors surface
//   as 502 — no silent fallback, so the trace never fakes Ember usage.
// - mode "ember" without a key: mock result WITH a note saying so, so
//   the demo still runs before credits/key land and the UI can badge it.

import { mockExtract } from "../../src/lib/mock";
import type { BusinessConfig, ExtractionResult } from "../../src/lib/schema";
import { emberEnvFromProcess, emberExtract, type EmberEnv } from "./ember";

export interface ExtractRequestBody {
  raw_text?: unknown;
  config?: Partial<BusinessConfig>;
  mode?: unknown;
}

export interface ExtractResponse {
  status: number;
  json: ExtractionResult | { error: string };
}

const DEFAULT_CONFIG: BusinessConfig = {
  businessName: "Demo Plumbing & AC",
  trade: "plumbing / HVAC",
  tone: "friendly-direct",
};

function normalizeConfig(partial: Partial<BusinessConfig> | undefined): BusinessConfig {
  return {
    businessName: partial?.businessName?.trim() || DEFAULT_CONFIG.businessName,
    trade: partial?.trade?.trim() || DEFAULT_CONFIG.trade,
    tone:
      partial?.tone === "professional" || partial?.tone === "warm"
        ? partial.tone
        : "friendly-direct",
  };
}

export async function handleExtract(
  body: ExtractRequestBody,
  env: EmberEnv = emberEnvFromProcess(),
): Promise<ExtractResponse> {
  const rawText = typeof body.raw_text === "string" ? body.raw_text : "";
  if (!rawText.trim()) {
    return { status: 400, json: { error: "raw_text is required" } };
  }
  const config = normalizeConfig(body.config);
  const wantEmber = body.mode === "ember";

  if (!wantEmber) {
    return { status: 200, json: mockExtract(rawText, config) };
  }
  if (!env.apiKey) {
    const result = mockExtract(rawText, config);
    result.note =
      "Ember requested but MODEL_API_KEY is not set on the server; this result came from the mock adapter.";
    return { status: 200, json: result };
  }
  try {
    const { record, usage } = await emberExtract(rawText, config, env);
    return { status: 200, json: { record, usage, mode: "ember" } };
  } catch (err) {
    return {
      status: 502,
      json: { error: err instanceof Error ? err.message : "Ember call failed" },
    };
  }
}
