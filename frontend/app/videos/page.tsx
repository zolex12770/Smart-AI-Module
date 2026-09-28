"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createVideo, getProviders, listVideos, type MediaProviderInfo, type VideoProject } from "../lib/api";
import { StatusBadge } from "../lib/status-badge";

export default function VideosPage() {
  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [prompt, setPrompt] = useState("");
  const [targetDurationSeconds, setTargetDurationSeconds] = useState(16);
  const [sceneClipSeconds, setSceneClipSeconds] = useState(4);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoProvider, setVideoProvider] = useState<MediaProviderInfo | null>(null);

  function refresh() {
    listVideos()
      .then((r) => setProjects(r.projects))
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, []);

  // Asked once: what is actually going to make these clips? The answer decides what this page
  // is allowed to claim (ADR-124).
  useEffect(() => {
    getProviders()
      .then((r) => setVideoProvider(r.providers.video))
      .catch(() => setVideoProvider(null));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await createVideo({ prompt, targetDurationSeconds, sceneClipSeconds });
      setPrompt("");
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Long-form video generation</h1>
          <p className="page-subtitle">
            Scene-decomposition pipeline (docs/07_LONG_RUNNING_JOB_ARCHITECTURE.md Part 2). Final assembly needs
            ffmpeg where the job worker runs, and honestly reports when it isn&apos;t there.
          </p>
          {videoProvider && (
            <p className="page-subtitle">
              Clips come from <strong>{videoProvider.name ?? "no provider"}</strong>
              {videoProvider.isMock ? (
                <>
                  {" "}
                  — <strong>a mock</strong>: the output is a placeholder animation, not a generated video
                  (docs/26_DECISIONS.md ADR-030).
                </>
              ) : videoProvider.technique ? (
                <> — {videoProvider.technique}</>
              ) : null}
            </p>
          )}
        </div>
      </div>

      <form className="card" onSubmit={handleSubmit}>
        <div className="form-row">
          <label style={{ flex: 1, minWidth: 240 }}>
            Prompt
            <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="a lighthouse in a storm" />
          </label>
          <label>
            Target duration (s)
            <input
              type="number"
              min={4}
              value={targetDurationSeconds}
              onChange={(e) => setTargetDurationSeconds(Number(e.target.value))}
            />
          </label>
          <label>
            Scene length (s, max 8)
            <input
              type="number"
              min={2}
              max={8}
              value={sceneClipSeconds}
              onChange={(e) => setSceneClipSeconds(Number(e.target.value))}
            />
          </label>
          <button className="btn" type="submit" disabled={submitting || !prompt.trim()}>
            {submitting ? "Submitting…" : "Generate"}
          </button>
        </div>
      </form>

      {error && <p className="error-text">{error}</p>}
      {projects.length === 0 && <p className="empty-state">No video projects yet.</p>}

      <div className="card-list">
        {projects.map((p) => (
          <Link key={p.id} href={`/videos/${p.id}`} className="card card-row" style={{ textDecoration: "none", color: "inherit" }}>
            <div>
              <strong>{p.prompt}</strong>
              <div className="page-subtitle">
                {p.sceneCount} scene(s) · {p.targetDurationSeconds}s target · {new Date(p.createdAt).toLocaleString()}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <StatusBadge status={p.status} />
              {p.renderStatus && <StatusBadge status={p.renderStatus} />}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
