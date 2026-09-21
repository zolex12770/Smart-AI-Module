/**
 * What a tenant is told when a provider or a binary fails — docs/26_DECISIONS.md ADR-155.
 *
 * ADR-119 established the rule for the RAG route: the caller gets a stable sentence and the
 * request id, and the detail goes to the log. The media and ingestion workers never got it.
 * They persist `err.message` verbatim into a column that `GET /api/v1/images/:id` and its
 * siblings serve straight back, and those messages are built by the adapters out of whatever
 * the underlying failure said:
 *
 *  - `image-openai`: "Could not reach the image provider at ${this.baseUrl}: …" — the operator's
 *    endpoint, which for a self-hosted runtime is an internal address.
 *  - `image-sdcpp`: 400 bytes of stable-diffusion.cpp's stderr, which names the absolute model
 *    path on the host, and Node's spawn error, which names the absolute binary path.
 *  - `runFfmpeg`: the same shape for the video render.
 *
 * None of that is a tenant's business, and a worker has no request to attach an id to — so the
 * stored text names the STAGE that failed and nothing else, and the raw error goes to the log
 * beside the generation's own id, which is what an operator greps for.
 *
 * The classification is deliberately coarse. A longer list would be a longer list of things to
 * get wrong, and the three below are the ones an operator acts on differently.
 */
export type FailureStage = "image" | "speech" | "video" | "render" | "ingest";

const STAGE_TEXT: Record<FailureStage, string> = {
  image: "Image generation failed.",
  speech: "Speech synthesis failed.",
  video: "Video generation failed.",
  render: "Video rendering failed.",
  ingest: "This document could not be ingested.",
};

/**
 * True for the failures a USER can act on, which are worth saying in full: they describe the
 * request rather than the deployment. Everything else collapses to the stage sentence.
 */
function callerActionable(raw: string): string | null {
  if (/quota|limit of \d/i.test(raw)) return raw.slice(0, 300);
  if (/cancelled/i.test(raw)) return raw.slice(0, 300);
  if (/zero chunks|scanned\/image-only|no extractable text/i.test(raw)) return raw.slice(0, 300);
  if (/unsupported|not supported|too long|too large|exceeds/i.test(raw)) return raw.slice(0, 300);
  return null;
}

export function describeFailureForCaller(stage: FailureStage, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const actionable = callerActionable(raw);
  if (actionable) return actionable;
  return `${STAGE_TEXT[stage]} The server log records why, against this id.`;
}
