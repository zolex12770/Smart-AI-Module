import assert from "node:assert";
import { ConversationalIntentEngine } from "../lib/intent_engine.mjs";

console.log("=== RUNNING CONVERSATIONAL INTENT ENGINE UNIT TEST SUITE ===\n");

const engine = new ConversationalIntentEngine();

// -----------------------------------------------------------------------------
// Test 1: Language Detection
// -----------------------------------------------------------------------------
console.log("[Test 1] Language Modality Detection...");
assert.strictEqual(engine.detectLanguage("A lighthouse at dawn on a rocky coast"), "english");
assert.strictEqual(
  engine.detectLanguage("एक ग्रामीण भारतीय गांव का यथार्थवादी दृश्य, जहां वृद्ध पुरुष और महिला खाना बना रहे हैं"),
  "hindi_devanagari"
);
assert.strictEqual(
  engine.detectLanguage("Ek village ki realistic image banao, old man aur woman khana bana rahe hain"),
  "hinglish"
);
console.log("✓ Language detection verified for English, Hindi Devanagari, and Hinglish.");

// -----------------------------------------------------------------------------
// Test 2: Intent Classification
// -----------------------------------------------------------------------------
console.log("\n[Test 2] Intent Classification across modalities...");
assert.strictEqual(
  engine.classifyIntent("Ek village ki realistic photo banao"),
  "IMAGE_GENERATION"
);
assert.strictEqual(
  engine.classifyIntent("Fix failing tests in math.test.js and refactor the code"),
  "CODING_TASK"
);
assert.strictEqual(
  engine.classifyIntent("Generate a 1-minute video with a cinematic trailer storyboard"),
  "VIDEO_GENERATION"
);
assert.strictEqual(
  engine.classifyIntent("Synthesize speech narration for this podcast audio"),
  "AUDIO_SYNTHESIS"
);
assert.strictEqual(
  engine.classifyIntent("Explain the difference between TCP and UDP with examples"),
  "CHAT_REASONING"
);
console.log("✓ Intent classification verified across all core task categories.");

// -----------------------------------------------------------------------------
// Test 3: Constraint & Negative Instruction Extraction
// -----------------------------------------------------------------------------
console.log("\n[Test 3] Constraint & Negative Instruction Extraction...");
const constraints = engine.extractConstraints(
  "Draw a futuristic city without cars, avoid pollution, and original meaning change mat karna"
);
console.log("  Extracted constraints:", constraints);
assert.ok(constraints.negativeConstraints.some((c) => c.includes("cars")));
assert.ok(constraints.negativeConstraints.some((c) => c.includes("pollution")));
assert.ok(constraints.preservedConstraints.includes("PRESERVE_SEMANTIC_MEANING"));
console.log("✓ Negative constraints and preservation rules accurately extracted.");

// -----------------------------------------------------------------------------
// Test 4: Multi-Turn Context & Reference Resolution (The Village Benchmark)
// -----------------------------------------------------------------------------
console.log("\n[Test 4] Multi-Turn Intent & Delta Merging (Turn 1 -> Turn 2 -> Turn 3)...");

const sessionId = "test-session-village-001";

// Turn 1: Initial Hinglish Village Request
console.log("  -> Processing Turn 1: Initial creation");
const turn1 = engine.processTurn(
  sessionId,
  "Ek village ki realistic image banao, old man aur woman khana bana rahe hain aur bachche kha rahe hain."
);
console.log("  Turn 1 Enhanced:", turn1.enhancedPrompt);
assert.strictEqual(turn1.detectedLanguage, "hinglish");
assert.strictEqual(turn1.intent, "IMAGE_GENERATION");
assert.strictEqual(turn1.isRevision, false);
assert.ok(turn1.enhancedPrompt.includes("rural Indian village"));
assert.ok(turn1.enhancedPrompt.includes("cooking fresh food"));
assert.ok(turn1.enhancedPrompt.includes("village children"));

// Turn 2: Follow-up Revision with delta changes ("Same image but evening light, woman ki sari red honi chahiye")
console.log("  -> Processing Turn 2: Revision with delta changes");
const turn2 = engine.processTurn(
  sessionId,
  "Same image but evening light, woman ki sari red honi chahiye."
);
console.log("  Turn 2 Enhanced:", turn2.enhancedPrompt);
assert.strictEqual(turn2.isRevision, true);
// Verify composition preservation
assert.ok(turn2.enhancedPrompt.includes("rural Indian village"));
assert.ok(turn2.enhancedPrompt.includes("cooking fresh food"));
assert.ok(turn2.enhancedPrompt.includes("village children"));
// Verify delta application
assert.ok(turn2.enhancedPrompt.includes("evening sunset lighting"));
assert.ok(turn2.enhancedPrompt.includes("vibrant red"));

// Turn 3: Follow-up Preservation Request ("Isko aur professional banao, but original meaning change mat karna")
console.log("  -> Processing Turn 3: Professional polish with strict meaning preservation");
const turn3 = engine.processTurn(
  sessionId,
  "Isko aur professional banao, but original meaning change mat karna."
);
console.log("  Turn 3 Enhanced:", turn3.enhancedPrompt);
assert.strictEqual(turn3.isRevision, true);
assert.ok(turn3.preservedConstraints.includes("PRESERVE_SEMANTIC_MEANING"));
assert.ok(turn3.enhancedPrompt.includes("professional"));
assert.ok(turn3.enhancedPrompt.includes("rural Indian village"));
assert.ok(turn3.enhancedPrompt.includes("evening sunset lighting"));
assert.ok(turn3.enhancedPrompt.includes("vibrant red"));

console.log("\n=== ALL INTENT ENGINE UNIT TESTS PASSED (100%) ===");
