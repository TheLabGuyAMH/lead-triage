import { defineConfig, type Plugin } from "vite";
import { handleExtract } from "./api/_lib/extract-core.js";

// Mounts the same /api/extract logic used by the Vercel function, so
// `npm run dev` is a full local end-to-end run (mock until a key is set).
function localExtractApi(): Plugin {
  return {
    name: "local-extract-api",
    configureServer(server) {
      server.middlewares.use("/api/extract", (req, res) => {
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
            const { status, json } = await handleExtract(body);
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
    },
  };
}

export default defineConfig({
  plugins: [localExtractApi()],
});
