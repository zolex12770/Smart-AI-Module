import { eq } from "drizzle-orm";
import type { ImageGenerationRequest } from "@ai-platform/shared";
import type { DrizzleDb } from "../client.js";
import { imageGenerations } from "../schema/index.js";

export type ImageGenerationStatus = "pending" | "processing" | "succeeded" | "failed";

export interface ImageGeneration {
  id: string;
  prompt: string;
  request: ImageGenerationRequest;
  status: ImageGenerationStatus;
  providerName: string | null;
  resultAssetId: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ImageGenerationRepository {
  create(id: string, request: ImageGenerationRequest): Promise<ImageGeneration>;
  updateStatus(
    id: string,
    status: ImageGenerationStatus,
    patch?: { providerName?: string; resultAssetId?: string; errorMessage?: string }
  ): Promise<void>;
  get(id: string): Promise<ImageGeneration | undefined>;
  list(): Promise<ImageGeneration[]>;
}

export class PgImageGenerationRepository implements ImageGenerationRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(id: string, request: ImageGenerationRequest): Promise<ImageGeneration> {
    const now = new Date();
    const row = {
      id,
      prompt: request.prompt,
      request,
      status: "pending" as ImageGenerationStatus,
      providerName: null,
      resultAssetId: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(imageGenerations).values(row);
    return row;
  }

  async updateStatus(
    id: string,
    status: ImageGenerationStatus,
    patch?: { providerName?: string; resultAssetId?: string; errorMessage?: string }
  ): Promise<void> {
    await this.db
      .update(imageGenerations)
      .set({
        status,
        updatedAt: new Date(),
        ...(patch?.providerName !== undefined ? { providerName: patch.providerName } : {}),
        ...(patch?.resultAssetId !== undefined ? { resultAssetId: patch.resultAssetId } : {}),
        ...(patch?.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      })
      .where(eq(imageGenerations.id, id));
  }

  async get(id: string): Promise<ImageGeneration | undefined> {
    const [row] = await this.db.select().from(imageGenerations).where(eq(imageGenerations.id, id));
    return row as ImageGeneration | undefined;
  }

  async list(): Promise<ImageGeneration[]> {
    return (await this.db.select().from(imageGenerations)) as ImageGeneration[];
  }
}
