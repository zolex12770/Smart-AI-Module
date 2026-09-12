import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ImageGenerationRequest } from "@ai-platform/shared";
import type { DrizzleDb } from "../client.js";
import { imageGenerations } from "../schema/index.js";

export type ImageGenerationStatus = "pending" | "processing" | "succeeded" | "failed" | "cancelled";

/** The states a generation can still leave on its own — everything else is terminal. */
const IN_FLIGHT_STATUSES = ["pending", "processing"] as const;

export interface ImageGeneration {
  id: string;
  /** Tenant scope (ADR-049). Every read below filters on it in SQL. */
  projectId: string;
  /** Who asked for it. Null once that user is deleted (`ON DELETE SET NULL`), never omitted. */
  createdByUserId: string | null;
  prompt: string;
  request: ImageGenerationRequest;
  status: ImageGenerationStatus;
  providerName: string | null;
  /** The specific model behind the provider — `provider` alone cannot explain a cost line. */
  modelName: string | null;
  /** A real FK to `assets` now (ADR-049): it can no longer dangle after an asset is deleted. */
  resultAssetId: string | null;
  errorMessage: string | null;
  /** Attempts actually started, so a repeatedly-retried generation is visible rather than
   * looking like a single slow one. Incremented in SQL — see `updateStatus`. */
  attemptCount: number;
  /** Set by `requestCancel`; the worker observes it and settles the row as `cancelled`. */
  cancelRequestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateImageGenerationInput {
  id: string;
  projectId: string;
  /** Null only for system-initiated work; a user's request always attributes itself. */
  createdByUserId: string | null;
  request: ImageGenerationRequest;
}

export interface ImageGenerationPatch {
  providerName?: string;
  modelName?: string;
  resultAssetId?: string;
  errorMessage?: string;
  /** Increments `attempt_count` in SQL rather than from a value read moments earlier. */
  incrementAttempt?: boolean;
}

export interface ImageGenerationRepository {
  create(input: CreateImageGenerationInput): Promise<ImageGeneration>;
  updateStatus(
    projectId: string,
    id: string,
    status: ImageGenerationStatus,
    patch?: ImageGenerationPatch
  ): Promise<void>;
  /**
   * Cooperative cancellation (docs/07 §1.5 "Cancellation"): records the *request* and returns
   * whether this call is the one that recorded it. It does not move the row to `cancelled` —
   * a generation already in a provider call has to notice and settle itself, and claiming a
   * terminal state the worker has not reached would be a lie the UI would show.
   *
   * The conditional `WHERE` makes the answer authoritative under concurrency: two clicks on
   * Cancel both issue the same `UPDATE ... WHERE cancel_requested_at IS NULL`, exactly one
   * matches a row, and only that caller is told it won.
   */
  requestCancel(projectId: string, id: string): Promise<boolean>;
  /** Project-scoped read — returns undefined for another tenant's id (ADR-049 IDOR defence). */
  get(projectId: string, id: string): Promise<ImageGeneration | undefined>;
  list(projectId: string): Promise<ImageGeneration[]>;
}

export class PgImageGenerationRepository implements ImageGenerationRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: CreateImageGenerationInput): Promise<ImageGeneration> {
    const now = new Date();
    const row: ImageGeneration = {
      id: input.id,
      projectId: input.projectId,
      createdByUserId: input.createdByUserId,
      prompt: input.request.prompt,
      request: input.request,
      status: "pending",
      providerName: null,
      modelName: null,
      resultAssetId: null,
      errorMessage: null,
      attemptCount: 0,
      cancelRequestedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(imageGenerations).values(row);
    return row;
  }

  async updateStatus(
    projectId: string,
    id: string,
    status: ImageGenerationStatus,
    patch?: ImageGenerationPatch
  ): Promise<void> {
    await this.db
      .update(imageGenerations)
      .set({
        status,
        // ADR-049 rule: `updated_at` is written on every update, not only on create, so
        // "when did this row last change" is answerable without an audit-log join.
        updatedAt: new Date(),
        ...(patch?.providerName !== undefined ? { providerName: patch.providerName } : {}),
        ...(patch?.modelName !== undefined ? { modelName: patch.modelName } : {}),
        ...(patch?.resultAssetId !== undefined ? { resultAssetId: patch.resultAssetId } : {}),
        ...(patch?.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
        // Computed by the database from the row's current value. A read-then-write here would
        // lose an increment whenever two attempts overlap — the same lost-update defect the
        // audit found in `PgVideoSceneRepository.updateStatus`.
        ...(patch?.incrementAttempt ? { attemptCount: sql`${imageGenerations.attemptCount} + 1` } : {}),
      })
      .where(and(eq(imageGenerations.id, id), eq(imageGenerations.projectId, projectId)));
  }

  async requestCancel(projectId: string, id: string): Promise<boolean> {
    const now = new Date();
    const claimed = await this.db
      .update(imageGenerations)
      .set({ cancelRequestedAt: now, updatedAt: now })
      .where(
        and(
          eq(imageGenerations.id, id),
          eq(imageGenerations.projectId, projectId),
          isNull(imageGenerations.cancelRequestedAt),
          // A finished generation cannot be cancelled; saying otherwise would suggest the
          // asset it already produced is going away.
          inArray(imageGenerations.status, [...IN_FLIGHT_STATUSES])
        )
      )
      .returning({ id: imageGenerations.id });
    return claimed.length > 0;
  }

  async get(projectId: string, id: string): Promise<ImageGeneration | undefined> {
    const [row] = await this.db
      .select()
      .from(imageGenerations)
      .where(and(eq(imageGenerations.id, id), eq(imageGenerations.projectId, projectId)));
    return row as ImageGeneration | undefined;
  }

  async list(projectId: string): Promise<ImageGeneration[]> {
    // Ordered newest-first on `(project_id, created_at)` — the index the schema declares for
    // exactly this query, so the gallery does not sort a whole tenant's history in memory.
    return (await this.db
      .select()
      .from(imageGenerations)
      .where(eq(imageGenerations.projectId, projectId))
      .orderBy(desc(imageGenerations.createdAt))) as ImageGeneration[];
  }
}
