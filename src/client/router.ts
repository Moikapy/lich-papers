import { useEffect, useState } from "react";

export function navigate(to: string, replace = false): void {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function useLocation(): URL {
  const [url, setUrl] = useState(() => new URL(location.href));
  useEffect(() => {
    const on = () => setUrl(new URL(location.href));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return url;
}

/** Intercepts same-origin <a> clicks so links don't reload the SPA. */
export function onLinkClick(e: React.MouseEvent<HTMLAnchorElement>): void {
  const a = e.currentTarget;
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target === "_blank") return;
  if (a.origin !== location.origin) return;
  e.preventDefault();
  navigate(a.pathname + a.search + a.hash);
}
