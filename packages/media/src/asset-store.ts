import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { v4 as uuid } from "uuid";
import type { Asset, AssetKind, AssetRepository } from "@ai-platform/database";

/**
 * The storage boundary every producer (image/video providers, the ffmpeg render) writes
 * through and every consumer (the asset-serving route, the render's clip materialization)
 * reads through — docs/26_DECISIONS.md ADR-040. Two real implementations: `LocalAssetStore`
 * (local disk, the local-dev default) and `CloudStorageAssetStore` (`gcs-asset-store.ts`,
 * Google Cloud Storage — the docs/19 production target, the missing piece for a working
 * Cloud Run deploy per ADR-037). Nothing outside these two classes may touch
 * `asset.storagePath` directly: its meaning (an absolute local path vs. a `gs://` URI) is
 * an implementation detail of whichever store wrote it.
 */
export interface AssetStore {
  /** Persists `bytes` and records a real `assets` row in the same step, so an asset id
   * always resolves to something that actually exists. Returns the new asset's id. */
  store(bytes: Buffer, mimeType: string, ext: string, kind?: AssetKind): Promise<string>;
  /** Reads an asset's bytes back — the only supported way to get at them. */
  read(asset: Asset): Promise<Buffer>;
}

/**
 * Local filesystem asset storage (docs/19_DEPLOYMENT_ARCHITECTURE.md: "local filesystem
 * adapter by default" for dev). `storagePath` is an absolute path under `assetsRoot`.
 * Not suitable for Cloud Run (ephemeral, per-instance disk) — see ADR-037/ADR-040.
 */
export class LocalAssetStore implements AssetStore {
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

  async read(asset: Asset): Promise<Buffer> {
    return readFile(asset.storagePath);
  }
}
