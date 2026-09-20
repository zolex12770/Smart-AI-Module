import type { FastifyInstance } from "fastify";
import { PermissionError, type AuthContext } from "@ai-platform/shared";
import type { AppContext } from "../../context.js";
import { requireProject } from "../../plugins/auth.js";

/**
 * Day and month boundaries in the server's local timezone. Both `usage_records.created_at`
 * and these are real instants (the column is `timestamptz` — ADR-049 made that schema-wide),
 * so the comparison is unambiguous; what is left is the choice of *where* the day starts,
 * and this deliberately matches `backend/packages/quota`'s identical boundaries. Reporting a UTC
 * window next to a limit enforced over a local-time window would let this endpoint say
 * "800 tokens used" while the quota manager refused the next call on a different total.
 */
function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** See rag.ts for why this is a checked narrowing rather than a `!` assertion. */
function scopeOf(authCtx: AuthContext): string {
  if (!authCtx.projectId) throw new PermissionError("This request is not scoped to a project.");
  return authCtx.projectId;
}

/**
 * GET /api/v1/usage — docs/15_API_ARCHITECTURE.md's documented route, FR-061.
 *
 * Now per-project (ADR-049): every aggregate takes the caller's project id and filters on it
 * in SQL, so one tenant's spend can never be reported as — or charged against — another's.
 * The endpoint names `usage:read`, which every project role including `viewer` holds: seeing
 * what a project has spent is not a privileged action, spending it is.
 *
 * `estimatedCostUsdThisMonth` remains an honest lower bound, not a precise total — it only
 * sums calls with researched pricing (backend/packages/model-router/src/cost-estimator.ts), which
 * today is every real LLM provider's default model but not the mock provider.
 * `pricedCallsOnly` keeps that limitation visible in the response itself rather than
 * silently undercounting.
 *
 * The `limits` block reports the configured ceilings, which are read from environment
 * configuration and so are the same numbers for every project on the deployment.
 *
 * The usage measured against them is the ORGANIZATION's — docs/26_DECISIONS.md ADR-150.
 *
 * This route reported per-project totals under per-deployment limits, and the paragraph here
 * used to say every `QuotaManager` check "now filters on the project id". ADR-126 stopped that:
 * spend ceilings draw against the tenant, because every limit being per project made a project
 * a button that bought more budget. The dashboard was never moved, so a user watched "412,000 of
 * 500,000 tokens" and was refused at 500,000 across all their projects — the screen and the
 * enforcement were measuring different things, and only one of them could stop a request.
 *
 * Both figures are reported now: `usage` is the organization total the limits are enforced
 * against, and `projectUsage` is this project's share of it, which is what a member of one
 * project actually wants to know. Naming them apart is the point — a single ambiguous number is
 * how the two drifted for an entire release.
 */
export function registerUsageRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/v1/usage", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "usage:read");
    const projectId = scopeOf(authCtx);
    const limits = ctx.quota.getLimits();
    const now = new Date();
    const [
      // The tenant aggregates — the same ones `QuotaManager` checks against (ADR-126).
      orgTokensToday,
      orgTokensThisMonth,
      orgImagesToday,
      orgVideoSecondsThisMonth,
      // And this project's share, kept as a secondary figure.
      tokensToday,
      tokensThisMonth,
      imagesToday,
      videoSecondsThisMonth,
      estimatedCostUsdThisMonth,
    ] = await Promise.all([
      ctx.usage.sumLlmTokensForTenantSince(projectId, startOfDay(now)),
      ctx.usage.sumLlmTokensForTenantSince(projectId, startOfMonth(now)),
      ctx.usage.countImagesForTenantSince(projectId, startOfDay(now)),
      ctx.usage.sumVideoSecondsForTenantSince(projectId, startOfMonth(now)),
      ctx.usage.sumLlmTokensSince(projectId, startOfDay(now)),
      ctx.usage.sumLlmTokensSince(projectId, startOfMonth(now)),
      ctx.usage.countImagesSince(projectId, startOfDay(now)),
      ctx.usage.sumVideoSecondsSince(projectId, startOfMonth(now)),
      ctx.usage.sumLlmCostUsdSince(projectId, startOfMonth(now)),
    ]);

    return {
      projectId,
      /** Organization-wide, because that is what the limits below are enforced against. */
      usage: {
        llm: {
          tokensToday: orgTokensToday,
          tokensThisMonth: orgTokensThisMonth,
          estimatedCostUsdThisMonth,
          pricedCallsOnly: true,
        },
        images: { generatedToday: orgImagesToday },
        video: { secondsGeneratedThisMonth: orgVideoSecondsThisMonth },
      },
      /** This project's share of it. Never compared against `limits` — nothing enforces it. */
      projectUsage: {
        llm: { tokensToday, tokensThisMonth },
        images: { generatedToday: imagesToday },
        video: { secondsGeneratedThisMonth: videoSecondsThisMonth },
      },
      /** Which scope `usage` describes, said in the payload rather than only in a docstring. */
      usageScope: "organization" as const,
      limits: {
        dailyTokenLimit: limits.dailyTokenLimit ?? null,
        monthlyTokenLimit: limits.monthlyTokenLimit ?? null,
        dailyImageLimit: limits.dailyImageLimit ?? null,
        monthlyVideoSecondsLimit: limits.monthlyVideoSecondsLimit ?? null,
      },
    };
  });
}
