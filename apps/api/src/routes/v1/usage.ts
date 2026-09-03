import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.js";

function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/**
 * GET /api/v1/usage — docs/15_API_ARCHITECTURE.md's documented route, FR-061. Single-
 * operator scope (ADR-008): no per-user breakdown, since there's exactly one operator.
 * `estimatedCostUsdThisMonth` is an honest lower bound, not a precise total — it only sums
 * calls with researched pricing (packages/model-router/src/cost-estimator.ts), currently
 * every real LLM provider's default model but not the mock provider — `pricedCallsOnly`
 * makes that limitation visible in the response itself rather than silently undercounting.
 */
export function registerUsageRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/v1/usage", async () => {
    const now = new Date();
    const [tokensToday, tokensThisMonth, imagesToday, videoSecondsThisMonth, estimatedCostUsdThisMonth] = await Promise.all([
      ctx.usage.sumLlmTokensSince(startOfDay(now)),
      ctx.usage.sumLlmTokensSince(startOfMonth(now)),
      ctx.usage.countImagesSince(startOfDay(now)),
      ctx.usage.sumVideoSecondsSince(startOfMonth(now)),
      ctx.usage.sumLlmCostUsdSince(startOfMonth(now)),
    ]);

    return {
      usage: {
        llm: { tokensToday, tokensThisMonth, estimatedCostUsdThisMonth, pricedCallsOnly: true },
        images: { generatedToday: imagesToday },
        video: { secondsGeneratedThisMonth: videoSecondsThisMonth },
      },
      limits: {
        dailyTokenLimit: ctx.quota.getLimits().dailyTokenLimit ?? null,
        monthlyTokenLimit: ctx.quota.getLimits().monthlyTokenLimit ?? null,
        dailyImageLimit: ctx.quota.getLimits().dailyImageLimit ?? null,
        monthlyVideoSecondsLimit: ctx.quota.getLimits().monthlyVideoSecondsLimit ?? null,
      },
    };
  });
}
