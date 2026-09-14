"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "./session-context";

const NAV_LINKS = [
  { href: "/chat", label: "Chat" },
  { href: "/tasks", label: "Tasks" },
  { href: "/images", label: "Images" },
  { href: "/videos", label: "Videos" },
  // ADR-114: speech used to exist only inside the video pipeline, with no way to ask for it.
  { href: "/audio", label: "Audio" },
  { href: "/files", label: "Files" },
  // ADR-084: the ingestion half of RAG had no way to be queried from the UI at all.
  { href: "/ask", label: "Ask" },
  // ADR-084: memory silently shapes model answers, so it must be inspectable and deletable.
  { href: "/memory", label: "Memory" },
  { href: "/usage", label: "Usage" },
  // ADR-074: models, tools, MCP, jobs and dead letters — the ADR-066 API had no consumer.
  { href: "/platform", label: "Platform" },
  { href: "/settings", label: "Settings" },
];

const PUBLIC_PATHS = ["/login", "/signup"];

/**
 * The application chrome: navigation, the project switcher and the sign-out control.
 *
 * It renders nothing on the public screens — a sign-in page with a nav bar full of links
 * that all redirect back to sign-in is worse than no nav at all.
 */
export function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { status, user, projects, projectId, selectProject, signOut } = useSession();

  if (PUBLIC_PATHS.includes(pathname)) {
    return <>{children}</>;
  }

  return (
    <div className="app-shell">
      <nav className="app-nav">
        <span className="app-nav-brand">AI Agent Platform</span>
        <div className="app-nav-links">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`app-nav-link${pathname.startsWith(link.href) ? " is-active" : ""}`}
              aria-current={pathname.startsWith(link.href) ? "page" : undefined}
            >
              {link.label}
            </Link>
          ))}
        </div>
        {status === "authenticated" && user ? (
          <div className="app-nav-account">
            {projects.length > 0 ? (
              <label className="project-switcher">
                <span className="visually-hidden">Project</span>
                <select
                  value={projectId ?? ""}
                  onChange={(e) => selectProject(e.target.value)}
                  aria-label="Selected project"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <span className="app-nav-user" title={user.email}>
              {user.displayName}
            </span>
            <button type="button" className="app-nav-signout" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        ) : null}
      </nav>
      <main className="app-main">{children}</main>
    </div>
  );
}
