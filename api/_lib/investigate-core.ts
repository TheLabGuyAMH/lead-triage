// Framework-free core of POST /api/investigate: one bounded Ember tool
// loop for one message, over the pile the caller sends. Same three gates
// as the other endpoints; the proposal goes through validateLinks()
// before it leaves the server. Mock mode answers "no investigation"
// at $0 (there is no keyword stand-in for an agent).

import { validateLinks, type DispatchLead, type LeadLink } from "../../src/lib/dispatch.js";
import type { InvestigateStep } from "../../src/lib/investigate.js";
import type { BusinessConfig, Usage } from "../../src/lib/schema.js";
import { computeCostUsd, emberEnvFromProcess, emberInvestigate, usageFromError, type EmberEnv } from "./ember.js";
import { emberGate, normalizeConfig } from "./extract-core.js";

const MAX_PILE = 1200;
const MAX_RAW = 4000;
const URGENCIES = new Set(["emergency", "same-day", "routine"]);
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);

export interface InvestigateResponseBody {
  links: LeadLink[];
  dropped: string[];
  outcome: string;
  steps: InvestigateStep[];
  turns: number;
  usage: Usage;
  mode: "mock" | "ember";
  note?: string;
  model?: string;
  prompt_hash?: string;
  request_variant?: string;
}

function parsePile(v: unknown): DispatchLead[] | string {
  if (!Array.isArray(v) || v.length < 2 || v.length > MAX_PILE) return `send 2 to ${MAX_PILE} messages`;
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

export async function handleInvestigate(
  body: { leads?: unknown; target_index?: unknown; config?: Partial<BusinessConfig>; mode?: unknown },
  auth: { demoKey: string | null } = { demoKey: null },
  env: EmberEnv = emberEnvFromProcess(),
): Promise<{ status: number; json: InvestigateResponseBody | { error: string; usage?: Usage } }> {
  const pile = parsePile(body.leads);
  if (typeof pile === "string") return { status: 400, json: { error: pile } };
  const target = pile.find((l) => l.index === body.target_index);
  if (!target) return { status: 400, json: { error: "target_index must be one of the messages" } };
  const config = normalizeConfig(body.config);
  const zero: Usage = { tokens_in: 0, tokens_out: 0, cost_usd: 0, estimated: true };
  if (body.mode !== "ember") return { status: 200, json: { links: [], dropped: [], outcome: "skipped", steps: [], turns: 0, usage: zero, mode: "mock", note: "The investigator needs Ember; practice mode skips it." } };
  const blocked = emberGate(auth.demoKey, env);
  if (blocked) return { status: 200, json: { links: [], dropped: [], outcome: "skipped", steps: [], turns: 0, usage: zero, mode: "mock", note: `${blocked}; the investigator did not run.` } };
  try {
    const r = await emberInvestigate(target, pile, config, env);
    const targetId = pile.findIndex((l) => l.index === target.index) + 1;
    const ids = Array.isArray(r.proposal?.ids) ? (r.proposal!.ids as unknown[]) : [];
    // A proposal must include the message under investigation; anything else is off-task.
    const onTask = r.proposal && ids.includes(targetId);
    const v = onTask
      ? validateLinks({ links: [{ ...r.proposal, confidence: "possible" }] }, pile, "ember")
      : { links: [], dropped: r.proposal ? ["proposal did not include the investigated message (dropped)"] : [] };
    // Agent links start at "possible"; validateLinks keeps them there (only anchored block links are "likely").
    const links = v.links.map((l) => ({ ...l, investigation: { turns: r.turns, steps: r.steps } }));
    return {
      status: 200,
      json: { links, dropped: v.dropped, outcome: r.outcome, steps: r.steps, turns: r.turns, usage: r.usage, mode: "ember", model: r.model, prompt_hash: r.promptHash, request_variant: r.requestVariant },
    };
  } catch (err) {
    console.error("ember_investigate_error", err);
    const reported = usageFromError(err);
    const usage: Usage = {
      tokens_in: reported?.tokens_in ?? 0,
      tokens_out: reported?.tokens_out ?? 0,
      cost_usd: reported ? computeCostUsd(reported.tokens_in, reported.tokens_out, env) : null,
      estimated: false,
    };
    return { status: 502, json: { error: "Ember investigation failed; this message was not investigated.", usage } };
  }
}
