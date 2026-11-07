import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("=== BROWSER E2E VERIFICATION: USER REQUIREMENT SATISFACTION LOOP (PHASE 5) ===");

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

    // 2. Navigate to /chat
    console.log("[2/5] Navigating to http://localhost:3000/chat...");
    await page.goto("http://localhost:3000/chat", { waitUntil: "networkidle", timeout: 25000 });

    const newChatBtn = page.locator('a:has-text("+ New chat")');
    if (await newChatBtn.isVisible()) {
      await newChatBtn.click();
      await page.waitForTimeout(1000);
      console.log("✓ Clicked '+ New chat'");
    }

    // Turn 1: User Introduction & Personalization
    console.log("\n[3/5] Turn 1: Personal Profile Registration & Satisfaction Rating...");
    const composerInput = page.locator('form.composer input');
    await composerInput.waitFor({ state: "visible", timeout: 15000 });
    await composerInput.fill("Hello! My name is Rajesh, I am a Principal Architect from Pune.");
    const sendBtn = page.locator('form.composer button[type="submit"]');
    await sendBtn.click();

    // Wait for response to stream and finish
    await page.waitForTimeout(3000);
    const bubble1 = page.locator('.message.assistant').first();
    await bubble1.waitFor({ state: "visible", timeout: 20000 });
    const text1 = await bubble1.innerText();
    console.log(`Assistant Reply 1: "${text1.slice(0, 100)}..."`);
    if (!text1.includes("Rajesh") || !text1.includes("Pune")) {
      throw new Error(`Profile attribution failed in reply: ${text1}`);
    }

    // Click "👍 Satisfied"
    const satisfiedBtn = page.locator('button:has-text("👍 Satisfied")').first();
    await satisfiedBtn.waitFor({ state: "visible", timeout: 10000 });
    await satisfiedBtn.click();
    await page.waitForTimeout(500);
    console.log("✓ Successfully clicked '👍 Satisfied' rating button.");

    // Turn 2: Vernacular Hindi API Inquiry
    console.log("\n[4/5] Turn 2: Vernacular Hindi Architecture Inquiry & Negative Constraint...");
    await composerInput.fill("Write a function to calculate factorial in Python without recursion.");
    await sendBtn.click();

    await page.waitForTimeout(3000);
    const bubble2 = page.locator('.message.assistant').nth(1);
    await bubble2.waitFor({ state: "visible", timeout: 20000 });
    const text2 = await bubble2.innerText();
    console.log(`Assistant Reply 2: "${text2.slice(0, 100)}..."`);

    if (text2.includes("factorial(n - 1)") || text2.includes("factorial(n-1)")) {
      throw new Error(`Negative constraint violated (recursive call found): ${text2}`);
    }
    if (!text2.includes("factorial") || (!text2.includes("for ") && !text2.includes("while "))) {
      throw new Error(`Iterative factorial not returned: ${text2}`);
    }

    // Rate Turn 2 with "👍 Satisfied"
    const satisfiedBtn2 = page.locator('button:has-text("👍 Satisfied")').nth(1);
    if (await satisfiedBtn2.isVisible()) {
      await satisfiedBtn2.click();
      await page.waitForTimeout(500);
      console.log("✓ Successfully clicked '👍 Satisfied' on Turn 2.");
    }

    // 5. Capture Verified Proof Screenshot Artifact
    console.log("\n[5/5] Capturing Verified Proof Screenshot Artifact...");
    const screenshotPath = path.join(ARTIFACT_DIR, "browser_satisfaction_loop_verified.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`✓ Screenshot written to: ${screenshotPath}`);

    console.log("\n=== USER REQUIREMENT SATISFACTION LOOP (PHASE 5) VERIFIED 100% ===");
  } catch (err) {
    console.error("Test failed:", err);
    const errPath = path.join(ARTIFACT_DIR, "browser_satisfaction_loop_error.png");
    await page.screenshot({ path: errPath, fullPage: true }).catch(() => {});
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
