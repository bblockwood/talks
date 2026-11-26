// Copies the PDF.js runtime assets (cMaps, standard fonts, wasm decoders) from
// node_modules into public/pdfjs/ so they are self-hosted. No CDN at runtime.
import { cp, rm, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "node_modules", "pdfjs-dist");
const dest = path.join(root, "public", "pdfjs");

await rm(dest, { recursive: true, force: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  const from = path.join(src, dir);
  try {
    await access(from);
  } catch {
    continue; // not every PDF.js version ships every directory
  }
  await cp(from, path.join(dest, dir), { recursive: true });
}
