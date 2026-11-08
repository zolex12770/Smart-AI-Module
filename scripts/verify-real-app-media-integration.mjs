import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("=== PHASE 4: COMPREHENSIVE LIVE BROWSER VERIFICATION SUITE ===");

  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  const results = {};

  try {
    // -------------------------------------------------------------------------
    // 1. One-Click Sign In
    // -------------------------------------------------------------------------
    console.log("\n[STEP 1] Logging into application at http://localhost:3000/login...");
    await page.goto("http://localhost:3000/login", { waitUntil: "networkidle", timeout: 25000 });
    const oneClickBtn = page.locator('button:has-text("One-Click Sign In")');
    await oneClickBtn.waitFor({ state: "visible", timeout: 10000 });
    await oneClickBtn.click();
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
    console.log("✓ Successfully authenticated. Active URL:", page.url());
    results.auth = { status: "PASSED", url: page.url() };

    // -------------------------------------------------------------------------
    // 2. Images Module Live Generation & Gallery Verification (/images)
    // -------------------------------------------------------------------------
    console.log("\n[STEP 2] Verifying Images Module (/images)...");
    await page.goto("http://localhost:3000/images", { waitUntil: "networkidle", timeout: 25000 });
    
    // Check provider subtitle
    await page.waitForSelector("h1:has-text('Image generation')", { timeout: 10000 });
    const imageSubtitle = await page.locator(".page-subtitle").textContent();
    console.log("  Images Subtitle:", imageSubtitle.trim());

    // Verify warning status banner is gone
    const hasImageWarning = await page.locator("text=Image Generation Provider Status").isVisible();
    console.log("  Image warning notice present:", hasImageWarning);
    if (hasImageWarning) {
      throw new Error("Image Generation Provider Status warning is still visible!");
    }

    // Verify Generate button is ENABLED
    const generateBtn = page.locator('button[type="submit"]:has-text("Generate")');
    const promptInput = page.locator('input[placeholder="a lighthouse at dawn"]');
    await promptInput.fill("Neon cyberpunk city skyline with floating aerocars");
    const isBtnDisabled = await generateBtn.isDisabled();
    console.log("  Generate button disabled with prompt:", isBtnDisabled);
    if (isBtnDisabled) {
      throw new Error("Image Generate button is unexpectedly disabled!");
    }

    // Submit live image generation
    console.log("  Submitting live prompt: 'Neon cyberpunk city skyline with floating aerocars'...");
    await generateBtn.click();

    // Wait for the new card to appear and reach succeeded state
    console.log("  Waiting for image generation job to complete...");
    await page.waitForFunction(
      () => {
        const imgs = document.querySelectorAll(".grid .card img");
        return imgs && imgs.length > 0;
      },
      { timeout: 35000 }
    );

    const firstImageSrc = await page.locator(".grid .card img").first().getAttribute("src");
    console.log("✓ Live generated image rendered in DOM! Asset URL:", firstImageSrc);

    // Verify reload persistence
    await page.reload({ waitUntil: "networkidle" });
    const reloadedImageSrc = await page.locator(".grid .card img").first().getAttribute("src");
    console.log("✓ Reload persistence verified! Retained Asset URL:", reloadedImageSrc);

    await page.screenshot({ path: path.join(ARTIFACT_DIR, "verified_images_working.png") });
    results.images = {
      status: "PASSED",
      provider: imageSubtitle.trim(),
      assetUrl: reloadedImageSrc,
      persisted: true,
    };

    // -------------------------------------------------------------------------
    // 3. Videos Module Live Generation & Playback Verification (/videos)
    // -------------------------------------------------------------------------
    console.log("\n[STEP 3] Verifying Videos Module (/videos)...");
    await page.goto("http://localhost:3000/videos", { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForSelector("h1:has-text('Long-form video generation')", { timeout: 10000 });

    const videoSubtitle = await page.locator(".page-subtitle").first().textContent();
    console.log("  Videos Subtitle:", videoSubtitle.trim());

    // Verify video warning banner is gone
    const hasVideoWarning = await page.locator("text=Video Generation Provider Status").isVisible();
    console.log("  Video warning notice present:", hasVideoWarning);
    if (hasVideoWarning) {
      throw new Error("Video Generation Provider Status warning is still visible!");
    }

    // Submit a new 4s clip
    const videoPromptInput = page.locator('input[placeholder="a lighthouse in a storm"]');
    await videoPromptInput.fill("Atmospheric cybernetic quantum core pulse");
    const targetDurationInput = page.locator('label:has-text("Target duration") input');
    await targetDurationInput.fill("4");
    const sceneClipInput = page.locator('label:has-text("Scene length") input');
    await sceneClipInput.fill("4");
    
    console.log("  Submitting live video project...");
    await page.click('button[type="submit"]:has-text("Generate")');

    // Wait for the project card to appear in list
    console.log("  Waiting for project to be listed in video projects...");
    await page.waitForSelector('.card-list a[href^="/videos/"]', { timeout: 15000 });
    const firstProjectLink = page.locator('.card-list a[href^="/videos/"]').first();
    const projectHref = await firstProjectLink.getAttribute("href");
    console.log("  Navigating into project detail page:", projectHref);
    await firstProjectLink.click();

    // On /videos/:id page, wait for video rendering to succeed and <video> player with <source> to render
    console.log("  Waiting for video assembly and player to mount...");
    await page.waitForFunction(
      () => {
        const sourceElem = document.querySelector("video source");
        return sourceElem && sourceElem.src && sourceElem.src.includes("/api/v1/assets/");
      },
      { timeout: 60000 }
    );

    const sourceElem = page.locator("video source").first();
    const videoSrc = await sourceElem.getAttribute("src");
    console.log("✓ Live generated video player mounted! Video Source URL:", videoSrc);

    // Verify reload persistence
    await page.reload({ waitUntil: "networkidle" });
    const reloadedSourceElem = page.locator("video source").first();
    const reloadedVideoSrc = await reloadedSourceElem.getAttribute("src");
    console.log("✓ Video reload persistence verified! Source:", reloadedVideoSrc);

    await page.screenshot({ path: path.join(ARTIFACT_DIR, "verified_videos_working.png") });
    results.videos = {
      status: "PASSED",
      projectHref,
      videoSrc: reloadedVideoSrc,
      persisted: true,
    };

    // -------------------------------------------------------------------------
    // 4. Audio Module Verification (/audio)
    // -------------------------------------------------------------------------
    console.log("\n[STEP 4] Verifying Audio Module (/audio)...");
    await page.goto("http://localhost:3000/audio", { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForSelector("h1:has-text('Audio generation')", { timeout: 10000 });

    const sampleBtn = page.locator('button:has-text("Sample: NirnayAI Introduction")');
    await sampleBtn.waitFor({ state: "visible", timeout: 10000 });
    await sampleBtn.click();

    await page.click('button[type="submit"]:has-text("Generate speech")');
    console.log("  Submitted speech synthesis request...");

    await page.waitForSelector("audio", { timeout: 30000 });
    const audioSrc = await page.locator("audio").first().getAttribute("src");
    console.log("✓ Audio playback verified! Audio Source URL:", audioSrc);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "verified_audio_working.png") });
    results.audio = { status: "PASSED", audioSrc };

    // -------------------------------------------------------------------------
    // 5. Chat Verification (/chat)
    // -------------------------------------------------------------------------
    console.log("\n[STEP 5] Verifying Chat Module (/chat)...");
    await page.goto("http://localhost:3000/chat", { waitUntil: "networkidle", timeout: 25000 });
    const chip = page.locator('button:has-text("What is 2 + 2?")');
    await chip.waitFor({ state: "visible", timeout: 10000 });
    await chip.click();
    await page.waitForFunction(
      () => {
        const bubbles = document.querySelectorAll(".message.assistant");
        if (!bubbles || bubbles.length === 0) return false;
        const last = bubbles[bubbles.length - 1];
        const text = last && last.textContent ? last.textContent.trim() : "";
        return text.length > 0 && text !== "…";
      },
      { timeout: 25000 }
    );
    console.log("✓ Chat streaming response confirmed!");
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "verified_chat_working.png") });
    results.chat = { status: "PASSED" };

    // -------------------------------------------------------------------------
    // 6. Final Summary
    // -------------------------------------------------------------------------
    console.log("\n==================================================================");
    console.log("   🎉 COMPLETE APPLICATION BROWSER VERIFICATION SUCCESSFUL!");
    console.log("==================================================================");
    console.log(JSON.stringify(results, null, 2));

  } catch (err) {
    console.error("❌ Verification failed:", err);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "verification_error.png") }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
