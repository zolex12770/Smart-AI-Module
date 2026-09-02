import { describe, expect, it } from "vitest";
import { readZipEntry } from "./zip.js";
import { buildZip } from "./zip-fixtures.js";

describe("readZipEntry (real ZIP central-directory parsing)", () => {
  it("round-trips a deflate-compressed entry", () => {
    const content = "Hello from a real ZIP entry.\n".repeat(50); // long enough that deflate actually compresses it
    const zip = buildZip([{ name: "hello.txt", content }]);

    expect(readZipEntry(zip, "hello.txt").toString("utf8")).toBe(content);
  });

  it("round-trips a stored (uncompressed) entry", () => {
    const content = "stored, not deflated";
    const zip = buildZip([{ name: "raw.txt", content, store: true }]);

    expect(readZipEntry(zip, "raw.txt").toString("utf8")).toBe(content);
  });

  it("finds the correct entry among several", () => {
    const zip = buildZip([
      { name: "first.txt", content: "first" },
      { name: "second.txt", content: "second" },
      { name: "third.txt", content: "third" },
    ]);

    expect(readZipEntry(zip, "second.txt").toString("utf8")).toBe("second");
  });

  it("throws a clear error for a missing entry", () => {
    const zip = buildZip([{ name: "only.txt", content: "x" }]);
    expect(() => readZipEntry(zip, "missing.txt")).toThrow(/does not contain an entry/);
  });

  it("throws a clear error for a non-ZIP buffer", () => {
    expect(() => readZipEntry(Buffer.from("not a zip file at all"), "x")).toThrow(/not a valid zip/i);
  });
});
