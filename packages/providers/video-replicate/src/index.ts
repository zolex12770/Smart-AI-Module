import {
  AppError,
  NotFoundError,
  PermissionError,
  ProviderError,
  QuotaExceededError,
  RateLimitError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
  type VideoGenerationRequest,
  type VideoProvider,
  type VideoProviderCapabilities,
  type VideoResult,
} from "@ai-platform/shared";
import { probeMp4 } from "./mp4-probe.js";

/**
 * Real video generation over Replicate's prediction API — the first `VideoProvider` on this
 * platform that is not a mock.
 *
 * **Why Replicate, given ADR-065 said no.** ADR-065 declined to ship a video adapter because
 * there is no cross-vendor wire format for video the way `/v1/images/generations` is one for
 * images, and binding the platform to a single vendor's shape would have bought one model.
 * Replicate is the exception that argument was waiting for: it is *itself* a provider-neutral
 * layer (docs/05_IMAGE_GENERATION_RESEARCH.md §2.5 — "one API shape fronts hundreds of
 * different image and video models"), so one adapter against `predictions` reaches every
 * video model hosted there, and swapping models is a config change rather than a new package.
 * The `VideoProvider` interface stays the seam, and the mock stays the zero-configuration
 * development default.
 *
 * **Why the polling machinery is not optional.** Every provider surveyed in
 * docs/06_VIDEO_GENERATION_RESEARCH.md is job-based — there is no synchronous
 * video-generation API anywhere — and Replicate adds cold starts of 10–60s on top of
 * generation time (docs/05 §2.5). So a call here is: submit, poll on a backing-off but
 * bounded interval, and stop at a hard deadline. Three consequences are designed in rather
 * than bolted on:
 *
 * 1. **Cancellation reaches the provider.** docs/07 §1.2 is explicit that cancellation "must
 *    propagate to the provider's own cancel endpoint where one exists". A poll loop that just
 *    stops leaves a prediction running on a GPU that is still being billed by the second, and
 *    the caller has no handle left to stop it. Abort and deadline both POST the cancel URL.
 * 2. **The deadline is wall-clock, not a poll count.** A cold model plus a retried poll can
 *    stretch a "20 poll" budget across an unbounded span; only a real elapsed-time ceiling
 *    bounds what a runaway prediction can cost.
 * 3. **The bytes are stored, never the URL.** Replicate's `output` is a delivery URL that
 *    expires; handing that back as an `assetId` would produce a video project whose scenes
 *    silently 404 later. This downloads the clip and hands the bytes to `store`, exactly as
 *    the mock provider does.
 *
 * **Error mapping.** Two different kinds of bad news get two different shapes, deliberately.
 * A prediction that ran and failed — the model rejected the prompt, ran out of memory — is a
 * per-scene *outcome*: it returns `status: "failed"` carrying Replicate's own message, and
 * the scene worker records it and retries. A deployment-level problem — a rejected token, an
 * exhausted account, Replicate being down — is not an outcome, it is a condition an operator
 * has to act on, so it throws the matching typed error from `@ai-platform/shared` and keeps
 * the distinction (401 vs 429 vs 503) that a string in `VideoResult.error` would erase.
 *
 * **Honest verification status:** unit-tested against fixtures in the documented response
 * shapes (`starting` → `processing` → `succeeded`, both `output` forms, `failed`, the auth
 * and cancel paths). No real Replicate token was available in the environment that wrote
 * this, so a real end-to-end generation is unverified — the same status every other hosted
 * adapter here carries (ADR-023/ADR-024), stated rather than implied away.
 */

const DEFAULT_BASE_URL = "https://api.replicate.com/v1";

/**
 * docs/06: every real per-call ceiling in the survey sits between 5 and 25 seconds. Replicate
 * hosts models from across that range and below it, so this is an option rather than a
 * constant — but it defaults conservatively, because the failure mode of guessing high is a
 * request the model truncates without saying so.
 */
