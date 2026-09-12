import { createHash } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import { v4 as uuid } from "uuid";
import type { Asset, AssetKind, AssetRepository } from "@ai-platform/database";
import type { AssetStore } from "./asset-store.js";

export interface CloudStorageAssetStoreOptions {
  bucketName: string;
  /** Point the real client at a non-Google endpoint (a local `fake-gcs-server`). Unset in
   * production: the client then targets real GCS and authenticates via Application Default
   * Credentials — on Cloud Run, the attached service account, which
   * `infrastructure/terraform/main.tf` grants `roles/storage.objectAdmin` on the bucket.
   *
   * Deliberately an explicit option, NOT the library's `STORAGE_EMULATOR_HOST` env var: a
   * live check (docs/26_DECISIONS.md ADR-040) found that under the env var the library
   * builds its base URL as the bare host without `/storage/v1`, so uploads (which build
   * their own `/upload/storage/v1/...` URL) succeed while downloads (base-URL-relative)
   * 404 — the library's own source comments call the env var "experimental... use
   * apiEndpoint instead." With `apiEndpoint`, the test path and the production path are
   * the same code. */
  apiEndpoint?: string;
  /** Fully injectable client, for tests that need to inspect the bucket directly. */
  storage?: Storage;
}

/**
 * Google Cloud Storage asset storage — docs/19_DEPLOYMENT_ARCHITECTURE.md's production
 * target and the gap ADR-037 named as the real prerequisite for a working Cloud Run deploy
 * (docs/26_DECISIONS.md ADR-040). `storagePath` is a `gs://<bucket>/<object>` URI, so an
 * asset row is self-describing about where its bytes live even across a bucket rename.
 *
 * Same write discipline as `LocalAssetStore`: bytes are uploaded first, the `assets` row is
 * written only once the upload succeeded, so an id never points at an object that isn't
 * there. `resumable: false` — every asset this platform produces (SVGs, GIF clips, an MP4)
 * fits comfortably in one request, and a resumable session is an extra round trip plus a
 * server-side session to leak on failure, for no benefit at these sizes.
 */
export class CloudStorageAssetStore implements AssetStore {
  private readonly storage: Storage;
  private readonly bucketName: string;

  constructor(
    options: CloudStorageAssetStoreOptions,
    private readonly assetRepo: AssetRepository
  ) {
    this.bucketName = options.bucketName;
    this.storage = options.storage ?? new Storage(options.apiEndpoint ? { apiEndpoint: options.apiEndpoint } : {});
  }

  async store(
    projectId: string,
    bytes: Buffer,
    mimeType: string,
    ext: string,
    kind: AssetKind = "image"
  ): Promise<string> {
    const id = uuid();
    // Keyed by kind, not by project: the object name is a storage detail, and tenancy is
    // enforced by the `assets` row's `project_id` in the SQL `WHERE` of every read
    // (ADR-049), never by trusting a path prefix an operator could rename.
    const objectName = `${kind}/${id}.${ext}`;
    await this.storage.bucket(this.bucketName).file(objectName).save(bytes, {
      contentType: mimeType,
      resumable: false,
    });

    const checksum = createHash("sha256").update(bytes).digest("hex");
    const asset = await this.assetRepo.create({
      id,
      projectId,
      kind,
      mimeType,
      sizeBytes: bytes.length,
      storagePath: `gs://${this.bucketName}/${objectName}`,
      checksum,
    });
    return asset.id;
  }

  async read(asset: Asset): Promise<Buffer> {
    const { bucket, objectName } = parseGsUri(asset.storagePath);
    const [bytes] = await this.storage.bucket(bucket).file(objectName).download();
    return bytes;
  }

  async delete(asset: Asset): Promise<void> {
    try {
      await this.deleteByPath(asset.storagePath);
    } finally {
      // Same scope-from-the-row reasoning as LocalAssetStore.delete (ADR-049).
      await this.assetRepo.delete(asset.projectId, asset.id);
    }
  }

  async deleteByPath(storagePath: string): Promise<void> {
    const { bucket, objectName } = parseGsUri(storagePath);
    // ignoreNotFound: an object already gone (a retried job) is success, not a failure.
    await this.storage.bucket(bucket).file(objectName).delete({ ignoreNotFound: true });
  }
}

/** `gs://bucket/path/to/object` → its parts. Throws on anything else — a row written by
 * `LocalAssetStore` (an absolute path) must never be silently treated as an object name. */
export function parseGsUri(uri: string): { bucket: string; objectName: string } {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) throw new Error(`Not a gs:// URI: "${uri}" — was this asset written by a different AssetStore?`);
  return { bucket: match[1], objectName: match[2] };
}
