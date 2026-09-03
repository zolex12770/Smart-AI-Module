import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import { documents } from "../schema/index.js";

export type DocumentStatus = "ingesting" | "ready" | "failed";

export interface Document {
  id: string;
  filename: string;
  /** Sandbox-relative path — the local-dev ingestion flow. Null for uploaded documents. */
  sourcePath: string | null;
  /** The AssetStore asset holding the uploaded bytes (docs/26_DECISIONS.md ADR-041). Null
   * for path-based documents. Exactly one of `sourcePath`/`assetId` is set. */
  assetId: string | null;
  status: DocumentStatus;
  errorMessage: string | null;
  createdAt: Date;
}

export type CreateDocumentInput =
  | { id: string; filename: string; sourcePath: string; assetId?: undefined }
  | { id: string; filename: string; assetId: string; sourcePath?: undefined };

export interface DocumentRepository {
  create(input: CreateDocumentInput): Promise<Document>;
  updateStatus(id: string, status: DocumentStatus, errorMessage?: string): Promise<void>;
  get(id: string): Promise<Document | undefined>;
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
      status: "ingesting",
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

  async get(id: string): Promise<Document | undefined> {
    const [row] = await this.db.select().from(documents).where(eq(documents.id, id));
    return row as Document | undefined;
  }

  async list(): Promise<Document[]> {
    return (await this.db.select().from(documents)) as Document[];
  }
}
