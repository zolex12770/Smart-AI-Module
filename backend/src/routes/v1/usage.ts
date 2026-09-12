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
 * configuration and so are the same numbers for every project on the deployment — what is
 * per-project is the *usage measured against them*, since every aggregate above and every
 * `QuotaManager` check now filters on the project id. Per-project limit *values* would be
 * configuration this platform does not yet store anywhere, so the response says what is
 * actually enforced rather than implying a per-project number that does not exist.
 */
export function registerUsageRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/v1/usage", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "usage:read");
    const projectId = scopeOf(authCtx);
    const limits = ctx.quota.getLimits();
    const now = new Date();
    const [tokensToday, tokensThisMonth, imagesToday, videoSecondsThisMonth, estimatedCostUsdThisMonth] = await Promise.all([
      ctx.usage.sumLlmTokensSince(projectId, startOfDay(now)),
      ctx.usage.sumLlmTokensSince(projectId, startOfMonth(now)),
      ctx.usage.countImagesSince(projectId, startOfDay(now)),
      ctx.usage.sumVideoSecondsSince(projectId, startOfMonth(now)),
      ctx.usage.sumLlmCostUsdSince(projectId, startOfMonth(now)),
    ]);

    return {
      projectId,
      usage: {
        llm: { tokensToday, tokensThisMonth, estimatedCostUsdThisMonth, pricedCallsOnly: true },
        images: { generatedToday: imagesToday },
        video: { secondsGeneratedThisMonth: videoSecondsThisMonth },
      },
      limits: {
        dailyTokenLimit: limits.dailyTokenLimit ?? null,
        monthlyTokenLimit: limits.monthlyTokenLimit ?? null,
        dailyImageLimit: limits.dailyImageLimit ?? null,
        monthlyVideoSecondsLimit: limits.monthlyVideoSecondsLimit ?? null,
      },
    };
  });
}
