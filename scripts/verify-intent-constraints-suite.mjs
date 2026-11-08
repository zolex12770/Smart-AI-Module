import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { ConversationalIntentEngine } from "./lib/intent_engine.mjs";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";

async function main() {
  console.log("===============================================================================");
  console.log("  NIRNAY.AI — M-INTENT-02 CONSTRAINT PRESERVATION & CONFLICT RESOLUTION SUITE");
  console.log("===============================================================================\n");

  const engine = new ConversationalIntentEngine();

  const benchmarkPrompts = [
    {
      id: 1,
      prompt: "Write factorial in Python without recursion.",
      description: "Negative algorithmic constraint (no recursion) + format constraint (Python)",
      verify: (c) => c.negativeConstraints.includes("recursion") && c.explicitConstraints.includes("FORMAT_PYTHON"),
    },
    {
      id: 2,
      prompt: "Do not change the original meaning.",
      description: "Preserved invariant constraint (semantic meaning)",
      verify: (c) => c.preservedConstraints.includes("PRESERVE_SEMANTIC_MEANING"),
    },
    {
      id: 3,
      prompt: "Avoid cars.",
      description: "Negative generation constraint (exclude cars/vehicles)",
      verify: (c) => c.negativeConstraints.includes("cars"),
    },
    {
      id: 4,
      prompt: "Keep the same composition.",
      description: "Preserved visual invariant (framing & composition)",
      verify: (c) => c.preservedConstraints.includes("PRESERVE_STYLE_AND_COMPOSITION"),
    },
    {
      id: 5,
      prompt: "Only change the lighting.",
      description: "Scope-limited delta constraint (lighting only, preserve everything else)",
      verify: (c) => c.preservedConstraints.includes("PRESERVE_ALL_EXCEPT_LIGHTING") && c.explicitConstraints.includes("DELTA_LIGHTING_ONLY"),
    },
    {
      id: 6,
      prompt: "Do not modify any other file.",
      description: "Scope limitation constraint (codebase protection)",
      verify: (c) => c.preservedConstraints.includes("PRESERVE_UNMODIFIED_FILES") && c.negativeConstraints.includes("modify other files"),
    },
    {
      id: 7,
      prompt: "Explain in Hindi, but keep technical terms in English.",
      description: "Bilingual mixed modality constraint (Hindi explanation + English terminology)",
      verify: (c) => c.explicitConstraints.includes("EXPLAIN_HINDI") && c.explicitConstraints.includes("TECHNICAL_TERMS_ENGLISH"),
    },
    {
      id: 8,
      prompt: "Make it shorter without removing important information.",
      description: "Conciseness goal with preserved invariant (information retention)",
      verify: (c) => c.explicitConstraints.includes("CONCISE_SUMMARY") && c.preservedConstraints.includes("PRESERVE_ESSENTIAL_INFORMATION"),
    },
    {
      id: 9,
      prompt: "Use TypeScript, not JavaScript.",
      description: "Positive constraint with explicit negative negation (TypeScript over JavaScript)",
      verify: (c) => c.explicitConstraints.includes("FORMAT_TYPESCRIPT") && c.negativeConstraints.includes("javascript") && !c.explicitConstraints.includes("FORMAT_JAVASCRIPT"),
    },
    {
      id: 10,
      prompt: "Do not add dependencies.",
      description: "Negative architectural constraint (zero third-party dependencies)",
      verify: (c) => c.negativeConstraints.includes("dependencies"),
    },
    {
      id: 11,
      prompt: "Bina recursion ke factorial banao.",
      description: "Hinglish negative algorithmic constraint (bina recursion)",
      verify: (c) => c.negativeConstraints.includes("recursion"),
    },
    {
      id: 12,
      prompt: "Koi gaadi mat dikhana.",
      description: "Hindi/Hinglish negative visual constraint (koi gaadi mat dikhana -> no cars)",
      verify: (c) => c.negativeConstraints.includes("cars"),
    },
    {
      id: 13,
      prompt: "Original meaning change mat karna.",
      description: "Hinglish preserved semantic invariant (change mat karna)",
      verify: (c) => c.preservedConstraints.includes("PRESERVE_SEMANTIC_MEANING"),
    },
    {
      id: 14,
      prompt: "Sirf sari ka color red karo, baaki same rakho.",
      description: "Hinglish delta editing with invariant preservation (red sari, preserve rest)",
      verify: (c) => c.preservedConstraints.includes("PRESERVE_ALL_EXCEPT_TARGET") && c.explicitConstraints.includes("TARGET_COLOR_RED") && c.explicitConstraints.includes("TARGET_ELEMENT_SARI"),
    },
  ];

  console.log("--- PART 1: 14 MANDATORY CONSTRAINT BENCHMARK PROMPTS ---");
  let passedCount = 0;
  for (const item of benchmarkPrompts) {
    const c = engine.extractConstraints(item.prompt);
    const ok = item.verify(c);
    if (ok) {
      passedCount++;
      console.log(`✓ [Prompt ${item.id}/14 Passed] "${item.prompt}"`);
      console.log(`    Explicit: [${c.explicitConstraints.join(", ")}] | Negative: [${c.negativeConstraints.join(", ")}] | Preserved: [${c.preservedConstraints.join(", ")}]`);
    } else {
      console.error(`✗ [Prompt ${item.id}/14 FAILED] "${item.prompt}"`);
      console.error(`    Result: ${JSON.stringify(c)}`);
    }
  }

  if (passedCount !== 14) {
    throw new Error(`Only ${passedCount}/14 constraint benchmark prompts passed!`);
  }
  console.log(`\nAll 14/14 benchmark constraint tests PASSED perfectly.\n`);

  console.log("--- PART 2: CONFLICT DETECTION & PRIORITY RESOLUTION ---");
  // Test A: Contradictory recursion requirement
  const conflict1 = engine.extractConstraints("Write factorial in Python with recursion and without recursion.");
  if (conflict1.conflicts.length > 0 && conflict1.negativeConstraints.includes("recursion")) {
    console.log(`✓ Conflict 1 Handled: Contradictory recursion flagged: "${conflict1.conflicts[0]}"`);
    console.log(`    Negative constraint prioritized over positive: ${conflict1.negativeConstraints.includes("recursion")}`);
  } else {
    throw new Error("Failed to detect or resolve recursion conflict!");
  }

  // Test B: Mutually exclusive formats
  const conflict2 = engine.extractConstraints("Write this component in both TypeScript and JavaScript simultaneously.");
  if (conflict2.conflicts.length > 0 && conflict2.unresolvedAmbiguity.length > 0) {
    console.log(`✓ Conflict 2 Handled: Mutually exclusive formats flagged: "${conflict2.conflicts[0]}"`);
    console.log(`    Ambiguity resolution query generated: "${conflict2.unresolvedAmbiguity[0]}"`);
  } else {
    throw new Error("Failed to detect mutually exclusive formats conflict!");
  }

  // Test C: Concise vs Exhaustive In-depth
  const conflict3 = engine.extractConstraints("Make it shorter and very brief but provide an exhaustive in-depth detailed explanation.");
  if (conflict3.conflicts.length > 0) {
    console.log(`✓ Conflict 3 Handled: Concise vs detailed conflict flagged: "${conflict3.conflicts[0]}"`);
  } else {
    throw new Error("Failed to detect conciseness vs exhaustive detail conflict!");
  }

  console.log("\n--- PART 3: PLAYWRIGHT BROWSER E2E VERIFICATION (PORT 3000) ---");
  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  // 1. Authenticate via login page
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

  // Click "+ New chat" if present
  const newChatBtn = page.locator('button:has-text("+ New chat")');
  if (await newChatBtn.isVisible().catch(() => false)) {
    await newChatBtn.click();
    await page.waitForTimeout(1000);
  }

  // Send conversational prompt: "What are you doing right now?"
  console.log("Submitting conversational inquiry: 'What are you doing right now?'");
  const composerInput = page.locator("form.composer input");
  await composerInput.waitFor({ state: "visible", timeout: 15000 });
  await composerInput.fill("What are you doing right now?");
  
  const sendButton = page.locator('form.composer button[type="submit"]');
  await sendButton.waitFor({ state: "visible", timeout: 15000 });
  await sendButton.click();

  // Wait for assistant response to appear
  console.log("Waiting for assistant response stream...");
  const assistantMsg = page.locator(".message.assistant").first();
  await assistantMsg.waitFor({ state: "visible", timeout: 20000 });
  // Wait until streaming finishes (stop button disappears or text settles)
  await page.waitForTimeout(3000);

  const responseText = (await assistantMsg.textContent()) || "";
  console.log(`Assistant response snippet: "${responseText.slice(0, 150)}..."`);
  
  // Verify natural conversational response:
  const isNatural = responseText.includes("monitoring system status") || responseText.includes("ready to assist") || responseText.includes("core modules");
  const isRobotic = responseText.includes("### Technical Analysis: What are you doing");

  console.log(`Natural assistant response detected: ${isNatural}`);
  console.log(`Robotic boilerplate absent: ${!isRobotic}`);

  if (!isNatural || isRobotic) {
    throw new Error(`Chat did not return natural assistant response; returned robotic boilerplate or unexpected output: "${responseText}"`);
  }

  const screenshotPath = path.join(ARTIFACT_DIR, "browser_chat_natural_verified.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`✓ Verified screenshot saved to: ${screenshotPath}`);

  await browser.close();

  console.log("\n===============================================================================");
  console.log("  M-INTENT-02 VERIFICATION COMPLETE: ALL 14 PROMPTS & REAL BROWSER VERIFIED");
  console.log("===============================================================================");
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
