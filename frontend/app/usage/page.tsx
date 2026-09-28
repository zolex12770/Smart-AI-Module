"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/auth-client";
import { RequireSession, useSession } from "../lib/session-context";

/**
 * Usage and quota (FR-061/FR-063, product brief §27).
 *
 * `GET /api/v1/usage` has existed since the cost/quota work but had no screen at all — an
 * audit finding. Spend that nobody can see is spend nobody controls.
 */
interface UsageResponse {
  /**
   * ORGANIZATION-wide, because that is what the limits are enforced against — ADR-126/ADR-150.
   *
   * This screen showed per-project totals under per-deployment limits and said so in its own
   * subtitle. The ceilings draw against the tenant, so a user watched "412,000 of 500,000" and
   * was refused at 500,000 across all their projects: the meter and the refusal were measuring
   * different things, and only one of them could stop a request.
   */
  usage: {
    llm: { tokensToday: number; tokensThisMonth: number; estimatedCostUsdThisMonth: number | null; pricedCallsOnly: boolean };
    images: { generatedToday: number };
    video: { secondsGeneratedThisMonth: number };
    /** Audit finding 22: enforced, and never reported until now. */
    embeddings?: { tokensToday: number; tokensThisMonth: number };
    speech?: { charactersToday: number; charactersThisMonth: number };
  };
  /** This project's share of it. Deliberately not compared against a limit: nothing enforces one. */
  projectUsage?: {
    llm: { tokensToday: number; tokensThisMonth: number; estimatedCostUsdThisMonth?: number | null };
    images: { generatedToday: number };
    video: { secondsGeneratedThisMonth: number };
    embeddings?: { tokensThisMonth: number };
    speech?: { charactersThisMonth: number };
  };
  limits: {
    dailyTokenLimit: number | null;
    monthlyTokenLimit: number | null;
    dailyImageLimit: number | null;
    monthlyVideoSecondsLimit: number | null;
    dailyEmbeddingTokenLimit?: number | null;
    monthlyEmbeddingTokenLimit?: number | null;
    dailySpeechCharacterLimit?: number | null;
    monthlySpeechCharacterLimit?: number | null;
  };
}

export default function UsagePage() {
  return (
    <RequireSession>
      <UsageView />
    </RequireSession>
  );
}

function UsageView() {
  const { projectId } = useSession();
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<UsageResponse>("/api/v1/usage"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load usage.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, projectId]);

  if (error) {
    return (
      <section>
        <h1>Usage</h1>
        <p className="auth-error" role="alert">
          {error}
        </p>
        <button type="button" onClick={() => void load()}>
          Retry
        </button>
      </section>
    );
  }
  if (!data) return <p className="page-state">Loading usage…</p>;

  const { usage, limits, projectUsage } = data;
  return (
    <section>
      <h1>Usage</h1>
      <p className="page-subtitle">
        Everything this organization has spent. The limits below are enforced across every project
        it owns (ADR-126), so these are the numbers a request is actually refused against.
      </p>

      <div className="usage-grid">
        <Meter label="Tokens today" used={usage.llm.tokensToday} limit={limits.dailyTokenLimit} />
        <Meter label="Tokens this month" used={usage.llm.tokensThisMonth} limit={limits.monthlyTokenLimit} />
        <Meter label="Images today" used={usage.images.generatedToday} limit={limits.dailyImageLimit} />
        <Meter
          label="Video seconds this month"
          used={usage.video.secondsGeneratedThisMonth}
          limit={limits.monthlyVideoSecondsLimit}
        />
        {usage.embeddings ? (
          <>
            <Meter label="Embedding tokens today" used={usage.embeddings.tokensToday} limit={limits.dailyEmbeddingTokenLimit ?? null} />
            <Meter
              label="Embedding tokens this month"
              used={usage.embeddings.tokensThisMonth}
              limit={limits.monthlyEmbeddingTokenLimit ?? null}
            />
          </>
        ) : null}
        {usage.speech ? (
          <>
            <Meter label="Speech characters today" used={usage.speech.charactersToday} limit={limits.dailySpeechCharacterLimit ?? null} />
            <Meter
              label="Speech characters this month"
              used={usage.speech.charactersThisMonth}
              limit={limits.monthlySpeechCharacterLimit ?? null}
            />
          </>
        ) : null}
      </div>

      {projectUsage && (
        <>
          <h2>This project&apos;s share</h2>
          <p className="auth-hint">
            What the selected project contributed to the totals above. It has no limit of its own.
          </p>
          <div className="usage-grid">
            <Meter label="Tokens today" used={projectUsage.llm.tokensToday} limit={null} />
            <Meter label="Tokens this month" used={projectUsage.llm.tokensThisMonth} limit={null} />
            <Meter label="Images today" used={projectUsage.images.generatedToday} limit={null} />
            <Meter
              label="Video seconds this month"
              used={projectUsage.video.secondsGeneratedThisMonth}
              limit={null}
            />
            {projectUsage.embeddings ? (
              <Meter label="Embedding tokens this month" used={projectUsage.embeddings.tokensThisMonth} limit={null} />
            ) : null}
            {projectUsage.speech ? (
              <Meter label="Speech characters this month" used={projectUsage.speech.charactersThisMonth} limit={null} />
            ) : null}
          </div>
        </>
      )}

      <h2>Estimated cost this month (organization)</h2>
      <p className="usage-cost">
        {usage.llm.estimatedCostUsdThisMonth === null
          ? "Unknown"
          : `$${usage.llm.estimatedCostUsdThisMonth.toFixed(4)}`}
      </p>
      {typeof projectUsage?.llm.estimatedCostUsdThisMonth === "number" ? (
        <p className="auth-hint">This project: ${projectUsage.llm.estimatedCostUsdThisMonth.toFixed(4)}</p>
      ) : null}
      {/* The API reports this honestly rather than implying a total it cannot compute. */}
      <p className="auth-hint">
        Calls made with a model that has no researched price contribute nothing to this figure rather than
        being counted as $0, so it is a lower bound, not a bill.
      </p>
    </section>
  );
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  return (
    <div className="usage-card">
      <span className="usage-card-label">{label}</span>
      <span className="usage-card-value">{used.toLocaleString()}</span>
      {limit === null ? (
        <span className="usage-card-limit">no limit configured</span>
      ) : (
        <>
          <span className="usage-card-limit">
            of {limit.toLocaleString()} ({pct}%)
          </span>
          <div className="usage-bar" role="progressbar" aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <div className="usage-bar-fill" style={{ width: `${pct}%` }} />
          </div>
        </>
      )}
    </div>
  );
}
