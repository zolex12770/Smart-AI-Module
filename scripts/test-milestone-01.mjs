import { chromium } from "playwright";

async function main() {
  console.log("=== MILESTONE-01 E2E LIVE BROWSER VERIFICATION ===");
  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  try {
    await page.goto("http://localhost:3000/login", { waitUntil: "networkidle" });
    const heading = await page.locator("h1").textContent();
    const subtitle = await page.locator(".page-subtitle").textContent();
    console.log("✓ Login Heading:", heading);
    console.log("✓ Subtitle:", subtitle);

    const btn = page.locator('button:has-text("One-Click Sign In")');
    const isVisible = await btn.isVisible();
    console.log("✓ Local Dev One-Click Button visible:", isVisible);
    if (!isVisible) throw new Error("One-Click Sign In button not found");

    await page.waitForTimeout(1000); // ensure React hydration
    await btn.click();
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 20000 });
    console.log("✓ Successfully authenticated. Landed at:", page.url());

    const navBrand = await page.locator(".app-brand, .brand-title, nav").first().textContent();
    console.log("✓ Nav Brand Content:", navBrand?.replace(/\s+/g, " ").trim());

    console.log("\n🎉 MILESTONE-01 VERIFICATION COMPLETED SUCCESSFULLY!");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("❌ MILESTONE-01 FAILED:", err);
  process.exit(1);
});
