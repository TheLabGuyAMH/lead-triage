import { defineConfig, type Plugin } from "vite";
import { handleDispatch } from "./api/_lib/dispatch-core.js";
import { handleExtract } from "./api/_lib/extract-core.js";

// Mounts the same /api/extract logic used by the Vercel function, so
// `npm run dev` is a full local end-to-end run (mock until a key is set).
type Handler = (body: Record<string, unknown>, auth: { demoKey: string | null }) => Promise<{ status: number; json: unknown }>;

function localExtractApi(): Plugin {
  return {
    name: "local-extract-api",
    configureServer(server) {
      const mount = (path: string, handle: Handler) => server.middlewares.use(path, (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "POST only" }));
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            const key = req.headers["x-demo-key"];
            const { status, json } = await handle(body, {
              demoKey: typeof key === "string" ? key : null,
            });
            res.statusCode = status;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(json));
          } catch {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
          }
        });
      });
      mount("/api/extract", handleExtract as Handler);
      mount("/api/dispatch", handleDispatch as Handler);
    },
  };
}

export default defineConfig({
  plugins: [localExtractApi()],
});
