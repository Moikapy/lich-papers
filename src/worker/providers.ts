import type { ProviderConfig } from "@moikapy/lich";
import { HTTPException } from "hono/http-exception";
import { decryptSecret, encryptSecret } from "./crypto";
import { isPro, type ChatProvider, type Env, type ProviderId, type User } from "./env";
import { loadProKey } from "./billing";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const FREE_ROUTER_MODEL = "openrouter/free";
const OPENAI_BASE = "https://api.openai.com/v1";
const ANTHROPIC_BASE = "https://api.anthropic.com";
export const OLLAMA_CLOUD_BASE = "https://ollama.com";

/** True when a base URL points at Ollama Cloud (ollama.com) rather than a self-hosted server. */
export function isOllamaCloud(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return true; // no base URL means the cloud default
  try {
    const host = new URL(baseUrl).hostname;
    return host === "ollama.com" || host.endsWith(".ollama.com");
  } catch {
    return false;
  }
}

/**
 * Ollama's site lists cloud models as e.g. "gpt-oss:120b-cloud" (the name a local Ollama uses to proxy
 * to the cloud). The cloud API itself wants the plain name, so drop the suffix when talking to ollama.com.
 */
export function ollamaModelName(model: string, baseUrl: string | null | undefined): string {
  return isOllamaCloud(baseUrl) ? model.trim().replace(/-cloud$/, "") : model.trim();
}

export interface StoredKey {
  provider: ProviderId;
  api_key: string | null;
  base_url: string | null;
  source: "manual" | "oauth";
}

export async function loadKeys(env: Env, userId: string): Promise<Map<ProviderId, StoredKey>> {
  const { results } = await env.DB.prepare("SELECT provider, api_key, base_url, source FROM provider_keys WHERE user_id = ?")
    .bind(userId)
    .all<StoredKey>();
  const keys = new Map<ProviderId, StoredKey>();
  for (const r of results) {
    keys.set(r.provider, { ...r, api_key: r.api_key ? await decryptSecret(r.api_key, env.ENCRYPTION_KEY) : null });
  }
  return keys;
}

export function validateBaseUrl(env: Env, raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HTTPException(400, { message: "Base URL is not a valid URL" });
  }
  const insecureOk = env.ALLOW_INSECURE_PROVIDER_URLS === "1";
  if (url.protocol !== "https:" && !(insecureOk && url.protocol === "http:")) {
    throw new HTTPException(400, { message: "Base URL must use https:// (expose a local Ollama through a tunnel)" });
  }
  return url.toString().replace(/\/+$/, "");
}

export async function saveKey(
  env: Env,
  userId: string,
  provider: ProviderId,
  apiKey: string | null,
  baseUrl: string | null,
  source: "manual" | "oauth" = "manual",
): Promise<void> {
  const sealed = apiKey ? await encryptSecret(apiKey, env.ENCRYPTION_KEY) : null;
  await env.DB.prepare(
    `INSERT INTO provider_keys (user_id, provider, api_key, base_url, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, provider) DO UPDATE SET api_key = excluded.api_key, base_url = excluded.base_url,
       source = excluded.source, updated_at = excluded.updated_at`,
  )
    .bind(userId, provider, sealed, baseUrl, source, Date.now())
    .run();
}

/** Adds the attribution headers OpenRouter asks apps to send. */
function openRouterFetch(appUrl: string, appName: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("HTTP-Referer", appUrl);
    headers.set("X-Title", appName);
    return fetch(input, { ...init, headers });
  };
}

export const SHARED_PROVIDER = "openrouter-free-shared";
/** Pro plan's capped key: the chosen model, and the free router on the same key as fallback. */
export const PRO_PROVIDER = "pro";
export const PRO_FREE_PROVIDER = "pro-free";

/** Who pays for a reply, from the lich provider name that produced it. */
export function billedTo(providerName: string | null): "user" | "pro" | "trial" {
  if (providerName === SHARED_PROVIDER) return "trial";
  if (providerName === PRO_PROVIDER || providerName === PRO_FREE_PROVIDER) return "pro";
  return "user";
}

export interface ResolvedChain {
  providers: ProviderConfig[];
  label: string;
}

/**
 * Builds the lich provider failover chain for a chat request:
 *   1. the requested (or user's default) provider + model, using the user's own key;
 *   2. the OpenRouter free router as a fallback, with the user's OpenRouter key or the server key.
 */
