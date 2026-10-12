export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_NAME: string;
  /** Model used when nothing else is configured. */
  DEFAULT_MODEL: string;
  /** base64-encoded 32-byte key for encrypting stored provider keys. */
  ENCRYPTION_KEY: string;
  /** Optional server-funded OpenRouter key for a one-time free trial on the free router. */
  OPENROUTER_API_KEY?: string;
  /** Messages each user gets on the shared key, once (default 10). */
  FREE_TRIAL_MESSAGES?: string;
  /** Stripe secret key (sk_live_… / sk_test_…). Pro checkout is disabled without it. */
  STRIPE_SECRET_KEY?: string;
  /** Signing secret of the Stripe webhook endpoint (whsec_…). */
  STRIPE_WEBHOOK_SECRET?: string;
  /** OpenRouter management (provisioning) key used to mint per-subscriber keys. */
  OPENROUTER_PROVISIONING_KEY?: string;
  /** Pro price in cents per month (default 1000). */
  PRO_PRICE_CENTS?: string;
  /** Monthly model spend cap per subscriber, in USD (default 4). */
  PRO_MONTHLY_CAP_USD?: string;
  /** Default OpenRouter model for Pro chats. */
  PRO_DEFAULT_MODEL?: string;
  /** Dev/testing only: override the Stripe and OpenRouter management API base URLs. */
  STRIPE_API_BASE?: string;
  OPENROUTER_MGMT_BASE?: string;
  /** "1" lets provider base URLs use http:// (local development only). */
  ALLOW_INSECURE_PROVIDER_URLS?: string;
}

export interface User {
  id: string;
  email: string;
  default_provider: ChatProvider;
  default_model: string | null;
  plan: "free" | "pro";
}

/** Providers a user can bring their own key for. */
export type ProviderId = "openrouter" | "openai" | "anthropic" | "ollama";
export const PROVIDERS: readonly ProviderId[] = ["openrouter", "openai", "anthropic", "ollama"];
/** Providers a chat can run on: BYOK providers plus the Pro plan's hosted models. */
export type ChatProvider = ProviderId | "pro";

export const isPro = (u: Pick<User, "plan"> | null | undefined) => u?.plan === "pro";

export type AppEnv = { Bindings: Env; Variables: { user: User | null } };

/** The slice of ExecutionContext we use (Hono and workers-types disagree on the full shape). */
export type Ctx = { waitUntil(promise: Promise<unknown>): void };
