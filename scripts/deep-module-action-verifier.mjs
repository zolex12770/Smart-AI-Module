import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACT_DIR = "C:\\Users\\SAURABH KUMAR\\.gemini\\antigravity\\brain\\ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("=================================================================");
  console.log("   LIVE APPLICATION AUDIT: EVERY UI MODULE IN-DEPTH              ");
  console.log("=================================================================\n");

  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    headless: true,
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`[Browser Console Error]`, msg.text());
  });
  page.on("response", async (res) => {
    if (res.status() >= 400) {
      const txt = await res.text().catch(() => "");
      console.log(`[HTTP ${res.status()}] ${res.request().method()} ${res.url()} -> ${txt.slice(0, 120)}`);
    }
  });

  // Login
  console.log("[Auth] Signing in as operator@local.dev...");
  await page.goto("http://localhost:3000/login", { waitUntil: "networkidle" });
  await page.fill("#email", "operator@local.dev");
  await page.fill("#password", "test-password-1234");
  await page.click("button[type='submit']");
  await page.waitForURL("**/chat", { timeout: 30000 });
  console.log("  ✓ Signed in!\n");

  const report = {};

  // 1. CHAT
  console.log("-------------------------------------------------------------");
  console.log("1. Testing /chat module in browser...");
  try {
    await page.goto("http://localhost:3000/chat", { waitUntil: "networkidle" });
    const composer = page.getByPlaceholder(/say something/i);
    await composer.fill("What is 10 + 25?");
    await page.getByRole("button", { name: /send/i }).click();

    await page.waitForFunction(() => {
      const els = document.querySelectorAll(".message.assistant");
      const last = els[els.length - 1];
      return last && last.textContent && last.textContent.includes("35");
    }, { timeout: 15000 });

    const reply = await page.locator(".message.assistant").last().textContent();
    console.log(`  ✓ Chat Response: "${reply.trim()}"`);
    report.chat = { ok: true, detail: reply.trim() };
  } catch (err) {
    console.log(`  ❌ Chat failed: ${err.message}`);
    report.chat = { ok: false, error: err.message };
  }

  // 2. TASKS
  console.log("\n-------------------------------------------------------------");
  console.log("2. Testing /tasks module in browser...");
  try {
    await page.goto("http://localhost:3000/tasks", { waitUntil: "networkidle" });
    const taskSelect = page.locator("select").first();
    await taskSelect.selectOption("echo_chat");
    const inputField = page.locator("input[placeholder='message']");
    await inputField.fill("Browser live task test");
    const startBtn = page.getByRole("button", { name: /start task/i });
    await startBtn.click();

    // Should navigate to /agent/[id]
    await page.waitForURL(/\/agent\/[a-zA-Z0-9\-]+/, { timeout: 15000 });
    const taskUrl = page.url();
    console.log(`  ✓ Task started, navigated to: ${taskUrl}`);

    // Wait for task completion
    await page.waitForFunction(() => {
      return document.body.innerText.includes("COMPLETED") || document.body.innerText.includes("FAILED");
    }, { timeout: 20000 });

    const taskText = await page.innerText("body");
    const completed = taskText.includes("COMPLETED");
    console.log(`  ✓ Task state in DOM: ${completed ? "COMPLETED" : "NOT COMPLETED"}`);
    report.tasks = { ok: completed, url: taskUrl };
  } catch (err) {
    console.log(`  ❌ Tasks failed: ${err.message}`);
    report.tasks = { ok: false, error: err.message };
  }

  // 3. CODING
  console.log("\n-------------------------------------------------------------");
  console.log("3. Testing /coding module in browser...");
  try {
    await page.goto("http://localhost:3000/coding", { waitUntil: "networkidle" });
    const seedBtn = page.getByRole("button", { name: /seed demo/i });
    if (await seedBtn.isVisible()) {
      await seedBtn.click();
      await page.waitForTimeout(1000);
    }
    const startCodingBtn = page.getByRole("button", { name: /start coding agent/i });
    await startCodingBtn.click();

    await page.waitForURL(/\/coding\/[a-zA-Z0-9\-]+/, { timeout: 20000 });
    const codingUrl = page.url();
    console.log(`  ✓ Coding task started, navigated to: ${codingUrl}`);

    await page.waitForFunction(() => {
      return document.body.innerText.includes("COMPLETED") || document.body.innerText.includes("FAILED");
    }, { timeout: 45000 });

    const codingText = await page.innerText("body");
    const completed = codingText.includes("COMPLETED");
    console.log(`  ✓ Coding task state: ${completed ? "COMPLETED" : "NOT COMPLETED"}`);
    report.coding = { ok: completed, url: codingUrl };
  } catch (err) {
    console.log(`  ❌ Coding failed: ${err.message}`);
    report.coding = { ok: false, error: err.message };
  }

  // 4. IMAGES
  console.log("\n-------------------------------------------------------------");
  console.log("4. Inspecting /images module in browser...");
  try {
    await page.goto("http://localhost:3000/images", { waitUntil: "networkidle" });
    const promptInput = page.getByPlaceholder(/a lighthouse at dawn/i);
    const btn = page.getByRole("button", { name: /generate/i });
    const isDisabled = await btn.isDisabled();
    const alertText = await page.locator(".error-text, [role='status']").textContent().catch(() => "");
    console.log(`  Images Generate Button Disabled: ${isDisabled}`);
    console.log(`  Images Status Alert: "${alertText.trim()}"`);
    report.images = { ok: true, configured: !isDisabled, message: alertText.trim() };
  } catch (err) {
    console.log(`  ❌ Images failed: ${err.message}`);
    report.images = { ok: false, error: err.message };
  }

  // 5. VIDEOS
  console.log("\n-------------------------------------------------------------");
  console.log("5. Testing /videos module in browser...");
  try {
    await page.goto("http://localhost:3000/videos", { waitUntil: "networkidle" });
    const promptInput = page.getByPlaceholder(/a lighthouse in a storm/i);
    await promptInput.fill("a drone shot over waves");
    const btn = page.getByRole("button", { name: /generate/i });
    await btn.click();
    await page.waitForTimeout(2000);
    const alertText = await page.locator(".error-text").textContent().catch(() => "");
    console.log(`  Videos Response Message: "${alertText.trim()}"`);
    report.videos = { ok: true, message: alertText.trim() };
  } catch (err) {
    console.log(`  ❌ Videos failed: ${err.message}`);
    report.videos = { ok: false, error: err.message };
  }

  // 6. AUDIO
  console.log("\n-------------------------------------------------------------");
  console.log("6. Testing /audio module in browser...");
  try {
    await page.goto("http://localhost:3000/audio", { waitUntil: "networkidle" });
    const textarea = page.locator("textarea");
    await textarea.fill("This is a live test of Windows SAPI audio synthesis.");
    const btn = page.getByRole("button", { name: /generate speech/i });
    await btn.click();

    // Poll for generation to appear and finish in list
    console.log("  Audio submitted. Waiting for synthesis row to show up and succeed...");
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll(".card-row");
      return rows.length > 0;
    }, { timeout: 15000 });

    await page.waitForFunction(() => {
      return document.body.innerText.includes("succeeded") || document.body.innerText.includes("failed");
    }, { timeout: 30000 });

    const audioText = await page.innerText("body");
    const succeeded = audioText.includes("succeeded");
    const hasAudioPlayer = (await page.locator("audio").count()) > 0;
    console.log(`  ✓ Audio generation: ${succeeded ? "succeeded" : "in progress / failed"}, Player rendered: ${hasAudioPlayer}`);
    report.audio = { ok: succeeded, playerRendered: hasAudioPlayer };
  } catch (err) {
    console.log(`  ❌ Audio failed: ${err.message}`);
    report.audio = { ok: false, error: err.message };
  }

  // 7. FILES
  console.log("\n-------------------------------------------------------------");
  console.log("7. Testing /files module in browser...");
  try {
    await page.goto("http://localhost:3000/files", { waitUntil: "networkidle" });
    const tmpFile = path.resolve("test_rag_sample.txt");
    fs.writeFileSync(tmpFile, "NirnayAI Architecture: The platform contains an autonomous coding agent, RAG document intelligence, and real Windows SAPI audio synthesis.");
    const fileInput = page.locator("input[type='file']");
    await fileInput.setInputFiles(tmpFile);
    const uploadBtn = page.getByRole("button", { name: /upload/i });
    await uploadBtn.click();

    console.log("  File submitted. Waiting for document record in table...");
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll(".card-row");
      return rows.length > 0;
    }, { timeout: 15000 });

    const filesText = await page.innerText("body");
    const uploaded = filesText.includes("test_rag_sample.txt");
    console.log(`  ✓ Document in table: ${uploaded}`);
    report.files = { ok: uploaded };
  } catch (err) {
    console.log(`  ❌ Files failed: ${err.message}`);
    report.files = { ok: false, error: err.message };
  }

  // 8. ASK
  console.log("\n-------------------------------------------------------------");
  console.log("8. Testing /ask module in browser...");
  try {
    await page.goto("http://localhost:3000/ask", { waitUntil: "networkidle" });
    const askInput = page.locator("#rag-question");
    await askInput.fill("What is NirnayAI Architecture?");
    const askBtn = page.getByRole("button", { name: /ask/i });
    await askBtn.click();

    console.log("  Question submitted. Waiting for RAG answer...");
    await page.waitForFunction(() => {
      return document.querySelector(".card") !== null;
    }, { timeout: 20000 });

    const askText = await page.innerText("section");
    console.log(`  ✓ Ask answer received: "${askText.slice(0, 150).replace(/\n/g, ' ')}..."`);
    report.ask = { ok: true, snippet: askText.slice(0, 150).replace(/\n/g, ' ') };
  } catch (err) {
    console.log(`  ❌ Ask failed: ${err.message}`);
    report.ask = { ok: false, error: err.message };
  }

  await browser.close();

  console.log("\n=================================================================");
  console.log("FINAL IN-DEPTH AUDIT REPORT:");
  console.log(JSON.stringify(report, null, 2));
  console.log("=================================================================");
}

main().catch((err) => {
  console.error("Test execution fatal error:", err);
  process.exit(1);
});
