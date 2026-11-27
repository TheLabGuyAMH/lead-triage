// Vercel serverless function: POST /api/dispatch (the cross-message pass).
// All logic lives in ./_lib/dispatch-core.ts (shared with local dev).

import { handleDispatch } from "./_lib/dispatch-core.js";

interface Req {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

interface Res {
  status(code: number): Res;
  json(body: unknown): void;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const key = req.headers?.["x-demo-key"];
  const { status, json } = await handleDispatch((req.body ?? {}) as Record<string, unknown>, {
    demoKey: typeof key === "string" ? key : null,
  });
  res.status(status).json(json);
}
