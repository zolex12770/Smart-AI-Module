import { describe, expect, it } from "vitest";
import { describeFailureForCaller } from "./failure-message.js";

/**
 * What a tenant is told when a provider or a binary fails — docs/26_DECISIONS.md ADR-155.
 *
 * ADR-119 established the rule for the RAG route and the media workers never got it: they
 * persisted `err.message` verbatim into a column their own `GET` routes serve straight back.
 * The messages the adapters build are not a tenant's business — `image-openai` names the
 * configured endpoint, `image-sdcpp` returns 400 bytes of stable-diffusion.cpp's stderr (which
 * carries the absolute model path on the host) and Node's spawn error names the binary's path,
 * and `runFfmpeg` does the same for the render.
 *
 * The cases below are the real strings those adapters produce.
 */
describe("a stored failure reason does not carry the deployment's internals", () => {
  const leaky = [
    "Could not reach the image provider at http://10.0.4.7:8080/v1: fetch failed",
    "stable-diffusion.cpp exited with code 1: failed to load model from C:\\\\srv\\\\models\\\\sd-turbo-q8.gguf",
    "stable-diffusion.cpp could not be started: spawn C:\\\\tools\\\\sd\\\\sd.exe ENOENT",
    "ffmpeg exited with code 1: /srv/assets/p-9f31/scene-2.mp4: No such file or directory",
    "connect ECONNREFUSED 127.0.0.1:11434",
  ];

  it("replaces a provider's own message with a stage sentence", () => {
    for (const raw of leaky) {
      const out = describeFailureForCaller("image", new Error(raw));
      expect(out, raw).not.toContain("http://");
      expect(out, raw).not.toMatch(/[A-Za-z]:\\\\|\/srv\/|ENOENT|ECONNREFUSED/);
      expect(out).toMatch(/failed/i);
    }
  });

  it("names the stage, so two failures are not the same sentence", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:11434");
    expect(describeFailureForCaller("image", err)).toMatch(/image/i);
    expect(describeFailureForCaller("speech", err)).toMatch(/speech/i);
    expect(describeFailureForCaller("video", err)).toMatch(/video generation/i);
    expect(describeFailureForCaller("render", err)).toMatch(/rendering/i);
  });

  it("keeps a message the CALLER can act on", () => {
    // A quota refusal, a cancellation and an unsupported input describe the request rather than
    // the deployment — replacing those with "it failed" would make the platform less honest,
    // not more careful.
    expect(describeFailureForCaller("image", new Error("Daily image limit of 50 reached."))).toMatch(
      /Daily image limit of 50/
    );
    expect(describeFailureForCaller("speech", new Error("Cancelled before synthesis started."))).toMatch(
      /Cancelled/
    );
    expect(
      describeFailureForCaller(
        "ingest",
        new Error("Document produced zero chunks (empty file, or a scanned/image-only PDF …)")
      )
    ).toMatch(/zero chunks/);
  });

  it("bounds even the messages it keeps", () => {
    const long = `Daily image limit of 50 reached. ${"x".repeat(5_000)}`;
    expect(describeFailureForCaller("image", new Error(long)).length).toBeLessThanOrEqual(300);
  });
});
