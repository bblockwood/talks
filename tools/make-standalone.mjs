// Folds the standalone build (.standalone/) into one self-contained page, with a marker where
// the app later puts a PDF. Usage: node tools/make-standalone.mjs [out.html]
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
const js = await one(".js");
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
// Inside a script element only "</script" ends it; in JavaScript source "<\/script" means the same.
replaceOnce(/<\/body>/, `${MARKER}\n<script type="module">${js.replaceAll("</script", "<\\/script")}</script>\n</body>`, "the end of the body");
if (/(src|href)="\.\/assets\//.test(html)) throw new Error("standalone page still points at separate files");

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, html);
console.error(`standalone page: ${(html.length / 1e6).toFixed(1)} MB → ${path.relative(root, out)}`);
