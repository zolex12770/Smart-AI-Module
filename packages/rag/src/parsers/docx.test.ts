import { describe, expect, it } from "vitest";
import { extractDocxText } from "./docx.js";
import { buildZip } from "./zip-fixtures.js";

function docxFixture(bodyXml: string): Buffer {
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${bodyXml}</w:body></w:document>`;
  return buildZip([
    { name: "[Content_Types].xml", content: "<Types/>" },
    { name: "word/document.xml", content: documentXml },
  ]);
}

describe("extractDocxText (real hand-rolled ZIP + WordprocessingML reader)", () => {
  it("extracts text from simple paragraphs", () => {
    const docx = docxFixture(
      `<w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>` + `<w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>`
    );

    expect(extractDocxText(docx)).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("joins multiple runs within one paragraph with no extra whitespace inserted", () => {
    const docx = docxFixture(`<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> World</w:t></w:r></w:p>`);

    expect(extractDocxText(docx)).toBe("Hello World");
  });

  it("converts <w:tab/> and <w:br/> to a real tab and newline", () => {
    const docx = docxFixture(
      `<w:p><w:r><w:t>Col1</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Col2</w:t></w:r>` +
        `<w:r><w:br/></w:r><w:r><w:t>NextLine</w:t></w:r></w:p>`
    );

    expect(extractDocxText(docx)).toBe("Col1\tCol2\nNextLine");
  });

  it("decodes real XML entities inside text runs", () => {
    const docx = docxFixture(`<w:p><w:r><w:t>Fish &amp; Chips &lt;tasty&gt; &#39;quoted&#39;</w:t></w:r></w:p>`);

    expect(extractDocxText(docx)).toBe("Fish & Chips <tasty> 'quoted'");
  });

  it("excludes deleted tracked-change text (lives in <w:delText>, not <w:t>)", () => {
    const docx = docxFixture(
      `<w:p><w:r><w:t>Keep this.</w:t></w:r>` +
        `<w:del><w:r><w:delText>Delete this.</w:delText></w:r></w:del>` +
        `<w:ins><w:r><w:t>Inserted text.</w:t></w:r></w:ins></w:p>`
    );

    expect(extractDocxText(docx)).toBe("Keep this.Inserted text.");
  });

  it("skips empty paragraphs", () => {
    const docx = docxFixture(`<w:p><w:r><w:t>Text.</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>More text.</w:t></w:r></w:p>`);

    expect(extractDocxText(docx)).toBe("Text.\n\nMore text.");
  });
});
