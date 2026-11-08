import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("=== BROWSER E2E VERIFICATION: CONVERSATIONAL INTENT & HINDI/HINGLISH FLOW ===");

  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  try {
    // 1. Authenticate
    console.log("[1/6] Authenticating via One-Click Sign In...");
    await page.goto("http://localhost:3000/login", { waitUntil: "networkidle", timeout: 25000 });
    const oneClickBtn = page.locator('button:has-text("One-Click Sign In")');
    await oneClickBtn.waitFor({ state: "visible", timeout: 10000 });
    await oneClickBtn.click();
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
    console.log("✓ Authenticated. Current URL:", page.url());

    // 2. Navigate to /images
    console.log("[2/6] Navigating to http://localhost:3000/images...");
    await page.goto("http://localhost:3000/images", { waitUntil: "networkidle", timeout: 25000 });

    // 3. Inspect Provider Status Display
    console.log("[3/6] Verifying image provider display...");
    await page.waitForSelector(".page-subtitle", { timeout: 15000 });
    const subtitle = (await page.locator(".page-subtitle").textContent()) || "";
    console.log("  Provider subtitle:", subtitle.trim());

    if (!subtitle.includes("flux-diffusion")) {
      throw new Error(`Expected provider name 'flux-diffusion' in subtitle, got: "${subtitle}"`);
    }

    // 4. Fill Prompt 1 (Hinglish rural scene) & Submit Generation
    const prompt1 = "Ek village ki realistic photo jisme kisan aur aurat khana bana rahe hain";
    console.log(`[4/6] Submitting Turn 1 Prompt: "${prompt1}"...`);
    const promptInput = page.locator('input[placeholder="a lighthouse at dawn"]');
    await promptInput.fill(prompt1);

    const generateBtn = page.locator('button:has-text("Generate")');
    await generateBtn.click();
    console.log("✓ Generate clicked for Turn 1.");

    // Wait for generation card to appear and complete
    console.log("  Waiting for Turn 1 generation in browser gallery...");
    const card1 = page.locator(`.grid .card:has-text("${prompt1}")`).first();
    await card1.waitFor({ state: "visible", timeout: 15000 });

    const img1 = card1.locator("img");
    await img1.waitFor({ state: "visible", timeout: 120000 });
    console.log("✓ Turn 1 image is visible in gallery!");

    const src1 = await img1.getAttribute("src");
    console.log("  Turn 1 image src:", src1);

    // Download Turn 1 image
    const cookies = await context.cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const fullSrc1 = src1.startsWith("http") ? src1 : `http://localhost:3000${src1}`;
    const res1 = await fetch(fullSrc1, { headers: { Cookie: cookieHeader } });
    const buf1 = Buffer.from(await res1.arrayBuffer());
    const file1 = path.join(ARTIFACT_DIR, "browser_hinglish_turn1_village.png");
    fs.writeFileSync(file1, buf1);
    console.log(`✓ Turn 1 image saved to ${file1} (${buf1.length} bytes)`);

    // Pacing pause (46s) to stay within Pollinations free-tier rate limits
    console.log("  Pacing 46s for upstream rate limit before Turn 2...");
    await new Promise((r) => setTimeout(r, 46000));

    // 5. Fill Prompt 2 (Multi-turn Hinglish revision) & Submit
    const prompt2 = "Same scene but sham ka samay aur red sari";
    console.log(`[5/6] Submitting Turn 2 Prompt: "${prompt2}"...`);
    await promptInput.fill(prompt2);
    await generateBtn.click();
    console.log("✓ Generate clicked for Turn 2.");

    console.log("  Waiting for Turn 2 generation in browser gallery...");
    const card2 = page.locator(`.grid .card:has-text("${prompt2}")`).first();
    await card2.waitFor({ state: "visible", timeout: 15000 });

    const img2 = card2.locator("img");
    await img2.waitFor({ state: "visible", timeout: 120000 });
    console.log("✓ Turn 2 image is visible in gallery!");

    const src2 = await img2.getAttribute("src");
    console.log("  Turn 2 image src:", src2);

    // Download Turn 2 image
    const fullSrc2 = src2.startsWith("http") ? src2 : `http://localhost:3000${src2}`;
    const res2 = await fetch(fullSrc2, { headers: { Cookie: cookieHeader } });
    const buf2 = Buffer.from(await res2.arrayBuffer());
    const file2 = path.join(ARTIFACT_DIR, "browser_hinglish_turn2_red_sari.png");
    fs.writeFileSync(file2, buf2);
    console.log(`✓ Turn 2 image saved to ${file2} (${buf2.length} bytes)`);

    // 6. Screenshot Full Browser Gallery
    console.log("[6/6] Capturing full browser gallery screenshot...");
    const galleryScreenshotPath = path.join(ARTIFACT_DIR, "browser_conversational_gallery.png");
    await page.screenshot({ path: galleryScreenshotPath, fullPage: true });
    console.log("✓ Gallery screenshot saved to:", galleryScreenshotPath);

    console.log("\n==================================================");
    console.log("  BROWSER CONVERSATIONAL INTENT VERIFICATION PASSED");
    console.log("==================================================");
    console.log("Artifacts verified:");
    console.log("- Turn 1 image:", file1);
    console.log("- Turn 2 image:", file2);
    console.log("- Full gallery:", galleryScreenshotPath);
  } catch (err) {
    console.error("Browser verification failed:", err);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "browser_intent_error.png"), fullPage: true }).catch(() => {});
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
