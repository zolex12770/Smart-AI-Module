import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import { videoProjects, videoScenes } from "../schema/index.js";
import { newVideoSceneRow, type CreateVideoSceneInput } from "./video-scene-repository.js";

export type VideoProjectStatus =
  | "planning"
  | "generating_scenes"
  | "assembling"
  | "succeeded"
  | "partially_succeeded"
  | "failed"
  | "cancelled";
export type VideoRenderStatus = "pending" | "processing" | "succeeded" | "skipped_no_ffmpeg" | "failed";

/** Statuses a project can still leave on its own — the only ones worth cancelling. */
const IN_FLIGHT_STATUSES = ["planning", "generating_scenes", "assembling"] as const;

/**
 * The model-written script and storyboard (ADR-053) — the stage that replaced the old
 * index-prefixed shot template, which produced no narration and no cross-scene consistency.
 * Typed rather than left as free-form JSON: it is written by our own planner and read by the
 * scene materializer below, so the shape is a contract between two pieces of our own code.
 */
export interface VideoScriptScene {
  sceneIndex: number;
  shotDescription: string;
  /** Voice-over for the shot; omitted for a deliberately silent scene. */
  narration?: string;
  durationSeconds: number;
}

export interface VideoScript {
  title?: string;
  /** One-paragraph through-line, kept so a re-plan can stay consistent with the first pass. */
  summary?: string;
  scenes: VideoScriptScene[];
  /**
   * Who actually wrote this — ADR-080. `model` means a real script stage ran; `deterministic`
   * means the mechanical decomposition produced the scenes and nothing was authored.
   *
   * Persisted rather than inferred because the two are indistinguishable from the scene rows
   * alone, and a mechanical storyboard that reads as authored is exactly the kind of fake
   * completion this platform refuses. Optional only so rows written before ADR-080 still parse.
   */
  scriptSource?: "model" | "deterministic";
  /** The model that wrote it, or null on the deterministic path. */
  model?: string | null;
  /** Why it fell back, when it did — an operator's only clue that the script stage failed. */
  fallbackReason?: string | null;
}

export interface VideoProject {
  id: string;
  /** Tenant scope (ADR-049) — distinct from `id`, which is this video project's own id. */
  projectId: string;
  createdByUserId: string | null;
  prompt: string;
  /** Null until the planning stage completes (ADR-053). */
  script: VideoScript | null;
  targetDurationSeconds: number;
  sceneClipSeconds: number;
  sceneCount: number;
  status: VideoProjectStatus;
  renderStatus: VideoRenderStatus | null;
  renderAssetId: string | null;
  renderError: string | null;
  /** The render slot — see `claimRenderSlot`. Null means no render has been enqueued yet. */
  renderRequestedAt: Date | null;
  errorMessage: string | null;
  cancelRequestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateVideoProjectInput {
  id: string;
  projectId: string;
  createdByUserId: string | null;
  prompt: string;
  targetDurationSeconds: number;
  sceneClipSeconds: number;
  sceneCount: number;
  /**
   * Defaults to `planning`, the state a project sits in while ADR-053's script stage runs.
   * A caller that already has its scenes decided (the template planner, which needs no model
   * call) may create straight into `generating_scenes` rather than pass through a stage it
   * does not use — a project left in `planning` that nothing will ever advance is worse than
   * an honest initial status.
   */
  status?: VideoProjectStatus;
  /**
   * The model-written script and storyboard (ADR-080), or a record that the deterministic
   * planner produced the scenes instead. Persisted so the distinction between an authored
   * storyboard and a mechanical decomposition survives past creation — a caller must be able to
   * tell them apart, and only one of them is a script.
   */
  script?: VideoScript;
}

export interface VideoProjectRepository {
  create(input: CreateVideoProjectInput): Promise<VideoProject>;
  updateStatus(
    projectId: string,
    id: string,
    status: VideoProjectStatus,
    patch?: { errorMessage?: string }
  ): Promise<void>;
  updateRender(
    projectId: string,
    id: string,
    patch: { renderStatus: VideoRenderStatus; renderAssetId?: string; renderError?: string }
  ): Promise<void>;
  /**
   * Writes the script and materializes its scenes in one transaction (ADR-053): the old
   * scenes are replaced, the new ones inserted, and the parent moved to `generating_scenes`
   * atomically. Anything less can leave a project whose `status` and `scene_count` describe
   * scenes that were never written, or a re-plan showing the old and new storyboards at once.
   *
   * Throws if `id` is not a video project of `projectId` — the scope check runs inside the
   * transaction, in the `WHERE`, and rolls the whole thing back.
   */
  applyScript(projectId: string, id: string, script: VideoScript, scenes: CreateVideoSceneInput[]): Promise<void>;
  /**
   * Claims the exclusive right to enqueue this project's render job, atomically.
   *
   * Every scene that settles calls the completion check, scene workers run at concurrency 3,
   * and when the last few finish together they all observe "every scene succeeded" and all
   * enqueue `video.render` — duplicate renders, duplicate ffmpeg work, duplicate assets. The
   * audit found exactly that. Reading `render_requested_at` and then writing it would not fix
   * it; the read and the write have to be one statement.
   *
   * `UPDATE ... WHERE render_requested_at IS NULL` is that statement: Postgres locks the row,
   * and a concurrent updater re-evaluates the predicate against the committed new version, so
   * it matches zero rows. Exactly one caller gets `true`, and only that caller enqueues.
   *
   * Keyed by the video project's own id and not tenant-scoped: it is a system-side claim on a
   * row the caller has already resolved under scope, and adding `project_id` to the predicate
   * would change nothing about which caller wins.
   */
  claimRenderSlot(videoProjectId: string): Promise<boolean>;
  /**
   * Releases the slot so a later settle can claim it again — the explicit-retry path
   * (`POST /api/v1/videos/:id/retry`) after a failed or skipped render. Without it the slot
   * is a one-shot latch and a project whose render failed could never be re-rendered.
   */
  releaseRenderSlot(videoProjectId: string): Promise<void>;
  /** Cooperative cancellation — records the request; the workers settle the rows (docs/07 §1.5). */
  requestCancel(projectId: string, id: string): Promise<boolean>;
  /** Project-scoped read — undefined for another tenant's id (ADR-049 IDOR defence). */
  get(projectId: string, id: string): Promise<VideoProject | undefined>;
  list(projectId: string): Promise<VideoProject[]>;
}

export class PgVideoProjectRepository implements VideoProjectRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: CreateVideoProjectInput): Promise<VideoProject> {
    const now = new Date();
    const row: VideoProject = {
      id: input.id,
      projectId: input.projectId,
      createdByUserId: input.createdByUserId,
      prompt: input.prompt,
      script: input.script ?? null,
      targetDurationSeconds: input.targetDurationSeconds,
      sceneClipSeconds: input.sceneClipSeconds,
      sceneCount: input.sceneCount,
      status: input.status ?? "planning",
      renderStatus: null,
      renderAssetId: null,
      renderError: null,
      renderRequestedAt: null,
      errorMessage: null,
      cancelRequestedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(videoProjects).values(row);
    return row;
  }

