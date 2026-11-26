import { loadEnv } from "vite";
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
    ],
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    test: { include: ["tests/**/*.test.ts"] },
  };
});
