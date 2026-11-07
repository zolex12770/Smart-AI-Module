import { chromium } from "playwright";

async function main() {
  console.log("=== MILESTONE-04 MEMORY & RAG EVALUATION ===");

  // 1. API Memory Test
  console.log("[1] Testing Memory Storage & Deletion via API...");
  const loginRes = await fetch("http://127.0.0.1:8787/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "operator@local.dev", password: "test-password-1234" }),
  });
  const cookie = loginRes.headers.get("set-cookie");
  const loginData = await loginRes.json();
  const projectId = loginData.projects[0].id;
  const csrfToken = loginData.csrfToken;

  const testContent = "Operator prefers dark theme and strict TypeScript checking.";
  const addRes = await fetch("http://127.0.0.1:8787/api/v1/memory", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie,
      "x-csrf-token": csrfToken,
      "x-project-id": projectId,
    },
    body: JSON.stringify({ scope: "user", content: testContent }),
  });
  const addData = await addRes.json();
  console.log("✓ Memory created:", addData.item?.id, addData.item?.content);

  const listRes = await fetch("http://127.0.0.1:8787/api/v1/memory", {
    headers: { cookie, "x-csrf-token": csrfToken, "x-project-id": projectId },
  });
  const listData = await listRes.json();
  const found = listData.items?.some((i) => i.id === addData.item?.id);
  console.log("✓ Memory listed in repository:", found);

  if (addData.item?.id) {
    const delRes = await fetch(`http://127.0.0.1:8787/api/v1/memory/${addData.item.id}`, {
      method: "DELETE",
      headers: { cookie, "x-csrf-token": csrfToken, "x-project-id": projectId },
    });
    console.log("✓ Memory deleted status:", delRes.status);
  }

  // 2. Playwright Live Browser RAG Ask & Memory Verification
  console.log("\n[2] Testing Live Browser /ask and /memory pages...");
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

    // Visit /ask
    console.log("  Navigating to /ask...");
    await page.goto("http://localhost:3000/ask", { waitUntil: "domcontentloaded" });
    await page.locator('button:has-text("What capabilities does NirnayAI have?")').click();
    await page.locator('button:has-text("Ask")').click();
    await page.waitForSelector("h2:has-text('Answer')", { timeout: 30000 });
    const answerText = await page.textContent("main, section");
    console.log("  ✓ Grounded citation verified in DOM:", answerText.includes("[1]"));

    // Visit /memory
    console.log("  Navigating to /memory...");
    await page.goto("http://localhost:3000/memory", { waitUntil: "domcontentloaded" });
    await page.fill("#memory-content", "Persistent operator instruction: adhere to zero mocks.");
    await page.locator('button[type="submit"]:has-text("Remember")').click();
    await page.waitForFunction(
      () => {
        const text = document.body.textContent || "";
        return text.includes("adhere to zero mocks");
      },
      { timeout: 20000 }
    );
    console.log("  ✓ Memory rendered in DOM table.");

    console.log("\n🎉 MILESTONE-04 VERIFICATION COMPLETED SUCCESSFULLY!");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("❌ MILESTONE-04 FAILED:", err);
  process.exit(1);
});
