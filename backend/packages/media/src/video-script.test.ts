import { describe, expect, it } from "vitest";
import { parseScriptJson, writeVideoScript, type ScriptModel } from "./video-script.js";

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

/**
 * How much the model really wrote, and a stage that cannot hang — docs/26_DECISIONS.md ADR-137.
 *
 * Two defects in the same stage. The padding count was computed, used for the modulus and thrown
 * away, while `writeVideoScript` reported `scriptSource: "model"` unconditionally — so a reply
 * describing two shots for a five-scene video was persisted and displayed as a five-shot authored
 * storyboard. Padding by cycling real shots is sensible; claiming a model wrote the copies is not.
 *
 * And the call had no deadline of any kind. `ScriptModel` declared no way to cancel, so the
 * measured 74.6 seconds for a five-scene brief had no upper bound above it: a wedged provider held
 * `POST /api/v1/videos` open indefinitely.
 */
describe("the script stage reports what it wrote, and gives up in time", () => {
  const request = { prompt: "a harbour at dawn", targetDurationSeconds: 20, sceneClipSeconds: 4 };

  const modelReturning = (text: string): ScriptModel => ({
    async *streamChat() {
      yield {
        type: "done",
        message: { role: "assistant", content: text },
        usage: { inputTokens: 1, outputTokens: 1 },
        provider: "test",
        model: "test-model",
        finishReason: "stop",
      } as never;
    },
  });

  it("reports the count the model wrote when the storyboard was padded", async () => {
    // Two shots for a five-scene video: the other three are copies.
    const script = await writeVideoScript(
      {
        model: modelReturning(
          JSON.stringify({
            title: "Harbour",
            scenes: [
              { shotDescription: "A wide shot of the harbour", narration: "Dawn." },
              { shotDescription: "A boat's rope", narration: "Ropes creak." },
            ],
          })
        ),
      },
      request
    );

    expect(script.scriptSource).toBe("model");
    expect(script.scenes).toHaveLength(5);
    // The load-bearing number: two, not five.
    expect(script.scenesWritten).toBe(2);
  });

  it("reports a complete storyboard as complete", async () => {
    const scenes = Array.from({ length: 5 }, (_unused, i) => ({
      shotDescription: `Shot ${i + 1}`,
      narration: `Line ${i + 1}`,
    }));
    const script = await writeVideoScript({ model: modelReturning(JSON.stringify({ title: "T", scenes })) }, request);
    expect(script.scenesWritten).toBe(5);
    expect(script.scenes).toHaveLength(5);
  });

  it("reports zero when nothing was authored at all", async () => {
    const script = await writeVideoScript({}, request);
    expect(script.scriptSource).toBe("deterministic");
    expect(script.scenesWritten).toBe(0);
  });

  it("gives up on a model that never answers, and says that is why", async () => {
    // A provider that hangs. Before the deadline this held the HTTP request open with no bound.
    const hanging: ScriptModel = {
      async *streamChat(_request, options) {
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
        yield undefined as never;
      },
    };

    const started = Date.now();
    const script = await writeVideoScript({ model: hanging, timeoutMs: 300 }, request);
    const elapsed = Date.now() - started;

    // It fell back rather than throwing: a slow model costs a mechanical storyboard, not a 500.
    expect(script.scriptSource).toBe("deterministic");
    expect(script.fallbackReason).toMatch(/deadline/i);
    expect(script.scenes).toHaveLength(5);
    // And it really stopped waiting.
    expect(elapsed).toBeLessThan(15_000);
  });

  it("passes a signal the model can actually observe", async () => {
    // The interface used to declare no options at all, so no deadline could reach the router.
    let sawSignal = false;
    const observing: ScriptModel = {
      async *streamChat(_request, options) {
        sawSignal = options?.signal instanceof AbortSignal;
        yield {
          type: "done",
          message: { role: "assistant", content: '{"title":"T","scenes":[{"shotDescription":"S","narration":"N"}]}' },
          usage: { inputTokens: 1, outputTokens: 1 },
          provider: "test",
          model: "test-model",
          finishReason: "stop",
        } as never;
      },
    };
    await writeVideoScript({ model: observing }, request);
    expect(sawSignal).toBe(true);
  });
});
