import { describe, expect, it } from "vitest";
import { parseScriptJson } from "./video-script.js";

/**
 * docs/26_DECISIONS.md ADR-080 — the script stage's fitting of a model's storyboard to the
 * scene count the REQUEST determined.
 *
 * The padding path is the one that carried a silent bug: it promised to cycle the scenes the
 * model wrote and instead repeated the first one, so a short reply produced a video that opened
 * with the same shot over and over. No exception, no log line — only a worse video. These assert
 * the exact identities of the padded slots, because "the right number of scenes came back" is
 * what the broken version did too.
 */
describe("parseScriptJson: fitting a short storyboard to the requested scene count", () => {
  function reply(scenes: Array<{ shotDescription: string; narration: string }>): { text: string; model: string } {
    return { text: JSON.stringify({ title: "A Title", scenes }), model: "test-model" };
  }

  it("cycles the scenes the model wrote instead of repeating the first one", () => {
    const parsed = parseScriptJson(
      reply([
        { shotDescription: "a valley at sunrise", narration: "The valley wakes." },
        { shotDescription: "the river below", narration: "The river runs." },
      ]),
      5
    );

    expect(parsed).not.toBeNull();
    expect(parsed!.scenes.map((s) => s.shotDescription)).toEqual([
      "a valley at sunrise",
      "the river below",
      "a valley at sunrise",
      "the river below",
      "a valley at sunrise",
    ]);
    // Narration has to travel with the shot it belongs to: a padded slot carrying scene 0's
    // picture under scene 1's line would be worse than either.
    expect(parsed!.scenes.map((s) => s.narration)).toEqual([
      "The valley wakes.",
      "The river runs.",
      "The valley wakes.",
      "The river runs.",
      "The valley wakes.",
    ]);
  });

  it("copies padded scenes rather than aliasing them, so an edit to one cannot bleed into another", () => {
    const parsed = parseScriptJson(reply([{ shotDescription: "one shot", narration: "One line." }]), 3);

    expect(parsed!.scenes).toHaveLength(3);
    parsed!.scenes[0].shotDescription = "mutated";
    expect(parsed!.scenes[1].shotDescription).toBe("one shot");
    expect(parsed!.scenes[2].shotDescription).toBe("one shot");
  });

  it("cycles a three-scene reply across seven slots", () => {
    const parsed = parseScriptJson(
      reply([
        { shotDescription: "A", narration: "a" },
        { shotDescription: "B", narration: "b" },
        { shotDescription: "C", narration: "c" },
      ]),
      7
    );

    expect(parsed!.scenes.map((s) => s.shotDescription)).toEqual(["A", "B", "C", "A", "B", "C", "A"]);
  });

  it("truncates a long storyboard to the requested count, keeping the leading scenes", () => {
    const parsed = parseScriptJson(
      reply([
        { shotDescription: "A", narration: "a" },
        { shotDescription: "B", narration: "b" },
        { shotDescription: "C", narration: "c" },
      ]),
      2
    );

    expect(parsed!.scenes.map((s) => s.shotDescription)).toEqual(["A", "B"]);
  });
});
