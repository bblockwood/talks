import { loadEnv } from "vite";
import type { PreviewServer, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));

function serveTestDecks(req: IncomingMessage, res: ServerResponse): void {
  const rel = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
  const notFound = (): void => {
    res.statusCode = 404;
    res.end("not found");
  };
  if (!/^\/[0-9a-f]{32}\/(current\.json|[0-9a-f]{16}\.bin)$/.test(rel)) return notFound();
  readFile(page(`.e2e/d${rel}`))
    .then((body) => {
      res.setHeader("content-type", rel.endsWith(".json") ? "application/json" : "application/octet-stream");
      res.end(body);
    })
    .catch(notFound);
}

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
          sw: page("src/sw/sw.ts"),
        },
        output: {
          // The service worker must sit at the top of the site, under a fixed name, to control /talks/.
          entryFileNames: (chunk: { name: string }) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
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
          server.middlewares.use("/talks/d", serveTestDecks);
        },
        configurePreviewServer(server: PreviewServer) {
          server.middlewares.use("/talks/d", serveTestDecks);
        },
      },
      {
        // The service worker is built as an ordinary entry (so it shares code with the app), then
        // told which files to precache. Its version changes whenever any of those files does.
        name: "lectern-sw-manifest",
        apply: "build" as const,
        enforce: "post" as const,
        generateBundle(_options: unknown, bundle: Record<string, { type: string; fileName: string; code?: string; source?: string | Uint8Array }>) {
          const worker = bundle["sw.js"];
          if (!worker || worker.type !== "chunk" || worker.code === undefined) return;
          const files = Object.values(bundle)
            .map((f) => f.fileName)
            // The W0 test pages and the bundled fixture are not part of the app shell.
            .filter((f) => f !== "sw.js" && !f.endsWith(".map") && !f.endsWith(".pdf") && !/(^|[/-])w0/.test(f))
            .sort();
          const pages = files.filter((f) => f.endsWith("index.html")).map((f) => f.replace(/index\.html$/, ""));
          const assets = files.filter((f) => !f.endsWith(".html"));
          const hash = createHash("sha256");
          for (const f of files) {
            const item = bundle[f];
            hash.update(f);
            if (item && f.endsWith(".html") && item.source !== undefined) hash.update(item.source);
          }
          worker.code = worker.code
            .replace("__SW_VERSION__", hash.digest("hex").slice(0, 12))
            .replace("__SW_PRECACHE__", JSON.stringify([...pages, ...assets]));
        },
      },
    ],
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    test: { include: ["tests/**/*.test.ts"] },
  };
});
