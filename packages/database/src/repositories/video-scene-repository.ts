import { and, eq, ne } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import { videoScenes } from "../schema/index.js";

export type VideoSceneStatus = "pending" | "processing" | "succeeded" | "failed";

export interface VideoScene {
  id: string;
  projectId: string;
  sceneIndex: number;
  shotDescription: string;
  durationSeconds: number;
  status: VideoSceneStatus;
  jobId: string | null;
  assetId: string | null;
  retryCount: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateVideoSceneInput {
  id: string;
  projectId: string;
  sceneIndex: number;
  shotDescription: string;
  durationSeconds: number;
}

export interface VideoSceneRepository {
  createMany(scenes: CreateVideoSceneInput[]): Promise<VideoScene[]>;
  updateStatus(
    id: string,
    status: VideoSceneStatus,
    patch?: { jobId?: string; assetId?: string; lastError?: string; incrementRetry?: boolean }
  ): Promise<void>;
  get(id: string): Promise<VideoScene | undefined>;
  listByProject(projectId: string): Promise<VideoScene[]>;
  /** Scenes that still need a generation attempt — the resumability check from docs/07 §2.3. */
  listNotSucceeded(projectId: string): Promise<VideoScene[]>;
}

export class PgVideoSceneRepository implements VideoSceneRepository {
  constructor(private readonly db: DrizzleDb) {}

  async createMany(scenes: CreateVideoSceneInput[]): Promise<VideoScene[]> {
    const now = new Date();
    const rows: VideoScene[] = scenes.map((s) => ({
      ...s,
      status: "pending",
      jobId: null,
      assetId: null,
      retryCount: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }));
    if (rows.length > 0) await this.db.insert(videoScenes).values(rows);
    return rows;
  }

  async updateStatus(
    id: string,
    status: VideoSceneStatus,
    patch?: { jobId?: string; assetId?: string; lastError?: string; incrementRetry?: boolean }
  ): Promise<void> {
    const current = patch?.incrementRetry ? await this.get(id) : undefined;
    await this.db
      .update(videoScenes)
      .set({
        status,
        updatedAt: new Date(),
        ...(patch?.jobId !== undefined ? { jobId: patch.jobId } : {}),
        ...(patch?.assetId !== undefined ? { assetId: patch.assetId } : {}),
        ...(patch?.lastError !== undefined ? { lastError: patch.lastError } : {}),
        ...(patch?.incrementRetry ? { retryCount: (current?.retryCount ?? 0) + 1 } : {}),
      })
      .where(eq(videoScenes.id, id));
  }

  async get(id: string): Promise<VideoScene | undefined> {
    const [row] = await this.db.select().from(videoScenes).where(eq(videoScenes.id, id));
    return row as VideoScene | undefined;
  }

  async listByProject(projectId: string): Promise<VideoScene[]> {
    return (await this.db.select().from(videoScenes).where(eq(videoScenes.projectId, projectId))) as VideoScene[];
  }

  async listNotSucceeded(projectId: string): Promise<VideoScene[]> {
    return (await this.db
      .select()
      .from(videoScenes)
      .where(and(eq(videoScenes.projectId, projectId), ne(videoScenes.status, "succeeded")))) as VideoScene[];
  }
}
