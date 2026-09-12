import { describe, expect, it } from "vitest";
import { extractPdfText } from "./pdf.js";

/**
 * Builds a real, valid, minimal PDF (correct xref byte offsets computed programmatically,
 * not transcribed by hand) with one Type1/Helvetica text-showing content stream per page —
 * enough to exercise the real PDF.js parser end to end without a checked-in binary fixture.
 */
function buildMinimalPdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;

  const pageObjIds = pages.map((_, i) => 3 + i * 2);
  const kids = pageObjIds.map((id) => `${id} 0 R`).join(" ");
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`;

  const fontObjId = 3 + pages.length * 2;
  objects[fontObjId] = `${fontObjId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;

  pages.forEach((lines, i) => {
    const pageId = 3 + i * 2;
    const contentId = pageId + 1;
    objects[pageId] =
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] ` +
      `/Resources << /Font << /F1 ${fontObjId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`;

    let stream = "BT /F1 18 Tf 10 150 Td ";
    lines.forEach((line, j) => {
      if (j > 0) stream += "0 -30 Td ";
      stream += `(${line}) Tj `;
    });
    stream += "ET";
    objects[contentId] = `${contentId} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
  });

  const totalObjects = fontObjId;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let id = 1; id <= totalObjects; id++) {
    offsets[id] = body.length;
    body += objects[id];
  }

  const xrefStart = body.length;
  let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= totalObjects; id++) {
    xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(body + xref + trailer, "utf8");
}

describe("extractPdfText (real pdfjs-dist parsing)", () => {
  it("extracts text from a single-page PDF, preserving line breaks", async () => {
    const pdf = buildMinimalPdf([["Hello World", "Second line of text"]]);

    const text = await extractPdfText(pdf);

    expect(text).toBe("Hello World\nSecond line of text");
  });

  it("extracts and joins text from multiple pages", async () => {
    const pdf = buildMinimalPdf([["Page one content"], ["Page two content"]]);

    const text = await extractPdfText(pdf);

    expect(text).toBe("Page one content\n\nPage two content");
  });

  it("throws a real, catchable error for a non-PDF buffer", async () => {
    await expect(extractPdfText(Buffer.from("this is not a pdf file"))).rejects.toThrow();
  });
});
