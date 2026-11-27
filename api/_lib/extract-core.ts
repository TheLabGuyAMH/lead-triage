// Framework-free core of POST /api/extract, shared by the Vercel
// function (api/extract.ts) and the Vite dev middleware (vite.config.ts)
// so local dev exercises exactly the code that deploys.
//
// Behavior:
// - mode "mock" (or no mode): heuristic mock adapter, $0, always works.
// - mode "ember": a real Ember call ONLY when all three server gates
//   pass — EMBER_ENABLED=1 (kill switch), MODEL_API_KEY set, and the
//   caller's `x-demo-key` header matches EMBER_DEMO_KEY (timing-safe).
//   Otherwise the caller gets a mock result WITH a visible note, at $0.
//   This is what stops any internet caller from spending the hackathon's
//   $10 Ember budget (exceeding it makes the entry ineligible).
// - One lead over 4,000 chars is a 413; business config fields are
//   stripped of control characters/newlines and capped at 80 chars
//   before they can reach the system prompt.
// - Ember errors are logged on the server and returned as a generic
//   502 — upstream error bodies never reach the client.

import { timingSafeEqual } from "node:crypto";
import { mockExtract } from "../../src/lib/mock.js";
import type { BusinessConfig, ExtractionResult, Usage } from "../../src/lib/schema.js";
import { computeCostUsd, emberEnvFromProcess, emberExtract, usageFromError, type EmberEnv } from "./ember.js";

export interface ExtractRequestBody {
  raw_text?: unknown;
  config?: Partial<BusinessConfig>;
  mode?: unknown;
}

export interface ExtractResponse {
  status: number;
  json: ExtractionResult | { error: string; usage?: Usage };
}

const MAX_RAW_CHARS = 4000;
const MAX_CFG_CHARS = 80;

const DEFAULT_CONFIG: BusinessConfig = {
  businessName: "Demo Plumbing & AC",
  trade: "plumbing / HVAC",
  tone: "friendly-direct",
};

/**
 * Config fields land inside quoted slots in the system prompt, so they
 * are stripped of control characters and Unicode line separators
 * (U+2028, U+2029, U+0085), length-capped, and then have `\` and `"`
 * escaped so a field can never close its quote early. Capping happens
 * before escaping so the cut can't leave a dangling backslash.
 */
export function cleanConfigField(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, " ")
    .trim()
    .slice(0, max)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function clean(v: unknown, max: number): string {
  return cleanConfigField(v, max);
}

function keyMatches(given: string | null, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The three server gates for any paid Ember call (kill switch, server
 * key, caller's demo key). Returns null when all pass, else the reason.
 */
export function emberGate(demoKey: string | null, env: EmberEnv): string | null {
  if (process.env.EMBER_ENABLED !== "1") return "Ember is switched off on this deployment";
  if (!env.apiKey) return "MODEL_API_KEY is not set on the server";
  if (!keyMatches(demoKey, process.env.EMBER_DEMO_KEY)) return "Ember mode needs the demo key";
  return null;
}

export function normalizeConfig(partial: Partial<BusinessConfig> | undefined): BusinessConfig {
  return {
    businessName: clean(partial?.businessName, MAX_CFG_CHARS) || DEFAULT_CONFIG.businessName,
    trade: clean(partial?.trade, MAX_CFG_CHARS) || DEFAULT_CONFIG.trade,
    tone:
      partial?.tone === "professional" || partial?.tone === "warm"
        ? partial.tone
        : "friendly-direct",
  };
}

export async function handleExtract(
  body: ExtractRequestBody,
  auth: { demoKey: string | null } = { demoKey: null },
  env: EmberEnv = emberEnvFromProcess(),
): Promise<ExtractResponse> {
  const rawText = typeof body.raw_text === "string" ? body.raw_text : "";
  if (!rawText.trim()) {
    return { status: 400, json: { error: "raw_text is required" } };
  }
  if (rawText.length > MAX_RAW_CHARS) {
    return {
      status: 413,
      json: { error: `One lead is over ${MAX_RAW_CHARS} characters. Split it and retry.` },
    };
  }
  const config = normalizeConfig(body.config);
  if (body.mode !== "ember") {
    return { status: 200, json: mockExtract(rawText, config) };
  }

  const blocked = emberGate(auth.demoKey, env);
  if (blocked) {
    const result = mockExtract(rawText, config);
    result.note = `${blocked}; this result came from the mock adapter.`;
    return { status: 200, json: result };
  }

  try {
    const { record, usage, model, promptHash, outputMode, requestVariant, finishReason } = await emberExtract(
      rawText,
      config,
      env,
    );
    return {
      status: 200,
      json: { record, usage, mode: "ember", model, prompt_hash: promptHash, output_mode: outputMode, request_variant: requestVariant, finish_reason: finishReason },
    };
  } catch (err) {
    console.error("ember_error", err); // full detail stays in server logs
    // A failed call may still have billed upstream. Report its usage
    // when the upstream sent it; cost is null (unknown), never $0.
    const reported = usageFromError(err);
    const usage: Usage = {
      tokens_in: reported?.tokens_in ?? 0,
      tokens_out: reported?.tokens_out ?? 0,
      cost_usd: reported ? computeCostUsd(reported.tokens_in, reported.tokens_out, env) : null,
      estimated: false,
    };
    return { status: 502, json: { error: "Ember call failed; this lead was not processed.", usage } };
  }
}
