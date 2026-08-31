import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import { videoProjects } from "../schema/index.js";

export type VideoProjectStatus = "generating_scenes" | "assembling" | "succeeded" | "partially_succeeded" | "failed";
export type VideoRenderStatus = "pending" | "processing" | "succeeded" | "skipped_no_ffmpeg" | "failed";

export interface VideoProject {
  id: string;
  prompt: string;
  targetDurationSeconds: number;
  sceneClipSeconds: number;
  sceneCount: number;
  status: VideoProjectStatus;
  renderStatus: VideoRenderStatus | null;
  renderAssetId: string | null;
  renderError: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateVideoProjectInput {
  id: string;
  prompt: string;
  targetDurationSeconds: number;
  sceneClipSeconds: number;
  sceneCount: number;
}

export interface VideoProjectRepository {
  create(input: CreateVideoProjectInput): Promise<VideoProject>;
  updateStatus(id: string, status: VideoProjectStatus, patch?: { errorMessage?: string }): Promise<void>;
  updateRender(
    id: string,
    patch: { renderStatus: VideoRenderStatus; renderAssetId?: string; renderError?: string }
  ): Promise<void>;
  get(id: string): Promise<VideoProject | undefined>;
  list(): Promise<VideoProject[]>;
}

export class PgVideoProjectRepository implements VideoProjectRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: CreateVideoProjectInput): Promise<VideoProject> {
    const now = new Date();
    const row: VideoProject = {
      ...input,
      status: "generating_scenes",
      renderStatus: null,
      renderAssetId: null,
      renderError: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(videoProjects).values(row);
    return row;
  }

  async updateStatus(id: string, status: VideoProjectStatus, patch?: { errorMessage?: string }): Promise<void> {
    await this.db
      .update(videoProjects)
      .set({
        status,
        updatedAt: new Date(),
        ...(patch?.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      })
      .where(eq(videoProjects.id, id));
  }

  async updateRender(
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
      .where(eq(videoProjects.id, id));
  }

  async get(id: string): Promise<VideoProject | undefined> {
    const [row] = await this.db.select().from(videoProjects).where(eq(videoProjects.id, id));
    return row as VideoProject | undefined;
  }

  async list(): Promise<VideoProject[]> {
    return (await this.db.select().from(videoProjects)) as VideoProject[];
  }
}
