import { describe, expect, it } from "vitest";
import {
  NotFoundError,
  ProviderError,
  QuotaExceededError,
  RateLimitError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
  videoGenerationRequestSchema,
} from "@ai-platform/shared";
import { ReplicateVideoProvider, type ReplicateVideoProviderOptions } from "./index.js";
import { buildMp4 } from "./mp4-fixtures.js";

/**
 * This adapter's whole value is that it survives contact with a genuinely asynchronous API,
 * so these tests pin the lifecycle rather than the happy path alone: the submission's wire
 * shape, polling until the prediction settles, both documented `output` forms, and — the
 * three that cost real money when they are wrong — a caller's cancellation reaching
 * Replicate's cancel endpoint, the deadline doing the same, and a rejected token surfacing as
 * an error an operator can act on instead of a failed scene they will retry forever.
 *
 * The fixtures follow Replicate's documented prediction object (docs/05_IMAGE_GENERATION_RESEARCH.md
 * §2.5): the `id`/`status`/`urls`/`output`/`error` fields this adapter reads, carried alongside
 * the surrounding fields a real response includes, so nothing here depends on a response
 * containing only what the parser wants. No live prediction was captured to produce them — no
 * token was available — and that limitation is stated rather than implied away.
 *
 * Nothing below asserts that a mock was called. Every assertion is either a real HTTP request
 * this adapter actually issued, or the real bytes that reached the `store` callback.
 */

const BASE_URL = "https://api.replicate.com/v1";
const API_TOKEN = "r8_TESTONLY_not_a_real_token";
const MODEL_VERSION = "9f747673945c62801b13b84701c783929c0ee784e4748ec062204894dda1a351";
const PREDICTION_ID = "gm3qorzdhgbfurvjtvhg6dckhu";
const GET_URL = `${BASE_URL}/predictions/${PREDICTION_ID}`;
const CANCEL_URL = `${GET_URL}/cancel`;
const OUTPUT_URL = "https://replicate.delivery/pbxt/f2c1e9d0/out.mp4";
const PROMPT = "a lighthouse beam sweeping across fog at dawn";

/** A real MP4 header structure (see mp4-fixtures.ts) — 1024x576, four seconds at timescale 24. */
const MP4 = buildMp4({ tracks: [{ width: 1024, height: 576 }], durationSeconds: 4, timescale: 24 });

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function predictionBody(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PREDICTION_ID,
    model: "anotherjesse/zeroscope-v2-xl",
    version: MODEL_VERSION,
    input: { prompt: PROMPT, num_frames: 96 },
    logs: "",
    output: null,
    error: null,
    status,
    created_at: "2026-09-11T10:15:03.123456Z",
    started_at: null,
    completed_at: null,
    urls: { cancel: CANCEL_URL, get: GET_URL, stream: `https://stream.replicate.com/v1/files/${PREDICTION_ID}` },
    ...extra,
  };
}

/** Responses consumed in order; the last one repeats, which is what a stuck prediction looks like. */
function sequence(responses: Array<() => Response>): () => Response {
  let index = 0;
  return () => responses[Math.min(index++, responses.length - 1)]();
}

function createFetchStub(routes: {
  submit?: () => Response | Promise<Response>;
  poll?: () => Response | Promise<Response>;
  cancel?: () => Response | Promise<Response>;
  download?: () => Response | Promise<Response>;
}): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      ...(init?.body !== undefined && init.body !== null ? { body: String(init.body) } : {}),
    });

    if (url === `${BASE_URL}/predictions` && method === "POST") {
      return (routes.submit ?? (() => jsonResponse(predictionBody("starting"), 201)))();
    }
    if (url === CANCEL_URL) {
      return (routes.cancel ?? (() => jsonResponse(predictionBody("canceled"))))();
    }
    if (url === GET_URL) {
      return (routes.poll ?? (() => jsonResponse(predictionBody("processing"))))();
    }
    // Any delivery-CDN URL is the output download, whatever extension the prediction named.
    if (url.startsWith("https://replicate.delivery/")) {
      return (routes.download ?? (() => new Response(MP4, { status: 200 })))();
    }
    throw new Error(`the provider issued an unexpected request: ${method} ${url}`);
  };
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

