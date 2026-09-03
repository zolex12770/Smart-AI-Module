import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import { assets } from "../schema/index.js";

export type AssetKind = "image" | "video" | "audio" | "document" | "other";

export interface Asset {
  id: string;
  kind: AssetKind;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  checksum: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface CreateAssetInput {
  id: string;
  kind: AssetKind;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  checksum: string;
  metadata?: Record<string, unknown>;
}

export interface AssetRepository {
  create(input: CreateAssetInput): Promise<Asset>;
  get(id: string): Promise<Asset | undefined>;
  /** Removes the row only — the bytes are the AssetStore's to delete (docs/26_DECISIONS.md
   * ADR-042). Callers must clear any `documents.asset_id` reference first (FK). */
  delete(id: string): Promise<void>;
}

export class PgAssetRepository implements AssetRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: CreateAssetInput): Promise<Asset> {
    const row = { ...input, metadata: input.metadata ?? null, createdAt: new Date() };
    await this.db.insert(assets).values(row);
    return row;
  }

  async get(id: string): Promise<Asset | undefined> {
    const [row] = await this.db.select().from(assets).where(eq(assets.id, id));
    return row as Asset | undefined;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(assets).where(eq(assets.id, id));
  }
}
