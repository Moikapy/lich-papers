import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { navigate } from "../router";
import { takeVerifier } from "../openrouter";

export function OpenRouterCallback() {
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const code = new URLSearchParams(location.search).get("code");
    const verifier = takeVerifier();
    if (!code || !verifier) {
      setError("This sign-in link is missing its code or has already been used. Start again from Settings.");
      return;
    }
    api("/settings/openrouter/exchange", { method: "POST", json: { code, verifier } })
      .then(() => navigate("/settings?connected=openrouter", true))
      .catch((e) => setError((e as Error).message));
  }, []);
  return (
    <div className="card narrow">
      {error ? (
        <>
          <h1>Couldn't connect OpenRouter</h1>
          <p className="error">{error}</p>
          <button onClick={() => navigate("/settings")}>Back to settings</button>
        </>
      ) : (
        <p>Connecting your OpenRouter account…</p>
      )}
    </div>
  );
}
