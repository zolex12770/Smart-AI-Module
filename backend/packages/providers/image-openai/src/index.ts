import {
  ProviderError,
  type AspectRatio,
  type ImageGenerationRequest,
  type ImageProvider,
  type ImageProviderCapabilities,
  type ImageResult,
} from "@ai-platform/shared";

/**
 * Real image generation over the OpenAI-compatible `/v1/images/generations` API —
 * docs/26_DECISIONS.md ADR-065.
 *
 * This is the same provider-independence strategy the chat runtime uses (ADR-056), applied to
 * images: `/v1/images/generations` is the one image API with more than one implementation.
 * LocalAI implements it over Stable Diffusion, several ComfyUI and Automatic1111 bridges
 * expose it, and OpenAI's hosted models speak it natively. One adapter therefore covers both
 * a wholly self-hosted deployment and a hosted one, and the application code cannot tell
 * which it is talking to.
 *
 * It replaces nothing in development: `MockImageProvider` still serves the zero-configuration
 * local loop and still refuses to exist in production. What changes is that production now has
 * a real option instead of only a capability error.
 *
 * **Honest verification status:** unit-tested against fixtures of the documented response
 * shapes (`b64_json` and `url`), including the error paths. No real image server was available
 * in the environment that wrote this, so a real end-to-end generation is unverified — the same
 * status the chat adapters carry, and stated here rather than implied away.
 */

/**
 * The API takes pixel dimensions, not aspect ratios. These are the standard buckets those
 * models are trained around; a size the server rejects surfaces as a real provider error
 * rather than being silently substituted.
 *
 * They are also the buckets a HOSTED model is trained around, and this adapter is documented as
 * the way to reach a LOCAL OpenAI-compatible server too (`http://127.0.0.1:8080/v1` for LocalAI,
 * says the option's own comment). On a CPU backend a 1024-square generation is minutes of work
 * and a 1792×1024 is worse, so a deployment that points this at a local server could only wait or
 * time out — with no setting that helped, because the size was a constant. `baseSize` rescales
 * the whole table while keeping the ratios, so the same configuration reaches a small local model
 * and a hosted one (ADR-129).
 */
const SIZE_BY_RATIO: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "3:2": { width: 1536, height: 1024 },
  "2:3": { width: 1024, height: 1536 },
  "4:3": { width: 1152, height: 896 },
  "3:4": { width: 896, height: 1152 },
  "16:9": { width: 1792, height: 1024 },
  "9:16": { width: 1024, height: 1792 },
};

export interface OpenAICompatibleImageOptions {
  /** e.g. `http://127.0.0.1:8080/v1` for LocalAI, or `https://api.openai.com/v1`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /**
   * Longest edge of the square bucket, in pixels. Everything else keeps its ratio and scales with
   * it. Unset keeps the hosted-model defaults (1024 and up). Set it small — 512, or 384 — when
   * this points at a local CPU server, where the default sizes are minutes per image (ADR-129).
   */
  baseSize?: number;
  name?: string;
  /** Most local servers ignore a negative prompt; declare it honestly per deployment. */
  supportsNegativePrompt?: boolean;
  supportsSeed?: boolean;
  maxImagesPerCall?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ImagesResponse {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: { message?: string };
}

export class OpenAICompatibleImageProvider implements ImageProvider {
  readonly name: string;
  readonly isMock = false;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  /** Longest edge of the 1:1 bucket the table is written against; the rest scale with it. */
  private static readonly REFERENCE_SIZE = 1024;

  constructor(private readonly options: OpenAICompatibleImageOptions) {
    this.name = options.name ?? "image-openai";
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 180_000;
  }

