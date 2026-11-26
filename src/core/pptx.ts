// PowerPoint speaker notes from a .pptx (Native §5.1(5)). Runs at publish time.
// A .pptx is a ZIP of XML parts. The handful of elements needed here are picked out with
// regular expressions rather than a full XML parser, to stay within the allowed dependencies.
import { strFromU8, unzipSync } from "fflate";

export interface PptxSlideNotes {
  /** 0-based position among the *visible* slides, which is the PDF page index. */
  readonly index: number;
  readonly text: string;
}

export interface PptxNotes {
  /** Slides PowerPoint exports to PDF: every slide not marked hidden. */
  readonly visibleSlideCount: number;
  readonly hiddenSlideCount: number;
  /** Only slides that have notes. */
  readonly notes: readonly PptxSlideNotes[];
}

export class PptxError extends Error {
  override name = "PptxError";
}

const ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

export function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES.get(body) ?? whole;
  });
}

const attribute = (tag: string, name: string): string | null => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decodeXmlText(m[1] ?? m[2] ?? "") : null;
};

interface Relationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
}

function relationships(xml: string): Relationship[] {
  const out: Relationship[] = [];
  for (const m of xml.matchAll(/<Relationship\b([^>]*)>/g)) {
    const tag = m[1] ?? "";
    const id = attribute(tag, "Id");
    const type = attribute(tag, "Type");
    const target = attribute(tag, "Target");
    if (id !== null && type !== null && target !== null) out.push({ id, type, target });
  }
  return out;
}

/** Resolves a relationship target against the directory of the part that owns the .rels file. */
export function resolveTarget(ownerDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = ownerDir === "" ? [] : ownerDir.split("/");
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== "." && segment !== "") parts.push(segment);
  }
  return parts.join("/");
}

const dirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const relsPathFor = (part: string): string => {
  const dir = dirOf(part);
  const name = part.slice(dir === "" ? 0 : dir.length + 1);
  return `${dir === "" ? "" : `${dir}/`}_rels/${name}.rels`;
};

/** Text of the notes body placeholder: paragraphs joined by newlines, `<a:br/>` as a newline. */
export function notesText(notesSlideXml: string): string {
  const paragraphs: string[] = [];
  for (const shape of notesSlideXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
    const sp = shape[0];
    const placeholder = /<p:ph\b([^>]*)>/.exec(sp);
    // The notes page also holds the slide image, slide number, header, footer and date placeholders.
    if (!placeholder || attribute(placeholder[1] ?? "", "type") !== "body") continue;
    for (const p of sp.matchAll(/<a:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:p>)/g)) {
      let line = "";
      for (const run of (p[1] ?? "").matchAll(/<a:t\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:t>)|<a:br\b[^>]*>/g)) {
        line += run[0].startsWith("<a:br") ? "\n" : decodeXmlText(run[1] ?? "");
      }
      paragraphs.push(line);
    }
  }
  return paragraphs.join("\n").trim();
}

export function extractPptxNotes(pptx: Uint8Array): PptxNotes {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(pptx, {
      filter: (file) => file.name === "ppt/presentation.xml" || /^ppt\/(_rels|slides|notesSlides)\//.test(file.name),
    });
  } catch {
    throw new PptxError("not a .pptx file (not a ZIP archive)");
  }
  const read = (path: string): string | null => {
    const bytes = files[path];
    return bytes ? strFromU8(bytes) : null;
  };

  const presentation = read("ppt/presentation.xml");
  const presentationRels = read("ppt/_rels/presentation.xml.rels");
  if (presentation === null || presentationRels === null) throw new PptxError("not a .pptx file (no presentation part)");

  // Slide order is the order of <p:sldId> in <p:sldIdLst>, not the file names.
  const list = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(presentation)?.[1] ?? "";
  const targets = new Map(relationships(presentationRels).map((r) => [r.id, r.target]));

  const notes: PptxSlideNotes[] = [];
  let visible = 0;
  let hidden = 0;
  for (const m of list.matchAll(/<p:sldId\b([^>]*)>/g)) {
    const rid = attribute(m[1] ?? "", "r:id");
    const target = rid === null ? undefined : targets.get(rid);
    if (target === undefined) throw new PptxError("slide list refers to a missing slide");
    const slidePath = resolveTarget("ppt", target);
    const slide = read(slidePath);
    if (slide === null) throw new PptxError(`missing slide part ${slidePath}`);

    // Hidden slides are omitted from PowerPoint's PDF export, so they take no page.
    const root = /<p:sld\b([^>]*)>/.exec(slide)?.[1] ?? "";
    const show = attribute(root, "show");
    if (show === "0" || show === "false") {
      hidden += 1;
      continue;
    }

    const rels = read(relsPathFor(slidePath));
    const notesRel = rels === null ? undefined : relationships(rels).find((r) => r.type.endsWith("/notesSlide"));
    if (notesRel) {
      const xml = read(resolveTarget(dirOf(slidePath), notesRel.target));
      const text = xml === null ? "" : notesText(xml);
      if (text !== "") notes.push({ index: visible, text });
    }
    visible += 1;
  }
  return { visibleSlideCount: visible, hiddenSlideCount: hidden, notes };
}