export async function resolveChain(
  env: Env,
  user: User,
  appUrl: string,
  requested: { provider?: ChatProvider; model?: string },
): Promise<ResolvedChain> {
  const keys = await loadKeys(env, user.id);
  let provider: ChatProvider = requested.provider ?? user.default_provider ?? "openrouter";
  if (provider === "pro" && !isPro(user)) {
    if (requested.provider === "pro") throw new HTTPException(402, { message: "Lich Pro models need an active Pro plan." });
    provider = "openrouter";
  }
  const model = requested.model || (provider === user.default_provider ? user.default_model : null) || null;
  if (requested.provider && provider !== "openrouter" && provider !== "pro" && !model && keys.get(provider)) {
    throw new HTTPException(400, { message: `Choose a model for ${provider}` });
  }
  const proKey = isPro(user) ? await loadProKey(env, user.id) : null;
  const orFetch = openRouterFetch(appUrl, env.APP_NAME);
  const chain: ProviderConfig[] = [];
  const timeout_ms = 90_000;

  const k = provider === "pro" ? undefined : keys.get(provider);
  switch (provider) {
    case "pro":
      if (proKey) {
        chain.push({
          kind: "openai_compat",
          name: PRO_PROVIDER,
          model: model ?? env.PRO_DEFAULT_MODEL ?? FREE_ROUTER_MODEL,
          base_url: OPENROUTER_BASE,
          api_key: proKey,
          fetch_fn: orFetch,
          timeout_ms,
        });
      }
      break;
    case "openai":
      if (k?.api_key && model) {
        chain.push({ kind: "openai_compat", name: "openai", model, base_url: k.base_url ?? OPENAI_BASE, api_key: k.api_key, timeout_ms });
      }
      break;
    case "anthropic":
      if (k?.api_key && model) {
        chain.push({ kind: "anthropic", name: "anthropic", model, base_url: k.base_url ?? ANTHROPIC_BASE, api_key: k.api_key, timeout_ms });
      }
      break;
    case "ollama":
      // Ollama Cloud needs the user's key; a self-hosted server may not.
      if (k && model && (k.api_key || !isOllamaCloud(k.base_url))) {
        chain.push({
          kind: "ollama",
          name: "ollama",
          model: ollamaModelName(model, k.base_url),
          base_url: k.base_url ?? OLLAMA_CLOUD_BASE,
          ...(k.api_key ? { api_key: k.api_key } : {}),
          timeout_ms,
        });
      }
      break;
    case "openrouter":
      if (k?.api_key) {
        chain.push({
          kind: "openai_compat",
          name: "openrouter",
          model: model ?? env.DEFAULT_MODEL ?? FREE_ROUTER_MODEL,
          base_url: OPENROUTER_BASE,
          api_key: k.api_key,
          fetch_fn: orFetch,
          timeout_ms,
        });
      }
      break;
  }

  // Free-router fallback (or primary, when nothing above was usable).
  const orKey = keys.get("openrouter")?.api_key;
  const alreadyFree = chain.some((p) => p.name === "openrouter" && p.model === FREE_ROUTER_MODEL);
  if (!alreadyFree) {
    const trialKey = !orKey && !proKey && env.OPENROUTER_API_KEY && (await freeUsageRemaining(env, user.id)) > 0 ? env.OPENROUTER_API_KEY : undefined;
    const fallbackKey = orKey ?? proKey ?? trialKey;
    if (fallbackKey) {
      chain.push({
        kind: "openai_compat",
        name: orKey ? "openrouter-free" : proKey ? PRO_FREE_PROVIDER : SHARED_PROVIDER,
        model: FREE_ROUTER_MODEL,
        base_url: OPENROUTER_BASE,
        api_key: fallbackKey,
        fetch_fn: orFetch,
        timeout_ms,
      });
    }
  }

  if (chain.length === 0) {
    const hitCap = !orKey && !!env.OPENROUTER_API_KEY;
    throw new HTTPException(hitCap ? 429 : 400, {
      message: hitCap
        ? "You've used your free trial messages. Connect your own OpenRouter account (free) or upgrade to Pro in Settings to keep going."
        : "No model available. Connect OpenRouter (free) or add an API key in Settings.",
    });
  }
  const primary = chain[0]!;
  return { providers: chain, label: `${primary.name}/${primary.model}` };
}

/**
 * The shared server key is a one-time trial, counted in messages. It lives in free_usage under a
 * fixed key instead of a calendar day, so it never resets.
 */
const TRIAL = "trial";
const today = () => TRIAL;
export const trialLimit = (env: Env) => Number(env.FREE_TRIAL_MESSAGES ?? 10);

/** Trial messages the user has left on the server-funded key. */
export async function freeUsageRemaining(env: Env, userId: string): Promise<number> {
  const limit = trialLimit(env);
  const row = await env.DB.prepare("SELECT requests FROM free_usage WHERE user_id = ? AND day = ?")
    .bind(userId, today())
    .first<{ requests: number }>();
  return limit - (row?.requests ?? 0);
}

