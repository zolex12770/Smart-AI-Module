import { and, desc, eq, isNull } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import { documents } from "../schema/index.js";

export type DocumentStatus = "scanning" | "ingesting" | "ready" | "failed" | "rejected";
export type DocumentScanStatus = "pending" | "clean" | "infected" | "skipped_no_scanner";

export interface Document {
  id: string;
  /** The tenant boundary (ADR-049). Every read below filters on it in SQL, never after. */
  projectId: string;
  /** Who uploaded it. Null for path-based ingestion and for rows whose user was deleted. */
  uploadedByUserId: string | null;
  filename: string;
  /** Sandbox-relative path — the local-dev ingestion flow. Null for uploaded documents. */
  sourcePath: string | null;
  /** The AssetStore asset holding the uploaded bytes (docs/26_DECISIONS.md ADR-041). Null
   * for path-based documents, and cleared again if an upload is rejected as infected and its
   * asset deleted (ADR-042). */
  assetId: string | null;
  status: DocumentStatus;
  /** What the malware scan actually did (ADR-042) — null for never-scanned path-based rows. */
  scanStatus: DocumentScanStatus | null;
  errorMessage: string | null;
  /** Ingest generation. Bumped by an atomic re-ingest (see DocumentChunkRepository
   * `replaceForDocument`) so "which pass wrote these chunks" is answerable after the fact. */
  version: number;
  /** Soft delete (ADR-049). Set instead of issuing a DELETE, so an audit can still see what
   * a project once held and so chunk/asset cleanup is not a cascade race. */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Still a discriminated union over the two real ingestion sources — a document is either a
 * sandbox path or an uploaded asset, never both and never neither, and only the upload flow
 * has a scan verdict to record. `projectId` is required in both arms: a document that does
 * not belong to a project cannot be authorized on read, so there is no legal way to create one.
 */
export type CreateDocumentInput =
  | {
      id: string;
      projectId: string;
      uploadedByUserId?: string | null;
      filename: string;
      sourcePath: string;
      assetId?: undefined;
      scanStatus?: undefined;
    }
  | {
      id: string;
      projectId: string;
      uploadedByUserId?: string | null;
      filename: string;
      assetId: string;
      sourcePath?: undefined;
      scanStatus: DocumentScanStatus;
    };

/**
 * Interface application code depends on — never the Drizzle table directly.
 *
 * Every method that reads or mutates a document takes `projectId` as its first argument and
 * puts it in the `WHERE`. That is deliberate and is the whole IDOR defence (ADR-049): a
 * document id belonging to another project resolves to "not found" here, so a caller cannot
 * fetch first and check ownership second — the check it might forget does not exist. A
 * cross-project id and a genuinely missing id are indistinguishable to the caller on purpose:
 * a distinguishable "exists but forbidden" is an existence oracle over another tenant's data.
 */
export interface DocumentRepository {
  create(input: CreateDocumentInput): Promise<Document>;
  updateStatus(projectId: string, id: string, status: DocumentStatus, errorMessage?: string): Promise<void>;
  /** Records the scan outcome; optionally advances `status` in the same write. */
  updateScan(
    projectId: string,
    id: string,
    scanStatus: DocumentScanStatus,
    status?: DocumentStatus,
    errorMessage?: string
  ): Promise<void>;
  /** Detaches a rejected document from its (about-to-be-deleted) asset — the `documents.asset_id`
   * foreign key otherwise blocks deleting the `assets` row. */
  clearAsset(projectId: string, id: string): Promise<void>;
  get(projectId: string, id: string): Promise<Document | undefined>;
  /** The serve-gate's lookup (ADR-042): `GET /api/v1/assets/:id` must not hand out a document
   * asset that is still `scanning` or was `rejected`. */
  findByAssetId(projectId: string, assetId: string): Promise<Document | undefined>;
  /** Newest first. Replaces the old unscoped `list()`, which read every tenant's documents. */
  listByProject(projectId: string): Promise<Document[]>;
  /**
   * The delete that did not exist before ADR-049's audit: documents could be created and
   * ingested but never removed. Returns false when nothing matched (wrong project, unknown
   * id, or already deleted) so a route can answer 404 without a second read.
   */
  softDelete(projectId: string, id: string): Promise<boolean>;
}

export class PgDocumentRepository implements DocumentRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: CreateDocumentInput): Promise<Document> {
    const now = new Date();
    const row: Document = {
      id: input.id,
      projectId: input.projectId,
      uploadedByUserId: input.uploadedByUserId ?? null,
      filename: input.filename,
      sourcePath: input.sourcePath ?? null,
      assetId: input.assetId ?? null,
      // An upload starts life as `scanning` only if it is actually going to be scanned
      // (scanStatus "pending"); a fail-open upload or a path-based document starts ingesting.
      status: input.scanStatus === "pending" ? "scanning" : "ingesting",
      scanStatus: input.scanStatus ?? null,
      errorMessage: null,
      version: 1,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(documents).values(row);
    return row;
  }

