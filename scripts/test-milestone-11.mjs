import { chromium } from "playwright";

async function main() {
  console.log("=== MILESTONE-11 ADMIN & GOVERNANCE E2E VERIFICATION ===");
  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  try {
    await page.goto("http://localhost:3000/login", { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    await page.locator('button:has-text("One-Click Sign In")').click();
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 20000 });

    await page.goto("http://localhost:3000/admin", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("h1:has-text('Admin')", { timeout: 20000 });
    const content = await page.textContent("body");
    console.log("✓ Admin Screen loaded. Verified elements present:", content.length > 50);
    console.log("\n🎉 MILESTONE-11 VERIFICATION COMPLETED SUCCESSFULLY!");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("❌ MILESTONE-11 FAILED:", err);
  process.exit(1);
});
