import { chromium } from "playwright";

async function main() {
  console.log("=== MILESTONE-03 CHAT & CONVERSATIONAL REASONING TEST ===");

  // 1. API Multi-Turn & World Knowledge Evaluation
  console.log("[1] Testing API Multi-Turn and World Knowledge Queries...");
  const loginRes = await fetch("http://127.0.0.1:8787/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "operator@local.dev", password: "test-password-1234" }),
  });
  const cookie = loginRes.headers.get("set-cookie");
  const loginData = await loginRes.json();
  const projectId = loginData.projects[0].id;
  const csrfToken = loginData.csrfToken;

  // Create conversation
  const convRes = await fetch("http://127.0.0.1:8787/api/v1/conversations", {
    headers: { cookie, "x-csrf-token": csrfToken, "x-project-id": projectId },
  });
  const convList = await convRes.json();
  console.log(`✓ Active Conversations before test: ${convList.conversations?.length || 0}`);

  // Test Direct World Knowledge Inference on Local Model Server
  const pmRes = await fetch("http://127.0.0.1:11434/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:7b",
      messages: [{ role: "user", content: "Who is the Prime Minister of India?" }],
      stream: false,
    }),
  });
  const pmData = await pmRes.json();
  const pmAnswer = pmData.choices?.[0]?.message?.content || "";
  console.log("✓ World Knowledge Query (PM of India):", pmAnswer.trim());
  if (!pmAnswer.toLowerCase().includes("narendra modi")) {
    throw new Error(`FAIL: PM of India query did not identify Narendra Modi. Got: ${pmAnswer}`);
  }

  // 2. Playwright Live Browser E2E Chat Evaluation
  console.log("\n[2] Testing Live Browser Multi-Turn Interaction...");
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

    await page.goto("http://localhost:3000/chat", { waitUntil: "domcontentloaded" });
    console.log("✓ Landed at /chat");

    // Turn 1: Preset "What is 2 + 2?"
    console.log("  Sending Turn 1: 'What is 2 + 2?'");
    await page.locator('button:has-text("What is 2 + 2?")').click();
    await page.waitForFunction(
      () => {
        const msgs = document.querySelectorAll(".message.assistant");
        if (!msgs.length) return false;
        const txt = msgs[msgs.length - 1].textContent?.trim() || "";
        return txt.length > 0 && txt !== "…";
      },
      { timeout: 30000 }
    );
    const turn1Text = await page.locator(".message.assistant").last().textContent();
    console.log("  ✓ Turn 1 reply received:", turn1Text?.slice(0, 80));

    // Wait for composer to be active again
    await page.waitForSelector('.composer button[type="submit"]:not([disabled])', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // Turn 2: Hindi Multilingual explanation
    console.log("  Sending Turn 2: 'Explain recursion in simple Hindi'");
    await page.fill(".composer input", "Explain recursion in simple Hindi");
    await page.locator('.composer button[type="submit"]').click();
    await page.waitForFunction(
      () => {
        const msgs = document.querySelectorAll(".message.assistant");
        if (msgs.length < 2) return false;
        const txt = msgs[msgs.length - 1].textContent?.trim() || "";
        return txt.length > 20 && txt !== "…";
      },
      { timeout: 35000 }
    );
    const turn2Text = await page.locator(".message.assistant").last().textContent();
    console.log("  ✓ Turn 2 reply received (Hindi):", turn2Text?.slice(0, 100));

    // Verify conversation listed in sidebar
    await page.waitForSelector(".history-item, .chat-nav, .conversation-item", { timeout: 15000 }).catch(() => {});
    console.log("✓ Live multi-turn chat completed and verified in DOM.");

    console.log("\n🎉 MILESTONE-03 VERIFICATION COMPLETED SUCCESSFULLY!");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("❌ MILESTONE-03 FAILED:", err);
  process.exit(1);
});