const DEFAULT_MAX_DURATION_SECONDS = 10;

/**
 * Replicate video models take `num_frames`, not seconds — the clip's length is frames divided
 * by the frame rate the model renders at, which is the model's property and not something the
 * API reports. 24 is the common default across the hosted text-to-video models; a deployment
 * whose model differs sets `framesPerSecond`, because getting this wrong does not error, it
 * silently produces a clip of the wrong length.
 */
const DEFAULT_FRAMES_PER_SECOND = 24;

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 15_000;
/** Backing off keeps a warm model responsive while a cold one does not cost hundreds of polls. */
const POLL_BACKOFF_FACTOR = 1.5;
/**
 * docs/05 §2.5: a cold start alone can be 10–60s, and generation is several multiples of the
 * clip's own length (docs/06 §2.2). Ten minutes is generous for one short clip and still a hard
 * stop on what a stuck prediction can bill. It is also deliberately *below* the
 * `video.generate_scene` queue's `expireInSeconds` in apps/api: a provider that gave up after
 * the queue had already re-claimed the job would leave two workers polling one prediction.
 */
const DEFAULT_DEADLINE_MS = 10 * 60_000;
/** Per-HTTP-request, not per-generation: a single poll that hangs must not eat the deadline. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The containers Replicate's video models actually deliver. Extension and media type are kept
 * as one table so a stored asset's `Content-Type` can never disagree with its file extension —
 * the pair is what `GET /api/v1/assets/:id` serves and what a browser uses to decide whether
 * it can play the file at all.
 */
const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  gif: "image/gif",
};

export interface ReplicateVideoProviderOptions {
  /** `VIDEO_API_TOKEN`. Construction fails without it — see the constructor. */
  apiToken: string;
  /**
   * The exact model *version* hash Replicate's `predictions` endpoint takes (`VIDEO_MODEL_VERSION`).
   * A version, not a model name, because Replicate pins reproducibility to the version: the
   * same name re-published tomorrow is a different model with different inputs.
   */
  modelVersion: string;
  baseUrl?: string;
  name?: string;
  /** See `DEFAULT_FRAMES_PER_SECOND` — a property of the configured model, not of Replicate. */
  framesPerSecond?: number;
  /** See `DEFAULT_MAX_DURATION_SECONDS` — likewise per model (docs/06's 5–25s range). */
  maxDurationSeconds?: number;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  /** Hard wall-clock ceiling on one `generateVideo` call, cancel included. */
  deadlineMs?: number;
  requestTimeoutMs?: number;
  /** Injectable for tests — defaults to global fetch. See docs/21_TESTING_STRATEGY.md. */
  fetchImpl?: typeof fetch;
}

/** The prediction object, as `POST /v1/predictions` and `GET /v1/predictions/{id}` return it. */
interface ReplicatePrediction {
  id?: string;
  status?: string;
  /** A single URL, or a list of them for models that emit more than one artefact. */
  output?: string | string[] | null;
  error?: string | null;
  urls?: { get?: string; cancel?: string };
  metrics?: { predict_time?: number };
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled"]);

export class ReplicateVideoProvider implements VideoProvider {
  readonly name: string;
  readonly isMock = false;

  private readonly apiToken: string;
  private readonly modelVersion: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly framesPerSecond: number;
  private readonly maxDurationSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly maxPollIntervalMs: number;
  private readonly deadlineMs: number;
  private readonly requestTimeoutMs: number;

