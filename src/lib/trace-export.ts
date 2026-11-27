// Trace export builder (pure logic, shared by the UI download and
// verify.mjs). Privacy contract:
//
// - Redacted (the default) contains ONLY operational fields per call:
//   index, timestamp, category, urgency, needs_review as a boolean,
//   tokens, cost, latency, request_variant, finish_reason, model and
//   mode. No free text at all — no lead text, names, phones, drafts,
//   summaries, notes, reasons, or prompt text.
// - Unredacted is opt-in only, carries the full records, and sets
//   `contains_customer_data: true`.
// - Totals are always computed from the exported rows themselves,
//   never from session state that may cover other calls.
// - A replay export is marked `replay: true` and keeps the original
//   recorded timestamps carried on its entries.

import type { LeadLink } from "./dispatch.js";
import type { AdapterMode, LeadRecord } from "./schema.js";

/** One cross-message (link) call. Redacted exports keep counts only. */
export interface LinkTraceEntry {
  block: number;
  ts: string;
  mode: AdapterMode;
  model: string | null;
  prompt_hash: string | null;
  request_variant: string | null;
  finish_reason: string | null;
  latency_ms: number | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  estimated: boolean;
  messages: number;
  links: LeadLink[];
  dropped: string[];
  note?: string;
}

export interface TraceEntry {
  index: number;
  ts: string;
  mode: AdapterMode;
  model: string | null;
  prompt_hash: string | null;
  output_mode: string | null;
  request_variant: string | null;
  finish_reason: string | null;
  latency_ms: number | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  estimated: boolean;
  category: string;
  urgency: string;
  language: string;
  needs_review: string | null;
  note?: string;
  record: LeadRecord;
}

export interface TraceExportContext {
  model: string | null;
  prompt_hash: string | null;
  system_prompt: string | null;
  capUsd: number;
  replay: boolean;
  recorded_at: string | null;
}

/** Operational-only view of one call: the redacted export's row shape. */
export function operationalCall(t: TraceEntry) {
  return {
    call: t.index + 1,
    ts: t.ts,
    mode: t.mode,
    model: t.model,
    prompt_hash: t.prompt_hash,
    output_mode: t.output_mode,
    request_variant: t.request_variant,
    finish_reason: t.finish_reason,
    latency_ms: t.latency_ms,
    tokens_in: t.tokens_in,
    tokens_out: t.tokens_out,
    cost_usd: t.cost_usd,
    estimated: t.estimated,
    category: t.category,
    urgency: t.urgency,
    needs_review: t.needs_review !== null,
  };
}

function operationalLinkCall(t: LinkTraceEntry) {
  return {
    block: t.block + 1,
    ts: t.ts,
    mode: t.mode,
    model: t.model,
    prompt_hash: t.prompt_hash,
    request_variant: t.request_variant,
    finish_reason: t.finish_reason,
    latency_ms: t.latency_ms,
    tokens_in: t.tokens_in,
    tokens_out: t.tokens_out,
    cost_usd: t.cost_usd,
    estimated: t.estimated,
    messages: t.messages,
    links: t.links.length,
    dropped: t.dropped.length,
  };
}

export function buildTraceExport(entries: TraceEntry[], redact: boolean, ctx: TraceExportContext, linkCalls: LinkTraceEntry[] = []) {
  const shown = [...entries].sort((a, b) => a.index - b.index);
  const links = [...linkCalls].sort((a, b) => a.block - b.block);
  const all = [...shown, ...links];
  const costKnown = all.every((t) => t.cost_usd !== null);
  const totals = {
    calls: shown.length,
    link_calls: links.length,
    tokens_in: all.reduce((a, t) => a + t.tokens_in, 0),
    tokens_out: all.reduce((a, t) => a + t.tokens_out, 0),
    cost_usd: costKnown ? Number(all.reduce((a, t) => a + (t.cost_usd ?? 0), 0).toFixed(4)) : null,
    cost_note: costKnown
      ? "Computed from the exported rows (API usage + configured rates; mock calls are $0, estimated)."
      : "Usage missing for one or more exported calls; dollar total unavailable (never shown as $0).",
  };
  const base = {
    exported_at: new Date().toISOString(),
    app: "lead-triage",
    redacted: redact,
    contains_customer_data: !redact,
    replay: ctx.replay,
    ...(ctx.replay ? { recorded_at: ctx.recorded_at } : {}),
    model: ctx.model,
    prompt_hash: ctx.prompt_hash,
    budget_cap_usd_advisory: ctx.capUsd,
    totals,
  };
  if (redact) {
    return { ...base, calls: shown.map(operationalCall), link_calls: links.map(operationalLinkCall) };
  }
  return {
    ...base,
    // Prompt text is held server-side for live calls; prompt_hash
    // identifies exactly what was sent. Only the replay/eval
    // recordings carry the full text.
    system_prompt: ctx.system_prompt,
    calls: shown.map((t) => ({
      ...operationalCall(t),
      needs_review: t.needs_review,
      note: t.note ?? null,
      record: t.record,
    })),
    link_calls: links.map((t) => ({ ...operationalLinkCall(t), note: t.note ?? null, links: t.links, dropped: t.dropped })),
  };
}
