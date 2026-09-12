"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyCreated,
  type ApiKeySummary,
} from "../lib/api";
import { createProject } from "../lib/auth-client";
import { RequireSession, useSession } from "../lib/session-context";

/**
 * Account and project settings.
 *
 * This screen used to render a second, older copy of the memory list/add/delete that `/memory`
 * now owns, and told a signed-in user "Account/API-key management isn't built — there's no auth
 * system yet" — which stopped being true when ADR-049 landed the whole session, project and
 * API-key stack. A duplicated screen drifts from the one that is maintained, and a screen that
 * denies the auth system the user just signed in through is worse than no screen: it teaches
 * them the platform has no key management when the API has had `/api/v1/api-keys` all along.
 *
 * So it is now the settings screen the nav entry always promised, over endpoints that really
 * exist: the projects from the session, `POST /api/v1/projects` to add one, the API-key
 * triple, and sign-out. Memory lives at `/memory` and is linked, not re-implemented.
 */
export default function SettingsPage() {
  return (
    // `requireProject={false}`: an account with no project is told to "create one from
    // Settings", and this is that screen — it has to render before a project exists.
    <RequireSession requireProject={false}>
      <SettingsView />
    </RequireSession>
  );
}

function SettingsView() {
  const { user, projects, projectId, selectProject, refresh, signOut } = useSession();

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="page-subtitle">
            Your account, the projects you can act in, and the API keys that authenticate
            requests made outside this browser.
          </p>
        </div>
      </div>

      <div className="card">
        <strong>Account</strong>
        <p style={{ margin: "6px 0 0" }}>
          {user?.displayName} — {user?.email}
        </p>
        {user?.isSystemAdmin ? <p className="page-subtitle">System administrator.</p> : null}
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-secondary" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </div>

      <ProjectsCard
        projects={projects}
        projectId={projectId}
        selectProject={selectProject}
        refresh={refresh}
      />

      {/* Keys belong to a project, so there is nothing to show without one — and the request
          would be a 400 anyway, since `requireProject` has no scope to authorize. The `key`
          remounts the card on a switch: the previous project's keys under a new selection
          would misrepresent who can call the API. */}
      {projectId ? <ApiKeysCard key={projectId} /> : null}

      <div className="card">
        <strong>Memory</strong>
        {/* A link, not a second copy of the list. This screen carried its own memory
            list/add/delete alongside /memory's; two implementations of one feature drift, and
            the one nobody maintains is the one users find first. */}
        <p className="page-subtitle">
          What the platform remembers about you, and how often each fact has been recalled,
          lives on the <Link href="/memory">Memory</Link> screen.
        </p>
      </div>
    </section>
  );
}

function ProjectsCard({
  projects,
  projectId,
  selectProject,
  refresh,
}: {
  projects: Array<{ id: string; name: string; role: string }>;
  projectId: string | null;
  selectProject: (id: string) => void;
  refresh: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    try {
      const project = await createProject(trimmed);
      setName("");
      // The session is the source of truth for the project list and for the membership role
      // the server actually granted, so re-read it rather than trusting the local shape the
      // create call assembled; then switch to the new project so the nav switcher and every
      // subsequent request agree on what is selected.
      await refresh();
      selectProject(project.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="card">
      <strong>Projects</strong>
      <p className="page-subtitle">
        Every request this app makes is scoped to the selected project — data in one project is
        never visible from another.
      </p>

      <div className="card-list" style={{ marginTop: 8 }}>
        {projects.map((p) => (
          <div key={p.id} className="card card-row">
            <div>
              <strong>{p.name}</strong>
              <div className="page-subtitle">
                {p.role}
                {p.id === projectId ? " · selected" : ""}
              </div>
            </div>
            {p.id === projectId ? (
              <span className="badge badge-success">Selected</span>
            ) : (
              <button type="button" className="btn btn-secondary" onClick={() => selectProject(p.id)}>
                Switch to
              </button>
            )}
          </div>
        ))}
      </div>

      <form className="form-row" onSubmit={handleCreate} style={{ marginTop: 12 }}>
        <label style={{ flex: 1, minWidth: 240 }}>
          New project name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Research" />
        </label>
        <button className="btn" type="submit" disabled={creating || name.trim() === ""}>
          {creating ? "Creating…" : "Create project"}
        </button>
      </form>
      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ApiKeysCard() {
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await listApiKeys();
      setKeys(result.apiKeys);
      setError(null);
    } catch (e) {
      // `apikey:manage` is an admin permission, so an ordinary member gets a 403 here. That is
      // a correct answer to show, not a bug to hide — the list simply is not theirs to read.
      setKeys([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    try {
      setCreated(await createApiKey(trimmed));
      setName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(key: ApiKeySummary) {
    setBusyId(key.id);
    setError(null);
    try {
      await revokeApiKey(key.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card">
      <strong>API keys</strong>
      <p className="page-subtitle">
        For calling the API from a script or another service. A key acts only within this
        project, with the permissions of the member who created it.
      </p>

      {created ? (
        <div className="card" style={{ borderColor: "var(--warning)", marginTop: 8 }}>
          {/* The plaintext key exists in this one response and nowhere else — the server keeps
              only its SHA-256. If it is not copied now it can never be recovered, only
              replaced, so it is shown prominently and stays until dismissed. */}
          <strong>Copy this key now</strong>
          <p className="page-subtitle">{created.warning}</p>
          <pre className="mono">{created.key}</pre>
          <button type="button" className="btn btn-secondary" onClick={() => setCreated(null)}>
            I have stored it
          </button>
        </div>
      ) : null}

      <form className="form-row" onSubmit={handleCreate} style={{ marginTop: 12 }}>
        <label style={{ flex: 1, minWidth: 240 }}>
          Key name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ci-pipeline" />
        </label>
        <button className="btn" type="submit" disabled={creating || name.trim() === ""}>
          {creating ? "Creating…" : "Create key"}
        </button>
      </form>

      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      {keys === null ? (
        <p className="page-state">Loading keys…</p>
      ) : keys.length === 0 ? (
        <p className="empty-state">No API keys in this project.</p>
      ) : (
        <div className="card-list">
          {keys.map((key) => {
            const revoked = key.revokedAt !== null;
            const expired = key.expiresAt !== null && Date.parse(key.expiresAt) <= Date.now();
            return (
              <div key={key.id} className="card card-row">
                <div>
                  <strong>{key.name}</strong>
                  <div className="mono">{key.keyPrefix}…</div>
                  <div className="page-subtitle">
                    {/* Last use, not just creation: a key nobody calls is a key that can be
                        revoked, and that is the question this list is consulted to answer. */}
                    {key.lastUsedAt ? `last used ${new Date(key.lastUsedAt).toLocaleString()}` : "never used"}
                    {key.expiresAt ? ` · expires ${new Date(key.expiresAt).toLocaleDateString()}` : " · no expiry"}
                  </div>
                </div>
                {revoked ? (
                  <span className="badge badge-muted">Revoked</span>
                ) : expired ? (
                  <span className="badge badge-warning">Expired</span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busyId === key.id}
                    onClick={() => void handleRevoke(key)}
                  >
                    {busyId === key.id ? "Revoking…" : "Revoke"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
