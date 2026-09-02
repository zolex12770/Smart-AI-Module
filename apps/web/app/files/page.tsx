"use client";

import { useEffect, useState } from "react";
import { ingestFile, listFiles, type DocumentRecord } from "../lib/api";
import { StatusBadge } from "../lib/status-badge";

export default function FilesPage() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [path, setPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
            real async job — no synchronous upload widget exists yet, so the path below is relative to the API
            server's own sandbox directory (<code>SANDBOX_ROOT</code>), not a browser file picker. Plain text/Markdown
            only — PDF/DOCX parsing isn't built yet.
          </p>
        </div>
      </div>

      <form className="card" onSubmit={handleSubmit}>
        <div className="form-row">
          <label style={{ flex: 1, minWidth: 240 }}>
            Sandbox-relative path
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
              <div className="page-subtitle">{d.sourcePath}</div>
              {d.errorMessage && <p className="error-text">{d.errorMessage}</p>}
            </div>
            <StatusBadge status={d.status} />
          </div>
        ))}
      </div>
    </div>
  );
}