  /**
   * Refuses to exist without a token and a model version. There is deliberately no
   * "unconfigured" `ReplicateVideoProvider`: a provider that constructs and then reports every
   * generation as failed is a capability the platform would advertise as present
   * (`videoGenerationAvailable === true`) and never deliver, which is the exact failure
   * ADR-045 forbids. Unconfigured is expressed by not constructing one — apps/api then reports
   * the real `CapabilityUnavailableError`. These throw at construction, so a half-configured
   * deployment fails on boot with the variable named, not on a user's first request.
   */
  constructor(options: ReplicateVideoProviderOptions) {
    if (!options.apiToken || !options.apiToken.trim()) {
      throw new ValidationError(
        "ReplicateVideoProvider requires an API token (VIDEO_API_TOKEN). Video generation stays unavailable rather than running without one."
      );
    }
    if (!options.modelVersion || !options.modelVersion.trim()) {
      throw new ValidationError(
        "ReplicateVideoProvider requires a model version id (VIDEO_MODEL_VERSION) — Replicate's predictions endpoint pins a version hash, not a model name."
      );
    }
    this.name = options.name ?? "replicate";
    this.apiToken = options.apiToken.trim();
    this.modelVersion = options.modelVersion.trim();
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.framesPerSecond = options.framesPerSecond ?? DEFAULT_FRAMES_PER_SECOND;
    this.maxDurationSeconds = options.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPollIntervalMs = options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  getCapabilities(): VideoProviderCapabilities {
    return {
      maxDurationSeconds: this.maxDurationSeconds,
      // Replicate passes `seed` through to the model's own input schema, and the hosted
      // text-to-video models accept it; this is the one capability that is genuinely uniform
      // across the aggregator.
      supportsSeed: true,
      // No fast tier, and claiming one would matter: Replicate has no per-call speed/quality
      // switch — the hardware a model runs on is fixed by whoever published it. A router that
      // believed otherwise would keep selecting an option that does not exist.
      hasFastTier: false,
    };
  }

  /**
   * `signal` is an optional third parameter, which keeps this assignable to `VideoProvider`
   * while letting a caller that *has* a cancellation token stop a prediction that is still
   * billing. The interface does not carry one because the mock never needed it; widening the
   * shared interface would force every implementation to accept a parameter only real
   * asynchronous providers can honour.
   */
  async generateVideo(
    req: VideoGenerationRequest,
    store: (bytes: Buffer, mimeType: string, ext: string) => Promise<string>,
    signal?: AbortSignal
  ): Promise<VideoResult> {
    if (req.durationSeconds > this.maxDurationSeconds) {
      // Refused here rather than sent: a model asked for more frames than it supports does not
      // error, it returns a shorter clip, and the scene would be silently wrong (docs/06).
      return {
        status: "failed",
        error: `Requested duration ${req.durationSeconds}s exceeds this provider's ${this.maxDurationSeconds}s per-call ceiling (docs/06).`,
        providerName: this.name,
      };
    }
    if (signal?.aborted) {
      // Nothing was submitted, so there is nothing to cancel and nothing to bill.
      return this.canceledResult(null, "before it was submitted", null);
    }

    // Started before the submission, not after it: the deadline bounds the whole call, and a
    // submission that itself takes a minute has spent a minute of the caller's patience.
    const deadlineAt = Date.now() + this.deadlineMs;
    const numFrames = Math.max(1, Math.round(req.durationSeconds * this.framesPerSecond));
    const submitted = await this.submit(req, numFrames, signal);
    const predictionId = submitted.id ?? null;
    const pollUrl = submitted.urls?.get ?? (predictionId ? `${this.baseUrl}/predictions/${predictionId}` : null);
    const cancelUrl =
      submitted.urls?.cancel ?? (predictionId ? `${this.baseUrl}/predictions/${predictionId}/cancel` : null);
    if (!pollUrl) {
      throw new ProviderError(
        "Replicate accepted the prediction but returned neither an id nor a polling URL, so its result can never be collected."
      );
    }

    /**
     * ANY failure from here on must cancel the prediction — defect found in review.
     *
     * `pollUntilSettled` cancelled on abort and on the deadline and nothing else, so a transient
     * error on a single poll threw straight out: the prediction kept running on a billed GPU
     * with nothing left holding its id. Verified before this fix — a 429 on the second poll
     * produced exactly [POST /predictions, GET, GET] and ZERO cancel requests.
     *
     * It compounds: `processVideoScene` catches the throw, marks the scene failed with
     * `incrementRetry`, and pg-boss retries — submitting a BRAND NEW prediction while the
     * abandoned one runs to completion. Every retry doubles the orphan count. Replicate
     * rate-limits its API, and ~30 polls per scene across 150 scenes makes a 429 routine rather
     * than exotic.
     *
     * The download is inside the same guard: it happens after the prediction has succeeded and
     * been billed, but a failure there still leaves nothing to collect, and cancelling a
     * finished prediction is a harmless no-op.
     */
    let settled;
    try {
      settled = await this.pollUntilSettled(pollUrl, cancelUrl, submitted, deadlineAt, signal);
    } catch (error) {
      await this.cancelQuietly(cancelUrl);
      throw error;
    }
    if ("result" in settled) return settled.result;
    const prediction = settled.prediction;

    if (prediction.status === "failed") {
      // Replicate's own message, verbatim — it is the only description of what the model
      // actually objected to, and paraphrasing it would cost the operator the detail.
      return {
        status: "failed",
        error: prediction.error?.trim() || "Replicate reported the prediction failed but gave no reason.",
        providerName: this.name,
        providerMeta: { predictionId, modelVersion: this.modelVersion, status: "failed" },
      };
    }
    if (prediction.status === "canceled") {
      // Not cancelled by us — this loop cancels only on abort or deadline, and both return
      // above — so something outside this process stopped it (the dashboard, another worker).
      return this.canceledResult(predictionId, "by Replicate or another client", null);
    }

    const outputUrl = firstOutputUrl(prediction.output);
    if (!outputUrl) {
      // ADR-045, applied to video: a success with nothing in it is a failure. Reporting this
      // as a stored clip would create a scene row pointing at no bytes at all.
      throw new ProviderError(
        `Replicate reported prediction ${predictionId ?? "(unknown id)"} succeeded but returned no output URL.`
      );
    }

    let downloaded;
    try {
      downloaded = await this.download(outputUrl, signal);
    } catch (error) {
      // See above: the prediction is already finished, so this cancel is a no-op — but it costs
      // nothing and keeps "every exit from this function releases the prediction" true without
      // exceptions a reader has to remember.
      await this.cancelQuietly(cancelUrl);
      throw error;
    }
    const { bytes, mimeType, ext } = downloaded;
    const probe = probeMp4(bytes);
    const assetId = await store(bytes, mimeType, ext);

    return {
      status: "succeeded",
      video: {
        assetId,
        // Real, measured geometry where the container yields it (see mp4-probe.ts). Zero is
        // "not known" — reported honestly rather than filled in with the resolution this
        // adapter merely hopes the model used.
        width: probe?.width ?? 0,
        height: probe?.height ?? 0,
        durationSeconds: probe?.durationSeconds ?? req.durationSeconds,
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
      },
      providerName: this.name,
      providerMeta: {
        predictionId,
        modelVersion: this.modelVersion,
        numFrames,
        outputUrl,
        byteLength: bytes.length,
        // States plainly which of the numbers above were measured and which were assumed.
        dimensionsProbed: probe !== null,
        durationProbed: (probe?.durationSeconds ?? null) !== null,
        ...(prediction.metrics?.predict_time !== undefined
          ? { predictTimeSeconds: prediction.metrics.predict_time }
          : {}),
      },
    };
  }

  private async submit(
    req: VideoGenerationRequest,
    numFrames: number,
    signal: AbortSignal | undefined
  ): Promise<ReplicatePrediction> {
    const body = {
      version: this.modelVersion,
      input: {
        prompt: req.prompt,
        num_frames: numFrames,
        // Only sent when the caller asked for one: an explicit `seed: null` is a value the
        // model's input schema may well reject, and omitting the key is what "no preference"
        // means on this API.
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
      },
    };

    const { text: submitBody } = await this.request(`${this.baseUrl}/predictions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
      what: "submitting the prediction",
    });
    const prediction = parseJson(submitBody ?? "", "the prediction submission") as ReplicatePrediction;
    if (!prediction.id && !prediction.urls?.get) {
      throw new ProviderError("Replicate returned a prediction with no id and no URLs.");
    }
    return prediction;
  }

  /**
   * Polls until the prediction reaches a terminal status, or until the caller aborts or the
   * deadline passes — the last two cancel the prediction at Replicate before returning, which
   * is the whole reason this is not just a `while` loop around a `fetch`.
   *
   * Returns either the settled prediction or a finished `VideoResult`, rather than throwing
   * for the cancel paths: an aborted or timed-out generation is a scene that did not happen,
   * which is exactly what `status: "failed"` means to the worker that called this.
   */
  private async pollUntilSettled(
    pollUrl: string,
    cancelUrl: string | null,
    submitted: ReplicatePrediction,
    deadlineAt: number,
    signal: AbortSignal | undefined
  ): Promise<{ prediction: ReplicatePrediction } | { result: VideoResult }> {
    const predictionId = submitted.id ?? null;
    let prediction = submitted;
    let interval = this.pollIntervalMs;

    while (!TERMINAL_STATUSES.has(prediction.status ?? "")) {
      if (signal?.aborted) {
        return { result: await this.cancelAndReport(cancelUrl, predictionId, "by its caller") };
      }
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        return {
          result: await this.cancelAndReport(
            cancelUrl,
            predictionId,
            `because it exceeded this provider's ${Math.round(this.deadlineMs / 1000)}s deadline`
          ),
        };
      }