/** Atomically takes one trial message; false when the trial is used up. */
export async function reserveFreeUsage(env: Env, userId: string): Promise<boolean> {
  const limit = trialLimit(env);
  if (limit <= 0) return false;
  const res = await env.DB.prepare(
    `INSERT INTO free_usage (user_id, day, requests) VALUES (?, ?, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET requests = requests + 1 WHERE requests < ?`,
  )
    .bind(userId, today(), limit)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Corrects a reservation afterwards (delta may be negative, e.g. -1 to refund an unused one). */
export async function adjustFreeUsage(env: Env, userId: string, delta: number): Promise<void> {
  if (!delta) return;
  await env.DB.prepare("UPDATE free_usage SET requests = MAX(0, requests + ?) WHERE user_id = ? AND day = ?")
    .bind(delta, userId, today())
    .run();
}

export async function recordFreeUsage(env: Env, userId: string, calls: number): Promise<void> {
  if (calls <= 0) return;
  await env.DB.prepare(
    `INSERT INTO free_usage (user_id, day, requests) VALUES (?, ?, ?)
     ON CONFLICT (user_id, day) DO UPDATE SET requests = requests + excluded.requests`,
  )
    .bind(userId, today(), calls)
    .run();
}

export interface ModelInfo {
  id: string;
  name: string;
  free?: boolean;
  context?: number;
}

/** Lists models a user can pick for a provider, using their stored key. */
export async function listModels(env: Env, userId: string, provider: ChatProvider): Promise<ModelInfo[]> {
  const keys = await loadKeys(env, userId);
  const k = provider === "pro" ? undefined : keys.get(provider);
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new HTTPException(502, { message: `${provider} model list failed (${res.status})` });
    return (await res.json()) as any;
  };
  switch (provider) {
    case "pro":
    case "openrouter": {
      const data = await get(`${OPENROUTER_BASE}/models`);
      const models: ModelInfo[] = (data.data ?? []).map((m: any) => ({
        id: m.id,
        name: m.name ?? m.id,
        free: m.pricing?.prompt === "0" && m.pricing?.completion === "0",
        context: m.context_length,
      }));
      if (provider === "pro") {
        const preferred = env.PRO_DEFAULT_MODEL;
        return preferred ? [...models.filter((m) => m.id === preferred), ...models.filter((m) => m.id !== preferred)] : models;
      }
      models.unshift({ id: FREE_ROUTER_MODEL, name: "Free Models Router (auto)", free: true });
      return models;
    }
    case "openai": {
      if (!k?.api_key) return [];
      const data = await get(`${k.base_url ?? OPENAI_BASE}/models`, { authorization: `Bearer ${k.api_key}` });
      return (data.data ?? [])
        .map((m: any) => String(m.id))
        .filter((id: string) => /^(gpt-|o\d|chatgpt)/.test(id) && !/(audio|realtime|transcribe|tts|image|search)/.test(id))
        .sort()
        .map((id: string) => ({ id, name: id }));
    }
    case "anthropic": {
      if (!k?.api_key) return [];
      const data = await get(`${k.base_url ?? ANTHROPIC_BASE}/v1/models?limit=100`, {
        "x-api-key": k.api_key,
        "anthropic-version": "2023-06-01",
      });
      return (data.data ?? []).map((m: any) => ({ id: m.id, name: m.display_name ?? m.id }));
    }
    case "ollama": {
      if (!k) return [];
      const base = k.base_url ?? OLLAMA_CLOUD_BASE;
      const data = await get(`${base}/api/tags`, k.api_key ? { authorization: `Bearer ${k.api_key}` } : {});
      return (data.models ?? []).map((m: any) => ({ id: m.name ?? m.model, name: m.name ?? m.model }));
    }
  }
}

/** OpenRouter credit balance for the user's connected key, if any. */
export async function openRouterCredits(apiKey: string): Promise<{ total: number; used: number } | null> {
  try {
    const res = await fetch(`${OPENROUTER_BASE}/credits`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const { data } = (await res.json()) as { data?: { total_credits: number; total_usage: number } };
    return data ? { total: data.total_credits, used: data.total_usage } : null;
  } catch {
    return null; // decorative; never fail /settings over it
  }
}

/** Completes OpenRouter's OAuth PKCE flow: exchanges the code for a user-controlled API key. */
export async function exchangeOpenRouterCode(code: string, verifier: string): Promise<string> {
  const res = await fetch(`${OPENROUTER_BASE}/auth/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  if (!res.ok) throw new HTTPException(400, { message: `OpenRouter rejected the authorization code (${res.status})` });
  const { key } = (await res.json()) as { key?: string };
  if (!key) throw new HTTPException(502, { message: "OpenRouter returned no key" });
  return key;
}
