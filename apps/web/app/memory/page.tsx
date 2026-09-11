"use client";

import { useCallback, useEffect, useState } from "react";
import { addMemory, deleteMemory, listMemory, type MemoryItem } from "../lib/api";
import { RequireSession, useSession } from "../lib/session-context";

/**
 * What the platform remembers about you — docs/26_DECISIONS.md ADR-063 (the subsystem),
 * ADR-084 (this screen).
 *
 * `listMemory`, `addMemory` and `deleteMemory` have existed in the API client since the memory
 * work landed and NOTHING rendered them. That is a worse gap here than for most endpoints: memory
 * silently changes what the model answers (ADR-063 injects it into the prompt), so a user who
 * cannot see what is stored cannot explain a surprising answer, and cannot remove the fact that
 * caused it. Stored memory a user can neither inspect nor delete is the thing this screen exists
 * to prevent.
 */

const SCOPES: Array<{ value: MemoryItem["scope"]; label: string; help: string }> = [
  { value: "user", label: "About me", help: "Recalled in every conversation in this project." },
  { value: "project", label: "About this project", help: "Shared context for everyone in the project." },
  {
    value: "semantic",
    label: "General knowledge",
    help: "A durable fact, not tied to a person or a thread.",
  },
];

export default function MemoryPage() {
  return (
    <RequireSession>
      <MemoryView />
    </RequireSession>
  );
}

function MemoryView() {
  const { projectId } = useSession();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<MemoryItem["scope"]>("user");
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await listMemory();
      setItems(result.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, projectId]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = content.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await addMemory(scope, trimmed);
      setContent("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(item: MemoryItem) {
    setBusy(item.id);
    setError(null);
    try {
      await deleteMemory(item.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h1>Memory</h1>
      <p className="page-subtitle">
        Facts stored here are retrieved and added to the model&apos;s context when they look relevant to what
        you ask. Deleting one stops it being recalled.
      </p>

      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      <form onSubmit={handleAdd} style={{ display: "grid", gap: 8, maxWidth: 680, margin: "16px 0" }}>
        <label htmlFor="memory-content">Remember something</label>
        <textarea
          id="memory-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
          maxLength={8000}
          placeholder="e.g. I prefer TypeScript examples over JavaScript."
        />
        <label htmlFor="memory-scope">Scope</label>
        <select
          id="memory-scope"
          value={scope}
          onChange={(e) => setScope(e.target.value as MemoryItem["scope"])}
        >
          {SCOPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        {/* The scope decides when a fact is recalled, which is not guessable from its name. */}
        <p className="page-subtitle">{SCOPES.find((s) => s.value === scope)?.help}</p>
        <button type="submit" className="btn" disabled={saving || content.trim() === ""}>
          {saving ? "Saving…" : "Remember"}
        </button>
      </form>

      <h2>Stored</h2>
      {!loaded ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        // An empty state, not an empty table: "nothing is stored" is a normal, reassuring answer
        // to "what do you know about me", and a blank table reads as a broken screen.
        <p>Nothing is stored yet. Anything you add above will be recalled when it is relevant.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Fact</th>
              <th scope="col">Scope</th>
              <th scope="col">Recalled</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.content}</td>
                <td>{SCOPES.find((s) => s.value === item.scope)?.label ?? item.scope}</td>
                {/* How often it has actually been used. A fact stored months ago and never
                    recalled is a different thing from one shaping every answer, and only this
                    column tells them apart. */}
                <td>{item.useCount ?? 0}×</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy === item.id}
                    onClick={() => void handleDelete(item)}
                  >
                    {busy === item.id ? "Forgetting…" : "Forget"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