      // Never sleep past the deadline: a 15s poll interval must not turn into 15s of overrun.
      await sleep(Math.min(interval, remaining), signal);
      if (signal?.aborted) {
        return { result: await this.cancelAndReport(cancelUrl, predictionId, "by its caller") };
      }

      const { text: pollBody } = await this.request(pollUrl, {
        method: "GET",
        signal,
        what: "polling the prediction",
      });
      prediction = parseJson(pollBody ?? "", "a prediction poll") as ReplicatePrediction;
      interval = Math.min(Math.round(interval * POLL_BACKOFF_FACTOR), this.maxPollIntervalMs);
    }

    return { prediction };
  }

  /**
   * Stops the prediction at Replicate, then reports the generation as failed.
   *
   * Best-effort by design, and the outcome is stated either way: a cancel that itself fails
   * leaves a prediction running on billed hardware, and an operator who is told "canceled"
   * when the request never landed has been misinformed about their own bill.
   */
  private async cancelAndReport(
    cancelUrl: string | null,
    predictionId: string | null,
    why: string
  ): Promise<VideoResult> {
    if (!cancelUrl) {
      return this.canceledResult(predictionId, why, "Replicate returned no cancel URL, so the prediction may still be running.");
    }
    try {
      // Deliberately NOT the caller's signal. By the time this runs that signal is usually
      // already aborted, and passing it would abort the very request whose job is to stop the
      // billing — the bug this whole path exists to avoid.
      await this.request(cancelUrl, { method: "POST", signal: undefined, what: "canceling the prediction" });
      return this.canceledResult(predictionId, why, null);
    } catch (err) {
      return this.canceledResult(
        predictionId,
        why,
        `The cancel request itself failed (${err instanceof Error ? err.message : String(err)}), so the prediction may still be running and billing.`
      );
    }
  }

  /**
   * `predictionStopped` answers the only question an operator actually has here — is anything
   * still running on my account? — rather than the narrower "did a cancel request succeed".
   * It is true when the cancel was accepted, when Replicate itself reported the prediction
   * canceled, and when nothing was ever submitted; false only when this adapter could not
   * deliver the cancel and something may still be billing. The caveat spells that out in the
   * message too, because a `providerMeta` field alone is not what reaches a user.
   */
  private canceledResult(predictionId: string | null, why: string, caveat: string | null): VideoResult {
    return {
      status: "failed",
      error: `Video generation was canceled ${why}.${caveat ? ` ${caveat}` : ""}`,
      providerName: this.name,
      providerMeta: {
        predictionId,
        modelVersion: this.modelVersion,
        status: "canceled",
        predictionStopped: caveat === null,
      },
    };
  }

  /**
   * Best-effort cancel on an error path.
   *
   * Deliberately swallows its own failure: this runs while an error is already propagating, and
   * a failed cancel must not replace the real cause with a less useful one. The original error
   * is what the operator needs; the cancel is an attempt to stop the meter.
   */
  private async cancelQuietly(cancelUrl: string | null): Promise<void> {
    if (!cancelUrl) return;
    try {
      // `signal: undefined` on purpose — reusing the caller's signal would abort the very
      // request that stops the billing, which is the opposite of the point.
      await this.request(cancelUrl, { method: "POST", signal: undefined, what: "canceling the prediction" });
    } catch {
      /* the original error is the one worth reporting */
    }
  }

  /** Downloads the produced clip. The bytes are the deliverable; the URL is not. */
  private async download(
    outputUrl: string,
    signal: AbortSignal | undefined
  ): Promise<{ bytes: Buffer; mimeType: string; ext: string }> {
    // No Authorization header: the output lives on Replicate's delivery CDN, a different host
    // from the API, and attaching the account token to a third-party fetch would leak the
    // credential to whatever host the prediction's output happened to name.
    const { res, bytes } = await this.request(outputUrl, {
      method: "GET",
      signal,
      what: "downloading the generated video",
      authorize: false,
      // Read as bytes inside the request's own signal lifetime; see `request`.
      expect: "bytes",
      // The CDN is not the API (defect 3): a 404 from a delivery host means the output expired
      // or the URL is wrong, and telling an operator to "check VIDEO_API_TOKEN" — which the
      // API's status table does — sends them to fix something that is not broken.
      statusContext: "cdn",
    });
    if (!bytes || bytes.length === 0) {
      throw new ProviderError(`Replicate's output URL returned an empty body: ${outputUrl}`);
    }
    return { bytes, ...resolveMediaType(outputUrl, res.headers.get("content-type")) };
  }

  /**
   * One place where every HTTP call gets its timeout, its auth header and its error mapping,
   * so a poll and a submission cannot drift apart on any of the three.
   */
  private async request(
    url: string,
    init: {
      /** `bytes` for the video download; anything else reads the body as text. */
      expect?: "bytes" | "text";
      /**
       * Which status table to map a failure through. The delivery CDN is a different service
       * from the API and its statuses mean different things — a 404 there is an expired output,
       * not a missing prediction, and 401 there is not a bad API token (no token is sent).
       */
      statusContext?: "api" | "cdn";
      method: string;
      headers?: Record<string, string>;
      body?: string;
      signal: AbortSignal | undefined;
      what: string;
      authorize?: boolean;
    }
  ): Promise<{ res: Response; bytes: Buffer | null; text: string | null }> {
    const link = linkAbort(this.requestTimeoutMs, init.signal);
    try {
      const res = await this.fetchImpl(url, {
        method: init.method,
        headers: {
          ...(init.authorize === false ? {} : { Authorization: `Bearer ${this.apiToken}` }),
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: link.signal,
      });
      if (!res.ok) await throwForStatus(res, init.what, init.statusContext ?? "api");
      /**
       * The body is read HERE, inside the signal's lifetime — not returned for the caller to
       * read later.
       *
       * `finally` calls `link.dispose()`, which clears the request timer and removes the
       * external abort listener. A caller that read the body after that ran it on no signal at
       * all: a server or CDN that sends headers and then stalls the connection pinned the worker
       * forever, past both the request timeout and the wall-clock deadline. Verified before this
       * fix — a 50ms deadline against a body stream that never enqueued was still hanging at
       * 1502ms, with no rejection and no cancel.
       *
       * `bytes` for a binary download, `text` for JSON: reading both would double the memory of
       * a video, and reading the wrong one consumes the stream so the other can never run.
       */
      const readBody: Promise<{ bytes: Buffer | null; text: string | null }> =
        init.expect === "bytes"
          ? res.arrayBuffer().then((buf) => ({ bytes: Buffer.from(buf), text: null }))
          : safeText(res).then((text) => ({ bytes: null, text }));
      const payload = await withDeadline(
        readBody,
        this.requestTimeoutMs,
        `reading the response body while ${init.what}`
      );
      return { res, ...payload };
    } catch (err) {
      // Every typed error from `@ai-platform/shared` — including the ones `throwForStatus`
      // just raised — passes through untouched; only a genuine transport failure is rewritten.
      if (err instanceof AppError) throw err;
      if (init.signal?.aborted) {
        // The caller's cancellation, surfacing as a rejected fetch. The poll loop checks
        // `signal.aborted` again and takes the cancel path, so this must not be reported as
        // an unreachable provider.
        throw new ProviderError(`Replicate request aborted by its caller while ${init.what}.`);
      }
      throw new ServiceUnavailableError(
        `Could not reach Replicate at ${url} while ${init.what}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      link.dispose();
    }
  }
}

/**
 * HTTP status → the platform's typed errors. Each one carries a different operator action —
 * fix the token, top up the account, wait, retry later — and that is precisely what a single
 * "provider failed" string throws away.
 */
async function throwForStatus(res: Response, what: string, context: "api" | "cdn" = "api"): Promise<never> {
  const detail = truncate(await safeText(res));
  const suffix = detail ? ` ${detail}` : "";
  if (context === "cdn") {
    /**
     * The delivery CDN, not the API — defect found in review.
     *
     * Routing these through the API's table produced actively misleading advice: a 404 from the
     * CDN became "prediction not found, check the id", and a 401 became "check VIDEO_API_TOKEN",
     * when no token is sent to the CDN at all. An operator following either would go and fix
     * something that is not broken.
     */
    if (res.status === 404 || res.status === 410) {
      throw new NotFoundError(
        `Replicate's delivery CDN no longer has the generated video (${res.status}) while ${what}. ` +
          `Prediction outputs expire; the clip must be regenerated.${suffix}`
      );
    }
    throw new ServiceUnavailableError(
      `Replicate's delivery CDN returned ${res.status} ${res.statusText} while ${what}. ` +
        `This is the output host, not the API — the account and token are not implicated.${suffix}`
    );
  }
  switch (res.status) {
    case 401:
      throw new UnauthorizedError(
        `Replicate rejected the API token while ${what} (401). Check VIDEO_API_TOKEN.${suffix}`
      );
    case 403:
      throw new PermissionError(
        `Replicate refused this account access while ${what} (403) — the token is valid but not permitted to run this model.${suffix}`
      );
    case 402:
      throw new QuotaExceededError(
        `Replicate refused the request for billing reasons while ${what} (402) — the account is out of credit or has hit its spend limit.${suffix}`
      );
    case 404:
      throw new NotFoundError(
        `Replicate returned 404 while ${what} — the model version in VIDEO_MODEL_VERSION or the prediction no longer exists.${suffix}`
      );
    case 429: {
      const retryAfter = res.headers.get("retry-after");
      throw new RateLimitError(
        `Replicate rate-limited this account while ${what} (429).${retryAfter ? ` Retry after ${retryAfter}s.` : ""}${suffix}`
      );
    }
    default:
      if (res.status >= 500) {
        throw new ServiceUnavailableError(
          `Replicate returned ${res.status} while ${what} — a provider-side failure, retryable.${suffix}`
        );
      }
      throw new ValidationError(`Replicate rejected the request while ${what} (${res.status}).${suffix}`);
  }
}

