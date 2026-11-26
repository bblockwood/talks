import { loadEnv } from "vite";
import type { ViteDevServer } from "vite";
import { readFile } from "node:fs/promises";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const relayUrl = env.VITE_RELAY_URL ?? "";
  // The CSP needs the relay's origin (scheme + host), not the full URL.
  const relayOrigin = relayUrl ? new URL(relayUrl).origin.replace(/^http/, "ws") : "";

  return {
    base: "/talks/",
    build: {
      target: "es2022",
      rollupOptions: {
        input: {
          index: page("index.html"),
          remote: page("remote/index.html"),
          presenter: page("presenter/index.html"),
          w0: page("w0/index.html"),
          w0phone: page("w0/phone/index.html"),
        },
      },
    },
    plugins: [
      {
        name: "lectern-csp-relay-origin",
        transformIndexHtml: (html: string) => html.replaceAll("__RELAY_ORIGIN__", relayOrigin),
      },
      {
        // Development and e2e only: serves encrypted test decks from .e2e/d/ at /talks/d/, where
        // the deployed site serves the `decks` branch. Nothing under .e2e/ is ever built or committed.
        name: "lectern-dev-decks",
        apply: "serve" as const,
        configureServer(server: ViteDevServer) {
          server.middlewares.use("/talks/d", (req, res, next) => {
            const rel = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
            if (!/^\/[0-9a-f]{32}\/(current\.json|[0-9a-f]{16}\.bin)$/.test(rel)) {
              res.statusCode = 404;
              res.end("not found");
              return;
            }
            readFile(page(`.e2e/d${rel}`))
              .then((body) => {
                res.setHeader("content-type", rel.endsWith(".json") ? "application/json" : "application/octet-stream");
                res.end(body);
              })
              .catch(() => {
                res.statusCode = 404;
                res.end("not found");
              });
            void next;
          });
        },
      },
    ],
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    test: { include: ["tests/**/*.test.ts"] },
  };
});
