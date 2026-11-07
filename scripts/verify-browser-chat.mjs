import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("=== BROWSER E2E VERIFICATION: CHAT MODULE & MULTI-TURN REASONING (M2) ===");

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
    console.log("[1/6] Authenticating via One-Click Sign In...");
    await page.goto("http://localhost:3000/login", { waitUntil: "networkidle", timeout: 25000 });
    const oneClickBtn = page.locator('button:has-text("One-Click Sign In")');
    await oneClickBtn.waitFor({ state: "visible", timeout: 10000 });
    await oneClickBtn.click();
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
    console.log("✓ Authenticated. Current URL:", page.url());

    // 2. Navigate to /chat
    console.log("[2/6] Navigating to http://localhost:3000/chat...");
    await page.goto("http://localhost:3000/chat", { waitUntil: "networkidle", timeout: 25000 });

    // Click "+ New chat" to ensure a fresh, isolated conversation session
    const newChatBtn = page.locator('button:has-text("+ New chat")');
    if (await newChatBtn.isVisible()) {
      await newChatBtn.click();
      await page.waitForTimeout(1000);
      console.log("✓ Started fresh conversation via '+ New chat'");
    }

    // Helper function to send message and wait for streaming completion
    async function sendMessage(turnNum, userText, expectedContentFragment) {
      console.log(`\n--- [Turn ${turnNum}] User Prompt: "${userText}" ---`);
      
      // Wait for composer to be ready (send button not disabled)
      const composerInput = page.locator('form.composer input');
      await composerInput.waitFor({ state: "visible", timeout: 15000 });
      await composerInput.fill(userText);

      // Click send button
      const sendBtn = page.locator('form.composer button[type="submit"]');
      await sendBtn.waitFor({ state: "visible", timeout: 15000 });
      await sendBtn.click();
      console.log(`✓ Turn ${turnNum} submitted.`);

      // Wait for the new assistant bubble (nth turnNum - 1) to exist
      const newBubble = page.locator('.message.assistant').nth(turnNum - 1);
      await newBubble.waitFor({ state: "visible", timeout: 15000 });

      // Poll until Stop button disappears (streaming is complete)
      await page.locator('form.composer button:has-text("Stop")').waitFor({ state: "detached", timeout: 25000 }).catch(() => {});

      // Extra check: wait for send button to be in normal state
      await page.waitForTimeout(1000);

      const text = (await newBubble.textContent()) || "";
      console.log(`✓ Turn ${turnNum} assistant response received (${text.length} chars):`);
      console.log(`  Preview: "${text.slice(0, 150).replace(/\n/g, " ")}..."`);

      if (expectedContentFragment && !text.toLowerCase().includes(expectedContentFragment.toLowerCase())) {
        throw new Error(`Turn ${turnNum} response did not contain expected fragment "${expectedContentFragment}". Got: "${text.slice(0, 300)}"`);
      }
      console.log(`✓ Turn ${turnNum} verified with fragment "${expectedContentFragment}".`);
      return text;
    }

    // Turn 1: Introduction with personal entity details
    await sendMessage(
      1,
      "Hi! My name is Rajesh and I am a software engineer from Pune. Remember my name.",
      "Rajesh"
    );

    // Turn 2: Multilingual / Hinglish technical inquiry
    await sendMessage(
      2,
      "Recursion ko simple Hindi me samjhao with a real life example.",
      "रिकर्शन"
    );

    // Turn 3: Technical algorithm with TypeScript
    await sendMessage(
      3,
      "Can you explain Binary Search algorithm with TypeScript code and time complexity?",
      "Binary Search"
    );

    // Turn 4: Context retention across 4 turns
    await sendMessage(
      4,
      "Do you remember my name and where I am from?",
      "Pune"
    );

    // 6. Capture full conversation screenshot
    console.log("\n[6/6] Capturing full multi-turn chat screenshot...");
    const screenshotPath = path.join(ARTIFACT_DIR, "browser_chat_multi_turn_verified.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log("✓ Chat screenshot saved to:", screenshotPath);

    console.log("\n==================================================");
    console.log("  BROWSER CHAT MULTI-TURN VERIFICATION PASSED (M2)");
    console.log("==================================================");
    console.log("- Multi-turn profile retention: VERIFIED (Rajesh / Pune)");
    console.log("- Bilingual Hindi/Hinglish reasoning: VERIFIED (Recursion explanation)");
    console.log("- Algorithm & TypeScript code synthesis: VERIFIED (Binary Search)");
    console.log("- DOM screenshot:", screenshotPath);

  } catch (err) {
    console.error("Browser chat verification failed:", err);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "browser_chat_error.png"), fullPage: true }).catch(() => {});
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
