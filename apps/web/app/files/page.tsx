"use client";

import { useEffect, useRef, useState } from "react";
import { ingestFile, listFiles, uploadFile, type DocumentRecord } from "../lib/api";
import { badgeClass, StatusBadge } from "../lib/status-badge";

export default function FilesPage() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [path, setPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await uploadFile(file);
      if (fileInput.current) fileInput.current.value = "";
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setUploading(false);
    }
  }

  function refresh() {
    listFiles()
      .then((r) => setDocuments(r.documents))
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!path.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await ingestFile(path.trim());
      setPath("");
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
          <h1>Files &amp; retrieval (RAG)</h1>
          <p className="page-subtitle">
            Ingests a real file into chunked, embedded, pgvector-searchable storage (docs/09_RAG_ARCHITECTURE.md) as a
            real async job. Upload a file directly (stored under a generated key in the asset store — local disk or
            Cloud Storage), or, for local development, point at a path relative to the API server&apos;s sandbox
            directory (<code>SANDBOX_ROOT</code>). Plain text/Markdown, PDF, and DOCX all ingest for real — CSV
            isn&apos;t parsed yet.
          </p>
        </div>
      </div>

      <form className="card" onSubmit={handleUpload}>
        <div className="form-row">
          <label style={{ flex: 1, minWidth: 240 }}>
            Upload a document (.txt, .md, .pdf, .docx — up to 25 MB)
            <input ref={fileInput} type="file" accept=".txt,.md,.pdf,.docx" />
          </label>
          <button className="btn" type="submit" disabled={uploading}>
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </div>
      </form>

      <form className="card" onSubmit={handleSubmit}>
        <div className="form-row">
          <label style={{ flex: 1, minWidth: 240 }}>
            Or: sandbox-relative path (local dev only)
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="handbook.txt" />
          </label>
          <button className="btn" type="submit" disabled={submitting || !path.trim()}>
            {submitting ? "Ingesting…" : "Ingest"}
          </button>
        </div>
      </form>

      {error && <p className="error-text">{error}</p>}
      {documents.length === 0 && <p className="empty-state">No documents ingested yet.</p>}

      <div className="card-list">
        {documents.map((d) => (
          <div key={d.id} className="card card-row">
            <div>
              <strong>{d.filename}</strong>
              <div className="page-subtitle">
                {d.sourcePath ?? (d.assetId ? `uploaded · asset ${d.assetId.slice(0, 8)}…` : "uploaded")}
                {d.scanStatus && (
                  <>
                    {" · scan: "}
                    <span className={badgeClass(d.scanStatus === "clean" ? "ready" : d.scanStatus === "skipped_no_scanner" ? "" : d.scanStatus)}>
                      {d.scanStatus === "skipped_no_scanner" ? "not scanned (no scanner configured)" : d.scanStatus}
                    </span>
                  </>
                )}
              </div>
              {d.errorMessage && <p className="error-text">{d.errorMessage}</p>}
            </div>
            <StatusBadge status={d.status} />
          </div>
        ))}
      </div>
    </div>
  );
}
