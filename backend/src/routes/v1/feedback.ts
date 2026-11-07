import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { ValidationError, type AuthContext } from "@ai-platform/shared";
import type { AppContext } from "../../context.js";
import { requireProject } from "../../plugins/auth.js";

function scopedProjectId(authCtx: AuthContext): string {
  if (!authCtx.projectId) {
    throw new ValidationError("A projectId is required (send it as a query parameter or in the body).");
  }
  return authCtx.projectId;
}

const submitFeedbackSchema = z.object({
  conversationId: z.string().max(200).optional(),
  messageIndex: z.number().int().nonnegative().optional(),
  rating: z.enum(["satisfied", "partially_satisfied", "needs_improvement"]),
  categoryTag: z.string().max(100).optional(),
  userNotes: z.string().max(2000).optional(),
});

let isInitialized = false;

export async function initFeedbackTable(db: AppContext["db"]): Promise<void> {
  if (isInitialized) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS user_feedback (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        conversation_id TEXT,
        message_index INTEGER,
        rating TEXT NOT NULL,
        category_tag TEXT,
        user_notes TEXT,
        created_at TIMESTAMPTZ NOT NULL
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_user_feedback_project ON user_feedback (project_id)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_user_feedback_conversation ON user_feedback (conversation_id)
    `);
    isInitialized = true;
  } catch (err) {
    console.error("[initFeedbackTable] Schema initialization error:", err);
  }
}

export function registerFeedbackRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Ensure the table exists on first route setup
  void initFeedbackTable(ctx.db);

  // Endpoint: POST /api/v1/feedback
  app.post("/api/v1/feedback", async (request, reply) => {
    await initFeedbackTable(ctx.db);
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    const parsed = submitFeedbackSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        issues: parsed.error.issues,
      });
    }

    const { conversationId, messageIndex, rating, categoryTag, userNotes } = parsed.data;
    const id = uuid();
    const createdAt = new Date().toISOString();

    const projectId = scopedProjectId(authCtx);

    await ctx.db.execute(sql`
      INSERT INTO user_feedback (
        id, project_id, user_id, conversation_id, message_index, rating, category_tag, user_notes, created_at
      ) VALUES (
        ${id}, ${projectId}, ${authCtx.user.id}, ${conversationId ?? null},
        ${messageIndex ?? null}, ${rating}, ${categoryTag ?? null}, ${userNotes ?? null}, NOW()
      )
    `);

    return reply.status(201).send({
      ok: true,
      id,
      rating,
      categoryTag: categoryTag ?? null,
      createdAt,
    });
  });

  // Endpoint: GET /api/v1/feedback
  app.get("/api/v1/feedback", async (request) => {
    await initFeedbackTable(ctx.db);
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    const projectId = scopedProjectId(authCtx);

    const result = await ctx.db.execute(sql`
      SELECT id, project_id as "projectId", user_id as "userId",
             conversation_id as "conversationId", message_index as "messageIndex",
             rating, category_tag as "categoryTag", user_notes as "userNotes",
             created_at as "createdAt"
      FROM user_feedback
      WHERE project_id = ${projectId}
      ORDER BY created_at DESC
      LIMIT 100
    `);

    const rawRows = (result as { rows?: unknown[] }).rows ?? (Array.isArray(result) ? result : []);
    const rows = rawRows as Array<{
      id: string;
      projectId: string;
      userId: string;
      conversationId: string | null;
      messageIndex: number | null;
      rating: "satisfied" | "partially_satisfied" | "needs_improvement";
      categoryTag: string | null;
      userNotes: string | null;
      createdAt: string;
    }>;
    let satisfiedCount = 0;
    let partiallySatisfiedCount = 0;
    let needsImprovementCount = 0;
    const categoryBreakdown: Record<string, number> = {};

    for (const r of rows) {
      if (r.rating === "satisfied") satisfiedCount++;
      else if (r.rating === "partially_satisfied") partiallySatisfiedCount++;
      else if (r.rating === "needs_improvement") needsImprovementCount++;

      if (r.categoryTag) {
        categoryBreakdown[r.categoryTag] = (categoryBreakdown[r.categoryTag] || 0) + 1;
      }
    }

    const totalCount = rows.length;
    const satisfactionRate =
      totalCount > 0 ? Math.round(((satisfiedCount + partiallySatisfiedCount) / totalCount) * 100) : 100;

    return {
      feedback: rows,
      summary: {
        totalCount,
        satisfiedCount,
        partiallySatisfiedCount,
        needsImprovementCount,
        satisfactionRate,
        categoryBreakdown,
      },
    };
  });
}
