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
  usage: {
    llm: { tokensToday: number; tokensThisMonth: number; estimatedCostUsdThisMonth: number | null; pricedCallsOnly: boolean };
    images: { generatedToday: number };
    video: { secondsGeneratedThisMonth: number };
  };
  limits: {
    dailyTokenLimit: number | null;
    monthlyTokenLimit: number | null;
    dailyImageLimit: number | null;
    monthlyVideoSecondsLimit: number | null;
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

  const { usage, limits } = data;
  return (
    <section>
      <h1>Usage</h1>
      <p className="page-subtitle">Everything this project has spent, for the selected project only.</p>

      <div className="usage-grid">
        <Meter label="Tokens today" used={usage.llm.tokensToday} limit={limits.dailyTokenLimit} />
        <Meter label="Tokens this month" used={usage.llm.tokensThisMonth} limit={limits.monthlyTokenLimit} />
        <Meter label="Images today" used={usage.images.generatedToday} limit={limits.dailyImageLimit} />
        <Meter
          label="Video seconds this month"
          used={usage.video.secondsGeneratedThisMonth}
          limit={limits.monthlyVideoSecondsLimit}
        />
      </div>

      <h2>Estimated cost this month</h2>
      <p className="usage-cost">
        {usage.llm.estimatedCostUsdThisMonth === null
          ? "Unknown"
          : `$${usage.llm.estimatedCostUsdThisMonth.toFixed(4)}`}
      </p>
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
