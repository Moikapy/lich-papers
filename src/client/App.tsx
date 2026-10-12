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
import { LegalPage, type LegalDoc } from "./pages/Legal";

const LEGAL_PATHS: Record<string, LegalDoc> = { "/terms": "terms", "/privacy": "privacy", "/refunds": "refunds", "/copyright": "copyright" };

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
  else if (LEGAL_PATHS[path]) page = <LegalPage key={path} doc={LEGAL_PATHS[path]!} />;
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
    <Link href={href} className={path === href ? "active" : undefined} aria-current={path === href ? "page" : undefined}>
      {label}
    </Link>
  );

  const tab = (href: string, label: string, icon: React.ReactNode) => (
    <Link href={href} className={path === href ? "active" : undefined} aria-current={path === href ? "page" : undefined}>
      {icon}
      <span>{label}</span>
    </Link>
  );

  return (
    <AuthContext.Provider value={{ user, loading, setUser, logout }}>
      <div className={`app${paperMatch ? " paper-mode" : ""}${user && !paperMatch ? " has-tabbar" : ""}`}>
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="glyph">⚱</span> Lich Papers
          </Link>
          <nav aria-label="Main">
            <span className="desk">{navLink("/", "Search")}</span>
            {user && <span className="desk">{navLink("/sessions", "History")}</span>}
            {user && <span className="desk">{navLink("/knowledge", "Knowledge")}</span>}
            {user && <span className="desk">{navLink("/settings", "Settings")}</span>}
            {user?.plan === "free" && (
              <Link href="/settings" className="go-pro">
                Go Pro
              </Link>
            )}
            {user?.plan === "pro" && <span className="tag">Pro</span>}
            {!loading && !user && navLink("/login", "Sign in")}
            {user && (
              <button className="linklike desk" onClick={logout} title={user.email}>
                Sign out
              </button>
            )}
          </nav>
        </header>
        <main id="main" tabIndex={-1} className={paperMatch ? "main wide" : "main"}>
          {page}
        </main>
        {!paperMatch && (
          <footer className="site-footer">
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/refunds">Refunds</Link>
            <Link href="/copyright">Copyright</Link>
            <span className="muted">Not affiliated with arXiv</span>
          </footer>
        )}
        {user && !paperMatch && (
          <nav className="tabbar" aria-label="Sections">
            {tab("/", "Search", <Icon d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4.35-4.35" />)}
            {tab("/sessions", "History", <Icon d="M12 7v5l3 2M3 12a9 9 0 1 0 3-6.7M3 4v4h4" />)}
            {tab("/knowledge", "Knowledge", <Icon d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2V5zm0 16a2 2 0 0 1 2-2h12v2" />)}
            {tab("/settings", "Settings", <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />)}
          </nav>
        )}
      </div>
    </AuthContext.Provider>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
