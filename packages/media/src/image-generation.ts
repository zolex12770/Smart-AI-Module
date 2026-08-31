import type { ImageGenerationRepository } from "@ai-platform/database";
import type { ImageGenerationRequest, ImageProvider } from "@ai-platform/shared";
import type { LocalAssetStore } from "./asset-store.js";

export interface ImageGenerationDeps {
  generationRepo: ImageGenerationRepository;
  assetStore: LocalAssetStore;
  provider: ImageProvider;
}

export async function createPendingImageGeneration(
  generationRepo: ImageGenerationRepository,
  id: string,
  request: ImageGenerationRequest
) {
  return generationRepo.create(id, request);
}

/**
 * Runs the actual generation — designed to execute inside a job worker (docs/07 §1.6
 * "mock-provider parity": even the mock goes through the real async job system, not an
 * inline call), mirroring packages/rag's `processDocumentIngestion` split.
 */
export async function processImageGeneration(deps: ImageGenerationDeps, generationId: string): Promise<void> {
  const generation = await deps.generationRepo.get(generationId);
  if (!generation) throw new Error(`Unknown image generation "${generationId}".`);

  await deps.generationRepo.updateStatus(generationId, "processing");

  try {
    const result = await deps.provider.generateImage(generation.request, (bytes, mimeType, ext) =>
      deps.assetStore.store(bytes, mimeType, ext, "image")
    );

    if (result.status !== "succeeded" || !result.images?.length) {
      await deps.generationRepo.updateStatus(generationId, "failed", {
        providerName: result.providerName,
        errorMessage: result.error ?? "Provider returned no images.",
      });
      return;
    }

    await deps.generationRepo.updateStatus(generationId, "succeeded", {
      providerName: result.providerName,
      resultAssetId: result.images[0].assetId,
    });
  } catch (err) {
    await deps.generationRepo.updateStatus(generationId, "failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
