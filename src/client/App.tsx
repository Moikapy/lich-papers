import { useEffect, useState } from "react";
import { api, type User } from "./api";
import { AuthContext } from "./auth";
import { Link } from "./components/Link";
import { navigate, useLocation } from "./router";
import { SearchPage } from "./pages/Search";
import { PaperPage } from "./pages/Paper";
import { SessionsPage } from "./pages/Sessions";
import { KnowledgePage } from "./pages/Knowledge";
import { SettingsPage } from "./pages/Settings";
import { AuthPage } from "./pages/Auth";
import { OpenRouterCallback } from "./pages/OpenRouterCallback";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const url = useLocation();

  useEffect(() => {
    api<{ user: User | null }>("/me")
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const path = url.pathname;
  let page: React.ReactNode;
  const paperMatch = path.match(/^\/paper\/(.+)$/);
  if (paperMatch) page = <PaperPage key={paperMatch[1]} arxivId={decodeURIComponent(paperMatch[1]!)} sessionId={url.searchParams.get("session")} />;
  else if (path === "/sessions") page = <SessionsPage />;
  else if (path === "/knowledge") page = <KnowledgePage />;
  else if (path === "/settings") page = <SettingsPage />;
  else if (path === "/login" || path === "/signup") page = <AuthPage mode={path === "/login" ? "login" : "signup"} />;
  else if (path === "/openrouter/callback") page = <OpenRouterCallback />;
  else page = <SearchPage />;

  const logout = async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {}
    try {
      localStorage.removeItem("lp_model");
    } catch {}
    setUser(null);
    navigate("/");
  };

  const navLink = (href: string, label: string) => (
    <Link href={href} className={path === href ? "active" : undefined}>
      {label}
    </Link>
  );

  return (
    <AuthContext.Provider value={{ user, loading, setUser }}>
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <header className="topbar">
        <Link href="/" className="brand">
          <span className="glyph">⚱</span> Lich Papers
        </Link>
        <nav>
          {navLink("/", "Search")}
          {user && navLink("/sessions", "History")}
          {user && navLink("/knowledge", "Knowledge")}
          {user && navLink("/settings", "Settings")}
          {user?.plan === "free" && (
            <Link href="/settings" className="go-pro">
              Go Pro
            </Link>
          )}
          {user?.plan === "pro" && <span className="tag">Pro</span>}
          {!loading && !user && navLink("/login", "Sign in")}
          {user && (
            <button className="linklike" onClick={logout} title={user.email}>
              Sign out
            </button>
          )}
        </nav>
      </header>
      <main id="main" tabIndex={-1} className={paperMatch ? "main wide" : "main"}>{page}</main>
    </AuthContext.Provider>
  );
}
