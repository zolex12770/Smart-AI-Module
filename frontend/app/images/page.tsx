"use client";

import { useEffect, useState } from "react";
import type { AspectRatio } from "@ai-platform/shared";
import { assetUrl, cancelImage, createImage, listImages, type ImageGeneration } from "../lib/api";
import { StatusBadge } from "../lib/status-badge";

const ASPECT_RATIOS: AspectRatio[] = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"];

export default function ImagesPage() {
  const [generations, setGenerations] = useState<ImageGeneration[]>([]);
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("1:1");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listImages()
      .then((r) => setGenerations(r.generations))
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    refresh();
    // Poll — generation runs async through a real job (docs/07 §1.6); a live SSE stream
    // wasn't built for this endpoint, so a short poll is the honest, working alternative.
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await createImage({ prompt, aspectRatio });
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
          <h1>Image generation</h1>
          <p className="page-subtitle">
            Runs on a mock provider until real image credentials are supplied (docs/26_DECISIONS.md ADR-009) —
            every image below is a real, clearly-labeled placeholder SVG, not a fake preview.
          </p>
        </div>
      </div>

      <form className="card" onSubmit={handleSubmit}>
        <div className="form-row">
          <label style={{ flex: 1, minWidth: 240 }}>
            Prompt
            <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="a lighthouse at dawn" />
          </label>
          <label>
            Aspect ratio
            <select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}>
              {ASPECT_RATIOS.map((ar) => (
                <option key={ar} value={ar}>
                  {ar}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" type="submit" disabled={submitting || !prompt.trim()}>
            {submitting ? "Submitting…" : "Generate"}
          </button>
        </div>
      </form>

      {error && <p className="error-text">{error}</p>}
      {generations.length === 0 && <p className="empty-state">No image generations yet.</p>}

      <div className="grid">
        {generations.map((g) => (
          <div key={g.id} className="card">
            {g.status === "succeeded" && g.resultAssetId ? (
              <img src={assetUrl(g.resultAssetId)} alt={g.prompt} style={{ width: "100%", borderRadius: 8 }} />
            ) : (
              <div className="empty-state" style={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {/* ADR-122 made `cancelled` reachable; without this branch a cancelled tile
                    said "Generating…" forever, with its own Cancel button already gone
                    (ADR-154). */}
                {g.status === "failed" ? "Failed" : g.status === "cancelled" ? "Cancelled" : "Generating…"}
              </div>
            )}
            <p className="mono" style={{ marginTop: 8 }}>
              {g.prompt}
            </p>
            <StatusBadge status={g.status} />
            {(g.status === "pending" || g.status === "processing") && (
              <button
                className="btn"
                type="button"
                onClick={async () => {
                  // Stops work that has not reached the provider yet (ADR-122).
                  try {
                    await cancelImage(g.id);
                    refresh();
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                Cancel
              </button>
            )}
            {g.errorMessage && <p className="error-text">{g.errorMessage}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