  async updateStatus(
    projectId: string,
    id: string,
    status: VideoProjectStatus,
    patch?: { errorMessage?: string }
  ): Promise<void> {
    await this.db
      .update(videoProjects)
      .set({
        status,
        updatedAt: new Date(),
        ...(patch?.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      })
      .where(and(eq(videoProjects.id, id), eq(videoProjects.projectId, projectId)));
  }

  async updateRender(
    projectId: string,
    id: string,
    patch: { renderStatus: VideoRenderStatus; renderAssetId?: string; renderError?: string }
  ): Promise<void> {
    await this.db
      .update(videoProjects)
      .set({
        renderStatus: patch.renderStatus,
        updatedAt: new Date(),
        ...(patch.renderAssetId !== undefined ? { renderAssetId: patch.renderAssetId } : {}),
        ...(patch.renderError !== undefined ? { renderError: patch.renderError } : {}),
      })
      .where(and(eq(videoProjects.id, id), eq(videoProjects.projectId, projectId)));
  }

  async applyScript(
    projectId: string,
    id: string,
    script: VideoScript,
    scenes: CreateVideoSceneInput[]
  ): Promise<void> {
    const now = new Date();
    const rows = scenes.map((s) => newVideoSceneRow(id, s, now));
    await this.db.transaction(async (tx) => {
      const [parent] = await tx
        .select({ id: videoProjects.id })
        .from(videoProjects)
        .where(and(eq(videoProjects.id, id), eq(videoProjects.projectId, projectId)));
      if (!parent) throw new Error(`Video project "${id}" does not exist in project "${projectId}".`);

      // Replace, not merge: a re-plan's scene indices are the new script's, and any surviving
      // row from the previous storyboard would collide with the `(video_project_id,
      // scene_index)` unique index or, worse, quietly render as part of the new video.
      await tx.delete(videoScenes).where(eq(videoScenes.videoProjectId, id));
      if (rows.length > 0) await tx.insert(videoScenes).values(rows);

      await tx
        .update(videoProjects)
        .set({
          script,
          sceneCount: rows.length,
          status: "generating_scenes",
          updatedAt: now,
        })
        .where(and(eq(videoProjects.id, id), eq(videoProjects.projectId, projectId)));
    });
  }

  async claimRenderSlot(videoProjectId: string): Promise<boolean> {
    const now = new Date();
    const claimed = await this.db
      .update(videoProjects)
      .set({ renderRequestedAt: now, updatedAt: now })
      .where(and(eq(videoProjects.id, videoProjectId), isNull(videoProjects.renderRequestedAt)))
      .returning({ id: videoProjects.id });
    return claimed.length > 0;
  }

  async releaseRenderSlot(videoProjectId: string): Promise<void> {
    await this.db
      .update(videoProjects)
      .set({ renderRequestedAt: null, updatedAt: new Date() })
      .where(eq(videoProjects.id, videoProjectId));
  }

  async requestCancel(projectId: string, id: string): Promise<boolean> {
    const now = new Date();
    const claimed = await this.db
      .update(videoProjects)
      .set({ cancelRequestedAt: now, updatedAt: now })
      .where(
        and(
          eq(videoProjects.id, id),
          eq(videoProjects.projectId, projectId),
          isNull(videoProjects.cancelRequestedAt),
          inArray(videoProjects.status, [...IN_FLIGHT_STATUSES])
        )
      )
      .returning({ id: videoProjects.id });
    return claimed.length > 0;
  }

  async get(projectId: string, id: string): Promise<VideoProject | undefined> {
    const [row] = await this.db
      .select()
      .from(videoProjects)
      .where(and(eq(videoProjects.id, id), eq(videoProjects.projectId, projectId)));
    return row as VideoProject | undefined;
  }

  async list(projectId: string): Promise<VideoProject[]> {
    return (await this.db
      .select()
      .from(videoProjects)
      .where(eq(videoProjects.projectId, projectId))
      .orderBy(desc(videoProjects.createdAt))) as VideoProject[];
  }
}
