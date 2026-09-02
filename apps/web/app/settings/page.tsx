"use client";

import { useEffect, useState } from "react";
import { addMemory, deleteMemory, listMemory, type MemoryItem } from "../lib/api";

const SCOPES: MemoryItem["scope"][] = ["user", "project", "conversation", "task", "semantic"];

export default function SettingsPage() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<MemoryItem["scope"]>("user");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listMemory()
      .then((r) => setItems(r.items))
      .catch((e) => setError(String(e)));
  }

  useEffect(refresh, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await addMemory(scope, content.trim());
      setContent("");
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    await deleteMemory(id);
    refresh();
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Settings — Memory</h1>
          <p className="page-subtitle">
            Real, user-visible, user-deletable memory items (FR-032). Storage/list/delete is real; nothing here yet
            *generates* a summary via LLM reasoning — the same honest constraint as the agent planner
            (docs/26_DECISIONS.md ADR-018). Account/API-key management isn't built — there's no auth system yet.
          </p>
        </div>
      </div>

      <form className="card" onSubmit={handleAdd}>
        <div className="form-row">
          <label>
            Scope
            <select value={scope} onChange={(e) => setScope(e.target.value as MemoryItem["scope"])}>
              {SCOPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: 1, minWidth: 240 }}>
            Content
            <input value={content} onChange={(e) => setContent(e.target.value)} placeholder="Remember that..." />
          </label>
          <button className="btn" type="submit" disabled={submitting || !content.trim()}>
            Add
          </button>
        </div>
      </form>

      {error && <p className="error-text">{error}</p>}
      {items.length === 0 && <p className="empty-state">No memory items yet.</p>}

      <div className="card-list">
        {items.map((item) => (
          <div key={item.id} className="card card-row">
            <div>
              <span className="badge badge-muted">{item.scope}</span>
              <p style={{ margin: "6px 0 0" }}>{item.content}</p>
            </div>
            <button className="btn btn-secondary" onClick={() => handleDelete(item.id)}>
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
