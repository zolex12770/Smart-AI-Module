import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("=== VERIFYING AUDIO SCREEN PROVIDER DISCLOSURES & SPEECH WORKFLOW ===");

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

    // 2. Open /audio
    console.log("[2/4] Navigating to http://localhost:3000/audio...");
    await page.goto("http://localhost:3000/audio", { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(2000);

    // Verify Title & Subtitle
    const heading = await page.locator("h1").first().innerText();
    console.log("Page Heading:", heading);

    // Verify Honest Capability Disclosure Panel
    const engineText = page.locator("text=Windows SAPI 5.4 / Native Local OS Speech");
    await engineText.waitFor({ state: "visible", timeout: 10000 });
    console.log("✓ Verified: 'Windows SAPI 5.4 / Native Local OS Speech' engine disclosure is displayed.");

    const modeText = page.locator("text=Local Deterministic Audio Subsystem");
    await modeText.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Verified: 'Local Deterministic Audio Subsystem' mode disclosure is visible.");

    const formatText = page.locator("text=16-bit PCM Linear RIFF WAV Container");
    await formatText.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Verified: '16-bit PCM Linear RIFF WAV Container' specification is displayed.");

    const pacingText = page.locator("text=Pacing-adjusted for English technical narration");
    await pacingText.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Verified: Pacing & inflection technical notice is displayed.");

    // 3. Test Form Controls & Preset Selection
    console.log("[3/4] Testing preset buttons and speech synthesis form...");
    const presetBtn = page.locator('button:has-text("Sample: NirnayAI Introduction")');
    await presetBtn.waitFor({ state: "visible", timeout: 5000 });
    await presetBtn.click();
    console.log("✓ Clicked preset button: 'Sample: NirnayAI Introduction'.");

    const textarea = page.locator("textarea");
    const textValue = await textarea.inputValue();
    console.log("  Textarea value:", textValue);
    if (!textValue.includes("Windows SAPI")) {
      throw new Error(`Expected preset text in textarea, found: "${textValue}"`);
    }

    const generateBtn = page.locator('button:has-text("Generate speech")');
    await generateBtn.waitFor({ state: "visible", timeout: 5000 });
    console.log("  Triggering speech synthesis job...");
    await generateBtn.click();

    // Wait for the generation card to appear and complete
    console.log("  Waiting for synthesis job to complete...");
    await page.waitForSelector("audio", { timeout: 30000 });
    const audioPlayer = page.locator("audio").first();
    const audioSrc = await audioPlayer.getAttribute("src");
    console.log("✓ Audio player mounted with source:", audioSrc);

    // 4. Capture verified screenshot artifact
    console.log("[4/4] Capturing verified screenshot artifact...");
    const screenshotPath = path.join(ARTIFACT_DIR, "browser_audio_disclosure_verified.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`✓ Screenshot written to: ${screenshotPath}`);

    console.log("\n=== M-AUDIO-01 SPEECH SYNTHESIS & DISCLOSURES VERIFIED SUCCESSFULLY ===");
    process.exit(0);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