function makeProvider(fetchImpl: typeof fetch, overrides: Partial<ReplicateVideoProviderOptions> = {}) {
  return new ReplicateVideoProvider({
    apiToken: API_TOKEN,
    modelVersion: MODEL_VERSION,
    fetchImpl,
    // Real sleeps, real elapsed-time arithmetic — just small enough that the suite is not
    // waiting on a poll interval sized for a real GPU cold start.
    pollIntervalMs: 1,
    maxPollIntervalMs: 2,
    ...overrides,
  });
}

function collectStore() {
  const stored: Array<{ bytes: Buffer; mimeType: string; ext: string }> = [];
  const store = async (bytes: Buffer, mimeType: string, ext: string) => {
    stored.push({ bytes, mimeType, ext });
    return `asset-${stored.length}`;
  };
  return { stored, store };
}

function request(overrides: Record<string, unknown> = {}) {
  return videoGenerationRequestSchema.parse({ prompt: PROMPT, sceneIndex: 3, durationSeconds: 4, ...overrides });
}

describe("ReplicateVideoProvider", () => {
  it("submits, polls until the prediction succeeds, and hands the downloaded bytes to store", async () => {
    const { fetchImpl, calls } = createFetchStub({
      poll: sequence([
        () => jsonResponse(predictionBody("processing", { started_at: "2026-09-11T10:15:09.001Z" })),
        () =>
          jsonResponse(
            predictionBody("succeeded", {
              output: OUTPUT_URL,
              completed_at: "2026-09-11T10:15:31.552Z",
              metrics: { predict_time: 21.4 },
            })
          ),
      ]),
    });
    const provider = makeProvider(fetchImpl);
    const { stored, store } = collectStore();

    const result = await provider.generateVideo(request({ seed: 7 }), store);

    expect(result.status).toBe("succeeded");
    // The deliverable is the bytes, not the URL: what `store` received is the actual video.
    expect(stored).toHaveLength(1);
    expect(stored[0].bytes.equals(MP4)).toBe(true);
    expect(stored[0]).toMatchObject({ mimeType: "video/mp4", ext: "mp4" });
    // Dimensions and duration are read out of those bytes, not echoed from the request.
    expect(result.video).toMatchObject({ assetId: "asset-1", width: 1024, height: 576, durationSeconds: 4, seed: 7 });
    expect(result.providerMeta).toMatchObject({
      predictionId: PREDICTION_ID,
      dimensionsProbed: true,
      durationProbed: true,
      predictTimeSeconds: 21.4,
    });

    const submit = calls[0];
    expect(submit.url).toBe(`${BASE_URL}/predictions`);
    expect(submit.method).toBe("POST");
    expect(submit.headers.Authorization).toBe(`Bearer ${API_TOKEN}`);
    // 4 seconds at the default 24fps — the API takes frames, never seconds.
    expect(JSON.parse(String(submit.body))).toEqual({
      version: MODEL_VERSION,
      input: { prompt: PROMPT, num_frames: 96, seed: 7 },
    });

    // It really polled: twice, because the first poll was not terminal.
    expect(calls.filter((call) => call.url === GET_URL && call.method === "GET")).toHaveLength(2);

    const download = calls[calls.length - 1];
    expect(download.url).toBe(OUTPUT_URL);
    // The account token must not follow the output to the delivery CDN, which is a different
    // host from the API and has no business seeing the credential.
    expect(download.headers.Authorization).toBeUndefined();
  });

  it("accepts the array form of `output`, which models emitting several artefacts return", async () => {
    const { fetchImpl } = createFetchStub({
      poll: () => jsonResponse(predictionBody("succeeded", { output: [OUTPUT_URL, "https://replicate.delivery/pbxt/f2c1e9d0/preview.gif"] })),
    });
    const { stored, store } = collectStore();

    const result = await makeProvider(fetchImpl).generateVideo(request(), store);

    expect(result.status).toBe("succeeded");
    expect(stored[0].bytes.equals(MP4)).toBe(true);
    expect(result.providerMeta).toMatchObject({ outputUrl: OUTPUT_URL });
  });

  it("omits `seed` entirely when the caller did not ask for one", async () => {
    const { fetchImpl, calls } = createFetchStub({
      poll: () => jsonResponse(predictionBody("succeeded", { output: OUTPUT_URL })),
    });
    const { store } = collectStore();

    await makeProvider(fetchImpl).generateVideo(request(), store);

    // Not `seed: null` — that is a value a model's input schema can reject outright.
    expect(JSON.parse(String(calls[0].body)).input).toEqual({ prompt: PROMPT, num_frames: 96 });
  });

  it("reports a failed prediction with Replicate's own message, and stores nothing", async () => {
    const modelError = "CUDA out of memory. Tried to allocate 2.44 GiB (GPU 0; 23.68 GiB total capacity)";
    const { fetchImpl } = createFetchStub({
      poll: () => jsonResponse(predictionBody("failed", { error: modelError, completed_at: "2026-09-11T10:15:22.101Z" })),
    });
    const { stored, store } = collectStore();

    const result = await makeProvider(fetchImpl).generateVideo(request(), store);

    expect(result.status).toBe("failed");
    // Verbatim: it is the only description of what the model actually objected to.
    expect(result.error).toBe(modelError);
    expect(result.providerName).toBe("replicate");
    expect(result.providerMeta).toMatchObject({ predictionId: PREDICTION_ID, status: "failed" });
    expect(stored).toEqual([]);
  });

  it("raises a real authentication error for a rejected token, not a failed generation", async () => {
    const { fetchImpl } = createFetchStub({
      submit: () => jsonResponse({ detail: "Invalid token." }, 401),
    });
    const { stored, store } = collectStore();
    const provider = makeProvider(fetchImpl);

    // Thrown, not returned: a bad token is an operator's problem, and a scene worker that saw
    // `status: "failed"` would retry it forever against a credential that will never work.
    await expect(provider.generateVideo(request(), store)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(provider.generateVideo(request(), store)).rejects.toThrow(/VIDEO_API_TOKEN/);
    expect(stored).toEqual([]);
  });

  it("maps each provider-side status to the typed error that describes what to do about it", async () => {
    type ErrorClass = new (message: string) => Error;
    const cases: Array<{ status: number; body: unknown; error: ErrorClass; matches: RegExp }> = [
      { status: 402, body: { detail: "Insufficient credit." }, error: QuotaExceededError, matches: /credit|spend limit/i },
      { status: 429, body: { detail: "Request was throttled." }, error: RateLimitError, matches: /rate-limited/i },
      { status: 404, body: { detail: "The specified version does not exist." }, error: NotFoundError, matches: /VIDEO_MODEL_VERSION/ },
      { status: 422, body: { detail: "Invalid input: num_frames" }, error: ValidationError, matches: /422/ },
      { status: 503, body: { detail: "Service unavailable" }, error: ServiceUnavailableError, matches: /retryable/i },
    ];

    for (const testCase of cases) {
      const { fetchImpl } = createFetchStub({ submit: () => jsonResponse(testCase.body, testCase.status) });
      const provider = makeProvider(fetchImpl);
      const { store } = collectStore();

      await expect(provider.generateVideo(request(), store)).rejects.toBeInstanceOf(testCase.error);
      await expect(provider.generateVideo(request(), store)).rejects.toThrow(testCase.matches);
    }
  });

  it("reports an unreachable Replicate as a retryable service error naming the URL", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const { store } = collectStore();

    await expect(makeProvider(fetchImpl).generateVideo(request(), store)).rejects.toBeInstanceOf(
      ServiceUnavailableError
    );
    await expect(makeProvider(fetchImpl).generateVideo(request(), store)).rejects.toThrow(
      /Could not reach Replicate at https:\/\/api\.replicate\.com\/v1\/predictions/
    );
  });

  it("calls Replicate's cancel endpoint when the caller aborts — stopping the poll is not enough", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = createFetchStub({
      // Aborts while the prediction is still running, which is the only case that matters:
      // a prediction left running occupies a GPU and bills by the second.
      poll: () => {
        controller.abort();
        return jsonResponse(predictionBody("processing"));
      },
    });
    const { stored, store } = collectStore();

    const result = await makeProvider(fetchImpl).generateVideo(request(), store, controller.signal);

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/canceled by its caller/);
    const cancels = calls.filter((call) => call.url === CANCEL_URL);
    expect(cancels).toHaveLength(1);
    expect(cancels[0].method).toBe("POST");
    // The cancel is authenticated and is NOT sent on the caller's already-aborted signal —
    // if it were, the request that stops the billing would abort before it left.
    expect(cancels[0].headers.Authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(result.providerMeta).toMatchObject({ predictionId: PREDICTION_ID, predictionStopped: true });
    expect(stored).toEqual([]);
  });

  it("says so honestly when the cancel request itself fails, because the prediction may still be billing", async () => {
    const controller = new AbortController();
    const { fetchImpl } = createFetchStub({
      poll: () => {
        controller.abort();
        return jsonResponse(predictionBody("processing"));
      },
      cancel: () => jsonResponse({ detail: "Service unavailable" }, 503),
    });
    const { store } = collectStore();

    const result = await makeProvider(fetchImpl).generateVideo(request(), store, controller.signal);

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/may still be running and billing/);
    // The caller is told plainly that something may still be on the clock, not just "canceled".
    expect(result.providerMeta).toMatchObject({ predictionStopped: false });
  });

  it("never submits at all when the caller's signal is already aborted", async () => {
    const { fetchImpl, calls } = createFetchStub({});
    const { store } = collectStore();

    const result = await makeProvider(fetchImpl).generateVideo(request(), store, AbortSignal.abort());

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/before it was submitted/);
    expect(calls).toEqual([]);
  });

  it("stops at the overall deadline and cancels the prediction rather than polling forever", async () => {
    const { fetchImpl, calls } = createFetchStub({
      // Never leaves `processing` — a model stuck on a cold start, or a genuinely hung job.
      poll: () => jsonResponse(predictionBody("processing")),
    });
    const provider = makeProvider(fetchImpl, { deadlineMs: 60, pollIntervalMs: 5, maxPollIntervalMs: 10 });
    const { stored, store } = collectStore();

    const result = await provider.generateVideo(request(), store);

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/deadline/);
    expect(calls.some((call) => call.url === CANCEL_URL && call.method === "POST")).toBe(true);
    expect(calls.filter((call) => call.url === GET_URL).length).toBeGreaterThanOrEqual(1);
    expect(stored).toEqual([]);
  });

  it("treats a success carrying no output as a failure, never as a stored clip", async () => {
    const { fetchImpl } = createFetchStub({
      poll: () => jsonResponse(predictionBody("succeeded", { output: null })),
    });
    const { stored, store } = collectStore();

    await expect(makeProvider(fetchImpl).generateVideo(request(), store)).rejects.toThrow(/no output URL/);
    expect(stored).toEqual([]);
  });

  it("reports a prediction canceled elsewhere as canceled, not as a mysterious empty success", async () => {
    const { fetchImpl } = createFetchStub({
      poll: () => jsonResponse(predictionBody("canceled")),
    });
    const { store } = collectStore();

    const result = await makeProvider(fetchImpl).generateVideo(request(), store);

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/canceled by Replicate or another client/);
  });

  it("stores a WebM output as a WebM — the extension and the media type are decided together", async () => {
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]);
    const { fetchImpl } = createFetchStub({
      poll: () =>
        jsonResponse(predictionBody("succeeded", { output: "https://replicate.delivery/pbxt/f2c1e9d0/out.webm" })),
      download: () => new Response(webm, { status: 200, headers: { "Content-Type": "video/webm" } }),
    });
    const { stored, store } = collectStore();

    const result = await makeProvider(fetchImpl).generateVideo(request(), store);

    expect(result.status).toBe("succeeded");
    // `GET /api/v1/assets/:id` serves this pair; a mismatch is a video a browser will not play.
    expect(stored[0]).toMatchObject({ mimeType: "video/webm", ext: "webm" });
  });

  it("refuses to guess the container when neither the URL nor the response declares one", async () => {
    const { fetchImpl } = createFetchStub({
      poll: () =>
        jsonResponse(predictionBody("succeeded", { output: "https://replicate.delivery/pbxt/f2c1e9d0/output" })),
      download: () => new Response(MP4, { status: 200, headers: { "Content-Type": "application/octet-stream" } }),
    });
    const { stored, store } = collectStore();

    // Storing it as `.mp4` on a hunch would surface much later, as a file the assets route
    // serves with the wrong Content-Type — a failure far from its cause.
    await expect(makeProvider(fetchImpl).generateVideo(request(), store)).rejects.toThrow(/media type/i);
    expect(stored).toEqual([]);
  });

  it("reports honest zeroes rather than invented dimensions when the container cannot be probed", async () => {
    const notAnMp4 = Buffer.from("a delivery URL that ends in .mp4 but is not one");
    const { fetchImpl } = createFetchStub({
      poll: () => jsonResponse(predictionBody("succeeded", { output: OUTPUT_URL })),
      download: () => new Response(notAnMp4, { status: 200 }),
    });
    const { stored, store } = collectStore();

    const result = await makeProvider(fetchImpl).generateVideo(request(), store);

    expect(result.status).toBe("succeeded");
    expect(stored[0].bytes.equals(notAnMp4)).toBe(true);
    // Zero means "not measured" and `dimensionsProbed: false` says so out loud; a guessed
    // 1280x720 would read as a fact.
    expect(result.video).toMatchObject({ width: 0, height: 0 });
    expect(result.providerMeta).toMatchObject({ dimensionsProbed: false, durationProbed: false });
    // The duration falls back to what was requested, and is labelled as unprobed.
    expect(result.video?.durationSeconds).toBe(4);
  });

  it("refuses a duration above its declared ceiling without spending a request on it", async () => {
    const { fetchImpl, calls } = createFetchStub({});
    const provider = makeProvider(fetchImpl);
    const { store } = collectStore();

    const result = await provider.generateVideo(
      request({ durationSeconds: provider.getCapabilities().maxDurationSeconds + 5 }),
      store
    );

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/exceeds/);
    expect(calls).toEqual([]);
  });

  it("refuses to be constructed without the credentials it needs — there is no no-op provider", () => {
    expect(() => new ReplicateVideoProvider({ apiToken: "", modelVersion: MODEL_VERSION })).toThrow(ValidationError);
    expect(() => new ReplicateVideoProvider({ apiToken: "   ", modelVersion: MODEL_VERSION })).toThrow(
      /VIDEO_API_TOKEN/
    );
    expect(() => new ReplicateVideoProvider({ apiToken: API_TOKEN, modelVersion: "" })).toThrow(
      /VIDEO_MODEL_VERSION/
    );
  });

  it("is not a mock, and declares limits inside the range real providers actually have", () => {
    const provider = new ReplicateVideoProvider({ apiToken: API_TOKEN, modelVersion: MODEL_VERSION });

    expect(provider.isMock).toBe(false);
    expect(provider.name).toBe("replicate");
    const caps = provider.getCapabilities();
    // docs/06: every surveyed per-call ceiling sits between 5 and 25 seconds.
    expect(caps.maxDurationSeconds).toBeGreaterThanOrEqual(5);
    expect(caps.maxDurationSeconds).toBeLessThanOrEqual(25);
    expect(caps.supportsSeed).toBe(true);
    // Replicate has no per-call speed tier; claiming one would have the router pick an option
    // that does not exist.
    expect(caps.hasFastTier).toBe(false);
  });

  it("surfaces a non-JSON response as a provider error instead of crashing on the parse", async () => {
    const { fetchImpl } = createFetchStub({
      submit: () => new Response("<html>502 Bad Gateway</html>", { status: 200 }),
    });
    const { store } = collectStore();

    await expect(makeProvider(fetchImpl).generateVideo(request(), store)).rejects.toBeInstanceOf(ProviderError);
  });
});
