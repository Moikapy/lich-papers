import { useEffect, useRef, useState } from "react";
import { api, chatProviders, PROVIDER_LABELS, type ChatProvider, type ModelInfo, type ProviderId, type User } from "../api";
import { useAuth } from "../auth";
import { startOpenRouterConnect } from "../openrouter";
import { navigate, useLocation } from "../router";
import { Link } from "../components/Link";
import { RequireAuth } from "./RequireAuth";

interface ProviderStatus {
  connected: boolean;
  source?: "manual" | "oauth";
  base_url?: string | null;
  key_hint?: string | null;
}

interface PlanInfo {
  plan: "free" | "pro";
  status: string | null;
  renews_at: number | null;
  has_billing_account: boolean;
  price_cents: number;
  monthly_cap_usd: number;
  allowance: { limit: number | null; remaining: number | null; usage: number | null } | null;
  billing_enabled: boolean;
}

interface DecisionSettings {
  model: string | null;
  server_available: boolean;
  active: boolean;
  models: { id: string; name: string }[];
}

interface SettingsData {
  default_provider: ChatProvider;
  default_model: string | null;
  decision: DecisionSettings;
  providers: Record<ProviderId, ProviderStatus>;
  openrouter_credits: { total: number; used: number } | null;
  trial: { remaining: number; limit: number } | null;
  plan: PlanInfo;
}

const KEY_HELP: Record<ProviderId, { placeholder: string; link: string; note: string }> = {
  openrouter: { placeholder: "sk-or-…", link: "https://openrouter.ai/settings/keys", note: "" },
  openai: { placeholder: "sk-…", link: "https://platform.openai.com/api-keys", note: "Used for GPT models." },
  anthropic: { placeholder: "sk-ant-…", link: "https://console.anthropic.com/settings/keys", note: "Used for Claude models." },
  ollama: {
    placeholder: "Ollama API key",
    link: "https://ollama.com/settings/keys",
    note: "Runs chats on Ollama Cloud with your own key, billed to your Ollama account. Pick a model that supports tool calling (e.g. gpt-oss, qwen3) so the tutor can search the paper.",
  },
};

