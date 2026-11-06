import { chromium } from "playwright";
import fs from "node:fs";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACT_DIR = "C:\\Users\\SAURABH KUMAR\\.gemini\\antigravity\\brain\\ab308118-6248-4511-b0d0-542a264329d5";

async function run() {
  console.log("=== LIVE BROWSER E2E: REAL AI CHAT VERIFICATION ===");

  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    headless: true,
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  page.on("console", (msg) => console.log(`[Browser Console ${msg.type()}]`, msg.text()));
  page.on("pageerror", (err) => console.log(`[Browser PageError]`, err.message));
  page.on("requestfailed", (req) => console.log(`[Browser RequestFailed]`, req.url(), req.failure()?.errorText));

  const uniqueId = Date.now();
  const email = `browser-user-${uniqueId}@example.com`;
  const password = "ValidPassword123!@#Secure";

  console.log(`[1] Navigating to http://localhost:3000/signup...`);
  await page.goto("http://localhost:3000/signup", { waitUntil: "networkidle" });

  console.log(`[2] Registering account: ${email}...`);
  await page.getByLabel("Name").fill("Browser E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /create account/i }).click();

  console.log(`[3] Waiting for redirect to /chat...`);
  await page.waitForURL("**/chat", { timeout: 30000 });
  console.log(`✓ Landed on /chat page!`);

  // Verify Header Badge
  console.log(`[4] Verifying Model State Badge in Header...`);
  const localModelBadge = page.getByText("LOCAL MODEL");
  await localModelBadge.waitFor({ state: "visible", timeout: 30000 });
  console.log(`✓ Active Header Badge: "LOCAL MODEL"`);

  const headerText = await page.locator("header.chat-header").textContent();
  console.log(`✓ Header Text: "${headerText.replace(/\s+/g, " ").trim()}"`);

  // Test Prompt 1: "Prime minister of india"
  console.log(`[5] Submitting prompt: 'Prime minister of india'...`);
  const composer = page.getByPlaceholder(/say something/i);
  await composer.fill("Prime minister of india");
  await page.getByRole("button", { name: /send/i }).click();

  console.log(`[6] Awaiting streaming tokens in browser DOM...`);
  const assistantBubble = page.locator(".message.assistant").last();
  await assistantBubble.waitFor({ state: "visible", timeout: 30000 });

  // Wait until text completes streaming
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".message.assistant:last-child");
      return el && el.textContent && el.textContent.includes("Narendra Modi");
    },
    { timeout: 30000 }
  );

  const reply1 = (await assistantBubble.textContent())?.trim();
  console.log(`✓ Turn 1 Real AI Reply Received:\n${reply1}\n`);

  if (reply1.includes("[mock response")) {
    throw new Error("FAILED: Canned mock response detected!");
  }
  if (!reply1.includes("Narendra Modi")) {
    throw new Error("FAILED: Did not mention Narendra Modi!");
  }

  // Take screenshot as visual proof
  const screenshotPath = `${ARTIFACT_DIR}/browser_real_ai_chat.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`✓ Screenshot saved to: ${screenshotPath}`);

  // Test Prompt 2: Multilingual Hindi
  console.log(`[7] Submitting prompt: 'Explain quantum computing in simple Hindi'...`);
  await composer.fill("Explain quantum computing in simple Hindi");
  await page.getByRole("button", { name: /send/i }).click();

  const secondBubble = page.locator(".message.assistant").last();
  await page.waitForFunction(
    () => {
      const els = document.querySelectorAll(".message.assistant");
      const last = els[els.length - 1];
      return last && last.textContent && last.textContent.includes("क्वांटम");
    },
    { timeout: 30000 }
  );

  const reply2 = (await secondBubble.textContent())?.trim();
  console.log(`✓ Turn 2 Real AI Hindi Reply Received:\n${reply2.slice(0, 300)}...\n`);

  // Take second screenshot showing multi-turn chat in browser
  const screenshotMultiTurn = `${ARTIFACT_DIR}/browser_multi_turn_chat.png`;
  await page.screenshot({ path: screenshotMultiTurn, fullPage: true });
  console.log(`✓ Multi-turn screenshot saved to: ${screenshotMultiTurn}`);

  await browser.close();
  console.log(`\n🎉 BROWSER LIVE END-TO-END VERIFICATION COMPLETED WITH 100% SUCCESS!`);
}

run().catch((err) => {
  console.error("Browser verification error:", err);
  process.exit(1);
});
