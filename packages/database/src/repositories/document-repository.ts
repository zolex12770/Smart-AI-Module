import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import { documents } from "../schema/index.js";

export type DocumentStatus = "ingesting" | "ready" | "failed";

export interface Document {
  id: string;
  filename: string;
  sourcePath: string;
  status: DocumentStatus;
  errorMessage: string | null;
  createdAt: Date;
}

export interface DocumentRepository {
  create(input: { id: string; filename: string; sourcePath: string }): Promise<Document>;
  updateStatus(id: string, status: DocumentStatus, errorMessage?: string): Promise<void>;
  get(id: string): Promise<Document | undefined>;
  list(): Promise<Document[]>;
}

export class PgDocumentRepository implements DocumentRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: { id: string; filename: string; sourcePath: string }): Promise<Document> {
    const row = {
      id: input.id,
      filename: input.filename,
      sourcePath: input.sourcePath,
      status: "ingesting" as DocumentStatus,
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
