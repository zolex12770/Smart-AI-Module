import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { ConversationalIntentEngine } from "./lib/intent_engine.mjs";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("===============================================================================");
  console.log("  NIRNAY.AI — M-INTENT-03 MULTI-TURN REFERENCE RESOLUTION & DELTA MERGING");
  console.log("===============================================================================\n");

  const engine = new ConversationalIntentEngine();

  // ---------------------------------------------------------------------------
  // PART 1: 3-TURN VERNACULAR IMAGE DELTA MERGING
  // ---------------------------------------------------------------------------
  console.log("--- PART 1: 3-TURN VERNACULAR IMAGE DELTA MERGING ---");
  const imgSession = "session-img-bench-" + Date.now();

  // Turn 1: Initial Prompt
  const t1 = engine.processTurn(
    imgSession,
    "Ek village ki realistic photo banao jisme kisan khet me hai aur aurat khana bana rahi hai"
  );
  console.log(`[Turn 1] Original: "${t1.originalPrompt}"`);
  console.log(`    Detected Language: ${t1.detectedLanguage} | Target: ${t1.targetModule} | isRevision: ${t1.isRevision}`);
  console.log(`    Enhanced: "${t1.enhancedPrompt.slice(0, 100)}..."`);
  if (!t1.enhancedPrompt.includes("rural Indian village") || !t1.enhancedPrompt.includes("Indian farmer")) {
    throw new Error("Turn 1 failed to enrich vernacular village concepts!");
  }
  console.log("✓ Turn 1 Verified: Vernacular concepts enriched.\n");

  // Turn 2: Follow-up Revision Delta
  const t2 = engine.processTurn(
    imgSession,
    "Same photo but evening light, woman ki sari red honi chahiye without cars"
  );
  console.log(`[Turn 2] Original: "${t2.originalPrompt}"`);
  console.log(`    isRevision: ${t2.isRevision} | Negatives: [${t2.negativeConstraints.join(", ")}]`);
  console.log(`    Enhanced: "${t2.enhancedPrompt.slice(0, 120)}..."`);
  if (
    !t2.isRevision ||
    !t2.enhancedPrompt.includes("rural Indian village") ||
    !t2.enhancedPrompt.includes("golden hour evening sunset") ||
    !t2.enhancedPrompt.includes("vibrant red") ||
    !t2.negativeConstraints.includes("cars")
  ) {
    throw new Error("Turn 2 failed delta merging, composition preservation, or negative constraint extraction!");
  }
  console.log("✓ Turn 2 Verified: Setting preserved, evening light and red sari merged, negative constraint 'cars' extracted.\n");

  // Turn 3: Professional polish with meaning preservation
  const t3 = engine.processTurn(
    imgSession,
    "Isko aur professional banao, but original meaning change mat karna."
  );
  console.log(`[Turn 3] Original: "${t3.originalPrompt}"`);
  console.log(`    isRevision: ${t3.isRevision} | Preserved: [${t3.preservedConstraints.join(", ")}]`);
  console.log(`    Negatives carried forward: [${t3.negativeConstraints.join(", ")}]`);
  if (
    !t3.isRevision ||
    !t3.enhancedPrompt.includes("award-winning photographic clarity") ||
    !t3.negativeConstraints.includes("cars") ||
    !t3.preservedConstraints.includes("PRESERVE_SEMANTIC_MEANING")
  ) {
    throw new Error("Turn 3 failed to carry forward negative constraints or preserved semantic meaning invariant!");
  }
  console.log("✓ Turn 3 Verified: Photographic clarity merged, 'cars' negative constraint retained, invariant preserved.\n");

  // ---------------------------------------------------------------------------
  // PART 2: CODING MULTI-TURN CONSTRAINT & FORMAT EVOLUTION
  // ---------------------------------------------------------------------------
  console.log("--- PART 2: CODING MULTI-TURN CONSTRAINT & FORMAT EVOLUTION ---");
  const codeSession = "session-code-bench-" + Date.now();

  const c1 = engine.processTurn(codeSession, "Write factorial in Python.");
  console.log(`[Code Turn 1] Prompt: "${c1.originalPrompt}" | Format: [${c1.explicitConstraints.join(", ")}]`);

  const c2 = engine.processTurn(codeSession, "Bina recursion ke factorial banao.");
  console.log(`[Code Turn 2] Prompt: "${c2.originalPrompt}" | isRevision: ${c2.isRevision} | Negatives: [${c2.negativeConstraints.join(", ")}]`);
  if (!c2.isRevision || !c2.negativeConstraints.includes("recursion")) {
    throw new Error("Code Turn 2 failed to recognize revision or extract negative recursion constraint!");
  }

  const c3 = engine.processTurn(codeSession, "Use TypeScript, not JavaScript.");
  console.log(`[Code Turn 3] Prompt: "${c3.originalPrompt}" | isRevision: ${c3.isRevision} | Format: [${c3.explicitConstraints.join(", ")}] | Negatives: [${c3.negativeConstraints.join(", ")}]`);
  if (!c3.isRevision || !c3.explicitConstraints.includes("FORMAT_TYPESCRIPT") || !c3.negativeConstraints.includes("recursion") || !c3.negativeConstraints.includes("javascript")) {
    throw new Error("Code Turn 3 failed to maintain negative constraints across format transition!");
  }
  console.log("✓ Coding Evolution Verified: Constraints accumulated and maintained across iterative revisions.\n");

  // ---------------------------------------------------------------------------
  // PART 3: AMBIGUOUS REVISION CLARIFICATION PROMPTING
  // ---------------------------------------------------------------------------
  console.log("--- PART 3: AMBIGUOUS REVISION CLARIFICATION PROMPTING ---");
  const ambigSession = "session-ambig-" + Date.now();
  engine.processTurn(ambigSession, "Write binary search algorithm.");
  const ambigTurn = engine.processTurn(ambigSession, "isko change karo");
  console.log(`[Ambiguous Turn] Prompt: "${ambigTurn.originalPrompt}" | isRevision: ${ambigTurn.isRevision}`);
  console.log(`    Unresolved Ambiguity: [${ambigTurn.unresolvedAmbiguity.join(", ")}]`);
  console.log(`    Assumptions/Conflicts: [${ambigTurn.assumptions.join(", ")}]`);
  if (ambigTurn.unresolvedAmbiguity.length === 0 || !ambigTurn.unresolvedAmbiguity[0].includes("Please specify which attribute")) {
    throw new Error("Ambiguous revision failed to generate clarification query!");
  }
  console.log("✓ Ambiguous Revision Verified: Proactive clarification query generated.\n");

  // ---------------------------------------------------------------------------
  // PART 4: PLAYWRIGHT BROWSER E2E VERIFICATION (PORT 3000)
  // ---------------------------------------------------------------------------
  console.log("--- PART 4: PLAYWRIGHT BROWSER E2E MULTI-TURN VERIFICATION ---");
  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 950 },
  });
  const page = await context.newPage();

  console.log("Authenticating via One-Click Sign In...");
  await page.goto("http://localhost:3000/login", { waitUntil: "networkidle", timeout: 25000 });
  const oneClickBtn = page.locator('button:has-text("One-Click Sign In")');
  if (await oneClickBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await oneClickBtn.click();
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
  }

  console.log("Navigating to http://localhost:3000/chat...");
  await page.goto("http://localhost:3000/chat", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1000);

  // Click "+ New chat" for fresh session
  const newChatBtn = page.locator('button:has-text("+ New chat")');
  if (await newChatBtn.isVisible().catch(() => false)) {
    await newChatBtn.click();
    await page.waitForTimeout(1000);
  }

  async function sendChatMessage(promptText, turnIndex) {
    console.log(`Sending Turn ${turnIndex}: "${promptText}"`);
    const composerInput = page.locator("form.composer input");
    await composerInput.waitFor({ state: "visible", timeout: 15000 });
    await composerInput.fill(promptText);

    const sendButton = page.locator('form.composer button[type="submit"]');
    await sendButton.waitFor({ state: "visible", timeout: 15000 });
    await sendButton.click();

    // Wait for corresponding assistant message
    const assistantMsg = page.locator(".message.assistant").nth(turnIndex - 1);
    await assistantMsg.waitFor({ state: "visible", timeout: 20000 });
    await page.waitForTimeout(3000);
    const content = (await assistantMsg.textContent()) || "";
    console.log(`Turn ${turnIndex} Assistant Response snippet: "${content.slice(0, 120)}..."\n`);
    return content;
  }

  // Turn 1: Hello from user
  const r1 = await sendChatMessage("Hello! Who are you?", 1);
  if (!r1.includes("Nirnay.AI")) {
    throw new Error("Chat Turn 1 did not introduce as Nirnay.AI!");
  }

  // Turn 2: What are you doing
  const r2 = await sendChatMessage("What are you doing right now?", 2);
  if (!r2.includes("monitoring system status") && !r2.includes("ready to assist")) {
    throw new Error("Chat Turn 2 did not provide natural status response!");
  }

  // Turn 3: Multilingual technical query
  const r3 = await sendChatMessage("Factorial python function bina recursion ke samjhao", 3);
  if (!r3.includes("factorial") && !r3.includes("recursion")) {
    throw new Error("Chat Turn 3 did not provide iterative factorial explanation!");
  }

  const screenshotPath = path.join(ARTIFACT_DIR, "browser_chat_multiturn_delta_verified.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`✓ Verified screenshot saved to: ${screenshotPath}`);

  await browser.close();

  console.log("\n===============================================================================");
  console.log("  M-INTENT-03 VERIFICATION COMPLETE: ALL 4 PARTS & PLAYWRIGHT E2E PASSED");
  console.log("===============================================================================");
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
