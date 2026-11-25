// Server-only: the real Muse Ember adapter.
//
// Talks to the Meta Model API (Chat Completions endpoint, which the
// public docs list for muse-ember-1.0 alongside Responses and Messages).
// VERIFY ON DAY 1 of the build window, once the hackathon API key and
// credits land: the exact request/response shape below, and the real
// per-token rates (set EMBER_INPUT_RATE_PER_MTOK /
// EMBER_OUTPUT_RATE_PER_MTOK from the official pricing page). Everything
// Ember-shaped is isolated in this one file so a correction lands here
// and nowhere else.

import {
  RECORD_LEAD_TOOL,
  extractionSystemPrompt,
  type BusinessConfig,
  type Category,
  type Language,
  type LeadRecord,
  type Urgency,
  type Usage,
} from "../../src/lib/schema.js";

export interface EmberEnv {
  apiKey: string | null;
  model: string;
  base: string;
  inputRatePerMTok: number | null;
  outputRatePerMTok: number | null;
}

function parseRate(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function emberEnvFromProcess(): EmberEnv {
  return {
    apiKey: process.env.MODEL_API_KEY || null,
    model: process.env.EMBER_MODEL || "muse-ember-1.0",
    base: (process.env.EMBER_API_BASE || "https://api.meta.ai/v1").replace(/\/$/, ""),
    inputRatePerMTok: parseRate(process.env.EMBER_INPUT_RATE_PER_MTOK),
    outputRatePerMTok: parseRate(process.env.EMBER_OUTPUT_RATE_PER_MTOK),
  };
}

export function computeCostUsd(
  tokensIn: number,
  tokensOut: number,
  env: EmberEnv,
): number | null {
  if (env.inputRatePerMTok === null || env.outputRatePerMTok === null) return null;
  return (tokensIn * env.inputRatePerMTok + tokensOut * env.outputRatePerMTok) / 1_000_000;
}

const URGENCIES: Urgency[] = ["emergency", "same-day", "routine"];
const CATEGORIES: Category[] = ["real", "spam", "not-a-lead"];

function normalizeRecord(args: Record<string, unknown>, rawText: string): LeadRecord {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v : null;
  const urgency = URGENCIES.includes(args.urgency as Urgency)
    ? (args.urgency as Urgency)
    : "routine";
  const category = CATEGORIES.includes(args.category as Category)
    ? (args.category as Category)
    : "real";
  const language: Language = args.language === "es" ? "es" : "en";
  return {
    raw_text: rawText,
    name: str(args.name),
    phone: str(args.phone),
    service_needed: str(args.service_needed),
    urgency,
    urgency_reason: str(args.urgency_reason) ?? "",
    area: str(args.area),
    language,
    category,
    category_reason: str(args.category_reason) ?? "",
    owner_summary: str(args.owner_summary) ?? "",
    followup_draft: str(args.followup_draft) ?? "",
  };
}

export async function emberExtract(
  rawText: string,
  config: BusinessConfig,
  env: EmberEnv,
): Promise<{ record: LeadRecord; usage: Usage }> {
  if (!env.apiKey) throw new Error("MODEL_API_KEY is not set on the server.");

  const res = await fetch(`${env.base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.model,
      temperature: 0,
      messages: [
        { role: "system", content: extractionSystemPrompt(config) },
        { role: "user", content: rawText },
      ],
      tools: [RECORD_LEAD_TOOL],
      tool_choice: { type: "function", function: { name: "record_lead" } },
    }),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Ember API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{
      message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const call = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!call?.function?.arguments) {
    throw new Error("Ember response contained no record_lead tool call.");
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch {
    throw new Error("Ember returned malformed tool arguments.");
  }

  const tokensIn = data.usage?.prompt_tokens ?? 0;
  const tokensOut = data.usage?.completion_tokens ?? 0;
  return {
    record: normalizeRecord(args, rawText),
    usage: {
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: computeCostUsd(tokensIn, tokensOut, env),
      estimated: false,
    },
  };
}
