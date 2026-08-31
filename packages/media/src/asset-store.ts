import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { v4 as uuid } from "uuid";
import type { AssetKind, AssetRepository } from "@ai-platform/database";

/**
 * Local filesystem asset storage (docs/19_DEPLOYMENT_ARCHITECTURE.md: "local filesystem
 * adapter by default" for dev; object storage — GCS — is the documented production
 * target, not built yet). Writes real bytes to disk and a real row to `assets` in the
 * same step, so an asset id always resolves to something that actually exists.
 */
export class LocalAssetStore {
  constructor(
    private readonly assetsRoot: string,
    private readonly assetRepo: AssetRepository
  ) {}

  async store(bytes: Buffer, mimeType: string, ext: string, kind: AssetKind = "image"): Promise<string> {
    await mkdir(this.assetsRoot, { recursive: true });
    const id = uuid();
    const filename = `${id}.${ext}`;
    const fullPath = join(this.assetsRoot, filename);
    await writeFile(fullPath, bytes);

    const checksum = createHash("sha256").update(bytes).digest("hex");
    const asset = await this.assetRepo.create({
      id,
      kind,
      mimeType,
      sizeBytes: bytes.length,
      storagePath: fullPath,
      checksum,
    });
    return asset.id;
  }
}
