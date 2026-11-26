import { describe, expect, it } from "vitest";
import { classify, staleBins, withoutQuery } from "../src/core/sw-routes";

const id = "0123456789abcdef0123456789abcdef";
const k = (path: string) => classify(path, "/talks/").kind;

describe("service worker routing", () => {
  it("treats app pages as pages", () => {
    for (const path of ["/talks/", "/talks", "/talks/remote", "/talks/remote/", "/talks/presenter/", "/talks/index.html", "/talks/some/page/"]) {
      expect(k(path)).toBe("page");
    }
  });

  it("treats hashed bundle files and PDF.js files as assets", () => {
    expect(k("/talks/assets/index-BQyVypf9.js")).toBe("asset");
    expect(k("/talks/assets/pdf.worker.min-CIqJB0yW.mjs")).toBe("asset");
    expect(k("/talks/pdfjs/cmaps/UniJIS-UTF16-H.bcmap")).toBe("asset");
    expect(k("/talks/pdfjs/wasm/openjpeg.wasm")).toBe("asset");
  });

  it("recognises a deck's two files and nothing else under d/", () => {
    expect(classify(`/talks/d/${id}/current.json`, "/talks/")).toEqual({ kind: "current", deckDir: `d/${id}/` });
    expect(classify(`/talks/d/${id}/0123456789abcdef.bin`, "/talks/")).toEqual({ kind: "bin", deckDir: `d/${id}/` });
    expect(k(`/talks/d/${id}/notes.txt`)).toBe("pass");
    expect(k(`/talks/d/${id}/`)).toBe("pass");
    expect(k("/talks/d/short/current.json")).toBe("pass");
    expect(k(`/talks/d/${id}/XYZ.bin`)).toBe("pass");
  });

  it("leaves everything else to the browser", () => {
    expect(k("/talks/sw.js")).toBe("pass");
    expect(k("/talks/favicon.ico")).toBe("pass");
    expect(k("/")).toBe("pass");
    expect(k("/research.html")).toBe("pass");
    expect(k("/talksextra/")).toBe("pass");
  });

  it("works under another base path", () => {
    expect(classify("/", "/").kind).toBe("page");
    expect(classify(`/d/${id}/current.json`, "/").kind).toBe("current");
  });

  it("keys current.json without its cache-buster", () => {
    expect(withoutQuery("https://x.example/talks/d/a/current.json?t=123")).toBe("https://x.example/talks/d/a/current.json");
    expect(withoutQuery("https://x.example/talks/")).toBe("https://x.example/talks/");
  });

  it("finds a deck's superseded files, and only that deck's", () => {
    const dir = `https://x.example/talks/d/${id}/`;
    const other = "https://x.example/talks/d/ffffffffffffffffffffffffffffffff/";
    const cached = [`${dir}current.json`, `${dir}aaaaaaaaaaaaaaaa.bin`, `${dir}bbbbbbbbbbbbbbbb.bin`, `${other}cccccccccccccccc.bin`];
    expect(staleBins(cached, dir, "bbbbbbbbbbbbbbbb.bin")).toEqual([`${dir}aaaaaaaaaaaaaaaa.bin`]);
    expect(staleBins(cached, dir, "aaaaaaaaaaaaaaaa.bin")).toEqual([`${dir}bbbbbbbbbbbbbbbb.bin`]);
  });
});
