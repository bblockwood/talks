// The packed copy (Ben, 2026-11-27): the whole app as one HTML file, which the page fills with a
// PDF and offers as a download, to be opened from a thumb drive with no connection at all.
// This build produces one script and one stylesheet (the PDF reader's worker inside the script
// as a data URL); tools/make-standalone.mjs folds them into the page.
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "./",
  publicDir: false,
  build: {
    target: "es2022",
    outDir: ".standalone",
    emptyOutDir: true,
    assetsInlineLimit: 100 * 1024 * 1024,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      input: fileURLToPath(new URL("index.html", import.meta.url)),
      output: { inlineDynamicImports: true },
    },
  },
  // A packed copy talks to nothing: no relay, whatever the environment says.
  define: { "import.meta.env.VITE_RELAY_URL": JSON.stringify("") },
});
