/** OpenRouter OAuth PKCE: https://openrouter.ai/docs/guides/overview/auth/oauth */
const VERIFIER_KEY = "or_pkce_verifier";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function startOpenRouterConnect(): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const params = new URLSearchParams({
    callback_url: `${location.origin}/openrouter/callback`,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  location.href = `https://openrouter.ai/auth?${params}`;
}

export function takeVerifier(): string | null {
  const v = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  return v;
}
