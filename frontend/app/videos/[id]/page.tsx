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

  /**
   * What a retry can actually fix — docs/26_DECISIONS.md ADR-157.
   *
   * The Retry control was gated on a failed SCENE, and `processVideoRender` only runs once every
   * scene has succeeded — so a render that failed, or that was skipped because the deployment
   * had no ffmpeg, could never be retried from the product at all. Those are precisely the two
   * states a retry exists for: the scenes are generated and paid for, and only the assembly is
   * missing.
   */
  const hasFailedScenes = scenes.some((s) => s.status === "failed");
  const renderIncomplete = project.renderStatus === "failed" || project.renderStatus === "skipped_no_ffmpeg";
  const canRetry = hasFailedScenes || renderIncomplete;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{project.prompt}</h1>
          <p className="page-subtitle">{project.id}</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <StatusBadge status={project.status} />
          {canRetry && (
            <button className="btn" disabled={retrying} onClick={handleRetry}>
              {retrying ? "Retrying…" : hasFailedScenes ? "Retry failed scenes" : "Retry rendering"}
            </button>
          )}
          {["planning", "generating_scenes", "assembling"].includes(project.status) && !project.cancelRequestedAt && (
            <button className="btn" type="button" disabled={cancelling} onClick={handleCancel}>
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          )}
          {project.cancelRequestedAt && <span className="page-subtitle">Cancellation requested</span>}
        </div>
      </div>

      {project.status === "planning" ? (
        <div className="card" role="status">
          <strong>Writing the storyboard</strong>
          <p className="page-subtitle">
            The model is writing the script: one shot and one line of narration per scene. On a local model this
            can take a few minutes; the scenes start as soon as it is done.
          </p>
        </div>
      ) : null}

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
            <p className="page-subtitle">
              Written by {project.script.model ?? "a model"}.
              {/**
               * How much of it — docs/26_DECISIONS.md ADR-137.
               *
               * A model that described two shots for a five-scene video had those two cycled to
               * fill the remainder, and this line still said "Written by <model>" with nothing
               * to indicate that three of the five were copies. The padding is reasonable; the
               * unqualified claim was not.
               */}
              {typeof project.script.scenesWritten === "number" &&
              project.script.scenesWritten > 0 &&
              project.script.scenesWritten < (project.script.scenes?.length ?? 0) ? (
                <>
                  {" "}
                  It described {project.script.scenesWritten} of {project.script.scenes?.length} shots; the rest
                  repeat those, cycled to fill the requested duration.
                </>
              ) : null}
            </p>
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
