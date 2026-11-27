// Framework-free core of POST /api/dispatch: the cross-message pass for
// one block of already-extracted messages. Shared by the Vercel function
// (api/dispatch.ts) and the Vite dev middleware.
//
// - mode "mock" (or no mode): code-only links (same phone) plus the
//   practice-mode keyword links, $0.
// - mode "ember": one Ember call, only when the same three gates as
//   /api/extract pass; otherwise the mock links with a visible note.
// - Every Ember link goes through validateLinks() (quotes must really be
//   in the cited message) before it leaves the server.
// - Limits: 2 to BLOCK_MAX messages, each under 4,000 characters.

import {
  BLOCK_MAX,
  codeLinks,
  mergeLinks,
  mockLinks,
  validateLinks,
  type DispatchLead,
  type LeadLink,
} from "../../src/lib/dispatch.js";
import type { BusinessConfig, Usage } from "../../src/lib/schema.js";
import { computeCostUsd, emberEnvFromProcess, emberLink, usageFromError, type EmberEnv } from "./ember.js";
import { emberGate, normalizeConfig } from "./extract-core.js";

export interface DispatchResponseBody {
  links: LeadLink[];
  dropped: string[];
  usage: Usage;
  mode: "mock" | "ember";
  note?: string;
  model?: string;
  prompt_hash?: string;
  request_variant?: string;
  finish_reason?: string | null;
}

const ZERO: Usage = { tokens_in: 0, tokens_out: 0, cost_usd: 0, estimated: true };
const MAX_RAW = 4000;
const URGENCIES = new Set(["emergency", "same-day", "routine"]);

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);

function parseLeads(v: unknown): DispatchLead[] | string {
  if (!Array.isArray(v)) return "leads must be an array";
  if (v.length < 2 || v.length > BLOCK_MAX) return `send 2 to ${BLOCK_MAX} messages per block`;
  const out: DispatchLead[] = [];
  const seen = new Set<number>();
  for (const item of v as Array<Record<string, unknown>>) {
    const raw = typeof item?.raw_text === "string" ? item.raw_text : "";
    const index = item?.index;
    if (!raw.trim() || !Number.isInteger(index) || (index as number) < 0 || seen.has(index as number)) return "each message needs raw_text and a unique index";
    if (raw.length > MAX_RAW) return `one message is over ${MAX_RAW} characters`;
    seen.add(index as number);
    out.push({
      index: index as number,
      raw_text: raw,
      name: str(item.name, 120),
      phone: str(item.phone, 40),
      area: str(item.area, 120),
      service_needed: str(item.service_needed, 120),
      urgency: URGENCIES.has(item.urgency as string) ? (item.urgency as DispatchLead["urgency"]) : "routine",
    });
  }
  return out;
}

export async function handleDispatch(
  body: { leads?: unknown; config?: Partial<BusinessConfig>; mode?: unknown },
  auth: { demoKey: string | null } = { demoKey: null },
  env: EmberEnv = emberEnvFromProcess(),
): Promise<{ status: number; json: DispatchResponseBody | { error: string; usage?: Usage } }> {
  const leads = parseLeads(body.leads);
  if (typeof leads === "string") return { status: 400, json: { error: leads } };
  const config = normalizeConfig(body.config);
  const code = codeLinks(leads);
  const mock = (note?: string): DispatchResponseBody => ({
    links: mergeLinks([code, mockLinks(leads)]),
    dropped: [],
    usage: ZERO,
    mode: "mock",
    ...(note ? { note } : {}),
  });
  if (body.mode !== "ember") return { status: 200, json: mock() };
  const blocked = emberGate(auth.demoKey, env);
  if (blocked) return { status: 200, json: mock(`${blocked}; these links came from the practice-mode rules.`) };
  try {
    const r = await emberLink(leads, config, env);
    const { links, dropped } = validateLinks(r.raw, leads, "ember");
    return {
      status: 200,
      json: {
        links: mergeLinks([code, links]),
        dropped,
        usage: r.usage,
        mode: "ember",
        model: r.model,
        prompt_hash: r.promptHash,
        request_variant: r.requestVariant,
        finish_reason: r.finishReason,
      },
    };
  } catch (err) {
    console.error("ember_link_error", err);
    const reported = usageFromError(err);
    const usage: Usage = {
      tokens_in: reported?.tokens_in ?? 0,
      tokens_out: reported?.tokens_out ?? 0,
      cost_usd: reported ? computeCostUsd(reported.tokens_in, reported.tokens_out, env) : null,
      estimated: false,
    };
    return { status: 502, json: { error: "Ember link call failed; this block was not linked.", usage } };
  }
}
