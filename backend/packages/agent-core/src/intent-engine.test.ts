import { describe, expect, it } from "vitest";
import { ConversationalIntentEngine } from "./intent-engine.js";

describe("ConversationalIntentEngine in agent-core", () => {
  const engine = new ConversationalIntentEngine();

  it("detects language modality across English, Devanagari Hindi, Hinglish, and Indian English", () => {
    expect(engine.detectLanguage("A red apple on a wooden table")).toBe("english");
    expect(
      engine.detectLanguage("एक ग्रामीण भारतीय गांव का यथार्थवादी दृश्य")
    ).toBe("hindi_devanagari");
    expect(
      engine.detectLanguage("Ek village ki realistic photo banao jisme kisan khet me hai")
    ).toBe("hinglish");
    expect(
      engine.detectLanguage("Kindly do one thing, revert back with the latest project status")
    ).toBe("indian_english");
  });

  it("classifies task intents accurately across all platform modules", () => {
    expect(engine.classifyIntent("Ek sundar titli ki image banao")).toBe("IMAGE_GENERATION");
    expect(engine.classifyIntent("Debug and fix failing unit test in math.test.js")).toBe("CODING_TASK");
    expect(engine.classifyIntent("Create a 2-minute video trailer with cinematic scenes")).toBe("VIDEO_GENERATION");
    expect(engine.classifyIntent("Synthesize narration audio for this text")).toBe("AUDIO_SYNTHESIS");
    expect(engine.classifyIntent("Explain quicksort in simple terms")).toBe("CHAT_REASONING");
    expect(engine.classifyIntent("Based on file, what are the travel reimbursement limits?")).toBe("DOCUMENT_QA");
    expect(engine.classifyIntent("Automate this multi-step workflow pipeline")).toBe("TASK_EXECUTION");
    expect(engine.classifyIntent("Do you remember who am I and where am I from?")).toBe("MEMORY_OPERATION");
    expect(engine.classifyIntent("Check current quota, token usage and server status")).toBe("ADMIN_OPERATION");
  });

  it("parses negative constraints, preserved invariants, and explicit format requirements", () => {
    const { negativeConstraints, preservedConstraints, explicitConstraints } = engine.extractConstraints(
      "Draw an old temple without cars, avoid modern electricity poles, bina pollution ke, keep original meaning, in typescript with O(log n) complexity"
    );
    expect(negativeConstraints.some((c) => c.includes("cars"))).toBe(true);
    expect(negativeConstraints.some((c) => c.includes("modern electricity poles"))).toBe(true);
    expect(negativeConstraints.some((c) => c.includes("pollution"))).toBe(true);
    expect(preservedConstraints).toContain("PRESERVE_SEMANTIC_MEANING");
    expect(explicitConstraints).toContain("FORMAT_TYPESCRIPT");
    expect(explicitConstraints).toContain("COMPLEXITY_O_LOG_N");
  });

  it("preserves context and applies delta modifications in multi-turn interactions", () => {
    const sessionId = "unit-test-session-village";

    // Turn 1: Initial creation
    const turn1 = engine.processTurn(
      sessionId,
      "Ek village ki realistic image banao, old man aur woman khana bana rahe hain aur bachche kha rahe hain."
    );
    expect(turn1.isRevision).toBe(false);
    expect(turn1.detectedLanguage).toBe("hinglish");
    expect(turn1.targetModule).toBe("images");
    expect(turn1.outputFormat).toBe("image_diffusion");
    expect(turn1.enhancedPrompt).toContain("rural Indian village");
    expect(turn1.enhancedPrompt).toContain("cooking fresh food");

    // Turn 2: Follow-up revision
    const turn2 = engine.processTurn(
      sessionId,
      "Same image but evening light, woman ki sari red honi chahiye."
    );
    expect(turn2.isRevision).toBe(true);
    expect(turn2.enhancedPrompt).toContain("rural Indian village");
    expect(turn2.enhancedPrompt).toContain("cooking fresh food");
    expect(turn2.enhancedPrompt).toContain("evening sunset lighting");
    expect(turn2.enhancedPrompt).toContain("vibrant red");

    // Turn 3: Polish with preservation
    const turn3 = engine.processTurn(
      sessionId,
      "Isko aur professional banao, but original meaning change mat karna."
    );
    expect(turn3.isRevision).toBe(true);
    expect(turn3.preservedConstraints).toContain("PRESERVE_SEMANTIC_MEANING");
    expect(turn3.enhancedPrompt).toContain("professional");
    expect(turn3.enhancedPrompt).toContain("rural Indian village");
    expect(turn3.enhancedPrompt).toContain("evening sunset lighting");
    expect(turn3.enhancedPrompt).toContain("vibrant red");
  });

  it("generates structured CodingIntentAdapter extracting test files, languages, and repair actions", () => {
    const state = engine.processTurn(
      "session-coding-01",
      "Fix failing assertion in math.test.js for math.js in TypeScript"
    );
    const codingAdapter = engine.adaptForCoding(state);

    expect(codingAdapter.actionType).toBe("fix_test");
    expect(codingAdapter.testFile).toBe("math.test.js");
    expect(codingAdapter.targetFile).toBe("math.js");
    expect(codingAdapter.language).toBe("typescript");
    expect(codingAdapter.testCommand).toBe("node");
    expect(codingAdapter.testArgs).toContain("math.test.js");
  });

  it("generates TaskIntentAdapter with sequential DAG execution steps", () => {
    const state = engine.processTurn(
      "session-task-01",
      "Diagnose and fix failing unit test in math.test.js"
    );
    const taskAdapter = engine.adaptForTasks(state);

    expect(taskAdapter.steps.length).toBeGreaterThanOrEqual(3);
    expect(taskAdapter.steps[0].title).toContain("Diagnose");
    expect(taskAdapter.steps[1].dependencies).toContain(1);
    expect(taskAdapter.steps[2].title).toContain("Verify");
  });

  it("generates RagIntentAdapter expanding Hindi/Hinglish concepts into canonical English search terms", () => {
    const state = engine.processTurn(
      "session-rag-01",
      "Company me naukri aur vacation policy ke niyam kya hain?"
    );
    const ragAdapter = engine.adaptForAskRAG(state);

    expect(ragAdapter.canonicalEnglishTerms).toContain("job");
    expect(ragAdapter.canonicalEnglishTerms).toContain("policy");
    expect(ragAdapter.canonicalEnglishTerms).toContain("rules");
    expect(ragAdapter.requiresGroundedCitations).toBe(true);
  });

  it("generates ChatIntentAdapter with user profile memory and reasoning style", () => {
    const state = engine.processTurn(
      "session-chat-01",
      "My name is Rajesh, I am a Software Architect from Pune. Explain quicksort in simple terms."
    );
    const chatAdapter = engine.adaptForChat(state);

    expect(chatAdapter.userProfile.name).toBe("Rajesh");
    expect(chatAdapter.userProfile.city).toBe("Pune");
    expect(chatAdapter.userProfile.role).toContain("Software Architect");
    expect(chatAdapter.reasoningStyle).toBe("concise");
  });

  it("verifies all 14 mandatory M-INTENT-02 constraint prompts and conflict detection", () => {
    // 1. Write factorial in Python without recursion.
    const c1 = engine.extractConstraints("Write factorial in Python without recursion.");
    expect(c1.negativeConstraints).toContain("recursion");
    expect(c1.explicitConstraints).toContain("FORMAT_PYTHON");

    // 2. Do not change the original meaning.
    const c2 = engine.extractConstraints("Do not change the original meaning.");
    expect(c2.preservedConstraints).toContain("PRESERVE_SEMANTIC_MEANING");

    // 3. Avoid cars.
    const c3 = engine.extractConstraints("Avoid cars.");
    expect(c3.negativeConstraints).toContain("cars");

    // 4. Keep the same composition.
    const c4 = engine.extractConstraints("Keep the same composition.");
    expect(c4.preservedConstraints).toContain("PRESERVE_STYLE_AND_COMPOSITION");

    // 5. Only change the lighting.
    const c5 = engine.extractConstraints("Only change the lighting.");
    expect(c5.preservedConstraints).toContain("PRESERVE_ALL_EXCEPT_LIGHTING");
    expect(c5.explicitConstraints).toContain("DELTA_LIGHTING_ONLY");

    // 6. Do not modify any other file.
    const c6 = engine.extractConstraints("Do not modify any other file.");
    expect(c6.preservedConstraints).toContain("PRESERVE_UNMODIFIED_FILES");
    expect(c6.negativeConstraints).toContain("modify other files");

    // 7. Explain in Hindi, but keep technical terms in English.
    const c7 = engine.extractConstraints("Explain in Hindi, but keep technical terms in English.");
    expect(c7.explicitConstraints).toContain("EXPLAIN_HINDI");
    expect(c7.explicitConstraints).toContain("TECHNICAL_TERMS_ENGLISH");

    // 8. Make it shorter without removing important information.
    const c8 = engine.extractConstraints("Make it shorter without removing important information.");
    expect(c8.explicitConstraints).toContain("CONCISE_SUMMARY");
    expect(c8.preservedConstraints).toContain("PRESERVE_ESSENTIAL_INFORMATION");

    // 9. Use TypeScript, not JavaScript.
    const c9 = engine.extractConstraints("Use TypeScript, not JavaScript.");
    expect(c9.explicitConstraints).toContain("FORMAT_TYPESCRIPT");
    expect(c9.negativeConstraints).toContain("javascript");
    expect(c9.explicitConstraints).not.toContain("FORMAT_JAVASCRIPT");

    // 10. Do not add dependencies.
    const c10 = engine.extractConstraints("Do not add dependencies.");
    expect(c10.negativeConstraints).toContain("dependencies");

    // 11. Bina recursion ke factorial banao.
    const c11 = engine.extractConstraints("Bina recursion ke factorial banao.");
    expect(c11.negativeConstraints).toContain("recursion");

    // 12. Koi gaadi mat dikhana.
    const c12 = engine.extractConstraints("Koi gaadi mat dikhana.");
    expect(c12.negativeConstraints).toContain("cars");

    // 13. Original meaning change mat karna.
    const c13 = engine.extractConstraints("Original meaning change mat karna.");
    expect(c13.preservedConstraints).toContain("PRESERVE_SEMANTIC_MEANING");

    // 14. Sirf sari ka color red karo, baaki same rakho.
    const c14 = engine.extractConstraints("Sirf sari ka color red karo, baaki same rakho.");
    expect(c14.preservedConstraints).toContain("PRESERVE_ALL_EXCEPT_TARGET");
    expect(c14.explicitConstraints).toContain("TARGET_COLOR_RED");
    expect(c14.explicitConstraints).toContain("TARGET_ELEMENT_SARI");

    // Conflict test: With and without recursion
    const cConflict = engine.extractConstraints("Write factorial in Python with recursion and without recursion.");
    expect(cConflict.conflicts.length).toBeGreaterThan(0);
    expect(cConflict.negativeConstraints).toContain("recursion"); // Negative constraint prioritized
  });
});
