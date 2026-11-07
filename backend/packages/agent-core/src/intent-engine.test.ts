import { describe, expect, it } from "vitest";
import { ConversationalIntentEngine } from "./intent-engine.js";

describe("ConversationalIntentEngine in agent-core", () => {
  const engine = new ConversationalIntentEngine();

  it("detects language modality across English, Devanagari Hindi, and Hinglish", () => {
    expect(engine.detectLanguage("A red apple on a wooden table")).toBe("english");
    expect(
      engine.detectLanguage("एक ग्रामीण भारतीय गांव का यथार्थवादी दृश्य")
    ).toBe("hindi_devanagari");
    expect(
      engine.detectLanguage("Ek village ki realistic photo banao jisme kisan khet me hai")
    ).toBe("hinglish");
  });

  it("classifies task intents accurately", () => {
    expect(engine.classifyIntent("Ek sundar titli ki image banao")).toBe("IMAGE_GENERATION");
    expect(engine.classifyIntent("Debug and fix failing unit test")).toBe("CODING_TASK");
    expect(engine.classifyIntent("Create a 2-minute video trailer")).toBe("VIDEO_GENERATION");
    expect(engine.classifyIntent("Synthesize narration audio for this text")).toBe("AUDIO_SYNTHESIS");
    expect(engine.classifyIntent("Explain quicksort in simple terms")).toBe("CHAT_REASONING");
  });

  it("parses negative constraints and semantic preservation markers", () => {
    const { negativeConstraints, preservedConstraints } = engine.extractConstraints(
      "Draw an old temple without cars, avoid modern electricity poles, and original meaning change mat karna"
    );
    expect(negativeConstraints.some((c) => c.includes("cars"))).toBe(true);
    expect(negativeConstraints.some((c) => c.includes("modern electricity poles"))).toBe(true);
    expect(preservedConstraints).toContain("PRESERVE_SEMANTIC_MEANING");
  });

  it("preserves context and applies delta modifications in multi-turn interactions", () => {
    const sessionId = "unit-test-session-village";

    // Turn 1
    const turn1 = engine.processTurn(
      sessionId,
      "Ek village ki realistic image banao, old man aur woman khana bana rahe hain aur bachche kha rahe hain."
    );
    expect(turn1.isRevision).toBe(false);
    expect(turn1.detectedLanguage).toBe("hinglish");
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
});
