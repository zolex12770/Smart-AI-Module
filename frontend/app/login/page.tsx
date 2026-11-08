"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSession } from "../lib/session-context";
import { ApiError, login } from "../lib/auth-client";

/**
 * Sign-in. The session is set as an httpOnly cookie by the API, so nothing here stores a
 * credential — on success we simply navigate and let `/api/v1/auth/me` establish state.
 */
export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      await refresh();
      router.push("/chat");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function handleQuickOperatorLogin() {
    setBusy(true);
    setError(null);
    setEmail("operator@local.dev");
    setPassword("test-password-1234");
    try {
      await login("operator@local.dev", "test-password-1234");
      await refresh();
      router.push("/chat");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const isLocalDev =
    process.env.NODE_ENV === "development" ||
    (typeof window !== "undefined" &&
      (window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1" ||
        window.location.hostname === "::1"));

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={onSubmit}>
        <h1>Sign in to NirnayAI</h1>
        <p className="page-subtitle" style={{ marginTop: 0, marginBottom: 16 }}>
          Independent Autonomous AI Platform
        </p>

        {isLocalDev ? (
          <>
            <button
              type="button"
              onClick={handleQuickOperatorLogin}
              disabled={busy}
              style={{
                background: "#059669",
                color: "#ffffff",
                border: "none",
                padding: "10px 16px",
                borderRadius: "6px",
                fontWeight: 600,
                fontSize: "14px",
                cursor: "pointer",
                width: "100%",
                marginBottom: "16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
              }}
            >
              ⚡ One-Click Sign In as Local Operator
            </button>

            <div style={{ textAlign: "center", margin: "8px 0 16px", color: "var(--muted)", fontSize: "12px" }}>
              — or enter credentials below —
            </div>
          </>
        ) : null}

        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        {isLocalDev ? (
          <div style={{ marginTop: 12, padding: "8px 12px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, fontSize: "12px", color: "var(--muted)" }}>
            <strong>Default Local Operator (Dev Only):</strong><br />
            <code>operator@local.dev</code> / <code>test-password-1234</code>
          </div>
        ) : null}

        <p className="auth-alt" style={{ marginTop: 16 }}>
          No account? <Link href="/signup">Create one</Link>
        </p>
      </form>
    </main>
  );
}
