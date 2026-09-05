import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import { assets } from "../schema/index.js";

export type AssetKind = "image" | "video" | "audio" | "document" | "other";

export interface Asset {
  id: string;
  /**
   * The tenant project the bytes belong to (ADR-049). Nullable in the schema only because
   * rows written before projects existed cannot be attributed retroactively — every path in
   * this codebase now sets it, which is why `CreateAssetInput.projectId` is required.
   */
  projectId: string | null;
  kind: AssetKind;
  mimeType: string;
  /**
   * `double precision`, not `integer`: a rendered long-form video can exceed the 2 GB signed
   * 32-bit ceiling, and an overflowed size is worse than no size — it silently mis-reports
   * `content-length` on the serve path. Still a plain `number` in TypeScript.
   */
  sizeBytes: number;
  storagePath: string;
  checksum: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface CreateAssetInput {
  id: string;
  /** Required even though the column is nullable — new bytes always belong to a project. */
  projectId: string;
  kind: AssetKind;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  checksum: string;
  metadata?: Record<string, unknown>;
}

export interface AssetRepository {
  create(input: CreateAssetInput): Promise<Asset>;
  /**
   * Project-scoped read (ADR-049). The `project_id` predicate is in the `WHERE`, so an asset
   * id guessed or leaked from another tenant returns `undefined` rather than a row the caller
   * must then be trusted to reject — that check-after-fetch is the IDOR this replaces.
   *
   * `projectId` accepts `null` deliberately: that scope matches *only* the pre-ADR-049 rows
   * whose `project_id` was never set, so serving legacy assets stays possible without any
   * scope ever reaching another project's row.
   */
  get(projectId: string | null, id: string): Promise<Asset | undefined>;
  /** Removes the row only — the bytes are the AssetStore's to delete (docs/26_DECISIONS.md
   * ADR-042). Callers must clear any `documents.asset_id` reference first (FK). Scoped like
   * `get`, so a rejected-upload cleanup can never reach another project's asset. */
  delete(projectId: string | null, id: string): Promise<void>;
}

export class PgAssetRepository implements AssetRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: CreateAssetInput): Promise<Asset> {
    const row: Asset = { ...input, metadata: input.metadata ?? null, createdAt: new Date() };
    await this.db.insert(assets).values(row);
    return row;
  }

  async get(projectId: string | null, id: string): Promise<Asset | undefined> {
    const [row] = await this.db
      .select()
      .from(assets)
      .where(and(eq(assets.id, id), scopedToProject(projectId)));
    return row as Asset | undefined;
  }

  async delete(projectId: string | null, id: string): Promise<void> {
    // `assets` has no `deleted_at`: an asset row exists to point at bytes, and once the bytes
    // are gone a tombstone would only be a dangling pointer. A real DELETE is the correct
    // disposal here, unlike the soft-deleted content tables (ADR-049).
    await this.db.delete(assets).where(and(eq(assets.id, id), scopedToProject(projectId)));
  }
}

/**
 * The scope predicate, in SQL. `IS NULL` rather than `= NULL` for the legacy scope — the
 * latter is never true in SQL and would silently match nothing, which is exactly the kind of
 * quiet authorization failure this file exists to prevent.
 */
function scopedToProject(projectId: string | null): SQL {
  return projectId === null ? isNull(assets.projectId) : eq(assets.projectId, projectId);
}
