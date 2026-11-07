import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACT_DIR = "C:\\Users\\SAURABH KUMAR\\.gemini\\antigravity\\brain\\ab308118-6248-4511-b0d0-542a264329d5";

const PAGES_TO_TEST = [
  { name: "Chat", path: "/chat" },
  { name: "Tasks", path: "/tasks" },
  { name: "Coding", path: "/coding" },
  { name: "Images", path: "/images" },
  { name: "Videos", path: "/videos" },
  { name: "Audio", path: "/audio" },
  { name: "Files", path: "/files" },
  { name: "Ask", path: "/ask" },
  { name: "Admin", path: "/admin" },
];

async function main() {
  console.log("=================================================================");
  console.log("   PHASE 2: LIVE BROWSER REPRODUCTION ACROSS ALL MODULES         ");
  console.log("=================================================================\n");

  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    headless: true,
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const networkFailures = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.log(`[Console Error] ${msg.text()}`);
      consoleErrors.push({ url: page.url(), text: msg.text() });
    }
  });

  page.on("requestfailed", (req) => {
    console.log(`[Network Failure] ${req.method()} ${req.url()} - ${req.failure()?.errorText}`);
    networkFailures.push({ url: req.url(), error: req.failure()?.errorText });
  });

  page.on("response", (res) => {
    if (res.status() >= 400) {
      console.log(`[HTTP ${res.status()}] ${res.request().method()} ${res.url()}`);
    }
  });

  // TEST 1: What happens if an unauthenticated user opens http://localhost:3000/ ?
  console.log("[Test 1] Navigating to http://localhost:3000/ while unauthenticated...");
  await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
  console.log(`  Landed on: ${page.url()}`);
  console.log(`  Page Title: ${await page.title()}`);

  // TEST 2: Sign in as operator
  console.log("\n[Test 2] Signing in as operator@local.dev...");
  await page.goto("http://localhost:3000/login", { waitUntil: "networkidle" });
  await page.fill("#email", "operator@local.dev");
  await page.fill("#password", "test-password-1234");
  await page.click("button[type='submit']");
  await page.waitForURL("**/chat", { timeout: 30000 });
  console.log(`  ✓ Successfully signed in! Landed on: ${page.url()}`);

  // TEST 3: Inspect every single navigation module while authenticated
  console.log("\n[Test 3] Navigating to each module and performing real action...");

  const results = {};

  for (const item of PAGES_TO_TEST) {
    console.log(`\n-------------------------------------------------------------`);
    console.log(`Checking Module: ${item.name} (${item.path})`);
    console.log(`-------------------------------------------------------------`);

    try {
      await page.goto(`http://localhost:3000${item.path}`, { waitUntil: "networkidle", timeout: 30000 });
      console.log(`  ✓ Navigation URL: ${page.url()}`);
      
      // Check for generic or error text in body
      const bodyText = await page.innerText("body");
      const hasLoading = bodyText.includes("Loading your session");
      const hasRedirect = bodyText.includes("Redirecting to sign in");
      const hasNoProject = bodyText.includes("This account has no project yet");

      console.log(`  Session State flags: loading=${hasLoading}, redirect=${hasRedirect}, noProject=${hasNoProject}`);

      const screenshotFile = `module_${item.name.toLowerCase()}.png`;
      const screenshotPath = path.join(ARTIFACT_DIR, screenshotFile);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      // Action-specific tests per module
      let actionResult = "loaded";

      if (item.name === "Chat") {
        const composer = page.getByPlaceholder(/say something/i);
        if (await composer.isVisible()) {
          console.log("  Testing Chat send...");
          await composer.fill("Hello from diagnostic script");
          await page.getByRole("button", { name: /send/i }).click();
          await page.waitForTimeout(3000);
          const lastMsg = await page.locator(".message.assistant").last().textContent().catch(() => "");
          console.log(`  Chat Response: "${lastMsg?.trim().slice(0, 100)}..."`);
          actionResult = lastMsg ? "chat_ok" : "chat_no_response";
        } else {
          actionResult = "composer_missing";
        }
      } else if (item.name === "Tasks") {
        console.log("  Inspecting Tasks table / form...");
        const select = page.locator("select");
        actionResult = (await select.count()) > 0 ? "tasks_form_present" : "tasks_form_missing";
      } else if (item.name === "Coding") {
        console.log("  Inspecting Coding agent page...");
        const seedBtn = page.getByRole("button", { name: /seed demo/i });
        const startBtn = page.getByRole("button", { name: /start coding agent/i });
        actionResult = (await startBtn.isVisible()) ? "coding_ready" : "coding_ui_missing";
      } else if (item.name === "Images") {
        console.log("  Inspecting Images prompt form...");
        const promptInput = page.getByPlaceholder(/a lighthouse at dawn/i);
        const submitBtn = page.getByRole("button", { name: /generate/i });
        actionResult = (await submitBtn.isVisible()) ? "images_ui_present" : "images_ui_missing";
      } else if (item.name === "Videos") {
        console.log("  Inspecting Videos prompt form...");
        const promptInput = page.getByPlaceholder(/a lighthouse in a storm/i);
        actionResult = (await promptInput.isVisible()) ? "videos_ui_present" : "videos_ui_missing";
      } else if (item.name === "Audio") {
        console.log("  Inspecting Audio form...");
        const textarea = page.locator("textarea");
        const submitBtn = page.getByRole("button", { name: /generate speech/i });
        actionResult = (await submitBtn.isVisible()) ? "audio_ui_present" : "audio_ui_missing";
      } else if (item.name === "Files") {
        console.log("  Inspecting Files upload form...");
        const fileInput = page.locator("input[type='file']");
        actionResult = (await fileInput.count()) > 0 ? "files_ui_present" : "files_ui_missing";
      } else if (item.name === "Ask") {
        console.log("  Inspecting Ask form...");
        const textarea = page.locator("#rag-question");
        actionResult = (await textarea.isVisible()) ? "ask_ui_present" : "ask_ui_missing";
      } else if (item.name === "Admin") {
        console.log("  Inspecting Admin dashboard...");
        const heading = page.locator("h1");
        actionResult = (await heading.textContent()).includes("System Administration") ? "admin_ok" : "admin_text_mismatch";
      }

      results[item.name] = { status: "OK", actionResult, url: page.url() };
    } catch (err) {
      console.log(`  ❌ Failed on ${item.name}: ${err.message}`);
      results[item.name] = { status: "FAILED", error: err.message };
    }
  }

  await browser.close();

  console.log("\n=================================================================");
  console.log("DIAGNOSTIC SUMMARY:");
  console.log(JSON.stringify(results, null, 2));
  console.log(`Total Console Errors: ${consoleErrors.length}`);
  console.log(`Total Network Failures: ${networkFailures.length}`);
  console.log("=================================================================");
}

main().catch((err) => {
  console.error("Diagnostic script failure:", err);
  process.exit(1);
});
