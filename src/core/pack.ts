// The packed copy: the app as one HTML file with a PDF inside it (Ben, 2026-11-27). The site
// serves the file with a marker where the PDF goes; this puts it there, as base64 in an inert
// script element.

export const PACK_MARKER = "<!--LECTERN-PACKED-DECK-->";
export const PACK_ELEMENT_ID = "packed-deck";

const escapeAttribute = (text: string): string => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The page in three parts, the PDF's base64 in the middle, for a Blob (so a large PDF is never
 * joined into one string). Null if `template` is not a standalone page.
 */
export function packPage(template: string, pdfBase64: string, title: string): [string, string, string] | null {
  const at = template.indexOf(PACK_MARKER);
  if (at < 0 || !/^[A-Za-z0-9+/]*=*$/.test(pdfBase64)) return null;
  const withTitle = template.slice(0, at).replace(/<title>[^<]*<\/title>/, () => `<title>${escapeAttribute(title)} · Lectern</title>`);
  return [
    `${withTitle}<script id="${PACK_ELEMENT_ID}" type="application/base64" data-title="${escapeAttribute(title)}">`,
    pdfBase64,
    `</script>${template.slice(at + PACK_MARKER.length)}`,
  ];
}

/** A file name for the packed copy: the title without ".pdf" or anything a file system dislikes. */
export function packFileName(title: string): string {
  const stem = title
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .trim()
    .slice(0, 80);
  return `${stem || "talk"}.lectern.html`;
}
