"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  addProjectMember,
  answerInvitation,
  changePassword,
  listMyInvitations,
  listProjectInvitations,
  revokeProjectInvitation,
  type MyInvitation,
  type ProjectInvitation,
  createApiKey,
  listAudit,
  listProjectMembers,
  removeProjectMember,
  type AuditEntry,
  type ProjectMember,
  deleteAccount,
  DELETE_ACCOUNT_CONFIRMATION,
  type AccountDeletionResult,
  listApiKeys,
  listSessions,
  revokeApiKey,
  revokeSession,
  type ApiKeyCreated,
  type ApiKeySummary,
  type SessionSummary,
} from "../lib/api";
import { createProject, deleteProject } from "../lib/auth-client";
import { Can, RequireSession, useSession } from "../lib/session-context";

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

      <PasswordCard onSignedOut={() => void signOut()} />

      <SessionsCard />

      <InvitationsCard refresh={refresh} selectProject={selectProject} />

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

      {/* Both are project-scoped and both remount on a switch, for the same reason the keys
          card does: the previous project's members or activity under a new selection would
          misrepresent who can act and what happened (ADR-154). */}
      {projectId ? <MembersCard key={`members-${projectId}`} projectId={projectId} /> : null}
      {projectId ? <ActivityCard key={`audit-${projectId}`} /> : null}

      <DangerZoneCard onDeleted={() => void signOut()} />

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

/**
 * Who else can act in this project — docs/26_DECISIONS.md ADR-154.
 *
 * `PROJECT_ROLE_PERMISSIONS` defines viewer, editor and admin, and the only route that could
 * create a non-admin member had no caller anywhere in the product. So every user a deployment
 * made through its own interface was an admin of their own project, a `viewer` existed only in
 * tests, and the permission table the whole authorization story rests on described something no
 * operator could reach.
 *
 * Behind `project:admin`, with the list itself readable by any member: knowing who your
 * collaborators are is not privileged, and changing the list is.
 */
function MembersCard({ projectId }: { projectId: string }) {
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProjectMember["role"]>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listProjectMembers(projectId)
      .then((r) => {
        setMembers(r.members);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // Open invitations are an admin's to see; a member's request is refused, and that is not an
    // error worth showing them — they simply have none to manage.
    listProjectInvitations(projectId)
      .then((r) => setInvitations(r.invitations))
      .catch(() => setInvitations([]));
  }, [projectId]);

  useEffect(refresh, [refresh]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await addProjectMember(projectId, email.trim(), role);
      setNotice(
        result.status === "invited"
          ? `Invitation sent to ${result.email} as ${result.role}. They join when they accept it from their Settings.`
          : `Role changed to ${result.role}.`
      );
      setEmail("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(invitationId: string) {
    setBusy(true);
    setError(null);
    try {
      await revokeProjectInvitation(projectId, invitationId);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string) {
    setBusy(true);
    setError(null);
    try {
      await removeProjectMember(projectId, userId);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <strong>Project members</strong>
      <p className="page-subtitle">
        A viewer can read this project; an editor can spend its budget on chat, agents and media;
        an admin can also manage members and API keys.
      </p>
      {error && <p className="error-text">{error}</p>}
      {notice && <p className="page-subtitle" role="status">{notice}</p>}
      {members === null && !error && <p className="empty-state">Loading…</p>}
      {members?.length === 0 && <p className="empty-state">No members yet.</p>}
      {members?.map((m) => (
        <div key={m.userId} className="card-row" style={{ marginTop: 8 }}>
          <div>
            <strong>{m.displayName}</strong>
            <div className="page-subtitle">
              {m.email} — {m.role}
            </div>
          </div>
          <Can permission="project:admin" fallback={null}>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void remove(m.userId)}>
              Remove
            </button>
          </Can>
        </div>
      ))}
      {invitations.map((i) => (
        <div key={i.id} className="card-row" style={{ marginTop: 8 }}>
          <div>
            <strong>{i.email}</strong>
            <div className="page-subtitle">
              invited as {i.role} — waiting for them to accept (until {new Date(i.expiresAt).toLocaleDateString()})
            </div>
          </div>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void revoke(i.id)}>
            Revoke
          </button>
        </div>
      ))}
      <Can
        permission="project:admin"
        fallback={
          <p className="page-subtitle" style={{ marginTop: 12 }}>
            A project admin can add or remove members.
          </p>
        }
      >
        <form onSubmit={add} style={{ marginTop: 12 }}>
          <div className="form-row">
            <label style={{ flex: 1, minWidth: 220 }}>
              Invite by email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label style={{ minWidth: 140 }}>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value as ProjectMember["role"])}>
                <option value="viewer">viewer</option>
                <option value="editor">editor</option>
                <option value="admin">admin</option>
              </select>
            </label>
          </div>
          <button type="submit" className="btn" disabled={busy || !email.trim()}>
            {busy ? "Saving…" : "Invite"}
          </button>
        </form>
      </Can>
    </div>
  );
}

