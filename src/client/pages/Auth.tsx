import { useState } from "react";
import { api, type User } from "../api";
import { useAuth } from "../auth";
import { Link } from "../components/Link";
import { navigate } from "../router";

/** Same-origin path only; anything else (e.g. //host, /\\host) falls back to the home page. */
function safeNext(n: string): string {
  try {
    const u = new URL(n, location.origin);
    return u.origin === location.origin && n.startsWith("/") ? u.pathname + u.search + u.hash : "/";
  } catch {
    return "/";
  }
}

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const { setUser } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = new URLSearchParams(location.search).get("next") || (mode === "signup" ? "/settings?welcome=1" : "/");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ user: User }>(`/auth/${mode}`, { method: "POST", json: { email, password } });
      try {
        localStorage.removeItem("lp_model");
      } catch {}
      setUser(r.user);
      navigate(safeNext(next));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth card">
      <h1>{mode === "login" ? "Sign in" : "Create your account"}</h1>
      <p className="muted">
        {mode === "login"
          ? "Pick up your conversations and knowledge where you left off."
          : "Chat with any arXiv paper, keep your history, and build knowledge across sessions. Free models via OpenRouter, or bring your own key."}
      </p>
      <form onSubmit={submit}>
        <label>
          Email
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>
      <p className="muted small">
        {mode === "login" ? (
          <>
            New here? <Link href={`/signup${location.search}`}>Create an account</Link>
          </>
        ) : (
          <>
            Have an account? <Link href={`/login${location.search}`}>Sign in</Link>
          </>
        )}
      </p>
    </div>
  );
}
