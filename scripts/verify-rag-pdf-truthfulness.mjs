/**
 * NIRNAY.AI — RAG PDF TRUTHFULNESS & CONVERSATIONAL MEMORY AUDIT SUITE
 *
 * Validates:
 * 1. Scanned raster PDF ingestion marks chunk as metadata-only requiring OCR.
 * 2. Mixed PDF extracts text and notes raster pages.
 * 3. Empty PDF (0 bytes) rejects cleanly.
 * 4. Model gateway retrieval against scanned raster PDF truthfully refuses without hallucination.
 * 5. Conversational profile memory update (latest takes precedence).
 * 6. Memory invalidation/forgetting ("forget my name").
 * 7. Truthful disclosure of ephemeral in-session vs durable profile persistence.
 */

import { extractPdfText } from "../backend/packages/rag/dist/parsers/pdf.js";

function buildMinimalPdf(pages) {
  const objects = [];
  const pageRefs = [];
  objects.push(""); // 1-indexed

  // 1: Catalog
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  // 2: Pages (placeholder)
  objects.push("");

  let objIdx = 3;
  for (const pageLines of pages) {
    const pageObjIdx = objIdx++;
    pageRefs.push(`${pageObjIdx} 0 R`);

    if (pageLines.length === 0) {
      // Empty / raster page without font streams
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>`);
    } else {
      const streamLines = ["BT", "/F1 12 Tf", "50 700 Td"];
      for (const line of pageLines) {
        streamLines.push(`(${line.replace(/[()\\]/g, "\\$&")}) Tj`, "T*");
      }
      streamLines.push("ET");
      const streamContent = streamLines.join("\n");
      const contentObjIdx = objIdx++;

      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjIdx} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`
      );
      objects.push(`<< /Length ${Buffer.byteLength(streamContent)} >>\nstream\n${streamContent}\nendstream`);
    }
  }

  objects[2] = `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pages.length} >>`;

  let pdfStr = "%PDF-1.4\n";
  const xref = [0];
  for (let i = 1; i < objects.length; i++) {
    xref.push(Buffer.byteLength(pdfStr, "latin1"));
    pdfStr += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const startxref = Buffer.byteLength(pdfStr, "latin1");
  pdfStr += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    pdfStr += String(xref[i]).padStart(10, "0") + " 00000 n \n";
  }
  pdfStr += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF`;
  return Buffer.from(pdfStr, "latin1");
}

async function queryModelGateway(messages) {
  const res = await fetch("http://127.0.0.1:11434/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, stream: false }),
  });
  if (!res.ok) throw new Error(`Model gateway HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log("================================================================================");
  console.log("  NIRNAY.AI: RAG PDF INGESTION INTEGRITY & MEMORY AUDIT SUITE                   ");
  console.log("================================================================================\n");

  let passed = 0;

  // 1. Scanned Raster PDF
  console.log("[1/6] Ingestion of scanned raster PDF (zero digital font streams)...");
  const scannedPdf = buildMinimalPdf([[]]);
  const scannedText = await extractPdfText(scannedPdf);
  if (!scannedText.includes("Document Metadata Only: Scanned/Raster PDF") || !scannedText.includes("OCR required")) {
    throw new Error(`Scanned PDF did not produce OCR metadata descriptor: ${scannedText}`);
  }
  console.log("  PASS: Scanned PDF produced explicit OCR metadata chunk.\n");
  passed++;

  // 2. Mixed PDF (Selectable text + raster page)
  console.log("[2/6] Ingestion of mixed PDF (selectable text + raster page)...");
  const mixedPdf = buildMinimalPdf([["Q3 Enterprise Revenue Report: $4.2M"], []]);
  const mixedText = await extractPdfText(mixedPdf);
  if (!mixedText.includes("Q3 Enterprise Revenue Report: $4.2M") || !mixedText.includes("raster/image-only")) {
    throw new Error(`Mixed PDF did not extract text or note raster page: ${mixedText}`);
  }
  console.log("  PASS: Mixed PDF extracted digital text and noted scanned pages.\n");
  passed++;

  // 3. Empty PDF Buffer
  console.log("[3/6] Ingestion of empty 0-byte PDF buffer...");
  let emptyRejected = false;
  try {
    await extractPdfText(Buffer.alloc(0));
  } catch (err) {
    emptyRejected = true;
    console.log("  ✓ Empty buffer rejected with:", err.message);
  }
  if (!emptyRejected) throw new Error("Empty 0-byte buffer was not rejected!");
  console.log("  PASS: 0-byte buffer rejected cleanly.\n");
  passed++;

  // 4. Grounded RAG Retrieval Refusal on Scanned Raster PDF Chunk
  console.log("[4/6] Truthful RAG refusal on scanned raster PDF chunk (no hallucination)...");
  const ragTurn = await queryModelGateway([
    {
      role: "user",
      content:
        `Answer the question based only on the provided context.\n` +
        `<untrusted-document-content>\n${scannedText}\n</untrusted-document-content>\n` +
        `Question: What was the company's net revenue for Q3?`,
    },
  ]);
  const ragContent = ragTurn.choices[0].message.content;
  if (!ragContent.includes("The provided documents do not contain the answer") && !ragContent.includes("OCR")) {
    throw new Error(`Model hallucinated on scanned raster chunk: ${ragContent}`);
  }
  console.log("  PASS: Model truthfully refused to answer from scanned metadata chunk without OCR.\n");
  passed++;

  // 5. Memory Update (Latest turn takes precedence)
  console.log("[5/6] Multi-turn profile memory update (overwriting prior city)...");
  const memTurn = await queryModelGateway([
    { role: "user", content: "Hi, my name is Vikram and I am a software architect from Pune." },
    { role: "assistant", content: "Hello Vikram! I noted you are from Pune." },
    { role: "user", content: "Actually, I just moved to Mumbai last week." },
    { role: "assistant", content: "Got it, updated your location to Mumbai." },
    { role: "user", content: "Do you remember where I live now?" },
  ]);
  const memContent = memTurn.choices[0].message.content;
  if (!memContent.includes("Mumbai") || memContent.includes("Pune") || !memContent.includes("Vikram")) {
    throw new Error(`Memory update failed to prioritize latest city: ${memContent}`);
  }
  if (!memContent.includes("In-session conversational context is active")) {
    throw new Error(`Memory response failed to truthfully disclose ephemeral session boundary: ${memContent}`);
  }
  console.log("  PASS: Latest profile update prioritized (Mumbai over Pune) and honest disclosure included.\n");
  passed++;

  // 6. Memory Deletion / Invalidation
  console.log("[6/6] Conversational memory invalidation ('forget my details')...");
  const forgetTurn = await queryModelGateway([
    { role: "user", content: "My name is Vikram from Mumbai." },
    { role: "assistant", content: "Hello Vikram from Mumbai!" },
    { role: "user", content: "Please forget my name and details." },
  ]);
  const forgetContent = forgetTurn.choices[0].message.content;
  if (!forgetContent.includes("cleared and forgotten") && !forgetContent.includes("reset")) {
    throw new Error(`Memory deletion not acknowledged: ${forgetContent}`);
  }
  console.log("  PASS: Memory deletion acknowledged and session context cleared.\n");
  passed++;

  console.log("================================================================================");
  console.log(`   🎉 RAG INGESTION INTEGRITY & MEMORY AUDIT: ${passed}/6 PASSED (100%) `);
  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("Audit suite failed:", err);
  process.exit(1);
});
