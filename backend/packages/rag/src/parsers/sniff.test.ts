import { describe, expect, it } from "vitest";
import { sniffDocumentBytes, UPLOAD_ALLOWED_TYPES } from "./sniff.js";
import { buildZip } from "./zip-fixtures.js";

describe("sniffDocumentBytes (docs/13 §12 content validation, not just the declared type)", () => {
  it("accepts a real PDF signature and rejects a renamed non-PDF", () => {
    expect(sniffDocumentBytes(".pdf", Buffer.from("%PDF-1.4\n%..."))).toEqual({ ok: true });
    expect(sniffDocumentBytes(".pdf", Buffer.from("<html>not a pdf</html>")).ok).toBe(false);
  });

  it("accepts a real DOCX (ZIP with word/document.xml) and rejects a ZIP that lacks it", () => {
    const realDocx = buildZip([{ name: "word/document.xml", content: "<w:document/>" }]);
    const otherZip = buildZip([{ name: "README.txt", content: "hello" }]);
    expect(sniffDocumentBytes(".docx", realDocx)).toEqual({ ok: true });
    expect(sniffDocumentBytes(".docx", otherZip).ok).toBe(false);
    expect(sniffDocumentBytes(".docx", Buffer.from("%PDF-1.4 pretending to be docx")).ok).toBe(false);
  });

  it("accepts UTF-8 text and rejects binaries renamed .txt/.md", () => {
    expect(sniffDocumentBytes(".txt", Buffer.from("plain text — with unicode ✓", "utf8"))).toEqual({ ok: true });
    expect(sniffDocumentBytes(".md", Buffer.from("# heading\n\nbody", "utf8"))).toEqual({ ok: true });
    expect(sniffDocumentBytes(".txt", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])).ok).toBe(false); // PNG-ish with a NUL
    expect(sniffDocumentBytes(".md", Buffer.from([0xff, 0xfe, 0xfd])).ok).toBe(false); // invalid UTF-8
  });

  it("rejects any extension outside the allow-list", () => {
    expect(sniffDocumentBytes(".exe", Buffer.from("MZ")).ok).toBe(false);
    expect(sniffDocumentBytes(".html", Buffer.from("<script>")).ok).toBe(false);
  });

  it("allow-list covers exactly what the ingestion parsers can handle, and tolerates browsers' octet-stream", () => {
    expect(Object.keys(UPLOAD_ALLOWED_TYPES).sort()).toEqual([".docx", ".md", ".pdf", ".txt"]);
    for (const mimes of Object.values(UPLOAD_ALLOWED_TYPES)) expect(mimes).toContain("application/octet-stream");
  });
});
