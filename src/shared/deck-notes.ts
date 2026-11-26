// Reads note annotations out of a PDF with PDF.js. Kept apart from deck.ts so the same code can
// be exercised under Node against the fixtures.
import { embeddedNote } from "../core/notes";

interface AnnotationPage {
  getAnnotations(params: { intent: string }): Promise<unknown[]>;
}
interface AnnotationDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<AnnotationPage>;
}

/**
 * Notes embedded as text annotations, per 0-based page. The pdfpc LaTeX package marks its notes
 * Hidden, so they are only returned for the "any" intent, not the default "display".
 */
export async function loadEmbeddedNotes(pdf: AnnotationDocument): Promise<Map<number, string>> {
  const notes = new Map<number, string>();
  for (let page = 0; page < pdf.numPages; page++) {
    try {
      const proxy = await pdf.getPage(page + 1);
      const raw = (await proxy.getAnnotations({ intent: "any" })) as Record<string, unknown>[];
      const note = embeddedNote(
        raw.map((a) => {
          const obj = a["contentsObj"] as { str?: unknown } | undefined;
          const contents = typeof obj?.str === "string" ? obj.str : typeof a["contents"] === "string" ? a["contents"] : "";
          return { subtype: typeof a["subtype"] === "string" ? a["subtype"] : "", contents };
        }),
      );
      if (note !== null) notes.set(page, note);
    } catch {
      // A page whose annotations can't be read simply has no embedded note.
    }
  }
  return notes;
}
