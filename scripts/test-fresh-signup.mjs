import { chromium } from "playwright";
import fs from "node:fs";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

async function test() {
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    headless: true,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.log(`[Console ${msg.type()}]`, msg.text());
    }
  });
  page.on("response", (res) => {
    if (res.status() >= 400) {
      console.log(`[HTTP ${res.status()}] ${res.request().method()} ${res.url()}`);
    }
  });

  console.log("1. Signing up fresh user...");
  await page.goto("http://localhost:3000/signup", { waitUntil: "networkidle" });
  await page.fill("#displayName", "Fresh Tester");
  const uid = Date.now();
  await page.fill("#email", `freshtester_${uid}@example.com`);
  await page.fill("#password", "ValidSecurePassword123!");
  await page.click("button[type='submit']");

  await page.waitForURL("**/chat", { timeout: 30000 });
  console.log("2. Landed on:", page.url());

  // Test chat
  console.log("\n3. Testing chat as fresh user...");
  const composer = page.getByPlaceholder(/say something/i);
  await composer.fill("Hello I am a fresh user");
  await page.getByRole("button", { name: /send/i }).click();
  await page.waitForTimeout(3000);
  const reply = await page.locator(".message.assistant").last().textContent().catch(() => "");
  console.log("   Chat reply:", reply?.slice(0, 80));

  // Test tasks
  console.log("\n4. Navigating to /tasks...");
  await page.goto("http://localhost:3000/tasks", { waitUntil: "networkidle" });
  const tasksBody = await page.innerText("body");
  console.log("   Tasks snippet:", tasksBody.slice(0, 150).replace(/\n/g, " "));

  // Test coding
  console.log("\n5. Navigating to /coding...");
  await page.goto("http://localhost:3000/coding", { waitUntil: "networkidle" });
  const codingBody = await page.innerText("body");
  console.log("   Coding snippet:", codingBody.slice(0, 150).replace(/\n/g, " "));

  // Test images
  console.log("\n6. Navigating to /images...");
  await page.goto("http://localhost:3000/images", { waitUntil: "networkidle" });
  const imagesBody = await page.innerText("body");
  console.log("   Images snippet:", imagesBody.slice(0, 150).replace(/\n/g, " "));

  // Test videos
  console.log("\n7. Navigating to /videos...");
  await page.goto("http://localhost:3000/videos", { waitUntil: "networkidle" });
  const videosBody = await page.innerText("body");
  console.log("   Videos snippet:", videosBody.slice(0, 150).replace(/\n/g, " "));

  // Test audio
  console.log("\n8. Navigating to /audio...");
  await page.goto("http://localhost:3000/audio", { waitUntil: "networkidle" });
  const audioBody = await page.innerText("body");
  console.log("   Audio snippet:", audioBody.slice(0, 150).replace(/\n/g, " "));

  // Test files
  console.log("\n9. Navigating to /files...");
  await page.goto("http://localhost:3000/files", { waitUntil: "networkidle" });
  const filesBody = await page.innerText("body");
  console.log("   Files snippet:", filesBody.slice(0, 150).replace(/\n/g, " "));

  // Test ask
  console.log("\n10. Navigating to /ask...");
  await page.goto("http://localhost:3000/ask", { waitUntil: "networkidle" });
  const askBody = await page.innerText("body");
  console.log("   Ask snippet:", askBody.slice(0, 150).replace(/\n/g, " "));

  await browser.close();
}

test().catch(console.error);