/**
 * `output` is a single URL for most video models and a list for those that emit more than one
 * artefact; both shapes are documented and both are real, so both are handled here rather than
 * by whichever one the first configured model happened to use.
 */
function firstOutputUrl(output: string | string[] | null | undefined): string | null {
  if (typeof output === "string") return output.trim() || null;
  if (Array.isArray(output)) {
    for (const entry of output) {
      if (typeof entry === "string" && entry.trim()) return entry.trim();
    }
  }
  return null;
}

/**
 * The stored asset's extension and media type, taken from the delivery URL's own extension —
 * Replicate's output URLs carry one — and falling back to the response's `Content-Type` when
 * it does not. The URL wins because a CDN's generic `application/octet-stream` is common and
 * says nothing, whereas `out.webm` is the model author's own statement of what it produced.
 *
 * It refuses rather than defaulting to `.mp4`. A clip stored under the wrong extension is
 * served with the wrong `Content-Type` by the assets route, and a browser handed
 * `video/mp4` for a WebM simply will not play it — a silent, much later failure in the one
 * place a user would actually notice. Failing here names the URL and the type that confused it.
 */
function resolveMediaType(url: string, contentType: string | null): { mimeType: string; ext: string } {
  const fromUrl = extensionOf(url);
  if (fromUrl && MEDIA_TYPE_BY_EXTENSION[fromUrl]) {
    return { mimeType: MEDIA_TYPE_BY_EXTENSION[fromUrl], ext: fromUrl };
  }
  const declared = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const fromHeader = Object.entries(MEDIA_TYPE_BY_EXTENSION).find(([, mime]) => mime === declared);
  if (fromHeader) return { mimeType: fromHeader[1], ext: fromHeader[0] };

  throw new ProviderError(
    `Could not determine the media type of Replicate's output (url: ${truncate(url, 200)}, content-type: ${contentType ?? "none"}). Storing it under a guessed extension would make it unplayable.`
  );
}

