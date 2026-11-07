import { chromium } from "playwright";
import path from "path";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("=== VERIFYING FILES SCREEN DISCLOSURES & RAG INGESTION WORKFLOW ===");

  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 950 },
  });

  const page = await context.newPage();

  try {
    // 1. Authenticate
    console.log("[1/4] Navigating to /login...");
    await page.goto("http://localhost:3000/login", { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(2000); // Allow React hydration
    console.log("  Clicking One-Click Sign In...");
    const oneClickBtn = page.locator('button:has-text("One-Click Sign In")');
    await oneClickBtn.waitFor({ state: "visible", timeout: 20000 });
    await oneClickBtn.click();
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 20000 });
    console.log("✓ Authenticated. Current URL:", page.url());

    // 2. Open /files
    console.log("[2/4] Navigating to http://localhost:3000/files...");
    await page.goto("http://localhost:3000/files", { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(2000);

    // Verify Title & Subtitle
    const heading = await page.locator("h1").first().innerText();
    console.log("Page Heading:", heading);

    // Verify Honest Capability Disclosure Panel
    const parserText = page.locator("text=Real native extraction for .pdf (pdfjs-dist)");
    await parserText.waitFor({ state: "visible", timeout: 10000 });
    console.log("✓ Verified: PDF & DOCX native parser disclosure is displayed.");

    const chunkingText = page.locator("text=Token-aware sliding chunker with paragraph and boundary alignment");
    await chunkingText.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Verified: Token-aware chunking pipeline disclosure is visible.");

    const embedText = page.locator("text=Lexical feature-hash vector space (256-dim) in local mode");
    await embedText.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Verified: Embedding engine specification is displayed.");

    const storageText = page.locator("text=Project-scoped pgvector PostgreSQL storage");
    await storageText.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Verified: PostgreSQL pgvector storage and isolation notice is displayed.");

    // 3. Document Seeding & Listing Check
    console.log("[3/4] Checking document list or seeding sample knowledge base...");
    const docCards = page.locator(".card-list .card-row");
    const docCount = await docCards.count();
    console.log(`  Current ingested documents in view: ${docCount}`);

    if (docCount === 0) {
      const seedBtn = page.locator('button:has-text("Seed Sample Document")');
      await seedBtn.waitFor({ state: "visible", timeout: 5000 });
      console.log("  Seeding sample knowledge document...");
      await seedBtn.click();
      await page.waitForSelector(".card-list .card-row", { timeout: 20000 });
      console.log("✓ Document seeded and listed.");
    }

    // Verify Document Row elements
    const firstDoc = page.locator(".card-list .card-row").first();
    const docTitle = await firstDoc.locator("strong").innerText();
    console.log(`✓ Ingested document verified: "${docTitle}"`);

    // 4. Capture verified screenshot artifact
    console.log("[4/4] Capturing verified screenshot artifact...");
    const screenshotPath = path.join(ARTIFACT_DIR, "browser_files_disclosure_verified.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`✓ Screenshot written to: ${screenshotPath}`);

    console.log("\n=== M-FILES-01 DOCUMENT LIFECYCLE & DISCLOSURES VERIFIED SUCCESSFULLY ===");
    process.exit(0);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
