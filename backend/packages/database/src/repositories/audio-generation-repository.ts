import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { AudioGenerationRequest } from "@ai-platform/shared";
import type { DrizzleDb } from "../client.js";
import { audioGenerations } from "../schema/index.js";

/**
 * Speech generations — docs/26_DECISIONS.md ADR-114.
 *
 * The same shape as `image-generation-repository`, for the same reasons: a row the caller can poll
 * the instant the request returns, a tenant predicate in every `WHERE` (ADR-049) so another
 * project's id resolves to nothing rather than to a row this code would then have to be trusted to
 * reject, attempts counted in SQL, and cancellation recorded as a request the worker settles.
 */
export type AudioGenerationStatus = "pending" | "processing" | "succeeded" | "failed" | "cancelled";

export interface AudioGeneration {
  id: string;
  /** Tenant scope (ADR-049). Every read below filters on it in SQL. */
  projectId: string;
  /** Who asked. Null once that user is deleted (`ON DELETE SET NULL`), never omitted. */
  createdByUserId: string | null;
  text: string;
  request: AudioGenerationRequest;
  status: AudioGenerationStatus;
  providerName: string | null;
  /** The voice actually used, which is what explains why two clips sound different. */
  voiceName: string | null;
  /** Measured from the produced file, not estimated from the text. Null until it succeeds. */
  durationSeconds: number | null;
  resultAssetId: string | null;
  errorMessage: string | null;
  attemptCount: number;
  cancelRequestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAudioGenerationInput {
  id: string;
  projectId: string;
  createdByUserId: string | null;
  request: AudioGenerationRequest;
}

export interface AudioGenerationPatch {
  providerName?: string;
  voiceName?: string;
  durationSeconds?: number;
  resultAssetId?: string;
  errorMessage?: string;
  /** Increments `attempt_count` in SQL rather than from a value read moments earlier. */
  incrementAttempt?: boolean;
}

export interface AudioGenerationRepository {
  create(input: CreateAudioGenerationInput): Promise<AudioGeneration>;
  updateStatus(
    projectId: string,
    id: string,
    status: AudioGenerationStatus,
    patch?: AudioGenerationPatch
  ): Promise<void>;
  /** Records the cancellation REQUEST and says whether this call is the one that recorded it. */
  requestCancel(projectId: string, id: string): Promise<boolean>;
  /** Project-scoped read — undefined for another tenant's id (ADR-049 IDOR defence). */
  get(projectId: string, id: string): Promise<AudioGeneration | undefined>;
  list(projectId: string): Promise<AudioGeneration[]>;
}

export class PgAudioGenerationRepository implements AudioGenerationRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: CreateAudioGenerationInput): Promise<AudioGeneration> {
    const now = new Date();
    const row: AudioGeneration = {
      id: input.id,
      projectId: input.projectId,
      createdByUserId: input.createdByUserId,
      text: input.request.text,
      request: input.request,
      status: "pending",
      providerName: null,
      voiceName: null,
      durationSeconds: null,
      resultAssetId: null,
      errorMessage: null,
      attemptCount: 0,
      cancelRequestedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(audioGenerations).values(row);
    return row;
  }

  async updateStatus(
    projectId: string,
    id: string,
    status: AudioGenerationStatus,
    patch: AudioGenerationPatch = {}
  ): Promise<void> {
    await this.db
      .update(audioGenerations)
      .set({
        status,
        ...(patch.providerName !== undefined ? { providerName: patch.providerName } : {}),
        ...(patch.voiceName !== undefined ? { voiceName: patch.voiceName } : {}),
        ...(patch.durationSeconds !== undefined ? { durationSeconds: patch.durationSeconds } : {}),
        ...(patch.resultAssetId !== undefined ? { resultAssetId: patch.resultAssetId } : {}),
        ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
        ...(patch.incrementAttempt ? { attemptCount: sql`${audioGenerations.attemptCount} + 1` } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(audioGenerations.id, id), eq(audioGenerations.projectId, projectId)));
  }

  async requestCancel(projectId: string, id: string): Promise<boolean> {
    const now = new Date();
    // The conditional WHERE makes the answer authoritative under concurrency: two clicks issue
    // the same UPDATE, exactly one matches, and only that caller is told it won.
    const updated = await this.db
      .update(audioGenerations)
      .set({ cancelRequestedAt: now, updatedAt: now })
      .where(
        and(
          eq(audioGenerations.id, id),
          eq(audioGenerations.projectId, projectId),
          isNull(audioGenerations.cancelRequestedAt)
        )
      )
      .returning({ id: audioGenerations.id });
    return updated.length > 0;
  }

  async get(projectId: string, id: string): Promise<AudioGeneration | undefined> {
    const [row] = await this.db
      .select()
      .from(audioGenerations)
      .where(and(eq(audioGenerations.id, id), eq(audioGenerations.projectId, projectId)));
    return row as AudioGeneration | undefined;
  }

  async list(projectId: string): Promise<AudioGeneration[]> {
    const rows = await this.db
      .select()
      .from(audioGenerations)
      .where(eq(audioGenerations.projectId, projectId))
      .orderBy(desc(audioGenerations.createdAt));
    return rows as AudioGeneration[];
  }
}
