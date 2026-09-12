import { readZipEntry } from "./zip.js";

/**
 * The document types this platform can actually ingest (backend/packages/rag/src/ingest.ts's
 * extension dispatch), as an allow-list keyed by extension → the declared MIME types a
 * browser may legitimately send for it. docs/13_SECURITY_ARCHITECTURE.md §12: "allow-list
 * accepted types, never a deny-list; validate both the declared MIME type and the actual
 * content." `application/octet-stream` is accepted as a *declared* type everywhere because
 * browsers (Windows especially) send it for any extension they don't recognize — `.md` and
 * `.docx` included — so rejecting it would reject real users; the content sniff below is
 * the check that actually matters, the declared type is only a first cheap filter.
 */
export const UPLOAD_ALLOWED_TYPES: Readonly<Record<string, readonly string[]>> = {
  ".txt": ["text/plain", "application/octet-stream"],
  ".md": ["text/markdown", "text/x-markdown", "text/plain", "application/octet-stream"],
  ".pdf": ["application/pdf", "application/octet-stream"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream"],
};

export type SniffResult = { ok: true } | { ok: false; reason: string };

/**
 * Real content validation, not just a trusted header (docs/13 §12): a PDF must start with
 * the `%PDF-` signature; a DOCX must be a real ZIP that actually contains
 * `word/document.xml` (checked with the same real ZIP reader the ingestion parser uses,
 * not a magic-number guess); text/Markdown must be valid UTF-8 with no NUL bytes (the
 * cheapest reliable tell that a binary was renamed `.txt`). Deliberately small and
 * dependency-free — this is a "is it plausibly what it claims" gate, not malware scanning,
 * which docs/13 §12 also calls for and which is NOT built (tracked in docs/27).
 */
export function sniffDocumentBytes(ext: string, bytes: Buffer): SniffResult {
  switch (ext) {
    case ".pdf":
      return bytes.subarray(0, 5).toString("latin1") === "%PDF-"
        ? { ok: true }
        : { ok: false, reason: "File does not start with a PDF signature." };
    case ".docx": {
      // Length guard first: readUInt32LE on a <4-byte buffer throws a RangeError, which
      // would surface as a 500 instead of the 400 a tiny garbage upload deserves.
      if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) {
        return { ok: false, reason: "File is not a ZIP container, so it cannot be a DOCX." };
      }
      try {
        readZipEntry(bytes, "word/document.xml");
        return { ok: true };
      } catch {
        return { ok: false, reason: "ZIP container has no word/document.xml, so it is not a DOCX." };
      }
    }
    case ".txt":
    case ".md": {
      if (bytes.includes(0)) return { ok: false, reason: "File contains NUL bytes, so it is not a text file." };
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return { ok: true };
      } catch {
        return { ok: false, reason: "File is not valid UTF-8 text." };
      }
    }
    default:
      return { ok: false, reason: `Unsupported extension "${ext}".` };
  }
}
