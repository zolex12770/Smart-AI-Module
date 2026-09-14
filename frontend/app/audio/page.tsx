"use client";

import { useEffect, useState } from "react";
import { assetUrl, cancelAudio, createAudio, listAudio, type AudioGeneration } from "../lib/api";
import { StatusBadge } from "../lib/status-badge";

/**
 * Speech generation — docs/26_DECISIONS.md ADR-114.
 *
 * Until this screen existed, text-to-speech was reachable only as a side effect of the long-form
 * video pipeline: there was no way for a person to ask this platform for audio. Each row below is
 * a real synthesis job, and the player is the produced file served from the asset route — not a
 * preview, not a placeholder.
 */
export default function AudioPage() {
  const [generations, setGenerations] = useState<AudioGeneration[]>([]);
  const [text, setText] = useState("");
  const [speed, setSpeed] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listAudio()
      .then((r) => setGenerations(r.generations))
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    refresh();
    // Synthesis runs through a real job (ADR-114), so the list polls like images and videos do.
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await createAudio({ text, speed });
      setText("");
      refresh();
    } catch (e) {
      // A deployment with no speech provider answers 501 with a message naming the setting;
      // showing it is more useful than a generic failure.
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel(id: string) {
    try {
      await cancelAudio(id);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Audio generation</h1>
          <p className="page-subtitle">
            Text to speech through the deployment&apos;s configured synthesiser. With{" "}
            <code>SPEECH_PROVIDER=piper</code> this runs offline on the same machine — the same binary and voice
            on Linux and Windows — and each clip below is a real WAV whose duration was measured from the file.
          </p>
        </div>
      </div>

      <form className="card" onSubmit={handleSubmit}>
        <label>
          Text
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="The quick brown fox jumps over the lazy dog."
            rows={3}
            maxLength={5000}
          />
        </label>
        <div className="form-row">
          <label>
            Speed
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              <option value={0.75}>0.75× (slower)</option>
              <option value={1}>1× (natural)</option>
              <option value={1.25}>1.25×</option>
              <option value={1.5}>1.5× (faster)</option>
            </select>
          </label>
          <button className="btn" type="submit" disabled={submitting || !text.trim()}>
            {submitting ? "Submitting…" : "Generate speech"}
          </button>
          <span className="page-subtitle">{text.length}/5000</span>
        </div>
      </form>

      {error && <p className="error-text">{error}</p>}
      {generations.length === 0 && <p className="empty-state">No audio generations yet.</p>}

      <div className="grid">
        {generations.map((g) => (
          <div key={g.id} className="card">
            <p className="mono">{g.text}</p>
            <StatusBadge status={g.status} />
            {g.status === "succeeded" && g.resultAssetId && (
              <>
                <audio controls preload="none" src={assetUrl(g.resultAssetId)} style={{ width: "100%", marginTop: 8 }} />
                <p className="page-subtitle">
                  {g.voiceName ?? "default voice"}
                  {g.durationSeconds !== null ? ` · ${g.durationSeconds.toFixed(1)}s` : " · duration not measured"}
                  {g.providerName ? ` · ${g.providerName}` : ""}
                </p>
                <a className="btn" href={assetUrl(g.resultAssetId)} download>
                  Download
                </a>
              </>
            )}
            {(g.status === "pending" || g.status === "processing") && (
              <button className="btn" type="button" onClick={() => handleCancel(g.id)}>
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
