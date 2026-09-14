"use client";

import { use, useEffect, useState } from "react";
import { assetUrl, cancelVideo, getVideo, retryVideo, type VideoProject, type VideoScene } from "../../lib/api";
import { StatusBadge } from "../../lib/status-badge";

export default function VideoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [project, setProject] = useState<VideoProject | null>(null);
  const [scenes, setScenes] = useState<VideoScene[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  function refresh() {
    getVideo(id)
      .then((r) => {
        setProject(r.project);
        setScenes(r.scenes);
      })
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [id]);

  async function handleRetry() {
    setRetrying(true);
    try {
      await retryVideo(id);
      refresh();
    } finally {
      setRetrying(false);
    }
  }

  /** Stops scenes that have not started yet (ADR-122); one already generating finishes. */
  async function handleCancel() {
    setCancelling(true);
    try {
      await cancelVideo(id);
      refresh();
    } finally {
      setCancelling(false);
    }
  }

  if (error) return <div className="page error-text">{error}</div>;
  if (!project) return <div className="page empty-state">Loading…</div>;

  const hasFailedScenes = scenes.some((s) => s.status === "failed");

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{project.prompt}</h1>
          <p className="page-subtitle">{project.id}</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <StatusBadge status={project.status} />
          {hasFailedScenes && (
            <button className="btn" disabled={retrying} onClick={handleRetry}>
              {retrying ? "Retrying…" : "Retry failed scenes"}
            </button>
          )}
          {["generating_scenes", "assembling"].includes(project.status) && !project.cancelRequestedAt && (
            <button className="btn" type="button" disabled={cancelling} onClick={handleCancel}>
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          )}
          {project.cancelRequestedAt && <span className="page-subtitle">Cancellation requested</span>}
        </div>
      </div>

      {project.script ? (
        <div className="card">
          <strong>Script</strong>
          <p style={{ marginTop: 8 }}>{project.script.title ?? "Untitled"}</p>
          {/*
            The most important line on this screen. A storyboard produced by the mechanical
            planner looks exactly like an authored one from the scene list alone, and presenting
            the former as a script would be the kind of fake completion the platform refuses
            (ADR-080). So it says which, every time.
          */}
          {project.script.scriptSource === "model" ? (
            <p className="page-subtitle">Written by {project.script.model ?? "a model"}.</p>
          ) : (
            <p className="page-subtitle">
              No script was written — the scenes come from the deterministic planner.
              {project.script.fallbackReason ? ` ${project.script.fallbackReason}` : ""}
            </p>
          )}
        </div>
      ) : null}

      <div className="card">
        <strong>Final render</strong>
        {project.renderStatus === "succeeded" && project.renderAssetId ? (
          <video
            src={assetUrl(project.renderAssetId)}
            controls
            // The captions are served by the same authenticated asset route as the video, so the
            // track element needs the cookie too (ADR-122). Without this the <track> silently 401s.
            crossOrigin="use-credentials"
            style={{ width: "100%", marginTop: 8, borderRadius: 8 }}
          >
            {project.subtitleVttAssetId && (
              <track
                kind="captions"
                label="Narration"
                srcLang="en"
                default
                src={assetUrl(project.subtitleVttAssetId)}
              />
            )}
          </video>
        ) : (
          <div style={{ marginTop: 8 }}>
            <StatusBadge status={project.renderStatus ?? "pending"} />
            {project.renderError && <p className="page-subtitle">{project.renderError}</p>}
          </div>
        )}
      </div>

      <div className="card">
        <strong>Scenes ({scenes.length})</strong>
        <div className="grid" style={{ marginTop: 8 }}>
          {scenes.map((scene) => (
            <div key={scene.id} className="card">
              {scene.status === "succeeded" && scene.assetId ? (
                <img src={assetUrl(scene.assetId)} alt={scene.shotDescription} style={{ width: "100%", borderRadius: 8 }} />
              ) : (
                <div className="empty-state" style={{ height: 90, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {scene.status}
                </div>
              )}
              <p className="page-subtitle" style={{ marginTop: 6 }}>
                Scene {scene.sceneIndex + 1} · {scene.durationSeconds}s
              </p>
              {scene.narration ? (
                <>
                  <p style={{ marginTop: 6, fontStyle: "italic" }}>&ldquo;{scene.narration}&rdquo;</p>
                  {scene.audioAssetId ? (
                    // The real synthesised narration, playable. Its presence is also the only
                    // way to tell a scene that WAS narrated from one whose synthesis failed and
                    // was degraded to silent (ADR-079) — the line is written either way.
                    <audio src={assetUrl(scene.audioAssetId)} controls style={{ width: "100%", marginTop: 4 }} />
                  ) : (
                    <p className="page-subtitle">No audio — narration was not synthesised for this scene.</p>
                  )}
                </>
              ) : null}
              <StatusBadge status={scene.status} />
              {scene.lastError && <p className="error-text">{scene.lastError}</p>}
            </div>
          ))}
        </div>
      </div>

      {project.errorMessage && (
        <div className="card" style={{ borderColor: "var(--warning)" }}>
          <strong>Note</strong>
          <p className="page-subtitle">{project.errorMessage}</p>
        </div>
      )}
    </div>
  );
}