export function SettingsPage() {
  const { user, setUser, logout } = useAuth();
  const url = useLocation();
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proParam = url.searchParams.get("pro");
  const [flash, setFlash] = useState<string | null>(
    url.searchParams.get("connected") === "openrouter"
      ? "OpenRouter connected. You can now use free models and any models your credits cover."
      : proParam === "success"
        ? "Payment received. Activating Pro…"
        : proParam === "cancelled"
          ? "Checkout cancelled. You haven't been charged."
          : null,
  );

  const load = () =>
    api<SettingsData>("/settings")
      .then(setData)
      .catch((e) => setError((e as Error).message));

  useEffect(() => {
    if (user) load();
  }, [user]);

  // After checkout, Pro turns on when Stripe's webhook lands (usually seconds). Poll briefly.
  const polled = useRef(false);
  useEffect(() => {
    if (proParam !== "success" || !user || polled.current) return;
    polled.current = true;
    if (user.plan === "pro") return setFlash("Welcome to Pro! Lich Pro models are now available in the chat.");
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      const me = await api<{ user: User | null }>("/me").catch(() => null);
      if (me?.user?.plan === "pro") {
        clearInterval(timer);
        setUser(me.user);
        setFlash("Welcome to Pro! Lich Pro models are now available in the chat.");
      } else if (tries >= 15) {
        clearInterval(timer);
        setFlash("Payment received, but Pro isn't active yet. Refresh in a minute; if it still isn't on, contact support.");
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [proParam, user, setUser]);

  return (
    <RequireAuth>
      <div className="list-page settings">
        <h1>Settings</h1>
        {url.searchParams.get("welcome") && !data?.providers.openrouter.connected && (
          <div className="card highlight">
            <h3>Welcome! One step to start chatting for free</h3>
            <p>
              Connect your OpenRouter account to use the free model router at no cost. No credit card needed. Already have keys for OpenAI,
              Anthropic, or Ollama? Add them below.
            </p>
            <button className="primary" onClick={startOpenRouterConnect}>
              Connect with OpenRouter
            </button>
          </div>
        )}
        {flash && (
          <p className="notice" role="button" tabIndex={0} onClick={() => setFlash(null)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setFlash(null)}>
            {flash}
          </p>
        )}
        {error && <p className="error">{error}</p>}
        {data && (
          <>
            <PlanCard plan={data.plan} />
            <OpenRouterCard data={data} reload={load} />
            {(["openai", "anthropic", "ollama"] as ProviderId[]).map((p) => (
              <KeyCard key={p} provider={p} status={data.providers[p]} reload={load} />
            ))}
            <DecisionCard decision={data.decision} ollamaConnected={data.providers.ollama.connected} reload={load} />
            <section className="card">
              <h3>Account</h3>
              <p className="small">
                Signed in as <strong>{user?.email}</strong>
              </p>
              <p className="muted small">
                Account ID: <code className="selectable">{user?.id}</code>
              </p>
              <div className="row">
                <button onClick={logout}>Sign out</button>
              </div>
            </section>
            <DataCard />
            <DefaultModelCard
              data={data}
              onSaved={(provider, model) => {
                if (user) setUser({ ...user, default_provider: provider, default_model: model || null });
                try {
                  localStorage.removeItem("lp_model");
                } catch {}
                setFlash("Default model saved.");
                load();
              }}
            />
          </>
        )}
      </div>
    </RequireAuth>
  );
}

function DataCard() {
  const { setUser } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/account/delete", { method: "POST", json: { password } });
      try {
        localStorage.removeItem("lp_model");
      } catch {}
      setUser(null);
      navigate("/?deleted=1");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h3>Your data</h3>
      <p className="muted small">
        Download everything we store about you (account, conversations, notes, usage), or permanently delete your account. See the{" "}
        <Link href="/privacy">Privacy Policy</Link>.
      </p>
      <div className="row">
        <a className="button" href="/api/account/export" download>
          Download my data
        </a>
        {!confirming && (
          <button className="danger" onClick={() => setConfirming(true)}>
            Delete account…
          </button>
        )}
      </div>
      {confirming && (
        <form className="stack" onSubmit={remove}>
          <p className="small">
            This permanently deletes your account, conversations, notes, and saved keys, and cancels any Pro subscription immediately with no
            refund for the current month. It can't be undone.
          </p>
          <input
            type="password"
            autoComplete="current-password"
            aria-label="Confirm your password"
            placeholder="Confirm your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button className="danger" disabled={busy || !password}>
              {busy ? "Deleting…" : "Permanently delete my account"}
            </button>
            <button type="button" onClick={() => (setConfirming(false), setPassword(""), setError(null))} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

const PRO_FEATURES = [
  "Strong hosted models, no API key needed",
  "Unlimited notes in your knowledge base",
  "Build on up to 5 earlier sessions at once",
  "Export your knowledge base to Markdown (Obsidian, Notion)",
];

function PlanCard({ plan }: { plan: PlanInfo }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const price = `$${(plan.price_cents / 100).toFixed(plan.price_cents % 100 ? 2 : 0)}`;

  const go = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>(path, { method: "POST" });
      location.href = url;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (plan.plan === "pro") {
    const a = plan.allowance;
    const usedPct = a?.limit && a.remaining !== null ? Math.min(100, Math.round(((a.limit - a.remaining) / a.limit) * 100)) : null;
    return (
      <section className="card highlight">
        <h3>
          Lich Pro <span className="tag ok">{plan.status === "past_due" ? "payment issue" : plan.status === "comp" ? "complimentary" : "active"}</span>
        </h3>
        {plan.status === "past_due" && <p className="error small">Your last payment failed. Update your card to keep Pro.</p>}
        {usedPct !== null && (
          <>
            <p className="small">AI allowance this month: {usedPct}% used. It resets on the 1st.</p>
            <div className="meter" role="progressbar" aria-label="AI allowance used" aria-valuenow={usedPct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${usedPct}%` }} />
            </div>
          </>
        )}
        {plan.renews_at && <p className="muted small">Renews {new Date(plan.renews_at).toLocaleDateString()}.</p>}
        <p className="muted small">If you use up the month's allowance, chats keep working on the free model router until it resets.</p>
        {error && <p className="error">{error}</p>}
        {plan.has_billing_account && (
          <div className="row">
            <button onClick={() => go("/billing/portal")} disabled={busy}>
              Manage billing
            </button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="card">
      <h3>Lich Pro · {price}/month</h3>
      <ul className="features">
        {PRO_FEATURES.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
      {plan.billing_enabled ? (
        <div className="row">
          <button className="primary" onClick={() => go("/billing/checkout")} disabled={busy}>
            {busy ? "Opening checkout…" : `Upgrade for ${price}/month`}
          </button>
          {plan.has_billing_account && (
            <button onClick={() => go("/billing/portal")} disabled={busy}>
              Billing history
            </button>
          )}
        </div>
      ) : (
        <p className="muted small">Pro is coming soon.</p>
      )}
      <p className="muted small">
        Renews monthly; cancel anytime. No refunds for partial months (<Link href="/refunds">details</Link>). Free stays free: use your own
        OpenRouter account or API keys.
      </p>
    </section>
  );
}

function OpenRouterCard({ data, reload }: { data: SettingsData; reload: () => void }) {
  const s = data.providers.openrouter;
  const [error, setError] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const credits = data.openrouter_credits;
  const balance = credits ? credits.total - credits.used : null;
  return (
    <section className="card">
      <h3>OpenRouter {s.connected && <span className="tag ok">connected</span>}</h3>
      <p className="muted small">
        The default. With OpenRouter connected you get the <code>openrouter/free</code> router at no cost, and if you add credits to your
        OpenRouter account you can pick any of its 300+ models.
      </p>
      {error && <p className="error">{error}</p>}
      {s.connected ? (
        <>
          <p className="small">
            {s.source === "oauth" ? "Connected via OpenRouter sign-in" : "Using a pasted key"} {s.key_hint && <code>{s.key_hint}</code>}
            {balance !== null && <> · Balance: ${balance.toFixed(2)}</>}
          </p>
          <div className="row">
            <button onClick={startOpenRouterConnect}>Reconnect</button>
            <button
              className="danger"
              onClick={async () => {
                try {
                  await api("/settings/keys/openrouter", { method: "DELETE" });
                  reload();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          {data.trial && (
            <p className="small">
              Until you connect, you're on a free trial: {data.trial.remaining} of {data.trial.limit} messages left.
            </p>
          )}
          <div className="row">
            <button className="primary" onClick={startOpenRouterConnect}>
              Connect with OpenRouter
            </button>
            <button onClick={() => setShowPaste((v) => !v)}>Paste a key instead</button>
          </div>
          {showPaste && <KeyForm provider="openrouter" onSaved={reload} />}
        </>
      )}
    </section>
  );
}

function KeyCard({ provider, status, reload }: { provider: ProviderId; status: ProviderStatus; reload: () => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const help = KEY_HELP[provider];
  return (
    <section className="card">
      <h3>
        {PROVIDER_LABELS[provider]} {status.connected && <span className="tag ok">connected</span>}
      </h3>
      <p className="muted small">
        {help.note}{" "}
        <a href={help.link} target="_blank" rel="noreferrer">
          Get a key ↗
        </a>
      </p>
      {error && <p className="error">{error}</p>}
      {status.connected && !editing ? (
        <>
          <p className="small">
            {status.key_hint && <code>{status.key_hint}</code>} {status.base_url && <code>{status.base_url}</code>}
          </p>
          <div className="row">
            <button onClick={() => setEditing(true)}>Replace</button>
            <button
              className="danger"
              onClick={async () => {
                try {
                  await api(`/settings/keys/${provider}`, { method: "DELETE" });
                  reload();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Remove
            </button>
          </div>
        </>
      ) : (
        <KeyForm
          provider={provider}
          initialBase={status.base_url ?? ""}
          onCancel={status.connected ? () => setEditing(false) : undefined}
          onSaved={() => {
            setEditing(false);
            reload();
          }}
        />
      )}
    </section>
  );
}

const OLLAMA_CLOUD = "https://ollama.com";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function KeyForm({ provider, initialBase = "", onSaved, onCancel }: { provider: ProviderId; initialBase?: string; onSaved: () => void; onCancel?: () => void }) {
  const [key, setKey] = useState("");
  // Ollama defaults to Ollama Cloud; "self-hosted" reveals a base URL for your own HTTPS server.
  const [selfHosted, setSelfHosted] = useState(provider === "ollama" && !!initialBase && !/(^|\.)ollama\.com$/.test(hostOf(initialBase)));
  const [base, setBase] = useState(provider === "ollama" ? (selfHosted ? initialBase : "") : initialBase);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showBase = provider === "openai" || (provider === "ollama" && selfHosted);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const base_url = provider === "ollama" && !selfHosted ? OLLAMA_CLOUD : base;
          await api(`/settings/keys/${provider}`, { method: "PUT", json: { api_key: key, base_url } });
          setKey("");
          onSaved();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        type="password"
        autoComplete="off"
        aria-label={`${PROVIDER_LABELS[provider]} API key`}
        placeholder={provider === "ollama" && selfHosted ? "API key (optional for your own server)" : KEY_HELP[provider].placeholder}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        required={provider !== "ollama" || !selfHosted}
      />
      {showBase && (
        <input
          aria-label="Base URL"
          placeholder={provider === "openai" ? "Base URL (optional, for OpenAI-compatible APIs)" : "https://your-ollama-server.example.com"}
          value={base}
          onChange={(e) => setBase(e.target.value)}
          required={provider === "ollama"}
        />
      )}
      {provider === "ollama" && (
        <label className="inline small">
          <input type="checkbox" checked={selfHosted} onChange={(e) => setSelfHosted(e.target.checked)} /> Use my own Ollama server instead of
          Ollama Cloud (must be reachable over HTTPS, e.g. through a Cloudflare Tunnel)
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="primary" disabled={busy}>
          Save
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
      <p className="muted small">Keys are encrypted at rest and only used to call the provider on your behalf.</p>
    </form>
  );
}

function DefaultModelCard({ data, onSaved }: { data: SettingsData; onSaved: (p: ChatProvider, m: string) => void }) {
  const available = chatProviders(data.plan, data.providers);
  const [provider, setProvider] = useState<ChatProvider>(available.includes(data.default_provider) ? data.default_provider : "openrouter");
  const [model, setModel] = useState(data.default_model ?? "");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [freeOnly, setFreeOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setModels([]);
    setError(null);
    api<{ models: ModelInfo[] }>(`/models/${provider}`)
      .then((r) => !cancelled && setModels(r.models))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const shown = models.filter((m) => !freeOnly || m.free);
  return (
    <section className="card">
      <h3>Default model</h3>
      <p className="muted small">
        Used for new chats (you can switch per message in the chat panel). If your chosen model fails, the tutor falls back to the free
        OpenRouter router automatically.
      </p>
      <div className="stack">
        <select value={provider} aria-label="Default provider" onChange={(e) => (setProvider(e.target.value as ChatProvider), setModel(""))}>
          {available.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
        {models.length > 0 ? (
          <select value={model} aria-label="Default model" onChange={(e) => setModel(e.target.value)}>
            <option value="">{provider === "openrouter" ? "openrouter/free (default)" : provider === "pro" ? "Recommended Pro model (default)" : "Choose a model…"}</option>
            {model && !shown.some((m) => m.id === model) && <option value={model}>{model}</option>}
            {shown.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.free ? " · free" : ""}
              </option>
            ))}
          </select>
        ) : (
          <input aria-label="Default model" placeholder="model id" value={model} onChange={(e) => setModel(e.target.value)} />
        )}
        {provider === "openrouter" && (
          <label className="inline small">
            <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} /> Show free models only
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <button
          className="primary"
          onClick={async () => {
            setError(null);
            if (provider !== "openrouter" && provider !== "pro" && !model) return setError("Choose a model for this provider.");
            try {
              await api("/settings/default", { method: "PUT", json: { provider, model } });
              onSaved(provider, model);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Save default
        </button>
      </div>
    </section>
  );
}

/** Picks the decision model (Clef on Ollama) used for smart ranking, routing, note tags and answer checks. */
function DecisionCard({ decision, ollamaConnected, reload }: { decision: DecisionSettings; ollamaConnected: boolean; reload: () => void }) {
  const known = decision.models.some((m) => m.id === decision.model);
  const initial = decision.model === null ? "" : decision.model === "off" ? "off" : known ? decision.model : "custom";
  const [pick, setPick] = useState(initial);
  const [custom, setCustom] = useState(known || !decision.model || decision.model === "off" ? "" : decision.model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const model = pick === "" ? null : pick === "custom" ? custom.trim() : pick;
      await api("/settings/decision", { method: "PUT", json: { model } });
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const needsKey = pick !== "" && pick !== "off" && !ollamaConnected;
  return (
    <section className="card">
      <h3>Decision model</h3>
      <p className="small">
        A small judge model (Cloudflare's Clef on Ollama) that re-ranks search results, steers the tutor to the right tools, tags your notes,
        looks at figures, and checks answers against the paper. It runs on your Ollama key, alongside your chat model.
      </p>
      <p className="small">
        Status: <strong>{decision.active ? "on" : "off"}</strong>
        {decision.model === null && decision.server_available && " (using the app's shared decision model)"}
      </p>
      <div className="row">
        <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Decision model">
          <option value="">{decision.server_available ? "Default (app's shared model)" : "Default (off)"}</option>
          {decision.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          <option value="custom">Other Ollama decision model…</option>
          <option value="off">Off</option>
        </select>
        {pick === "custom" && <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. clef:27b" />}
        <button onClick={save} disabled={busy || (pick === "custom" && !custom.trim())}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {needsKey && <p className="small muted">Add your Ollama key above to use your own decision model.</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
