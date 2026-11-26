// Server-only: the real Muse Ember adapter.
//
// Talks to the Meta Model API Chat Completions endpoint. Output strategy,
// in order: (1) `response_format` JSON-schema structured output (strict),
// if the endpoint accepts it; (2) the `record_lead` tool with
// `tool_choice: "auto"` (forced choice returns 400, verified live
// 2026-11-25); (3) a plain-text JSON object in `message.content`, which
// "auto" may legally return instead of a tool call. Which strategy is
// primary is decided by EMBER_OUTPUT_MODE and by the one-call test logged
// in docs/adr/README.md; every path funnels into the same fail-closed
// normalizeRecord(), so no path can silently degrade a lead.
//
// Everything Ember-shaped stays in this one file.

import { createHash } from "node:crypto";
import {
  RECORD_LEAD_SCHEMA,
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

export interface EmberOptions {
  /** "structured" (default) or "tool" — see the header comment. */
  outputMode?: "structured" | "tool";
  /** Sent only when set; the eval harness sweeps this. */
  reasoningEffort?: string | null;
  /** Token-cap parameter name; the endpoint's accepted name is verified by test call. */
  maxTokensParam?: "max_completion_tokens" | "max_tokens" | null;
  maxTokens?: number;
}

export interface EmberResult {
  record: LeadRecord;
  usage: Usage;
  /** Model string from the API response (falls back to the requested model). */
  model: string;
  /** SHA-256 hex of the system prompt actually sent. */
  promptHash: string;
  /** System prompt actually sent (for traces/evals; never rebuilt later). */
  systemPrompt: string;
  outputMode: "structured" | "tool" | "text-fallback";
}

const TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TOKENS = 1500;

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

/** Default request options from env, so the deployed path is configurable without a code change. */
export function emberOptionsFromProcess(): EmberOptions {
  const param = process.env.EMBER_MAX_TOKENS_PARAM;
  return {
    outputMode: process.env.EMBER_OUTPUT_MODE === "tool" ? "tool" : "structured",
    reasoningEffort: process.env.EMBER_REASONING_EFFORT || null,
    maxTokensParam:
      param === "max_tokens" || param === "none"
        ? param === "none"
          ? null
          : "max_tokens"
        : "max_completion_tokens",
    maxTokens: DEFAULT_MAX_TOKENS,
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

/**
 * A phone is trusted only when its digits literally appear in the lead.
 * Known gap: numbers spelled out in words ("three six one …") fail
 * grounding and go to review instead of being trusted. That is the
 * intended direction of failure.
 */
export function phoneIsGrounded(phone: string, rawText: string): boolean {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  const source = rawText.replace(/\D/g, "");
  if (source.includes(digits)) return true;
  return digits.length === 11 && digits.startsWith("1") && source.includes(digits.slice(1));
}

/**
 * Fail-closed normalization: anything unrecognized degrades toward the
 * top of the board with a `needs_review` explanation, never silently
 * toward the bottom. Unknown urgency → emergency + flagged; unknown
 * category → real (visible, not the spam fold) + flagged; ungrounded
 * phone → null + flagged.
 */
export function normalizeRecord(args: Record<string, unknown>, rawText: string): LeadRecord {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v : null;
  const problems: string[] = [];

  let urgency: Urgency = "emergency";
  if (URGENCIES.includes(args.urgency as Urgency)) urgency = args.urgency as Urgency;
  else problems.push(`urgency "${String(args.urgency)}" not recognised`);

  let category: Category = "real";
  if (CATEGORIES.includes(args.category as Category)) category = args.category as Category;
  else problems.push(`category "${String(args.category)}" not recognised`);

  let phone = str(args.phone);
  if (phone && !phoneIsGrounded(phone, rawText)) {
    problems.push(`phone "${phone}" does not appear in the message`);
    phone = null;
  }

  const language: Language = args.language === "es" ? "es" : "en";
  return {
    raw_text: rawText,
    name: str(args.name),
    phone,
    service_needed: str(args.service_needed),
    urgency,
    urgency_reason: str(args.urgency_reason) ?? "",
    area: str(args.area),
    language,
    category,
    category_reason: str(args.category_reason) ?? "",
    owner_summary: str(args.owner_summary) ?? "",
    followup_draft: str(args.followup_draft) ?? "",
    needs_review: problems.length ? problems.join("; ") : null,
  };
}

interface ChatResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export async function emberExtract(
  rawText: string,
  config: BusinessConfig,
  env: EmberEnv,
  opts: EmberOptions = emberOptionsFromProcess(),
): Promise<EmberResult> {
  if (!env.apiKey) throw new Error("MODEL_API_KEY is not set on the server.");

  const structured = opts.outputMode !== "tool";
  const systemPrompt = extractionSystemPrompt(config, structured ? "structured" : "tool");
  const promptHash = createHash("sha256").update(systemPrompt).digest("hex");

  const body: Record<string, unknown> = {
    model: env.model,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `<lead>\n${rawText}\n</lead>` },
    ],
  };
  if (opts.maxTokensParam) body[opts.maxTokensParam] = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
  if (structured) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "record_lead", strict: true, schema: RECORD_LEAD_SCHEMA },
    };
  } else {
    body.tools = [RECORD_LEAD_TOOL];
    body.tool_choice = "auto"; // forced choice returns 400 (verified live 2026-11-25)
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${env.base}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Detail is for server logs only; callers get a generic 502.
    throw new Error(`Ember API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = (await res.json()) as ChatResponse;
  const msg = data.choices?.[0]?.message;
  const call = msg?.tool_calls?.find((c) => c.function?.name === "record_lead");

  let argText: string | undefined;
  let outputMode: EmberResult["outputMode"];
  if (call?.function?.arguments) {
    argText = call.function.arguments;
    outputMode = "tool";
  } else if (typeof msg?.content === "string" && msg.content.trim()) {
    argText = msg.content.match(/\{[\s\S]*\}/)?.[0];
    outputMode = structured ? "structured" : "text-fallback";
  } else {
    throw new Error("Ember returned no record_lead payload.");
  }
  if (!argText) throw new Error("Ember returned no record_lead payload.");

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argText) as Record<string, unknown>;
  } catch {
    throw new Error("Ember returned malformed record_lead arguments.");
  }

  const pin = data.usage?.prompt_tokens;
  const pout = data.usage?.completion_tokens;
  const known = typeof pin === "number" && typeof pout === "number";
  return {
    record: normalizeRecord(args, rawText),
    usage: {
      tokens_in: pin ?? 0,
      tokens_out: pout ?? 0,
      // Missing usage is unknown cost, never $0 — $0 would defeat the meter.
      cost_usd: known ? computeCostUsd(pin, pout, env) : null,
      estimated: false,
    },
    model: typeof data.model === "string" && data.model ? data.model : env.model,
    promptHash,
    systemPrompt,
    outputMode,
  };
}
