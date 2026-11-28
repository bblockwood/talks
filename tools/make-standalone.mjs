// Folds the standalone build (.standalone/) into one self-contained page, with a marker where
// the app later puts a PDF. Usage: node tools/make-standalone.mjs [out.html]
//
// The page carries the app and the PDF reader's worker gzipped (as base64, in inert script
// elements), and a few lines that unpack and start them: about a third of the size of the same
// code written out (Ben, 2026-11-28).
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, ".standalone");
const out = path.resolve(process.argv[2] ?? path.join(root, "dist", "standalone.html"));
const MARKER = "<!--LECTERN-PACKED-DECK-->";

const assets = await readdir(path.join(from, "assets"));
const one = (ext) => {
  const found = assets.filter((f) => f.endsWith(ext));
  if (found.length !== 1) throw new Error(`expected one ${ext} file in the standalone build, found ${found.length}`);
  return readFile(path.join(from, "assets", found[0]), "utf8");
};
let js = await one(".js");
const css = await one(".css");
let html = await readFile(path.join(from, "index.html"), "utf8");

const replaceOnce = (pattern, replacement, what) => {
  if (!pattern.test(html)) throw new Error(`standalone page: ${what} not found`);
  html = html.replace(pattern, () => replacement);
};
// Nothing is fetched from anywhere: the page may run only what is inside it.
replaceOnce(
  /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' data: blob:; worker-src data: blob:; connect-src data: blob:; img-src blob: data:; font-src blob: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" />`,
  "the content security policy",
);
html = html.replace(/<link rel="(manifest|apple-touch-icon)"[^>]*>\s*/g, "");
replaceOnce(/<link rel="stylesheet"[^>]*>/, `<style>${css.replaceAll("</style", "<\\/style")}</style>`, "the stylesheet");
html = html.replace(/<script type="module"[^>]*src="[^"]*"[^>]*><\/script>\s*/g, "");

// The build writes the worker into the app as a base64 data URL, which gzip can do little with.
// It is taken out and packed by itself; the lines below hand the app the same data URL again.
const WORKER = /(["'`])data:text\/javascript;base64,([A-Za-z0-9+/=]+)\1/g;
const workers = [...js.matchAll(WORKER)];
if (workers.length !== 1) throw new Error(`standalone page: expected the worker once in the app, found it ${workers.length} times`);
const worker = Buffer.from(workers[0][2], "base64");
js = js.replace(WORKER, () => "globalThis.LECTERN_WORKER_URL");
const packed = (bytes) => gzipSync(bytes, { level: 9 }).toString("base64");
const boot = `
const unpack = (id) => {
  const bytes = Uint8Array.from(atob(document.getElementById(id).textContent), (c) => c.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")));
};
const dataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});
(async () => {
  const worker = await unpack("lectern-worker").blob();
  globalThis.LECTERN_WORKER_URL = await dataUrl(new Blob([worker], { type: "text/javascript" }));
  const app = document.createElement("script");
  app.type = "module";
  app.textContent = await unpack("lectern-app").text();
  document.body.append(app);
})();
`;
replaceOnce(
  /<\/body>/,
  `${MARKER}\n<script id="lectern-worker" type="application/gzip-base64">${packed(worker)}</script>\n<script id="lectern-app" type="application/gzip-base64">${packed(Buffer.from(js, "utf8"))}</script>\n<script>${boot}</script>\n</body>`,
  "the end of the body",
);
if (/(src|href)="\.\/assets\//.test(html)) throw new Error("standalone page still points at separate files");

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, html);
console.error(`standalone page: ${(html.length / 1e6).toFixed(1)} MB → ${path.relative(root, out)}`);
