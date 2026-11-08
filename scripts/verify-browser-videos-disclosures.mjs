import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("=== VERIFYING VIDEOS SCREEN PROVIDER DISCLOSURES & WORKFLOW ===");

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
    console.log("[1/3] Navigating to /login...");
    await page.goto("http://localhost:3000/login", { waitUntil: "load", timeout: 30000 });
    // Allow React hydration to attach onClick listeners
    await page.waitForTimeout(2000);
    console.log("  Waiting for One-Click Sign In button...");
    const oneClickBtn = page.locator('button:has-text("One-Click Sign In")');
    await oneClickBtn.waitFor({ state: "visible", timeout: 20000 });
    console.log("  Clicking One-Click Sign In...");
    await oneClickBtn.click();
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 20000 });
    console.log("✓ Authenticated. Current URL:", page.url());

    // 2. Open /videos
    console.log("[2/3] Navigating to http://localhost:3000/videos...");
    await page.goto("http://localhost:3000/videos", { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(2000);

    // Verify Provider Subtitle
    const subtitle = await page.locator(".page-subtitle").first().innerText();
    console.log("Subtitle:", subtitle);

    // Verify Honest Capability Disclosure Panel
    const capabilityText = page.locator("text=AI Image + Motion Assembly");
    await capabilityText.waitFor({ state: "visible", timeout: 10000 });
    console.log("✓ Verified: 'AI Image + Motion Assembly' capability disclosure is displayed.");

    const truthText = page.locator("text=Not native generative video diffusion");
    await truthText.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Verified: Truthful limitation disclosure ('Not native generative video diffusion') is visible.");

    const rendererText = page.locator("text=H.264 MP4 24 FPS FastStart");
    await rendererText.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Verified: Renderer technical specification is displayed.");

    // Verify Form Controls
    const promptInput = page.locator('input[placeholder="a lighthouse in a storm"]');
    await promptInput.waitFor({ state: "visible", timeout: 5000 });
    const durationInput = page.locator('input[type="number"]').first();
    await durationInput.waitFor({ state: "visible", timeout: 5000 });
    const generateBtn = page.locator('button:has-text("Generate")');
    await generateBtn.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Video generation composer form is ready and active.");

    // 3. Capture verified screenshot artifact
    console.log("[3/3] Capturing verified screenshot artifact...");
    const screenshotPath = path.join(ARTIFACT_DIR, "browser_videos_disclosure_verified.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`✓ Screenshot written to: ${screenshotPath}`);

    console.log("\n=== M-VIDEOS-01 BRANDING & DISCLOSURES VERIFIED SUCCESSFULLY ===");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
