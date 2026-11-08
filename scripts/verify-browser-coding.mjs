import { chromium } from "playwright";
import path from "node:path";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("=== BROWSER E2E VERIFICATION: CODING AGENT & PATH ISOLATION (/coding) ===");

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
    await page.goto("http://localhost:3000/login", { waitUntil: "networkidle", timeout: 30000 });
    const oneClickBtn = page.locator('button:has-text("One-Click Sign In")');
    await oneClickBtn.waitFor({ state: "visible", timeout: 15000 });
    await oneClickBtn.click();
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 35000 });
    console.log("✓ Authenticated.");

    // 2. Open /coding
    console.log("\n[2/5] Navigating to http://localhost:3000/coding...");
    await page.goto("http://localhost:3000/coding", { waitUntil: "networkidle", timeout: 25000 });

    // Verify honest path containment badge
    const badge = page.getByText("APPLICATION PATH CONTAINMENT (WINDOWS APPDATA ISOLATION)");
    await badge.waitFor({ state: "visible", timeout: 10000 });
    console.log("✓ Honest disclosure badge verified in DOM: 'APPLICATION PATH CONTAINMENT (WINDOWS APPDATA ISOLATION)'");

    // 3. Seed demo fixture
    console.log("\n[3/5] Seeding demo fixture (math.test.js)...");
    const seedBtn = page.locator('button:has-text("Seed Demo Fixture")');
    await seedBtn.waitFor({ state: "visible", timeout: 10000 });
    await seedBtn.click();
    await page.waitForTimeout(1000);
    console.log("✓ Demo fixture seeded.");

    // 4. Launch coding agent task from form
    console.log("\n[4/5] Launching coding agent task...");
    const dispatchBtn = page.locator('button:has-text("Start Coding Agent"), button[type="submit"]').first();
    await dispatchBtn.waitFor({ state: "visible", timeout: 10000 });
    await dispatchBtn.click();

    // 5. Observe task execution on /coding/[id]
    console.log("\n[5/5] Monitoring coding task execution on /coding/[id]...");
    await page.waitForURL((url) => url.pathname.includes("/coding/"), { timeout: 15000 });
    console.log("✓ Redirected to task detail:", page.url());

    // Wait for COMPLETED badge
    const completedBadge = page.getByText("COMPLETED").first();
    await completedBadge.waitFor({ state: "visible", timeout: 35000 });
    console.log("✓ Coding agent task reached COMPLETED status in live DOM!");

    const screenshotPath = path.join(ARTIFACT_DIR, "browser_coding_generalized_verified.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log("✓ Screenshot saved to:", screenshotPath);

    console.log("\n==================================================");
    console.log("  BROWSER /coding E2E VERIFICATION PASSED (100%)");
    console.log("==================================================");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Browser coding verification failed:", err);
  process.exit(1);
});
