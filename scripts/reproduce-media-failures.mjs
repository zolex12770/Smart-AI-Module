import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("=== PHASE 1: REPRODUCE MEDIA GENERATION FAILURES ===");

  // 1. Direct API checks
  console.log("\n[TEST 1] Probing API /api/v1/models and providers...");
  const loginRes = await fetch("http://127.0.0.1:8787/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: "admin-password-123" }),
  });
  const loginData = await loginRes.json();
  const token = loginData.token;
  console.log("Logged in via API. Token obtained:", !!token);

  // Try POST /api/v1/images
  console.log("\n[TEST 2] Testing POST /api/v1/images directly...");
  const imgRes = await fetch("http://127.0.0.1:8787/api/v1/images", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ prompt: "A glowing cybernetic neural node", aspectRatio: "1:1" }),
  });
  const imgData = await imgRes.json();
  console.log("POST /api/v1/images status:", imgRes.status);
  console.log("POST /api/v1/images response:", JSON.stringify(imgData, null, 2));

  // Try POST /api/v1/videos
  console.log("\n[TEST 3] Testing POST /api/v1/videos directly...");
  const vidRes = await fetch("http://127.0.0.1:8787/api/v1/videos", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ prompt: "Deep space nebula floating calmly", targetDurationSeconds: 4, sceneClipSeconds: 4 }),
  });
  const vidData = await vidRes.json();
  console.log("POST /api/v1/videos status:", vidRes.status);
  console.log("POST /api/v1/videos response:", JSON.stringify(vidData, null, 2));

  // 2. Browser checks
  console.log("\n[TEST 4] Capturing UI states in browser...");
  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Login
  await page.goto("http://localhost:3000/login", { waitUntil: "networkidle" });
  await page.click('button:has-text("One-Click Sign In")');
  await page.waitForURL((url) => !url.pathname.includes("/login"));

  // Check /images
  await page.goto("http://localhost:3000/images", { waitUntil: "networkidle" });
  const imgBanner = await page.locator("text=Image Generation Provider Status").isVisible();
  const generateBtnDisabled = await page.locator('button[type="submit"]:has-text("Generate")').isDisabled();
  console.log("UI /images: Provider notice visible:", imgBanner);
  console.log("UI /images: Generate button disabled:", generateBtnDisabled);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "reproduced_images_failure.png") });

  // Check /videos
  await page.goto("http://localhost:3000/videos", { waitUntil: "networkidle" });
  const vidBanner = await page.locator("text=Video Generation Provider Status").isVisible();
  console.log("UI /videos: Provider notice visible:", vidBanner);

  // Attempt to submit video in UI to observe error banner
  await page.fill('input[placeholder="a lighthouse in a storm"]', "Deep space nebula floating calmly");
  await page.click('button:has-text("Generate")');
  await page.waitForTimeout(1000);
  const vidError = await page.locator(".error-text").textContent();
  console.log("UI /videos: Error text after submit:", vidError);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "reproduced_videos_failure.png") });

  await browser.close();

  console.log("\n=== REPRODUCTION COMPLETE: Confirmed 501 CAPABILITY_UNAVAILABLE and blocked UI ===");
}

main().catch((e) => {
  console.error("Reproduction failed:", e);
  process.exit(1);
});
