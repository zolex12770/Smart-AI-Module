import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACT_DIR = "C:\\Users\\SAURABH KUMAR\\.gemini\\antigravity\\brain\\ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("=================================================================");
  console.log("   LIVE BROWSER E2E: AUTONOMOUS RECOVERY & VERIFICATION          ");
  console.log("=================================================================\n");

  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    headless: true,
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.log(`[Browser Console Error]`, msg.text());
    }
  });

  // Step 1: Sign in as Operator
  console.log("[1] Navigating to http://localhost:3000/login...");
  await page.goto("http://localhost:3000/login", { waitUntil: "networkidle" });

  console.log("    Signing in as operator@local.dev...");
  await page.fill("#email", "operator@local.dev");
  await page.fill("#password", "test-password-1234");
  await page.click("button[type='submit']");

  await page.waitForURL("**/chat", { timeout: 30000 });
  console.log("  ✓ Successfully signed in and landed on /chat!\n");

  // Step 2: Test Real AI Chat
  console.log("[2] Testing Real AI Chat UI & Live Inference...");
  const composer = page.getByPlaceholder(/say something/i);
  await composer.waitFor({ state: "visible", timeout: 15000 });

  // Query 1: What is 2 + 2?
  console.log("    Sending chat prompt: 'What is 2 + 2?'");
  await composer.fill("What is 2 + 2?");
  await page.getByRole("button", { name: /send/i }).click();

  const assistantBubble1 = page.locator(".message.assistant").last();
  await assistantBubble1.waitFor({ state: "visible", timeout: 30000 });

  await page.waitForFunction(
    () => {
      const el = document.querySelector(".message.assistant:last-child");
      return el && el.textContent && el.textContent.includes("4");
    },
    { timeout: 30000 }
  );

  const reply1 = (await assistantBubble1.textContent())?.trim();
  console.log(`  ✓ Chat Reply 1 received: "${reply1}"`);
  if (!reply1.includes("4")) {
    throw new Error(`Expected calculation result 4 in reply: ${reply1}`);
  }

  // Query 2: "how are you" - verify no canned template
  console.log("    Sending chat prompt: 'how are you'");
  await composer.fill("how are you");
  await page.getByRole("button", { name: /send/i }).click();

  const assistantBubble2 = page.locator(".message.assistant").last();
  await page.waitForFunction(
    () => {
      const els = document.querySelectorAll(".message.assistant");
      const last = els[els.length - 1];
      return last && last.textContent && last.textContent.length > 20;
    },
    { timeout: 30000 }
  );

  const reply2 = (await assistantBubble2.textContent())?.trim();
  console.log(`  ✓ Chat Reply 2 received: "${reply2.slice(0, 100)}..."`);
  if (reply2.includes("Core Principles") && reply2.includes("Practical Applications")) {
    throw new Error(`Generic template detected in reply 2!`);
  }

  // Screenshot Chat
  const chatShotPath = path.join(ARTIFACT_DIR, "recovery_browser_chat.png");
  await page.screenshot({ path: chatShotPath, fullPage: true });
  console.log(`  ✓ Chat screenshot captured: ${chatShotPath}\n`);

  // Step 3: Test Coding Agent Page & Sandbox Execution
  console.log("[3] Navigating to http://localhost:3000/coding...");
  await page.goto("http://localhost:3000/coding", { waitUntil: "networkidle" });
  await page.waitForSelector("h1", { timeout: 15000 });
  console.log("  ✓ Coding Agent workspace page loaded!");

  // Ensure workspace files visible
  await page.waitForTimeout(1000);
  console.log("    Seeding demo fixture (math.test.js)...");
  const seedBtn = page.getByRole("button", { name: /seed demo fixture/i });
  if (await seedBtn.isVisible()) {
    await seedBtn.click();
    await page.waitForTimeout(1500);
  }

  console.log("    Starting Coding Agent on coding-demo/math.test.js...");
  await page.getByRole("button", { name: /start coding agent/i }).click();

  console.log("    Waiting for navigation to Task Details...");
  await page.waitForURL(/\/coding\/[a-zA-Z0-9\-]+/, { timeout: 30000 });
  const taskDetailUrl = page.url();
  console.log(`  ✓ Landed on Task Details: ${taskDetailUrl}`);

  // Wait for task to transition to COMPLETED
  console.log("    Monitoring task execution progress...");
  await page.waitForFunction(
    () => {
      const text = document.body.innerText;
      return text.includes("COMPLETED") || text.includes("FAILED");
    },
    { timeout: 45000 }
  );

  const bodyText = await page.innerText("body");
  if (bodyText.includes("COMPLETED")) {
    console.log("  ✓ Coding Task successfully reached COMPLETED in Browser UI!");
  } else {
    throw new Error(`Coding task failed in UI: ${bodyText.slice(0, 500)}`);
  }

  // Screenshot Coding
  const codingShotPath = path.join(ARTIFACT_DIR, "recovery_browser_coding.png");
  await page.screenshot({ path: codingShotPath, fullPage: true });
  console.log(`  ✓ Coding Agent screenshot captured: ${codingShotPath}\n`);

  // Step 4: Test Admin Dashboard
  console.log("[4] Navigating to http://localhost:3000/admin...");
  await page.goto("http://localhost:3000/admin", { waitUntil: "networkidle" });
  await page.waitForSelector("h1", { timeout: 15000 });
  console.log("  ✓ Admin dashboard loaded!");

  // Wait for health cards and live status to load
  await page.waitForTimeout(2000);

  // Screenshot Admin
  const adminShotPath = path.join(ARTIFACT_DIR, "recovery_browser_admin.png");
  await page.screenshot({ path: adminShotPath, fullPage: true });
  console.log(`  ✓ Admin dashboard screenshot captured: ${adminShotPath}\n`);

  await browser.close();
  console.log("=================================================================");
  console.log("🎉 ALL LIVE BROWSER E2E TESTS PASSED WITH 100% SUCCESS!");
  console.log("=================================================================");
}

main().catch((err) => {
  console.error("\n❌ BROWSER E2E FAILED:", err);
  process.exit(1);
});
