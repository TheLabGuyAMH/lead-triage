// Server-only: the real Muse Ember adapter.
//
// Talks to the Meta Model API Chat Completions endpoint. Output strategy:
// `response_format` JSON-schema structured output (strict) first, then
// the `record_lead` tool with `tool_choice: "auto"` (forced choice
// returns 400, verified live 2026-11-25), with a plain-text JSON object
// in `message.content` accepted on either path ("auto" may legally
// answer in text). Request parameters whose support is uncertain
// (strict schemas, the token-cap name, `reasoning_effort`) are handled
// by the 400-only negotiation ladder below, which reports the accepted
// variant on every result; see docs/adr/README.md. Every path funnels
// into the same fail-closed normalizeRecord().
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
  /** Negotiated variant the API accepted, e.g. "structured+max_tokens". */
  requestVariant: string;
  /** API finish_reason ("length" means the output cap truncated the record). */
  finishReason: string | null;
}

const TIMEOUT_MS = 20_000;
// Completion tokens include model reasoning: measured live 2026-11-26,
// successful records used 1,217–1,454 of the old 1,500 cap and one lead
// truncated into a 502. The cap only bounds worst-case cost (~$0.0016
// per lead at 3,000) while billing is per token actually produced, so
// headroom is nearly free insurance. See docs/adr/README.md.
const DEFAULT_MAX_TOKENS = 3000;

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
  const capRaw = Number(process.env.EMBER_MAX_TOKENS);
  return {
    outputMode: process.env.EMBER_OUTPUT_MODE === "tool" ? "tool" : "structured",
    reasoningEffort: process.env.EMBER_REASONING_EFFORT || null,
    maxTokensParam:
      param === "max_tokens" || param === "none"
        ? param === "none"
          ? null
          : "max_tokens"
        : "max_completion_tokens",
    maxTokens: Number.isInteger(capRaw) && capRaw >= 256 && capRaw <= 8000 ? capRaw : DEFAULT_MAX_TOKENS,
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
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

class EmberHttpError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`Ember API ${status}: ${body}`);
    this.status = status;
  }
}

interface Variant {
  outputMode: "structured" | "tool";
  maxTokensParam: "max_completion_tokens" | "max_tokens" | null;
  reasoningEffort: string | null;
}

function variantLabel(v: Variant): string {
  return `${v.outputMode}+${v.maxTokensParam ?? "nocap"}${v.reasoningEffort ? `+effort=${v.reasoningEffort}` : ""}`;
}

/**
 * Capability negotiation ladder. Several request parameters
 * (`response_format` strict schemas, the token-cap parameter name,
 * `reasoning_effort`) are documented differently across sources, so the
 * adapter tries the configured variant first and, ONLY on an HTTP 400
 * (the API rejecting a parameter — other failures throw at once), steps
 * down to plainer variants. The variant that works is remembered for
 * the life of the server instance, so a batch negotiates once. Every
 * variant is still length-capped by the server-side gates upstream,
 * and only the accepted call can bill for output.
 */
function buildVariants(opts: EmberOptions): Variant[] {
  const mode = opts.outputMode ?? "structured";
  const otherMode = mode === "structured" ? "tool" : "structured";
  const cap = opts.maxTokensParam ?? "max_completion_tokens";
  const otherCap = cap === "max_tokens" ? "max_completion_tokens" : "max_tokens";
  const seen = new Set<string>();
  const out: Variant[] = [];
  const push = (v: Variant) => {
    const k = variantLabel(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  };
  push({ outputMode: mode, maxTokensParam: cap, reasoningEffort: opts.reasoningEffort ?? null });
  if (cap) push({ outputMode: mode, maxTokensParam: otherCap, reasoningEffort: null });
  push({ outputMode: mode, maxTokensParam: null, reasoningEffort: null });
  push({ outputMode: otherMode, maxTokensParam: null, reasoningEffort: null });
  return out;
}

let learnedVariant = 0;

async function attemptExtract(
  rawText: string,
  config: BusinessConfig,
  env: EmberEnv,
  variant: Variant,
  maxTokens: number,
): Promise<EmberResult> {
  const structured = variant.outputMode === "structured";
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
  if (variant.maxTokensParam) body[variant.maxTokensParam] = maxTokens;
  if (variant.reasoningEffort) body.reasoning_effort = variant.reasoningEffort;
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
    throw new EmberHttpError(res.status, (await res.text()).slice(0, 300));
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
    requestVariant: variantLabel(variant),
    finishReason: typeof data.choices?.[0]?.finish_reason === "string" ? data.choices[0].finish_reason : null,
  };
}

export async function emberExtract(
  rawText: string,
  config: BusinessConfig,
  env: EmberEnv,
  opts: EmberOptions = emberOptionsFromProcess(),
): Promise<EmberResult> {
  if (!env.apiKey) throw new Error("MODEL_API_KEY is not set on the server.");
  const variants = buildVariants(opts);
  let lastErr: unknown = null;
  for (let i = Math.min(learnedVariant, variants.length - 1); i < variants.length; i++) {
    try {
      const r = await attemptExtract(rawText, config, env, variants[i], opts.maxTokens ?? DEFAULT_MAX_TOKENS);
      learnedVariant = i;
      return r;
    } catch (err) {
      lastErr = err;
      // Step down only when the API rejected the request shape itself.
      if (!(err instanceof EmberHttpError && err.status === 400)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Ember call failed.");
}
