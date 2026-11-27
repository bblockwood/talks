// The text of the presenter view's information pop-ups (the "i" beside Notes and Outline), for
// someone who opens a deck and finds the pane empty. Adapted from the native app (Native §5.1,
// §4.4). Written in the notes' own small Markdown.

export const NOTES_INFO = [
  "Speaker notes for the current slide. They are read from the PDF itself, so they work for any PDF opened here. A build without notes of its own shows its frame's.",
  "- **pdfpc package.** In LaTeX, `\\usepackage{pdfpc}` and `\\pdfpcnote{…}` inside a frame; `\\only<2>{\\pdfpcnote{…}}` for one build only.",
  "- **pdfcomment package.** `\\usepackage{pdfcomment}` and `\\pdfcomment{…}` or `\\pdfmargincomment{…}` inside a frame. The comments' text becomes the notes; they are never drawn on the slide.",
  "- **Beamer notes on a second screen.** `\\usepackage{pgfpages}` and `\\setbeameroption{show notes on second screen=right}` (or `left`, `bottom`), with `\\note{…}` in frames. Each page then holds the slide and its notes side by side: the page where the view is chosen offers to hide the notes half from the audience, and it is shown here as an image.",
  "A talk published ahead of time with the `publish` tool also carries the notes kept in files beside the PDF: a `talk.pdfpc` file as pdfpc writes it, the speaker notes of a `.pptx` with the same name, and a `talk.lectern.json` sidecar, which comes before all the others.",
  "Text notes render basic Markdown (*emphasis*, `code`, lists, line breaks). A− and A+ change their size.",
].join("\n\n");

export const outlineInfo = (hasOutline: boolean): string =>
  [
    hasOutline
      ? "The PDF's outline (its bookmarks): one entry per section with the frame it starts on, the one you are in highlighted. Click an entry to jump there; Back returns."
      : "This PDF has no outline (bookmarks), so the tab is off. With one, Outline lists each section with the frame it starts on, highlights the one you are in, and jumps there on a click.",
    "- **Beamer.** Every `\\part`, `\\section`, `\\subsection` and `\\subsubsection` becomes an entry; nothing else is needed.",
    "- **Other LaTeX.** Load `hyperref`; the sectioning commands then write bookmarks. Pandoc's Beamer output has them already.",
    "- **PowerPoint and Keynote.** Their PDF exports usually carry no outline. The Overview (Tab) shows every frame instead.",
  ].join("\n\n");

/** The shortcut card (?), written for the keyboard in front of the presenter: ⌘ on a Mac, Ctrl elsewhere. */
export const keysInfo = (mac: boolean): string => {
  const mod = (key: string): string => (mac ? `\`⌘${key}\`` : `\`Ctrl\`+\`${key}\``);
  return [
    "- **Next:** `→` `↓` `Space` `Page Down` `Enter` `N`, or a click on the slide",
    "- **Previous:** `←` `↑` `Page Up` `P`",
    "- **Next / previous frame:** `Shift` with `→` / `←`",
    "- **Go to a frame:** type its number, then `Enter`",
    `- **Back after a jump:** ${mac ? "`Delete`" : "`Backspace` or `Delete`"} or ${mod("[")}. **Forward again:** ${mod("]")}`,
    `- **Overview:** \`Tab\`. **Search:** ${mod("F")}`,
    "- **Laser:** `L`. **Draw:** `D`. **Clear the ink:** `C`",
    "- **Black:** `B` or `.` **White,** to draw on: `W`",
    "- **Pause the clock:** `T`",
    `- **Swap displays** (two screens): ${mod("D")}`,
    "- **Exit to the choice of views:** `Esc` twice. One `Esc` closes whatever is open",
    "- **Connection diagnostics:** `Ctrl`+`Shift`+`D`. **This card:** `?`",
  ].join("\n");
};

/** The same card on the slides themselves, for a talk run from one device with one screen. */
export const stageKeysInfo = (mac: boolean): string => {
  const mod = (key: string): string => (mac ? `\`⌘${key}\`` : `\`Ctrl\`+\`${key}\``);
  return [
    "- **Next:** `→` `↓` `Space` `Page Down` `Enter` `N`, or a click on the slide",
    "- **Previous:** `←` `↑` `Page Up` `P`",
    "- **Next / previous frame:** `Shift` with `→` / `←`",
    "- **Go to a frame:** type its number, then `Enter`",
    `- **Back after a jump:** ${mac ? "`Delete`" : "`Backspace` or `Delete`"} or ${mod("[")}. **Forward again:** ${mod("]")}`,
    "- **Overview:** `Tab`; a click on a frame goes there",
    "- **Laser:** `L`, then move the mouse. **Draw:** `D`. **Clear the ink:** `C`",
    "- **Black:** `B` or `.` **White,** to draw on: `W`",
    "- **Pause the clock:** `T`",
    "- **Tools, clock and Exit:** move the mouse to the bottom edge of the screen, or tap twice",
    "- **Back to the choice of views:** `Esc` twice. One `Esc` closes whatever is open",
  ].join("\n");
};
