"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSession } from "../lib/session-context";
import { ApiError, signup } from "../lib/auth-client";

/** Account creation. Signing up also creates the user's organization and first project. */
export default function SignupPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const [form, setForm] = useState({ email: "", password: "", displayName: "", organizationName: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signup({
        email: form.email,
        password: form.password,
        displayName: form.displayName,
        organizationName: form.organizationName || undefined,
      });
      // The cookie now exists, but the session provider still holds the state it resolved
      // when this page mounted — anonymous. Navigating first would let the provider's
      // redirect effect bounce straight back to /login, which is exactly what the
      // end-to-end suite caught on its first run (ADR-070).
      await refresh();
      router.push("/chat");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={onSubmit}>
        <h1>Create an account</h1>
        <label htmlFor="displayName">Name</label>
        <input id="displayName" required value={form.displayName} onChange={update("displayName")} />
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="email" required value={form.email} onChange={update("email")} />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          value={form.password}
          onChange={update("password")}
        />
        <p className="auth-hint">At least 12 characters. Length matters more than symbols.</p>
        <label htmlFor="organizationName">Organization (optional)</label>
        <input id="organizationName" value={form.organizationName} onChange={update("organizationName")} />
        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </button>
        <p className="auth-alt">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </form>
    </main>
  );
}
