import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
   * always resolves to something that actually exists. Returns the new asset's id.
   *
   * `projectId` is the tenant project the bytes belong to (ADR-049) and is threaded in from
   * whoever asked for them — the uploading request, the image generation's row, the video
   * project's row. It is required rather than defaulted because an unowned asset is
   * unreachable: every read goes through `AssetRepository.get(projectId, id)`, whose scope
   * predicate lives in the SQL `WHERE`, so bytes written under the wrong project (or none)
   * could never be served back. */
  store(projectId: string, bytes: Buffer, mimeType: string, ext: string, kind?: AssetKind): Promise<string>;
  /** Reads an asset's bytes back — the only supported way to get at them. */
  read(asset: Asset): Promise<Buffer>;
  /** Removes the bytes AND the `assets` row — the disposal path for an upload rejected as
   * infected (docs/26_DECISIONS.md ADR-042). Idempotent: bytes already gone is success,
   * so a retried job can't get stuck on a half-completed earlier attempt. */
  delete(asset: Asset): Promise<void>;
  /**
   * Removes only the BYTES, named by their storage path — NFR-008, ADR-102.
   *
   * Account deletion cascades the `assets` rows away inside one database transaction, so by
   * the time the files are removed there is no row left to pass to `delete`. Deleting the rows
   * first is deliberate (see `deleteUserAccount`), which makes a path-addressed disposal the
   * only shape that can finish the job. Idempotent, like `delete`.
   */
  deleteByPath(storagePath: string): Promise<void>;
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

  async store(
    projectId: string,
    bytes: Buffer,
    mimeType: string,
    ext: string,
    kind: AssetKind = "image"
  ): Promise<string> {
    await mkdir(this.assetsRoot, { recursive: true });
    const id = uuid();
    const filename = `${id}.${ext}`;
    const fullPath = join(this.assetsRoot, filename);
    await writeFile(fullPath, bytes);

    const checksum = createHash("sha256").update(bytes).digest("hex");
    try {
      const asset = await this.assetRepo.create({
        id,
        projectId,
        kind,
        mimeType,
        sizeBytes: bytes.length,
        storagePath: fullPath,
        checksum,
      });
      return asset.id;
    } catch (err) {
      // The bytes were written first; if the row cannot be, they must not stay behind (ADR-109).
      // The case that proved it: a job still running when its project's account was deleted wrote
      // its output, then hit the foreign key to the deleted project — leaving a file with no row,
      // absent from the deletion response, that nothing could ever find.
      await this.deleteByPath(fullPath).catch(() => undefined);
      throw err;
    }
  }

  async read(asset: Asset): Promise<Buffer> {
    return readFile(asset.storagePath);
  }

  async delete(asset: Asset): Promise<void> {
    try {
      await this.deleteByPath(asset.storagePath);
    } finally {
      // Scoped by the row's own `projectId` (ADR-049) — the caller already resolved this
      // asset under its tenant scope, so re-deriving the scope here cannot widen it, and a
      // pre-ADR-049 row (`projectId === null`) still deletes through the legacy scope
      // rather than silently matching nothing.
      await this.assetRepo.delete(asset.projectId, asset.id);
    }
  }

  async deleteByPath(storagePath: string): Promise<void> {
    await rm(storagePath, { force: true }); // force: a missing file is not an error
  }
}
