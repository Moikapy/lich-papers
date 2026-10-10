import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, User } from "./env";
import { randomToken, sha256 } from "./crypto";

const COOKIE = "lp_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function startSession(c: Context<AppEnv>, userId: string): Promise<void> {
  const token = randomToken();
  const expires = Date.now() + SESSION_TTL_MS;
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").bind(Date.now()),
    c.env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(Date.now() - 24 * 60 * 60 * 1000),
  ]);
  await c.env.DB.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, expires)
    .run();
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    expires: new Date(expires),
  });
}

export async function endSession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  deleteCookie(c, COOKIE, { path: "/" });
}

/** Resolves the signed-in user (or null) for every /api request. */
export const loadUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, COOKIE);
  let user: User | null = null;
  if (token) {
    user = await c.env.DB.prepare(
      `SELECT u.id, u.email, u.default_provider, u.default_model
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
      .bind(await sha256(token), Date.now())
      .first<User>();
  }
  c.set("user", user);
  await next();
};

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user")) throw new HTTPException(401, { message: "Sign in required" });
  await next();
};

export function currentUser(c: Context<AppEnv>): User {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Sign in required" });
  return user;
}

/**
 * Cookie auth + SameSite=Lax already blocks most cross-site writes; also reject
 * state-changing requests whose Origin doesn't match ours.
 */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) throw new HTTPException(403, { message: "Bad origin" });
  }
  await next();
};

/**
 * Fixed-window throttle backed by D1. Counts this attempt and throws 429 once `max`
 * attempts have been made in the current window.
 */
export async function rateLimit(c: Context<AppEnv>, key: string, max: number, windowMs: number): Promise<void> {
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END
     RETURNING count`,
  )
    .bind(key, now, now - windowMs, now - windowMs, now)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > max) throw new HTTPException(429, { message: "Too many attempts. Try again later." });
}

export const clientIp = (c: Context<AppEnv>): string => c.req.header("cf-connecting-ip") ?? "unknown";