function extensionOf(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  const match = /\.([a-z0-9]{2,5})$/i.exec(pathname);
  return match ? match[1].toLowerCase() : null;
}

/**
 * A timeout signal that also follows the caller's, so one `fetch` can be bounded by both
 * without `AbortSignal.any` (Node 20.0 is the floor this repo declares, and that helper
 * landed later). The listener is removed in `dispose` — a long-lived caller signal would
 * otherwise accumulate one listener per poll.
 */
function linkAbort(timeoutMs: number, external: AbortSignal | undefined): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

/**
 * Sleeps, but wakes immediately when the caller aborts — otherwise a cancellation would sit
 * out the rest of a 15-second poll interval before the provider's cancel endpoint is called,
 * and that interval is billed. It resolves on abort rather than rejecting: the loop re-checks
 * `signal.aborted` on the next line, and a rejection here would need catching at every call
 * site to say the same thing.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Races a promise against a timer.
 *
 * Used for the response BODY specifically, because aborting a fetch is not guaranteed to reject
 * an already-returned body stream: whether the abort propagates into the stream depends on the
 * fetch implementation, and a stalled body is exactly the case where that matters. Relying on it
 * would make this adapter's only protection against a half-open connection an implementation
 * detail of whatever runtime it happens to be running on.
 *
 * The timer is unreffed so it can never hold the process open on its own.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ServiceUnavailableError(`Replicate stalled after ${ms}ms ${what}.`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Parses a body this module has ALREADY read — see `request`, which reads inside the signal. */
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`Replicate returned a non-JSON body for ${what}: ${truncate(text)}`);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(could not read response body)";
  }
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