  async updateStatus(projectId: string, id: string, status: DocumentStatus, errorMessage?: string): Promise<void> {
    // Soft-deleted rows are excluded: an ingest job that finishes after the user deleted the
    // document must not resurrect it to `ready` and put it back in front of retrieval.
    await this.db
      .update(documents)
      .set({ status, updatedAt: new Date(), ...(errorMessage !== undefined ? { errorMessage } : {}) })
      .where(and(eq(documents.projectId, projectId), eq(documents.id, id), isNull(documents.deletedAt)));
  }

  async updateScan(
    projectId: string,
    id: string,
    scanStatus: DocumentScanStatus,
    status?: DocumentStatus,
    errorMessage?: string
  ): Promise<void> {
    // Deliberately NOT filtered on `deletedAt`, unlike updateStatus: a malware verdict is a
    // security fact about bytes that still exist in the asset store, and it must be recorded
    // even if the user deleted the document row while the scan was in flight (ADR-042).
    await this.db
      .update(documents)
      .set({
        scanStatus,
        updatedAt: new Date(),
        ...(status !== undefined ? { status } : {}),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      })
      .where(and(eq(documents.projectId, projectId), eq(documents.id, id)));
  }

  async clearAsset(projectId: string, id: string): Promise<void> {
    // Also unfiltered on `deletedAt`, for the same reason and one more: this exists so the
    // `assets` row can be deleted, and a dangling FK from a soft-deleted document would block
    // that deletion forever, leaving known-bad bytes on disk.
    await this.db
      .update(documents)
      .set({ assetId: null, updatedAt: new Date() })
      .where(and(eq(documents.projectId, projectId), eq(documents.id, id)));
  }

  async get(projectId: string, id: string): Promise<Document | undefined> {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.projectId, projectId), eq(documents.id, id), isNull(documents.deletedAt)))
      .limit(1);
    return row;
  }

  async findByAssetId(projectId: string, assetId: string): Promise<Document | undefined> {
    // Soft-deleted rows are included here, and that is the fail-closed choice: the caller is
    // the ADR-042 serve-gate, which blocks on `status`. If deleting a document hid its row
    // from this lookup, the gate would see "no document" and happily serve the bytes of a
    // file that was rejected as infected.
    const [row] = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.projectId, projectId), eq(documents.assetId, assetId)))
      .limit(1);
    return row;
  }

  async listByProject(projectId: string): Promise<Document[]> {
    return this.db
      .select()
      .from(documents)
      .where(and(eq(documents.projectId, projectId), isNull(documents.deletedAt)))
      .orderBy(desc(documents.createdAt));
  }

  async softDelete(projectId: string, id: string): Promise<boolean> {
    const now = new Date();
    // `isNull(deletedAt)` in the predicate makes this idempotent *and* truthful: a second
    // delete reports false rather than silently re-stamping the timestamp and losing when the
    // document actually went away.
    const deleted = await this.db
      .update(documents)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(documents.projectId, projectId), eq(documents.id, id), isNull(documents.deletedAt)))
      .returning({ id: documents.id });
    return deleted.length > 0;
  }
}
