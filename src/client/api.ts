export type ProviderId = "openrouter" | "openai" | "anthropic" | "ollama";
/** Providers a chat can run on: BYOK providers plus the Pro plan's hosted models. */
export type ChatProvider = ProviderId | "pro";

export interface User {
  id: string;
  email: string;
  default_provider: ChatProvider;
  default_model: string | null;
  plan: "free" | "pro";
}

export interface PaperMeta {
  arxiv_id: string;
  title: string;
  authors: string[];
  abstract: string;
  categories: string[];
  published: string | null;
  updated: string | null;
  body_source?: string | null;
}

export interface Session {
  id: string;
  arxiv_id: string;
  title: string;
  summary: string | null;
  builds_on: string[];
  created_at: number;
  updated_at: number;
  paper_title?: string | null;
  message_count?: number;
}

export interface ToolUse {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
}

export interface ChatMessage {
  id: number | string;
  role: "user" | "assistant";
  content: string;
  meta: { provider: string | null; model: string | null; tools: ToolUse[] } | null;
  created_at: number;
}

export interface KnowledgeEntry {
  id: number;
  session_id: string | null;
  arxiv_id: string | null;
  kind: "note" | "summary";
  content: string;
  tags: string;
  created_at: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  free?: boolean;
  context?: number;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`/api${path}`, {
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

/** Encodes an arXiv id for use in a path segment (old-style ids contain "/"). */
export const enc = (id: string) => encodeURIComponent(id);

/** POSTs and reads a text/event-stream response, calling onEvent for each event. */
export async function postStream(
  path: string,
  body: unknown,
  onEvent: (event: string, data: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
    credentials: "same-origin",
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(event, JSON.parse(data.join("\n")));
    }
  }
}

export const PROVIDER_LABELS: Record<ChatProvider, string> = {
  pro: "Lich Pro",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama",
};

/** Chat providers a user can pick: Pro (if subscribed), OpenRouter, then connected BYOK providers. */
export function chatProviders(user: Pick<User, "plan"> | null, connected: Partial<Record<ProviderId, { connected: boolean }>>): ChatProvider[] {
  const out: ChatProvider[] = [];
  if (user?.plan === "pro") out.push("pro");
  out.push("openrouter");
  for (const p of ["openai", "anthropic", "ollama"] as ProviderId[]) if (connected[p]?.connected) out.push(p);
  return out;
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}
