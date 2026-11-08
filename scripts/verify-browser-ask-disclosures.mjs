import { chromium } from "playwright";
import path from "path";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("=== VERIFYING ASK / RAG SCREEN DISCLOSURES & GROUNDED Q&A ===");

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
    console.log("[1/5] Navigating to /login...");
    await page.goto("http://localhost:3000/login", { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(2000); // Allow React hydration
    console.log("  Clicking One-Click Sign In...");
    const oneClickBtn = page.locator('button:has-text("One-Click Sign In")');
    await oneClickBtn.waitFor({ state: "visible", timeout: 20000 });
    await oneClickBtn.click();
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 20000 });
    console.log("✓ Authenticated. Current URL:", page.url());

    // 2. Open /ask
    console.log("[2/5] Navigating to http://localhost:3000/ask...");
    await page.goto("http://localhost:3000/ask", { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(2000);

    // Verify Title & Subtitle
    const heading = await page.locator("h1").first().innerText();
    console.log("Page Heading:", heading);

    // Verify Honest Capability Disclosure Panel
    const groundText = page.locator("text=Strict passage-grounded answering");
    await groundText.waitFor({ state: "visible", timeout: 10000 });
    console.log("✓ Verified: Grounded retrieval guarantee disclosure is displayed.");

    const citationText = page.locator("text=Numbered bracket references");
    await citationText.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Verified: Verifiable citation architecture disclosure is visible.");

    const langText = page.locator("text=English, Hindi & Hinglish query expansion");
    await langText.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Verified: Cross-lingual querying disclosure is displayed.");

    const auditText = page.locator("text=Dual-pass validation flagging ungrounded claims");
    await auditText.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Verified: Hallucination audit disclosure is displayed.");

    // 3. Test Grounded Query with Citation
    console.log("[3/5] Testing grounded Q&A over indexed documents...");
    const presetBtn = page.locator('button:has-text("What capabilities does NirnayAI have?")');
    await presetBtn.waitFor({ state: "visible", timeout: 5000 });
    await presetBtn.click();

    const askBtn = page.locator('button[type="submit"]:has-text("Ask")');
    await askBtn.waitFor({ state: "visible", timeout: 5000 });
    await askBtn.click();

    console.log("  Waiting for RAG grounded answer...");
    await page.waitForSelector("h2:has-text('Answer')", { timeout: 30000 });
    const answerContent = await page.locator("section").innerText();
    console.log("✓ Answer received. Excerpt:", answerContent.slice(0, 200));

    // 4. Test Ungrounded Question Refusal
    console.log("[4/5] Testing strict ungrounded query refusal...");
    const textarea = page.locator("#rag-question");
    await textarea.fill("What is the quantum decryption speed of Mars rovers in 2099?");
    await askBtn.click();

    await page.waitForSelector("text=Your documents do not answer this question", { timeout: 30000 });
    console.log("✓ Verified: Strict truthful refusal ('Your documents do not answer this question') rendered.");

    // 5. Capture verified screenshot artifact
    console.log("[5/5] Capturing verified screenshot artifact...");
    const screenshotPath = path.join(ARTIFACT_DIR, "browser_ask_disclosure_verified.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`✓ Screenshot written to: ${screenshotPath}`);

    console.log("\n=== M-ASK-01 GROUNDED RAG & DISCLOSURES VERIFIED SUCCESSFULLY ===");
    process.exit(0);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
