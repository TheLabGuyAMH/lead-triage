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
import { applyHazardSafety } from "../../src/lib/safety.js";
import { LINK_SCHEMA, linkSystemPrompt, linkUserMessage, type DispatchLead } from "../../src/lib/dispatch.js";
import {
  INVESTIGATE_TOOLS,
  MAX_TURNS,
  investigateSystemPrompt,
  investigateUserMessage,
  searchMessages,
  type InvestigateStep,
} from "../../src/lib/investigate.js";
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
  /** Preferred token-cap parameter name. null/omitted = the default capped name; there is no uncapped mode. */
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
    // There is no uncapped setting: every request carries an output cap.
    // A legacy "none" value falls back to the default capped parameter.
    maxTokensParam: param === "max_tokens" ? "max_tokens" : "max_completion_tokens",
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

const DRAFT_URL_RE = /https?:\/\/\S+|www\.\S+/gi;
const DRAFT_PHONE_RE = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b|\b\d{10,15}\b/g;

/**
 * Strip URLs and phone numbers that do not appear in the lead from a
 * follow-up draft, in code (the prompt rule alone is not a control).
 * The rest of the draft is kept; every strip is flagged for review.
 */
export function sanitizeDraft(draft: string, rawText: string): { draft: string; problems: string[] } {
  const problems: string[] = [];
  let out = draft;
  if (out.match(DRAFT_URL_RE)) {
    problems.push("follow-up draft contained a URL (removed)");
    out = out.replace(DRAFT_URL_RE, " ");
  }
  out = out.replace(DRAFT_PHONE_RE, (m) => {
    if (phoneIsGrounded(m, rawText)) return m;
    problems.push(`follow-up draft contained phone "${m}" not in the message (removed)`);
    return " ";
  });
  out = out.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  return { draft: out, problems };
}

/**
 * Fail-closed normalization: anything unrecognized degrades toward the
 * top of the board with a `needs_review` explanation, never silently
 * toward the bottom. Unknown urgency → emergency + flagged critical;
 * unknown category → real (visible, not the spam fold) + flagged
 * critical; ungrounded phone → null + flagged. Drafts for spam and
 * not-a-lead are emptied in code; URLs / unlisted phones are stripped
 * from surviving drafts; a truncated call (`finish_reason: "length"`)
 * is flagged. Finally, hazard leads get the fixed safety script
 * (safety.ts), never the model's draft.
 */
