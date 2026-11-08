import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACT_DIR = "C:\\Users\\SAURABH KUMAR\\.gemini\\antigravity\\brain\\ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("=================================================================");
  console.log("   DEEP WORKFLOW EXECUTION: TESTING ALL 8 MODULE ACTIONS         ");
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

  page.on("response", async (res) => {
    if (res.status() >= 400) {
      const body = await res.text().catch(() => "");
      console.log(`[HTTP ${res.status()}] ${res.request().method()} ${res.url()} -> ${body.slice(0, 150)}`);
    }
  });

  // Login
  console.log("[1] Logging in as operator@local.dev...");
  await page.goto("http://localhost:3000/login", { waitUntil: "networkidle" });
  await page.fill("#email", "operator@local.dev");
  await page.fill("#password", "test-password-1234");
  await page.click("button[type='submit']");
  await page.waitForURL("**/chat", { timeout: 30000 });
  console.log("  ✓ Logged in!\n");

  // 1. CHAT
  console.log("[2] Testing Module 1: Chat...");
  await page.goto("http://localhost:3000/chat", { waitUntil: "networkidle" });
  const composer = page.getByPlaceholder(/say something/i);
  await composer.fill("Hello chat module");
  await page.getByRole("button", { name: /send/i }).click();
  await page.waitForTimeout(3000);
  const chatBubble = page.locator(".message.assistant").last();
  const chatText = (await chatBubble.textContent().catch(() => ""))?.trim();
  console.log(`  Chat result: "${chatText.slice(0, 80)}..."\n`);

  // 2. TASKS
  console.log("[3] Testing Module 2: Tasks...");
  await page.goto("http://localhost:3000/tasks", { waitUntil: "networkidle" });
  // Fill echo_chat form: input field for message
  const msgInput = page.locator("input[placeholder*='message'], textarea, input[type='text']").first();
  if (await msgInput.isVisible()) {
    await msgInput.fill("Hello from tasks test");
  }
  const taskSubmit = page.getByRole("button", { name: /create task/i });
  console.log(`  Create Task button visible: ${await taskSubmit.isVisible()}`);
  if (await taskSubmit.isVisible()) {
    await taskSubmit.click();
    await page.waitForTimeout(3000);
    console.log(`  Task creation URL after click: ${page.url()}`);
  }
  const tasksScreenshot = path.join(ARTIFACT_DIR, "deep_test_tasks.png");
  await page.screenshot({ path: tasksScreenshot, fullPage: true });

  // 3. CODING
  console.log("\n[4] Testing Module 3: Coding...");
  await page.goto("http://localhost:3000/coding", { waitUntil: "networkidle" });
  const startCodingBtn = page.getByRole("button", { name: /start coding agent/i });
  console.log(`  Start Coding Agent button visible: ${await startCodingBtn.isVisible()}`);
  if (await startCodingBtn.isVisible()) {
    await startCodingBtn.click();
    await page.waitForTimeout(3000);
    console.log(`  Coding URL after click: ${page.url()}`);
  }
  const codingScreenshot = path.join(ARTIFACT_DIR, "deep_test_coding.png");
  await page.screenshot({ path: codingScreenshot, fullPage: true });

  // 4. IMAGES
  console.log("\n[5] Testing Module 4: Images...");
  await page.goto("http://localhost:3000/images", { waitUntil: "networkidle" });
  const imgInput = page.getByPlaceholder(/a lighthouse at dawn/i);
  await imgInput.fill("a majestic waterfall");
  const imgSubmit = page.getByRole("button", { name: /generate/i });
  await imgSubmit.click();
  await page.waitForTimeout(2000);
  const imgError = await page.locator(".error-text, [role='alert']").textContent().catch(() => "");
  console.log(`  Image UI response / error: "${imgError.trim()}"`);
  const imagesScreenshot = path.join(ARTIFACT_DIR, "deep_test_images.png");
  await page.screenshot({ path: imagesScreenshot, fullPage: true });

  // 5. VIDEOS
  console.log("\n[6] Testing Module 5: Videos...");
  await page.goto("http://localhost:3000/videos", { waitUntil: "networkidle" });
  const vidInput = page.getByPlaceholder(/a lighthouse in a storm/i);
  await vidInput.fill("a drone shot over mountains");
  const vidSubmit = page.getByRole("button", { name: /generate/i });
  await vidSubmit.click();
  await page.waitForTimeout(2000);
  const vidError = await page.locator(".error-text, [role='alert']").textContent().catch(() => "");
  console.log(`  Video UI response / error: "${vidError.trim()}"`);
  const videosScreenshot = path.join(ARTIFACT_DIR, "deep_test_videos.png");
  await page.screenshot({ path: videosScreenshot, fullPage: true });

  // 6. AUDIO
  console.log("\n[7] Testing Module 6: Audio...");
  await page.goto("http://localhost:3000/audio", { waitUntil: "networkidle" });
  const audioTextarea = page.locator("textarea");
  await audioTextarea.fill("Testing audio synthesis from browser.");
  const audioSubmit = page.getByRole("button", { name: /generate speech/i });
  await audioSubmit.click();
  await page.waitForTimeout(2000);
  const audioError = await page.locator(".error-text, [role='alert']").textContent().catch(() => "");
  console.log(`  Audio UI response / error: "${audioError.trim()}"`);
  const audioScreenshot = path.join(ARTIFACT_DIR, "deep_test_audio.png");
  await page.screenshot({ path: audioScreenshot, fullPage: true });

  // 7. FILES
  console.log("\n[8] Testing Module 7: Files...");
  await page.goto("http://localhost:3000/files", { waitUntil: "networkidle" });
  // Create a temporary test file to upload
  const testFilePath = path.resolve("test_upload_doc.txt");
  fs.writeFileSync(testFilePath, "NirnayAI verification test document content.\nLine 2 for RAG extraction test.");
  const fileInput = page.locator("input[type='file']");
  await fileInput.setInputFiles(testFilePath);
  const uploadBtn = page.getByRole("button", { name: /upload/i });
  await uploadBtn.click();
  await page.waitForTimeout(3000);
  const filesError = await page.locator(".error-text, [role='alert']").textContent().catch(() => "");
  console.log(`  Files UI response / error: "${filesError.trim()}"`);
  const filesScreenshot = path.join(ARTIFACT_DIR, "deep_test_files.png");
  await page.screenshot({ path: filesScreenshot, fullPage: true });

  // 8. ASK
  console.log("\n[9] Testing Module 8: Ask...");
  await page.goto("http://localhost:3000/ask", { waitUntil: "networkidle" });
  const askTextarea = page.locator("#rag-question");
  await askTextarea.fill("What is NirnayAI verification test document?");
  const askSubmit = page.getByRole("button", { name: /ask/i });
  await askSubmit.click();
  await page.waitForTimeout(3000);
  const askError = await page.locator(".error-text, [role='alert']").textContent().catch(() => "");
  const askAnswer = await page.locator("section").textContent().catch(() => "");
  console.log(`  Ask UI response / error: "${askError.trim()}"`);
  console.log(`  Ask UI section snippet: "${askAnswer.slice(0, 150).replace(/\n/g, ' ')}..."`);
  const askScreenshot = path.join(ARTIFACT_DIR, "deep_test_ask.png");
  await page.screenshot({ path: askScreenshot, fullPage: true });

  await browser.close();
  console.log("\n=================================================================");
  console.log("   DEEP WORKFLOW EXECUTION COMPLETE                              ");
  console.log("=================================================================");
}

main().catch((err) => {
  console.error("Deep test failed:", err);
  process.exit(1);
});
