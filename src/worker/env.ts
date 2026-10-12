export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_NAME: string;
  /** Model used when nothing else is configured. */
  DEFAULT_MODEL: string;
  /** base64-encoded 32-byte key for encrypting stored provider keys. */
  ENCRYPTION_KEY: string;
  /** Optional server-funded OpenRouter key so new users can chat via the free router immediately. */
  OPENROUTER_API_KEY?: string;
  /** Daily request cap per user on the server key (default 50). */
  FREE_DAILY_LIMIT?: string;
  /** "1" lets provider base URLs use http:// (local development only). */
  ALLOW_INSECURE_PROVIDER_URLS?: string;
}

export interface User {
  id: string;
  email: string;
  default_provider: ProviderId;
  default_model: string | null;
}

export type ProviderId = "openrouter" | "openai" | "anthropic" | "ollama";
export const PROVIDERS: readonly ProviderId[] = ["openrouter", "openai", "anthropic", "ollama"];

export type AppEnv = { Bindings: Env; Variables: { user: User | null } };

/** The slice of ExecutionContext we use (Hono and workers-types disagree on the full shape). */
export type Ctx = { waitUntil(promise: Promise<unknown>): void };