export function normalizeRecord(
  args: Record<string, unknown>,
  rawText: string,
  opts: { finishReason?: string | null } = {},
): LeadRecord {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v : null;
  const problems: string[] = [];
  let critical = false;

  let urgency: Urgency = "emergency";
  if (URGENCIES.includes(args.urgency as Urgency)) urgency = args.urgency as Urgency;
  else {
    problems.push(`urgency "${String(args.urgency)}" not recognised`);
    critical = true;
  }

  let category: Category = "real";
  if (CATEGORIES.includes(args.category as Category)) category = args.category as Category;
  else {
    problems.push(`category "${String(args.category)}" not recognised`);
    critical = true;
  }

  let phone = str(args.phone);
  if (phone && !phoneIsGrounded(phone, rawText)) {
    problems.push(`phone "${phone}" does not appear in the message`);
    phone = null;
  }

  let draft = str(args.followup_draft) ?? "";
  if (category !== "real") {
    draft = "";
  } else if (draft) {
    const cleaned = sanitizeDraft(draft, rawText);
    draft = cleaned.draft;
    problems.push(...cleaned.problems);
  }

  if (opts.finishReason === "length") problems.push("output truncated");

  const language: Language = args.language === "es" ? "es" : "en";
  const record: LeadRecord = {
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
    followup_draft: draft,
    needs_review: problems.length ? problems.join("; ") : null,
    needs_review_critical: critical && problems.length > 0,
    safety_script: null,
  };
  return applyHazardSafety(record);
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

/** Usage the upstream reported for a call, when it reported any at all. */
export interface ReportedUsage {
  tokens_in: number;
  tokens_out: number;
}

function usageFromBody(parsed: unknown): ReportedUsage | null {
  const u = (parsed as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  if (!u || typeof u.prompt_tokens !== "number" || typeof u.completion_tokens !== "number") return null;
  return { tokens_in: u.prompt_tokens, tokens_out: u.completion_tokens };
}

class EmberHttpError extends Error {
  status: number;
  usage: ReportedUsage | null;
  constructor(status: number, body: string) {
    super(`Ember API ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* non-JSON error body: no usage to recover */
    }
    this.usage = usageFromBody(parsed);
  }
}

/** Any Ember failure may carry upstream-reported usage for honest cost. */
export function usageFromError(err: unknown): ReportedUsage | null {
  if (err instanceof EmberHttpError) return err.usage;
  const u = (err as { usage?: ReportedUsage | null } | null)?.usage;
  return u && typeof u.tokens_in === "number" && typeof u.tokens_out === "number" ? u : null;
}

function errorWithUsage(message: string, usage: ReportedUsage | null): Error {
  const err = new Error(message) as Error & { usage?: ReportedUsage | null };
  err.usage = usage;
  return err;
}

interface Variant {
  outputMode: "structured" | "tool";
  maxTokensParam: "max_completion_tokens" | "max_tokens";
  reasoningEffort: string | null;
}

function variantLabel(v: Variant): string {
  return `${v.outputMode}+${v.maxTokensParam}${v.reasoningEffort ? `+effort=${v.reasoningEffort}` : ""}`;
}

/**
 * Capability negotiation ladder. Several request parameters
 * (`response_format` strict schemas, the token-cap parameter name,
 * `reasoning_effort`) are documented differently across sources, so the
 * adapter tries the configured variant first and, ONLY on an HTTP 400
 * (the API rejecting a parameter — other failures throw at once), steps
 * down to plainer variants. Invariants: every rung keeps an
 * output-token cap (the ladder may rename the cap parameter, never
 * drop it — there are no uncapped rungs, and an explicit
 * `maxTokensParam: null` means the default capped name), and
 * `reasoning_effort` is kept through every cap/mode change and dropped
 * only on the last rungs, after all capped combinations with it were
 * rejected. Nothing is remembered across requests: each call starts
 * at the configured rung, so a downgrade can never stick.
 */
export function buildVariants(opts: EmberOptions): Variant[] {
  const mode = opts.outputMode ?? "structured";
  const otherMode = mode === "structured" ? "tool" : "structured";
  const cap: Variant["maxTokensParam"] = opts.maxTokensParam === "max_tokens" ? "max_tokens" : "max_completion_tokens";
  const otherCap: Variant["maxTokensParam"] = cap === "max_tokens" ? "max_completion_tokens" : "max_tokens";
  const effort = opts.reasoningEffort ?? null;
  const seen = new Set<string>();
  const out: Variant[] = [];
  const push = (v: Variant) => {
    const k = variantLabel(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  };
  for (const e of effort ? [effort, null] : [null]) {
    push({ outputMode: mode, maxTokensParam: cap, reasoningEffort: e });
    push({ outputMode: mode, maxTokensParam: otherCap, reasoningEffort: e });
    push({ outputMode: otherMode, maxTokensParam: cap, reasoningEffort: e });
    push({ outputMode: otherMode, maxTokensParam: otherCap, reasoningEffort: e });
  }
  return out;
}

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
  body[variant.maxTokensParam] = maxTokens; // every rung is capped, by construction
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
    throw new EmberHttpError(res.status, await res.text());
  }

  const data = (await res.json()) as ChatResponse;
  // Usage is captured before any payload check so a failed call still
  // reports what the upstream billed (cost unknown ≠ $0).
  const reported = usageFromBody(data);
  const finishReason: string | null =
    typeof data.choices?.[0]?.finish_reason === "string" ? data.choices[0].finish_reason : null;
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
    throw errorWithUsage("Ember returned no record_lead payload.", reported);
  }
  if (!argText) throw errorWithUsage("Ember returned no record_lead payload.", reported);

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argText) as Record<string, unknown>;
  } catch {
    throw errorWithUsage("Ember returned malformed record_lead arguments.", reported);
  }

  return {
    record: normalizeRecord(args, rawText, { finishReason }),
    usage: {
      tokens_in: reported?.tokens_in ?? 0,
      tokens_out: reported?.tokens_out ?? 0,
      // Missing usage is unknown cost, never $0 — $0 would defeat the meter.
      cost_usd: reported ? computeCostUsd(reported.tokens_in, reported.tokens_out, env) : null,
      estimated: false,
    },
    model: typeof data.model === "string" && data.model ? data.model : env.model,
    promptHash,
    systemPrompt,
    outputMode,
    requestVariant: variantLabel(variant),
    finishReason,
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
  // No cross-request memory: every call starts at the configured rung.
  for (let i = 0; i < variants.length; i++) {
    try {
      return await attemptExtract(rawText, config, env, variants[i], opts.maxTokens ?? DEFAULT_MAX_TOKENS);
    } catch (err) {
      lastErr = err;
      // Step down only when the API rejected the request shape itself.
      if (!(err instanceof EmberHttpError && err.status === 400)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Ember call failed.");
}

// ---------- the cross-message pass (Morning Dispatcher) ----------

export interface EmberLinkResult {
  /** Ember's links exactly as returned (validated later by validateLinks). */
  raw: unknown;
  usage: Usage;
  model: string;
  promptHash: string;
  requestVariant: string;
  finishReason: string | null;
}

// A block holds up to 30 messages and the answer lists links with
// quotes, so it gets more room than one lead: 6,000 output tokens
// (reasoning included) bounds a worst-case call at about $0.003.
const LINK_MAX_TOKENS = 6000;
const LINK_TIMEOUT_MS = 50_000;

/**
 * One structured-output call over a block of messages. Uses the same
 * 400-only ladder as extraction but only structured rungs: a link list
 * has no tool fallback, so a rejected schema is a hard failure.
 */
export async function emberLink(
  block: DispatchLead[],
  config: BusinessConfig,
  env: EmberEnv,
  opts: EmberOptions = emberOptionsFromProcess(),
): Promise<EmberLinkResult> {
  if (!env.apiKey) throw new Error("MODEL_API_KEY is not set on the server.");
  const systemPrompt = linkSystemPrompt(config);
  const promptHash = createHash("sha256").update(systemPrompt).digest("hex");
  const variants = buildVariants({ ...opts, outputMode: "structured" }).filter((v) => v.outputMode === "structured");
  let lastErr: unknown = null;
  for (const variant of variants) {
    const body: Record<string, unknown> = {
      model: env.model,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: linkUserMessage(block) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "link_messages", strict: true, schema: LINK_SCHEMA } },
    };
    body[variant.maxTokensParam] = LINK_MAX_TOKENS;
    if (variant.reasoningEffort) body.reasoning_effort = variant.reasoningEffort;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${env.base}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${env.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const err = new EmberHttpError(res.status, await res.text());
      lastErr = err;
      if (res.status === 400) continue;
      throw err;
    }
    const data = (await res.json()) as ChatResponse;
    const reported = usageFromBody(data);
    const finishReason = typeof data.choices?.[0]?.finish_reason === "string" ? data.choices[0].finish_reason : null;
    const text = data.choices?.[0]?.message?.content;
    const json = typeof text === "string" ? text.match(/\{[\s\S]*\}/)?.[0] : undefined;
    let raw: unknown;
    try {
      raw = json ? JSON.parse(json) : null;
    } catch {
      raw = null;
    }
    if (!raw) throw errorWithUsage("Ember returned no link list.", reported);
    return {
      raw,
      usage: {
        tokens_in: reported?.tokens_in ?? 0,
        tokens_out: reported?.tokens_out ?? 0,
        cost_usd: reported ? computeCostUsd(reported.tokens_in, reported.tokens_out, env) : null,
        estimated: false,
      },
      model: typeof data.model === "string" && data.model ? data.model : env.model,
      promptHash,
      requestVariant: variantLabel(variant),
      finishReason,
    };
  }
  throw lastErr instanceof Error ? lastErr : new Error("Ember link call failed.");
}

// ---------- the investigator: a bounded tool loop ----------

export interface EmberInvestigateResult {
  /** propose_link arguments (pile-local ids), or null when no link. */
  proposal: Record<string, unknown> | null;
  /** Why it stopped: "proposed" | "no_link" | "turns" | "text". */
  outcome: string;
  steps: InvestigateStep[];
  turns: number;
  usage: Usage;
  model: string;
  promptHash: string;
  requestVariant: string;
}

const INVESTIGATE_MAX_TOKENS = 2000;

/**
 * Up to MAX_TURNS Ember calls with tools over the pile (tool_choice
 * "auto": forced choice returns 400 on this API, verified 2026-11-25).
 * search_messages and read_message run here, in code, read-only; the
 * loop ends on propose_link, no_link, a plain-text answer, or the turn
 * cap. Usage is summed over every call so the cost is the whole loop.
 */
export async function emberInvestigate(
  target: DispatchLead,
  pile: DispatchLead[],
  config: BusinessConfig,
  env: EmberEnv,
  opts: EmberOptions = emberOptionsFromProcess(),
): Promise<EmberInvestigateResult> {
  if (!env.apiKey) throw new Error("MODEL_API_KEY is not set on the server.");
  const targetId = pile.findIndex((l) => l.index === target.index) + 1;
  if (targetId < 1) throw new Error("target is not in the pile");
  const systemPrompt = investigateSystemPrompt(config);
  const promptHash = createHash("sha256").update(systemPrompt).digest("hex");
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: investigateUserMessage(target, targetId) },
  ];
  const capParam = opts.maxTokensParam === "max_tokens" ? "max_tokens" : "max_completion_tokens";
  const usage = { tokens_in: 0, tokens_out: 0, known: true };
  const steps: InvestigateStep[] = [];
  let model = env.model;
  let outcome = "turns";
  let proposal: Record<string, unknown> | null = null;
  let turns = 0;
  for (; turns < MAX_TURNS && outcome === "turns"; turns++) {
    // The last turn may only finish: offer just propose_link / no_link and say so.
    const last = turns === MAX_TURNS - 1;
    if (last) messages.push({ role: "user", content: "Last turn: finish now with propose_link (if a message matches) or no_link." });
    const tools = last ? INVESTIGATE_TOOLS.filter((t) => t.function.name === "propose_link" || t.function.name === "no_link") : INVESTIGATE_TOOLS;
    const body: Record<string, unknown> = { model: env.model, temperature: 0, messages, tools, tool_choice: "auto" };
    body[capParam] = INVESTIGATE_MAX_TOKENS;
    if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let res: Response;
    try {
      res = await fetch(`${env.base}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${env.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const err = new EmberHttpError(res.status, await res.text());
      const u = err.usage;
      if (u) {
        usage.tokens_in += u.tokens_in;
        usage.tokens_out += u.tokens_out;
      } else usage.known = false;
      (err as unknown as { usage: ReportedUsage }).usage = { tokens_in: usage.tokens_in, tokens_out: usage.tokens_out };
      throw err;
    }
    const data = (await res.json()) as ChatResponse & {
      choices?: Array<{ message?: { tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> } }>;
    };
    const reported = usageFromBody(data);
    if (reported) {
      usage.tokens_in += reported.tokens_in;
      usage.tokens_out += reported.tokens_out;
    } else usage.known = false;
    if (typeof data.model === "string" && data.model) model = data.model;
    const msg = data.choices?.[0]?.message;
    const calls = msg?.tool_calls ?? [];
    if (!calls.length) {
      outcome = "text";
      break;
    }
    messages.push({ role: "assistant", content: msg?.content ?? "", tool_calls: calls });
    for (const call of calls) {
      const name = call.function?.name ?? "";
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      let result: unknown;
      if (name === "search_messages") {
        const hits = searchMessages(pile, String(args.query ?? ""), targetId);
        steps.push({ tool: name, args: { query: String(args.query ?? "").slice(0, 120) }, found: hits.map((h) => pile[h.id - 1].index) });
        result = hits;
      } else if (name === "read_message") {
        const id = Number(args.id);
        const l = Number.isInteger(id) && id >= 1 && id <= pile.length ? pile[id - 1] : null;
        steps.push({ tool: name, args: { id }, found: l ? [l.index] : [] });
        result = l ? { id, name: l.name, phone: l.phone, area: l.area, text: l.raw_text } : { error: "no such message" };
      } else if (name === "propose_link") {
        proposal = args;
        outcome = "proposed";
        steps.push({ tool: name, args: {}, found: Array.isArray(args.ids) ? (args.ids as unknown[]).filter((n): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= pile.length).map((n) => pile[n - 1].index) : [] });
        result = { ok: true };
      } else if (name === "no_link") {
        outcome = "no_link";
        steps.push({ tool: name, args: { reason: String(args.reason ?? "").slice(0, 200) }, found: [] });
        result = { ok: true };
      } else result = { error: "unknown tool" };
      messages.push({ role: "tool", tool_call_id: call.id ?? name, content: JSON.stringify(result) });
    }
  }
  return {
    proposal,
    outcome,
    steps,
    turns,
    usage: {
      tokens_in: usage.tokens_in,
      tokens_out: usage.tokens_out,
      cost_usd: usage.known ? computeCostUsd(usage.tokens_in, usage.tokens_out, env) : null,
      estimated: false,
    },
    model,
    promptHash,
    requestVariant: `tools+auto+${capParam}${opts.reasoningEffort ? `+effort=${opts.reasoningEffort}` : ""}`,
  };
}
