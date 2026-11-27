// The small Markdown subset speaker notes use (Native §5.2): paragraphs with line breaks, bullet
// and numbered lists, emphasis and inline code. Output is HTML with every piece of note text
// escaped, so it is safe to assign to innerHTML.

export type Block =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "bullet"; readonly text: string; readonly level: number }
  | { readonly kind: "numbered"; readonly text: string; readonly number: number };

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "    ");
    const trimmed = line.trim();
    if (trimmed === "") {
      flush();
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const bullet = /^[-*+•] +(.*)$/.exec(trimmed);
    const numbered = /^(\d{1,4})[.)] +(.*)$/.exec(trimmed);
    if (bullet) {
      flush();
      blocks.push({ kind: "bullet", text: (bullet[1] ?? "").trim(), level: Math.min(4, Math.floor(indent / 2)) });
    } else if (numbered) {
      flush();
      blocks.push({ kind: "numbered", text: (numbered[2] ?? "").trim(), number: Number.parseInt(numbered[1] ?? "0", 10) });
    } else {
      paragraph.push(trimmed);
    }
  }
  flush();
  return blocks;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Inline code, bold and emphasis. Operates on already-escaped text. */
function inline(escaped: string): string {
  // Code spans first, held aside so their contents are not treated as emphasis.
  const code: string[] = [];
  let out = escaped.replace(/`([^`\n]+)`/g, (_whole, body: string) => {
    code.push(`<code>${body}</code>`);
    return `\u0000${code.length - 1}\u0000`;
  });
  out = out
    .replace(/\*\*([^\s*](?:[^*]*[^\s*])?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^\s_](?:[^_]*[^\s_])?)__/g, "<strong>$1</strong>")
    .replace(/\*([^\s*](?:[^*]*[^\s*])?)\*/g, "<em>$1</em>")
    .replace(/(^|[^\w])_([^\s_](?:[^_]*[^\s_])?)_(?![\w])/g, "$1<em>$2</em>");
  return out.replace(/\u0000(\d+)\u0000/g, (_whole, i: string) => code[Number(i)] ?? "");
}

export function renderNotesHtml(text: string): string {
  const html: string[] = [];
  for (const block of parseBlocks(text.replace(/\u0000/g, ""))) {
    const body = inline(escapeHtml(block.text)).replace(/\n/g, "<br>");
    if (block.kind === "paragraph") html.push(`<p>${body}</p>`);
    // The text is one box beside its mark, so bold or code inside it wraps as text does.
    else if (block.kind === "bullet") html.push(`<p class="li l${block.level}"><span class="mark">•</span><span>${body}</span></p>`);
    else html.push(`<p class="li l0"><span class="mark">${block.number}.</span><span>${body}</span></p>`);
  }
  return html.join("");
}

/** `12:34`, `1:02:03`, or `-0:45` for a negative duration. */
export function formatClock(ms: number): string {
  const negative = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${negative ? "-" : ""}${h > 0 ? `${h}:${two(m)}` : String(m)}:${two(s)}`;
}
