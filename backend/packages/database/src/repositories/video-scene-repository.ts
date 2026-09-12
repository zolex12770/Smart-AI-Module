import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import { videoProjects, videoScenes } from "../schema/index.js";

export type VideoSceneStatus = "pending" | "processing" | "succeeded" | "failed" | "cancelled";

export interface VideoScene {
  id: string;
  /**
   * The parent long-form video, renamed from `projectId` by ADR-049: `project_id` now means
   * the *tenant* project everywhere in the schema, so the old name would have been actively
   * misleading on the one table where it meant something else.
   */
  videoProjectId: string;
  sceneIndex: number;
  shotDescription: string;
  /** Voice-over line for this shot (ADR-053's script stage); null for a silent clip. */
  narration: string | null;
  durationSeconds: number;
  status: VideoSceneStatus;
  jobId: string | null;
  assetId: string | null;
  /** The narration audio, generated separately from the clip and muxed at render time. */
  audioAssetId: string | null;
  retryCount: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateVideoSceneInput {
  id: string;
  sceneIndex: number;
  shotDescription: string;
  narration?: string | null;
  durationSeconds: number;
}

/**
 * Scenes carry no `project_id` of their own: they inherit tenant scope through a NOT NULL FK
 * to `video_projects`, and the schema's rule (ADR-049) is that such a child is *always read
 * through its parent*. This scope carries both ids so that rule can be honoured in the `WHERE`
 * — `videoProjectId` picks the parent, `projectId` proves the caller may see it.
 */
export interface VideoSceneScope {
  /** Tenant project — the predicate that makes these queries an access control. */
  projectId: string;
  /** The long-form video project whose scenes these are. */
  videoProjectId: string;
}

export interface VideoScenePatch {
  jobId?: string;
  assetId?: string;
  audioAssetId?: string;
  lastError?: string;
  /** Increments `retry_count` in SQL — see the note on `updateStatus`. */
  incrementRetry?: boolean;
}

export interface VideoSceneRepository {
  createMany(scope: VideoSceneScope, scenes: CreateVideoSceneInput[]): Promise<VideoScene[]>;
  updateStatus(
    scope: VideoSceneScope,
    id: string,
    status: VideoSceneStatus,
    patch?: VideoScenePatch
  ): Promise<void>;
  get(scope: VideoSceneScope, id: string): Promise<VideoScene | undefined>;
  listByVideoProject(scope: VideoSceneScope): Promise<VideoScene[]>;
  /** Scenes that still need a generation attempt — the resumability check from docs/07 §2.3. */
  listNotSucceeded(scope: VideoSceneScope): Promise<VideoScene[]>;
}

export class PgVideoSceneRepository implements VideoSceneRepository {
  constructor(private readonly db: DrizzleDb) {}

  async createMany(scope: VideoSceneScope, scenes: CreateVideoSceneInput[]): Promise<VideoScene[]> {
    if (scenes.length === 0) return [];
    const now = new Date();
    const rows = scenes.map((s) => newVideoSceneRow(scope.videoProjectId, s, now));
    // An INSERT has no `WHERE` to hang the scope check on, so the check and the insert run in
    // one transaction: either the parent belongs to this tenant and the scenes are written, or
    // nothing is. Without the transaction a concurrent parent delete could leave orphan rows.
    await this.db.transaction(async (tx) => {
      const [parent] = await tx
        .select({ id: videoProjects.id })
        .from(videoProjects)
        .where(and(eq(videoProjects.id, scope.videoProjectId), eq(videoProjects.projectId, scope.projectId)));
      if (!parent) {
        throw new Error(
          `Video project "${scope.videoProjectId}" does not exist in project "${scope.projectId}".`
        );
      }
      await tx.insert(videoScenes).values(rows);
    });
    return rows;
  }

  async updateStatus(
    scope: VideoSceneScope,
    id: string,
    status: VideoSceneStatus,
    patch?: VideoScenePatch
  ): Promise<void> {
    await this.db
      .update(videoScenes)
      .set({
        status,
        updatedAt: new Date(),
        ...(patch?.jobId !== undefined ? { jobId: patch.jobId } : {}),
        ...(patch?.assetId !== undefined ? { assetId: patch.assetId } : {}),
        ...(patch?.audioAssetId !== undefined ? { audioAssetId: patch.audioAssetId } : {}),
        ...(patch?.lastError !== undefined ? { lastError: patch.lastError } : {}),
        // `retry_count = retry_count + 1`, evaluated by Postgres against the row it is
        // locking. The previous implementation read the row and wrote `read + 1`, which loses
        // an increment whenever two attempts settle at once — the exact lost-update the audit
        // recorded, and it mattered because scene jobs run at concurrency 3.
        ...(patch?.incrementRetry ? { retryCount: sql`${videoScenes.retryCount} + 1` } : {}),
      })
      .where(and(eq(videoScenes.id, id), ownedParent(this.db, scope)));
  }

  async get(scope: VideoSceneScope, id: string): Promise<VideoScene | undefined> {
    const [row] = await this.db
      .select()
      .from(videoScenes)
      .where(and(eq(videoScenes.id, id), ownedParent(this.db, scope)));
    return row as VideoScene | undefined;
  }

  async listByVideoProject(scope: VideoSceneScope): Promise<VideoScene[]> {
    // Ordered in SQL: every caller (the render's concat list, the detail view) wants scene
    // order, and the `(video_project_id, scene_index)` unique index already provides it.
    return (await this.db
      .select()
      .from(videoScenes)
      .where(ownedParent(this.db, scope))
      .orderBy(asc(videoScenes.sceneIndex))) as VideoScene[];
  }

  async listNotSucceeded(scope: VideoSceneScope): Promise<VideoScene[]> {
    return (await this.db
      .select()
      .from(videoScenes)
      .where(and(ownedParent(this.db, scope), ne(videoScenes.status, "succeeded")))
      .orderBy(asc(videoScenes.sceneIndex))) as VideoScene[];
  }
}

/**
 * `video_project_id` restricted to a parent the tenant actually owns, as a subquery so the
 * scope lives in the same `WHERE` as the row lookup — usable by SELECT and UPDATE alike, and
 * never as a comparison made after the row has already been handed to the caller (ADR-049).
 * It constrains the parent id too, so it is the complete scope predicate on its own.
 */
function ownedParent(db: DrizzleDb, scope: VideoSceneScope): SQL {
  return inArray(
    videoScenes.videoProjectId,
    db
      .select({ id: videoProjects.id })
      .from(videoProjects)
      .where(and(eq(videoProjects.id, scope.videoProjectId), eq(videoProjects.projectId, scope.projectId)))
  );
}

/**
 * The one place a new scene row's defaults are written. Exported because
 * `VideoProjectRepository.applyScript` materializes scenes inside its own transaction, and a
 * scene created there must be indistinguishable from one created by `createMany`.
 */
export function newVideoSceneRow(videoProjectId: string, input: CreateVideoSceneInput, now: Date): VideoScene {
  return {
    id: input.id,
    videoProjectId,
    sceneIndex: input.sceneIndex,
    shotDescription: input.shotDescription,
    narration: input.narration ?? null,
    durationSeconds: input.durationSeconds,
    status: "pending",
    jobId: null,
    assetId: null,
    audioAssetId: null,
    retryCount: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}
