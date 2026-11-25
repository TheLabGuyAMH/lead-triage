// Vercel serverless function: POST /api/extract
// Holds the Meta Model API key server-side; the browser never sees it.
// All logic lives in ./_lib/extract-core.ts (shared with local dev).

import { handleExtract } from "./_lib/extract-core.js";

interface Req {
  method?: string;
  body?: unknown;
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
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { status, json } = await handleExtract(body);
  res.status(status).json(json);
}