  /**
   * The configured size, keeping each bucket's aspect ratio and rounding to a multiple of 64 —
   * every diffusion backend worth pointing this at wants dimensions on that grid (ADR-129).
   * Unset means the hosted defaults, unchanged.
   */
  private sizeFor(ratio: AspectRatio): { width: number; height: number } {
    const base = SIZE_BY_RATIO[ratio];
    const target = this.options.baseSize;
    if (!target || target === OpenAICompatibleImageProvider.REFERENCE_SIZE) return base;
    const scale = target / OpenAICompatibleImageProvider.REFERENCE_SIZE;
    const round64 = (n: number) => Math.max(64, Math.round((n * scale) / 64) * 64);
    return { width: round64(base.width), height: round64(base.height) };
  }

  getCapabilities(): ImageProviderCapabilities {
    return {
      // Declared per deployment rather than assumed: the same endpoint backed by SDXL and by
      // a hosted model genuinely differ here, and a route that trusts a wrong answer silently
      // drops the user's parameter.
      supportsNegativePrompt: this.options.supportsNegativePrompt ?? false,
      supportsSeed: this.options.supportsSeed ?? false,
      maxImagesPerCall: this.options.maxImagesPerCall ?? 1,
      supportedAspectRatios: Object.keys(SIZE_BY_RATIO) as AspectRatio[],
      hasFastTier: false,
    };
  }

  async generateImage(
    req: ImageGenerationRequest,
    store: (bytes: Buffer, mimeType: string, ext: string) => Promise<string>,
    signal?: AbortSignal
  ): Promise<ImageResult> {
    const size = this.sizeFor(req.aspectRatio);
    const body: Record<string, unknown> = {
      model: this.options.model,
      prompt: req.prompt,
      n: 1,
      size: `${size.width}x${size.height}`,
      // Base64 avoids a second fetch and the expiring-URL failure mode; servers that cannot
      // honour it fall back to a URL, which is handled below.
      response_format: "b64_json",
    };
    // Only sent when the deployment declares support, so a server that would reject an
    // unknown field never sees one.
    if (req.negativePrompt && this.getCapabilities().supportsNegativePrompt) {
      body.negative_prompt = req.negativePrompt;
    }
    if (req.seed !== undefined && this.getCapabilities().supportsSeed) body.seed = req.seed;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    // A cancellation stops the request as well as the deadline does (audit finding 5).
    const onCancel = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", onCancel, { once: true });
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        return {
          status: "failed",
          providerName: this.name,
          error: `Image generation failed (${res.status}): ${truncate(await safeText(res))}`,
        };
      }

      const payload = (await res.json()) as ImagesResponse;
      if (payload.error) {
        return { status: "failed", providerName: this.name, error: payload.error.message ?? "unknown provider error" };
      }
      const first = payload.data?.[0];
      if (!first) {
        // An empty success is a failure, not an image (the ADR-045 rule, applied to images).
        return { status: "failed", providerName: this.name, error: "The provider returned no image data." };
      }

      const bytes = await this.resolveBytes(first, controller.signal);
      const assetId = await store(bytes, "image/png", "png");

      return {
        status: "succeeded",
        providerName: this.name,
        images: [{ assetId, width: size.width, height: size.height, ...(req.seed !== undefined ? { seed: req.seed } : {}) }],
        providerMeta: {
          model: this.options.model,
          ...(first.revised_prompt ? { revisedPrompt: first.revised_prompt } : {}),
        },
      };
    } catch (err) {
      return {
        status: "failed",
        providerName: this.name,
        error:
          err instanceof Error && err.name === "AbortError"
            ? signal?.aborted
              ? "Image generation was cancelled."
              : `Image generation timed out after ${this.requestTimeoutMs}ms.`
            : `Could not reach the image provider at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCancel);
    }
  }

  /** Accepts either response form; a URL is fetched immediately because those links expire. */
  private async resolveBytes(item: { b64_json?: string; url?: string }, signal: AbortSignal): Promise<Buffer> {
    if (item.b64_json) return Buffer.from(item.b64_json, "base64");
    if (!item.url) throw new ProviderError("The provider returned neither b64_json nor url.");
    const res = await this.fetchImpl(item.url, { signal });
    if (!res.ok) throw new ProviderError(`Could not download the generated image (${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
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
