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
      // The cookie now exists, but the session provider still holds the state it resolved
      // when this page mounted — anonymous. Navigating first would let the provider's
      // redirect effect bounce straight back to /login, which is exactly what the
      // end-to-end suite caught on its first run (ADR-070).
      await refresh();
      router.push("/chat");
    } catch (err) {
      // The API deliberately returns one message for both "wrong password" and "no such
      // account" so the form cannot be used to enumerate users; show it verbatim.
      setError(err instanceof ApiError ? err.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={onSubmit}>
        <h1>Sign in</h1>
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
        <p className="auth-alt">
          No account? <Link href="/signup">Create one</Link>
        </p>
      </form>
    </main>
  );
}
