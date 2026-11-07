import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("=== VERIFYING IMAGES SCREEN PROVIDER DISCLOSURES & GALLERY ===");

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
    console.log("[1/3] Authenticating via One-Click Sign In...");
    await page.goto("http://localhost:3000/login", { waitUntil: "networkidle", timeout: 25000 });
    const oneClickBtn = page.locator('button:has-text("One-Click Sign In")');
    await oneClickBtn.waitFor({ state: "visible", timeout: 10000 });
    await oneClickBtn.click();
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
    console.log("✓ Authenticated.");

    // 2. Open /images
    console.log("[2/3] Navigating to http://localhost:3000/images...");
    await page.goto("http://localhost:3000/images", { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForTimeout(2000);

    // Verify Provider Subtitle
    const subtitle = await page.locator(".page-subtitle").innerText();
    console.log("Subtitle:", subtitle);
    if (!subtitle.includes("flux-diffusion")) {
      throw new Error(`Expected flux-diffusion in subtitle, got: ${subtitle}`);
    }

    // Verify Honest Cloud Diffusion & Mode Disclosures
    const disclosureBox = page.locator("text=Remote Cloud Diffusion (Pollinations FLUX.1");
    await disclosureBox.waitFor({ state: "visible", timeout: 10000 });
    console.log("✓ Verified: Honest Cloud Diffusion disclosure is visible.");

    const modeText = page.locator("text=Text-to-Image Diffusion Latents");
    await modeText.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Verified: Text-to-Image synthesis mode distinction is displayed.");

    const watermarkText = page.locator("text=pollinations.ai watermark");
    await watermarkText.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Verified: Upstream watermark disclosure is explicitly stated.");

    // Verify Gallery and Download Controls
    const cards = page.locator(".grid .card");
    const count = await cards.count();
    console.log(`✓ Image Gallery rendered with ${count} images.`);

    if (count > 0) {
      const firstImg = cards.first().locator("img");
      if (await firstImg.isVisible()) {
        console.log("✓ Gallery image element is visible in the DOM.");
      }
      const downloadBtn = cards.first().locator('a:has-text("Download")');
      if (await downloadBtn.isVisible()) {
        console.log("✓ Download button is available on gallery item.");
      }
    }

    // 3. Capture verified screenshot artifact
    console.log("[3/3] Capturing verified screenshot artifact...");
    const screenshotPath = path.join(ARTIFACT_DIR, "browser_images_disclosure_verified.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`✓ Screenshot written to: ${screenshotPath}`);

    console.log("\n=== M-IMAGES-01 BRANDING & DISCLOSURES VERIFIED SUCCESSFULLY ===");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
