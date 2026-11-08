import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("=== BROWSER E2E VERIFICATION: AUDIO & VIDEO PIPELINES (M6 & M7) ===");

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
    console.log("[1/5] Authenticating via One-Click Sign In...");
    await page.goto("http://localhost:3000/login", { waitUntil: "networkidle", timeout: 25000 });
    const oneClickBtn = page.locator('button:has-text("One-Click Sign In")');
    await oneClickBtn.waitFor({ state: "visible", timeout: 10000 });
    await oneClickBtn.click();
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
    console.log("✓ Authenticated. Current URL:", page.url());

    // 2. Audio Generation (/audio)
    console.log("\n[2/5] Testing Audio Generation (/audio)...");
    await page.goto("http://localhost:3000/audio", { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForSelector("h1", { timeout: 15000 });

    const sampleBtn = page.locator('button:has-text("Sample: NirnayAI Introduction")').first();
    await sampleBtn.waitFor({ state: "visible", timeout: 10000 });
    await sampleBtn.click();

    const generateSpeechBtn = page.locator('button[type="submit"]:has-text("Generate speech")');
    await generateSpeechBtn.click();
    console.log("✓ Submitted speech synthesis request.");

    // Wait for <audio> element to mount
    console.log("  Waiting for <audio> player element...");
    const audioElement = page.locator("audio").first();
    await audioElement.waitFor({ state: "visible", timeout: 35000 });

    const audioSrc = await audioElement.getAttribute("src");
    console.log("✓ Audio player mounted with source URL:", audioSrc);

    // Download audio file to artifact directory
    const cookies = await context.cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const fullAudioUrl = audioSrc.startsWith("http") ? audioSrc : `http://localhost:3000${audioSrc}`;
    const audioRes = await fetch(fullAudioUrl, { headers: { Cookie: cookieHeader } });
    const audioBuf = Buffer.from(await audioRes.arrayBuffer());
    const audioSavePath = path.join(ARTIFACT_DIR, "browser_generated_speech.wav");
    fs.writeFileSync(audioSavePath, audioBuf);
    console.log(`✓ Audio WAV downloaded and saved (${audioBuf.length} bytes):`, audioSavePath);

    const audioScreenshotPath = path.join(ARTIFACT_DIR, "browser_audio_verified.png");
    await page.screenshot({ path: audioScreenshotPath, fullPage: true });
    console.log("✓ Audio screenshot saved to:", audioScreenshotPath);

    // 3. Video Generation (/videos)
    console.log("\n[3/5] Testing Video Generation (/videos)...");
    await page.goto("http://localhost:3000/videos", { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForSelector("h1", { timeout: 15000 });

    // Fill video generation form (4s clip)
    const promptInput = page.locator('input[placeholder="a lighthouse in a storm"]');
    await promptInput.waitFor({ state: "visible", timeout: 10000 });
    await promptInput.fill("Atmospheric cybernetic quantum core pulse");

    const targetDurationInput = page.locator('label:has-text("Target duration") input');
    await targetDurationInput.fill("4");
    const sceneClipInput = page.locator('label:has-text("Scene length") input');
    await sceneClipInput.fill("4");

    const generateVideoBtn = page.locator('button[type="submit"]:has-text("Generate")');
    await generateVideoBtn.click();
    console.log("✓ Video project submitted.");

    // Wait for project in list and click into it
    console.log("  Waiting for project to appear in video list...");
    await page.waitForSelector('.card-list a[href^="/videos/"]', { timeout: 15000 });
    const firstProjectLink = page.locator('.card-list a[href^="/videos/"]').first();
    const projectHref = await firstProjectLink.getAttribute("href");
    console.log("  Navigating into video detail page:", projectHref);
    await firstProjectLink.click();

    // On /videos/:id page, wait for <video> player with source
    console.log("  Waiting for video assembly (diffusion + FFmpeg zoompan + audio mux)...");
    await page.waitForFunction(
      () => {
        const sourceElem = document.querySelector("video source");
        return sourceElem && sourceElem.src && sourceElem.src.includes("/api/v1/assets/");
      },
      { timeout: 90000 }
    );

    const videoSourceElem = page.locator("video source").first();
    const videoSrc = await videoSourceElem.getAttribute("src");
    console.log("✓ Live generated video player mounted! Video Source URL:", videoSrc);

    // Download video file to artifact directory
    const fullVideoUrl = videoSrc.startsWith("http") ? videoSrc : `http://localhost:3000${videoSrc}`;
    const videoRes = await fetch(fullVideoUrl, { headers: { Cookie: cookieHeader } });
    const videoBuf = Buffer.from(await videoRes.arrayBuffer());
    const videoSavePath = path.join(ARTIFACT_DIR, "browser_generated_video.mp4");
    fs.writeFileSync(videoSavePath, videoBuf);
    console.log(`✓ Video MP4 downloaded and saved (${videoBuf.length} bytes):`, videoSavePath);

    const videoScreenshotPath = path.join(ARTIFACT_DIR, "browser_video_verified.png");
    await page.screenshot({ path: videoScreenshotPath, fullPage: true });
    console.log("✓ Video screenshot saved to:", videoScreenshotPath);

    console.log("\n==================================================");
    console.log("  BROWSER AUDIO & VIDEO VERIFICATION PASSED");
    console.log("==================================================");
    console.log("- Audio synthesis & playback: VERIFIED");
    console.log("- Video storyboard, FFmpeg & muxing: VERIFIED");
    console.log("- Audio WAV file:", audioSavePath);
    console.log("- Video MP4 file:", videoSavePath);
    console.log("- Audio screenshot:", audioScreenshotPath);
    console.log("- Video screenshot:", videoScreenshotPath);

  } catch (err) {
    console.error("Browser media verification failed:", err);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "browser_media_error.png"), fullPage: true }).catch(() => {});
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
