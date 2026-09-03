import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import { documents } from "../schema/index.js";

export type DocumentStatus = "scanning" | "ingesting" | "ready" | "failed" | "rejected";
export type DocumentScanStatus = "pending" | "clean" | "infected" | "skipped_no_scanner";

export interface Document {
  id: string;
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
  createdAt: Date;
}

export type CreateDocumentInput =
  | { id: string; filename: string; sourcePath: string; assetId?: undefined; scanStatus?: undefined }
  | { id: string; filename: string; assetId: string; sourcePath?: undefined; scanStatus: DocumentScanStatus };

export interface DocumentRepository {
  create(input: CreateDocumentInput): Promise<Document>;
  updateStatus(id: string, status: DocumentStatus, errorMessage?: string): Promise<void>;
  /** Records the scan outcome; optionally advances `status` in the same write. */
  updateScan(id: string, scanStatus: DocumentScanStatus, status?: DocumentStatus, errorMessage?: string): Promise<void>;
  /** Detaches a rejected document from its (about-to-be-deleted) asset — the `documents.asset_id`
   * foreign key otherwise blocks deleting the `assets` row. */
  clearAsset(id: string): Promise<void>;
  get(id: string): Promise<Document | undefined>;
  /** The serve-gate's lookup (ADR-042): `GET /api/v1/assets/:id` must not hand out a document
   * asset that is still `scanning` or was `rejected`. */
  findByAssetId(assetId: string): Promise<Document | undefined>;
  list(): Promise<Document[]>;
}

export class PgDocumentRepository implements DocumentRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: CreateDocumentInput): Promise<Document> {
    const row: Document = {
      id: input.id,
      filename: input.filename,
      sourcePath: input.sourcePath ?? null,
      assetId: input.assetId ?? null,
      // An upload starts life as `scanning` only if it is actually going to be scanned
      // (scanStatus "pending"); a fail-open upload or a path-based document starts ingesting.
      status: input.scanStatus === "pending" ? "scanning" : "ingesting",
      scanStatus: input.scanStatus ?? null,
      errorMessage: null,
      createdAt: new Date(),
    };
    await this.db.insert(documents).values(row);
    return row;
  }

  async updateStatus(id: string, status: DocumentStatus, errorMessage?: string): Promise<void> {
    await this.db
      .update(documents)
      .set({ status, ...(errorMessage !== undefined ? { errorMessage } : {}) })
      .where(eq(documents.id, id));
  }

  async updateScan(id: string, scanStatus: DocumentScanStatus, status?: DocumentStatus, errorMessage?: string): Promise<void> {
    await this.db
      .update(documents)
      .set({
        scanStatus,
        ...(status !== undefined ? { status } : {}),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      })
      .where(eq(documents.id, id));
  }

  async clearAsset(id: string): Promise<void> {
    await this.db.update(documents).set({ assetId: null }).where(eq(documents.id, id));
  }

  async get(id: string): Promise<Document | undefined> {
    const [row] = await this.db.select().from(documents).where(eq(documents.id, id));
    return row as Document | undefined;
  }

  async findByAssetId(assetId: string): Promise<Document | undefined> {
    const [row] = await this.db.select().from(documents).where(eq(documents.assetId, assetId));
    return row as Document | undefined;
  }

  async list(): Promise<Document[]> {
    return (await this.db.select().from(documents)) as Document[];
  }
}
