import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";
const OUT_DIR = "data/sandbox/audit_browser";

fs.mkdirSync(OUT_DIR, { recursive: true });

const PROMPTS = [
  { slug: "lighthouse", prompt: "A lighthouse at dawn on a rocky coast" },
  { slug: "retriever", prompt: "A golden retriever running through a snowy forest" },
  { slug: "apple", prompt: "A red apple on a wooden table" },
];

async function main() {
  console.log("=== INDEPENDENT AUDIT: 3 BROWSER PROMPT GENERATIONS ===");

  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  try {
    // 1. Login
    console.log("[1] Logging in via One-Click Sign In...");
    await page.goto("http://localhost:3000/login", { waitUntil: "networkidle" });
    await page.click('button:has-text("One-Click Sign In")');
    await page.waitForURL((u) => !u.pathname.includes("/login"));

    // 2. Open /images
    console.log("[2] Navigating to http://localhost:3000/images...");
    await page.goto("http://localhost:3000/images", { waitUntil: "networkidle" });
    await page.waitForSelector(".page-subtitle", { timeout: 15000 });

    const auditResults = [];

    for (let i = 0; i < PROMPTS.length; i++) {
      const item = PROMPTS[i];
      console.log(`\n------------------------------------------------------------`);
      console.log(`[Prompt ${i + 1}/3] Submitting: "${item.prompt}"`);

      // Count existing cards with this exact prompt before submitting
      const existingCount = await page.locator(`.grid .card:has-text("${item.prompt}")`).count();

      const input = page.locator('input[placeholder="a lighthouse at dawn"]');
      await input.fill(item.prompt);
      await page.click('button:has-text("Generate")');
      console.log("  Submitted via UI button.");

      // Wait for new card to appear (count becomes existingCount + 1)
      const targetCard = page.locator(`.grid .card:has-text("${item.prompt}")`).first();
      await targetCard.waitFor({ state: "visible", timeout: 15000 });

      // Wait for <img> to render within this card
      const img = targetCard.locator("img");
      await img.waitFor({ state: "visible", timeout: 120000 });
      console.log("  ✓ Generated image rendered in gallery card!");

      const src = await img.getAttribute("src");
      console.log("  Image src:", src);

      // Download exact image from browser session
      const cookies = await context.cookies();
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const fullUrl = src.startsWith("http") ? src : `http://localhost:3000${src}`;
      const imgRes = await fetch(fullUrl, { headers: { Cookie: cookieHeader } });
      const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

      const savePath = path.join(OUT_DIR, `audit_${item.slug}.png`);
      fs.writeFileSync(savePath, imgBuffer);
      const artifactPath = path.join(ARTIFACT_DIR, `audit_browser_${item.slug}.png`);
      fs.writeFileSync(artifactPath, imgBuffer);

      console.log(`  ✓ Saved downloaded PNG: ${savePath} (${imgBuffer.length} bytes)`);

      auditResults.push({
        slug: item.slug,
        prompt: item.prompt,
        src,
        bytes: imgBuffer.length,
        savePath,
        artifactPath,
      });

      // Pacing pause between requests for rate limit compliance
      if (i < PROMPTS.length - 1) {
        console.log("  Pacing: waiting 46s for next generation...");
        await new Promise((r) => setTimeout(r, 46000));
      }
    }

    // Capture screenshot of the gallery with all audit items
    const screenshotPath = path.join(ARTIFACT_DIR, "audit_browser_gallery.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`\n✓ Saved audit gallery screenshot to ${screenshotPath}`);

    fs.writeFileSync(
      path.join(OUT_DIR, "audit_summary.json"),
      JSON.stringify(auditResults, null, 2)
    );
    console.log("=== ALL 3 BROWSER AUDIT PROMPTS GENERATED & CAPTURED ===");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("FATAL ERROR in audit:", err);
  process.exit(1);
});