/**
 * Invitations addressed to this account — docs/DECISION_LOG.md DL-7. Nobody is put into a
 * project without saying yes here; accepting makes the project appear in the switcher.
 */
function InvitationsCard({
  refresh,
  selectProject,
}: {
  refresh: () => Promise<void>;
  selectProject: (projectId: string) => void;
}) {
  const [invitations, setInvitations] = useState<MyInvitation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listMyInvitations()
      .then((r) => {
        setInvitations(r.invitations);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(load, [load]);

  async function respond(invitation: MyInvitation, answer: "accept" | "decline") {
    setBusy(true);
    setError(null);
    try {
      await answerInvitation(invitation.id, answer);
      if (answer === "accept") {
        await refresh();
        selectProject(invitation.projectId);
      }
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Nothing to answer is the normal state; the card appears only when there is something to do.
  if (!error && (invitations === null || invitations.length === 0)) return null;

  return (
    <div className="card">
      <strong>Invitations</strong>
      {error && <p className="error-text">{error}</p>}
      {invitations?.map((i) => (
        <div key={i.id} className="card-row" style={{ marginTop: 8 }}>
          <div>
            <strong>{i.projectName}</strong>
            <div className="page-subtitle">
              as {i.role}
              {i.invitedBy ? `, from ${i.invitedBy}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn" disabled={busy} onClick={() => void respond(i, "accept")}>
              Accept
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void respond(i, "decline")}>
              Decline
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The audit trail, readable — ADR-139, reached by ADR-154.
 *
 * Every tool call, login, approval and member change writes an `audit_log` row, and
 * `GET /api/v1/audit` had no consumer anywhere in the product: the trail existed for an operator
 * who had no way to open it. `project:admin`, which is what the route requires.
 */
function ActivityCard() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listAudit()
      .then((r) => {
        setEntries(r.entries);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <Can permission="project:admin" fallback={null}>
      <div className="card">
        <strong>Activity</strong>
        <p className="page-subtitle">
          What has happened in this project: every tool call, sign-in, approval and membership
          change, newest first.
        </p>
        {entries === null ? (
          <button type="button" className="btn btn-secondary" style={{ marginTop: 8 }} onClick={load}>
            Load activity
          </button>
        ) : entries.length === 0 ? (
          <p className="empty-state">Nothing recorded yet.</p>
        ) : (
          <ul className="page-subtitle" style={{ margin: "8px 0 0 18px" }}>
            {entries.slice(0, 50).map((entry) => (
              <li key={entry.id}>
                <code>{entry.action}</code> — {entry.outcome}
                {entry.resourceId ? ` · ${entry.resourceId}` : ""} ·{" "}
                {new Date(entry.createdAt).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
    </Can>
  );
}

/**
 * Changing your own password — docs/26_DECISIONS.md ADR-127.
 *
 * There was no way to do this at all: `revokeAllSessions` existed with a docstring naming a
 * password change that no route implemented. A user who thought their password was known had
 * nothing to do about it but delete the account.
 */
function PasswordCard({ onSignedOut }: { onSignedOut: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await changePassword(currentPassword, newPassword);
      // The server revoked every session, this one included — that is the point of the feature,
      // so the screen follows it rather than pretending the browser is still signed in.
      onSignedOut();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <strong>Password</strong>
      <p className="page-subtitle">
        Changing it signs out every session, including this one — which is what makes it worth
        doing if you think someone else has your password.
      </p>
      <form onSubmit={submit} style={{ marginTop: 12 }}>
        <div className="form-row">
          <label style={{ flex: 1, minWidth: 200 }}>
            Current password
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </label>
          <label style={{ flex: 1, minWidth: 200 }}>
            New password (at least 12 characters)
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </label>
        </div>
        <button type="submit" className="btn" disabled={busy || !currentPassword || newPassword.length < 12}>
          {busy ? "Changing…" : "Change password"}
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

/**
 * Deleting the account, from the account screen — NFR-008, ADR-102, reached at last by ADR-147.
 *
 * The endpoint went to real trouble to be safe for a person to drive: a session credential
 * rather than an API key, the current password, a typed confirmation, and a per-user rate
 * limit. Then nothing in the product called it, so the requirement it satisfies — "self-service
 * rather than an operator ticket, because a privacy requirement satisfied only by asking
 * someone else is not satisfied" — was not satisfied either.
 *
 * What is NOT removed is reported rather than hidden. The route returns the storage objects,
 * workspaces and job queues it could not clear, and a screen that showed a plain "deleted"
 * over that list would be making exactly the claim this platform refuses everywhere else.
 */
function DangerZoneCard({ onDeleted }: { onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AccountDeletionResult | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await deleteAccount(password);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const leftovers =
      result.storageObjectsNotRemoved.length +
      result.workspacesNotRemoved.length +
      result.projectsWithJobsNotCancelled.length;
    return (
      <div className="card">
        <strong>Account deleted</strong>
        <p style={{ margin: "6px 0 0" }}>
          {result.deleted.projects} project(s), {result.deleted.organizations} organization(s),{" "}
          {result.deleted.storageObjects} stored file(s) and {result.deleted.workspaces} workspace(s) removed;{" "}
          {result.deleted.queuedJobs} queued job(s) cancelled.
        </p>
        {result.retainedProjects > 0 && (
          <p className="page-subtitle">
            {result.retainedProjects} project(s) other members can still reach were kept; only your access ended.
          </p>
        )}
        {leftovers > 0 && (
          // Said plainly, because an orphaned object is a privacy problem and the person is
          // entitled to know one exists.
          <p className="error-text">
            {leftovers} item(s) could not be removed and need an operator: {result.storageObjectsNotRemoved.length}{" "}
            stored file(s), {result.workspacesNotRemoved.length} workspace(s),{" "}
            {result.projectsWithJobsNotCancelled.length} project(s) with jobs still queued.
          </p>
        )}
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-secondary" onClick={onDeleted}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <strong>Delete account</strong>
      <p className="page-subtitle">
        Removes your account, every organization you alone own, their projects, files and agent
        workspaces, and cancels their queued jobs. Projects other members can still reach are kept.
        This cannot be undone.
      </p>
      {!open ? (
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
            Delete account…
          </button>
        </div>
      ) : (
        <form onSubmit={submit} style={{ marginTop: 12 }}>
          <div className="form-row">
            <label style={{ flex: 1, minWidth: 200 }}>
              Current password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label style={{ flex: 1, minWidth: 220 }}>
              Type {DELETE_ACCOUNT_CONFIRMATION} to confirm
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
          </div>
          <button
            type="submit"
            className="btn"
            disabled={busy || !password || confirm !== DELETE_ACCOUNT_CONFIRMATION}
          >
            {busy ? "Deleting…" : "Delete my account"}
          </button>{" "}
          <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </button>
        </form>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

/** Live sessions, so a compromise is something a user can SEE and end — ADR-127. */
function SessionsCard() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listSessions()
      .then((r) => setSessions(r.sessions))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  async function end(id: string) {
    try {
      await revokeSession(id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="card">
      <strong>Signed-in sessions</strong>
      <p className="page-subtitle">
        Every browser currently holding a session for this account. Ending one takes effect
        immediately.
      </p>
      {error && <p className="error-text">{error}</p>}
      {sessions === null && !error && <p className="empty-state">Loading…</p>}
      {sessions?.length === 0 && <p className="empty-state">No other sessions.</p>}
      {sessions?.map((s) => (
        <div key={s.id} className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
          <span>
            {s.userAgent ?? "Unknown browser"}
            {s.ipAddress ? ` — ${s.ipAddress}` : ""}
            <span className="page-subtitle"> last used {new Date(s.lastUsedAt).toLocaleString()}</span>
          </span>
          <button type="button" className="btn btn-secondary" onClick={() => void end(s.id)}>
            End session
          </button>
        </div>
      ))}
    </div>
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
  const [notice, setNotice] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleDelete(project: { id: string; name: string }) {
    if (
      !window.confirm(
        `Delete "${project.name}"? Its queued and running work is stopped, and it disappears for every member.`
      )
    ) {
      return;
    }
    setDeletingId(project.id);
    setError(null);
    setNotice(null);
    try {
      const result = await deleteProject(project.id);
      // The server reports what it could not stop rather than hiding it (DL-9); so does this.
      setNotice(
        result.notStopped.length > 0
          ? `"${project.name}" was deleted, but its ${result.notStopped.join(" and ")} could not be stopped — an operator should check.`
          : `"${project.name}" was deleted.`
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingId(null);
    }
  }

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
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {p.id === projectId ? (
                <span className="badge badge-success">Selected</span>
              ) : (
                <button type="button" className="btn btn-secondary" onClick={() => selectProject(p.id)}>
                  Switch to
                </button>
              )}
              {p.role === "admin" ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={deletingId !== null}
                  aria-label={`Delete project ${p.name}`}
                  onClick={() => void handleDelete(p)}
                >
                  {deletingId === p.id ? "Deleting…" : "Delete"}
                </button>
              ) : null}
            </div>
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
      {notice ? (
        <p className="page-subtitle" role="status">
          {notice}
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
