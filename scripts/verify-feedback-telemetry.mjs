import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("=== M-FEEDBACK-01: VERIFYING BACKEND FEEDBACK PERSISTENCE & TELEMETRY ===");

  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 950 },
  });

  const page = await context.newPage();

  page.on("console", (msg) => console.log(`[BROWSER CONSOLE ${msg.type()}]:`, msg.text()));
  page.on("pageerror", (err) => console.error("[BROWSER ERROR]:", err));
  page.on("request", (req) => {
    if (req.url().includes("feedback")) {
      console.log(`[BROWSER REQ]: ${req.method()} ${req.url()}`);
    }
  });
  page.on("response", async (res) => {
    if (res.url().includes("feedback")) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {}
      console.log(`[BROWSER RES]: ${res.status()} ${res.url()} -> ${bodyText.slice(0, 150)}`);
    }
  });

  try {
    // 1. Authenticate via One-Click Sign In
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

    // 3. Send message and rate "Satisfied"
    console.log("\n[3/5] Turn 1: Sending message and rating '👍 Satisfied'...");
    const composerInput = page.locator('form.composer input');
    await composerInput.waitFor({ state: "visible", timeout: 15000 });
    await composerInput.fill("What is the time complexity of quicksort in the average case?");
    const sendBtn = page.locator('form.composer button[type="submit"]');
    await sendBtn.click();

    await page.waitForTimeout(2500);
    const bubble1 = page.locator('.message.assistant').first();
    await bubble1.waitFor({ state: "visible", timeout: 20000 });
    const text1 = await bubble1.innerText();
    console.log(`Assistant Reply 1: "${text1.slice(0, 100)}..."`);

    // Click "👍 Satisfied"
    const satisfiedBtn = page.locator('button:has-text("👍 Satisfied")').first();
    await satisfiedBtn.waitFor({ state: "visible", timeout: 10000 });
    await satisfiedBtn.click();
    await page.waitForTimeout(1000);

    const ratedText = await page.locator('text=✓ Rated: Satisfied').first();
    await ratedText.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ UI updated: '✓ Rated: Satisfied'");

    // 4. Send message and rate "Needs Improvement" with Refine Constraints tag
    console.log("\n[4/5] Turn 2: Testing Needs Improvement & constraint refinement...");
    await composerInput.fill("Explain bubble sort in Hinglish.");
    await sendBtn.click();

    await page.waitForTimeout(2500);
    const bubble2 = page.locator('.message.assistant').nth(1);
    await bubble2.waitFor({ state: "visible", timeout: 20000 });
    const text2 = await bubble2.innerText();
    console.log(`Assistant Reply 2: "${text2.slice(0, 100)}..."`);

    // Click "👎 Needs Improvement" (only unrated messages display the buttons)
    const needsImpBtn = page.locator('button:has-text("👎 Needs Improvement")').first();
    await needsImpBtn.waitFor({ state: "visible", timeout: 15000 });
    await needsImpBtn.click();
    await page.waitForTimeout(500);

    // Click "🎯 Refine Constraints"
    const refineBtn = page.locator('button:has-text("🎯 Refine Constraints")').first();
    if (await refineBtn.isVisible()) {
      await refineBtn.click();
      await page.waitForTimeout(2000);
      console.log("✓ Clicked '🎯 Refine Constraints'");
    }

    // 5. Query Backend API directly through page context to verify Postgres persistence
    console.log("\n[5/5] Querying GET /api/v1/feedback from browser context...");
    const feedbackData = await page.evaluate(async () => {
      const projectId = localStorage.getItem("aip.selectedProjectId") || "";
      const res = await fetch(`http://localhost:8787/api/v1/feedback?projectId=${encodeURIComponent(projectId)}`, {
        headers: {
          "x-project-id": projectId,
        },
        credentials: "include",
      });
      return { status: res.status, data: await res.json() };
    });

    console.log("API Response Status:", feedbackData.status);
    console.log("Summary:", JSON.stringify(feedbackData.data.summary, null, 2));
    console.log("Recorded Feedback Count:", feedbackData.data.feedback?.length);

    if (feedbackData.status !== 200) {
      throw new Error(`Failed to fetch feedback: status ${feedbackData.status}`);
    }

    const { summary, feedback } = feedbackData.data;
    if (!summary || summary.totalCount < 1) {
      throw new Error(`No telemetry recorded in Postgres database!`);
    }

    const satisfiedFound = feedback.some((f) => f.rating === "satisfied");
    if (!satisfiedFound) {
      throw new Error("Expected at least one 'satisfied' rating persisted in database!");
    }
    console.log("✓ Verified: Database holds 'satisfied' rating record.");

    const screenshotPath = path.join(ARTIFACT_DIR, "browser_feedback_persistence_verified.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`✓ Screenshot written to: ${screenshotPath}`);

    console.log("\n=== M-FEEDBACK-01 PERSISTENCE & TELEMETRY VERIFIED SUCCESSFULLY ===");
  } catch (err) {
    console.error("Verification failed:", err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
