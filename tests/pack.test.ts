import { describe, expect, it } from "vitest";
import { PACK_MARKER, packFileName, packPage } from "../src/core/pack";

describe("packed copy", () => {
  const template = `<html><head><title>Lectern</title></head><body>${PACK_MARKER}<script type="module">run()</script></body></html>`;

  it("puts the PDF where the marker is, and the title in the page", () => {
    const parts = packPage(template, "QUJD", 'My "talk" <1>.pdf');
    expect(parts).not.toBeNull();
    const page = (parts ?? []).join("");
    expect(page).toContain("<title>My &quot;talk&quot; &lt;1&gt;.pdf · Lectern</title>");
    expect(page).toContain('<script id="packed-deck" type="application/base64" data-title="My &quot;talk&quot; &lt;1&gt;.pdf">QUJD</script><script type="module">');
    expect(page).not.toContain(PACK_MARKER);
  });

  it("refuses a page without the marker, and anything that is not base64", () => {
    expect(packPage("<html></html>", "QUJD", "t")).toBeNull();
    expect(packPage(template, "</script>", "t")).toBeNull();
  });

  it("names the file after the talk", () => {
    expect(packFileName("Job talk.pdf")).toBe("Job talk.lectern.html");
    expect(packFileName('a/b:c*?"<>|.PDF')).toBe("a b c.lectern.html");
    expect(packFileName("")).toBe("talk.lectern.html");
  });
});
