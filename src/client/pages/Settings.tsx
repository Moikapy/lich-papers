import { useEffect, useState } from "react";
import { api, PROVIDER_LABELS, type ModelInfo, type ProviderId } from "../api";
import { useAuth } from "../auth";
import { startOpenRouterConnect } from "../openrouter";
import { useLocation } from "../router";
import { RequireAuth } from "./RequireAuth";

interface ProviderStatus {
  connected: boolean;
  source?: "manual" | "oauth";
  base_url?: string | null;
  key_hint?: string | null;
}

interface SettingsData {
  default_provider: ProviderId;
  default_model: string | null;
  providers: Record<ProviderId, ProviderStatus>;
  openrouter_credits: { total: number; used: number } | null;
  shared_free: { remaining_today: number; limit: number } | null;
}

const KEY_HELP: Record<ProviderId, { placeholder: string; link: string; note: string }> = {
  openrouter: { placeholder: "sk-or-…", link: "https://openrouter.ai/settings/keys", note: "" },
  openai: { placeholder: "sk-…", link: "https://platform.openai.com/api-keys", note: "Used for GPT models." },
  anthropic: { placeholder: "sk-ant-…", link: "https://console.anthropic.com/settings/keys", note: "Used for Claude models." },
  ollama: {
    placeholder: "API key (Ollama Cloud only)",
    link: "https://ollama.com/settings/keys",
    note: "Use Ollama Cloud (https://ollama.com + API key), or your own Ollama server exposed over HTTPS (e.g. a Cloudflare Tunnel). The app runs in the cloud, so it can't reach localhost.",
  },
};

export function SettingsPage() {
  const { user, setUser } = useAuth();
  const url = useLocation();
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(
    url.searchParams.get("connected") === "openrouter" ? "OpenRouter connected. You can now use free models and any models your credits cover." : null,
  );

  const load = () =>
    api<SettingsData>("/settings")
      .then(setData)
      .catch((e) => setError((e as Error).message));

  useEffect(() => {
    if (user) load();
  }, [user]);

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
          <p className="notice" onClick={() => setFlash(null)}>
            {flash}
          </p>
        )}
        {error && <p className="error">{error}</p>}
        {data && (
          <>
            <OpenRouterCard data={data} reload={load} />
            {(["openai", "anthropic", "ollama"] as ProviderId[]).map((p) => (
              <KeyCard key={p} provider={p} status={data.providers[p]} reload={load} />
            ))}
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

function OpenRouterCard({ data, reload }: { data: SettingsData; reload: () => void }) {
  const s = data.providers.openrouter;
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
                await api("/settings/keys/openrouter", { method: "DELETE" });
                reload();
              }}
            >
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          {data.shared_free && (
            <p className="small">
              Until you connect, you're using a shared free allowance: {data.shared_free.remaining_today}/{data.shared_free.limit} messages left today.
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
                await api(`/settings/keys/${provider}`, { method: "DELETE" });
                reload();
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
          onSaved={() => {
            setEditing(false);
            reload();
          }}
        />
      )}
    </section>
  );
}

function KeyForm({ provider, initialBase = "", onSaved }: { provider: ProviderId; initialBase?: string; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [base, setBase] = useState(initialBase || (provider === "ollama" ? "https://ollama.com" : ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showBase = provider === "ollama" || provider === "openai";
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api(`/settings/keys/${provider}`, { method: "PUT", json: { api_key: key, base_url: base } });
          setKey("");
          onSaved();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input type="password" autoComplete="off" placeholder={KEY_HELP[provider].placeholder} value={key} onChange={(e) => setKey(e.target.value)} />
      {showBase && (
        <input
          placeholder={provider === "openai" ? "Base URL (optional, for OpenAI-compatible APIs)" : "Base URL"}
          value={base}
          onChange={(e) => setBase(e.target.value)}
        />
      )}
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy}>
        Save
      </button>
      <p className="muted small">Keys are encrypted at rest and only used to call the provider on your behalf.</p>
    </form>
  );
}

function DefaultModelCard({ data, onSaved }: { data: SettingsData; onSaved: (p: ProviderId, m: string) => void }) {
  const [provider, setProvider] = useState<ProviderId>(data.default_provider);
  const [model, setModel] = useState(data.default_model ?? "");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [freeOnly, setFreeOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = (Object.keys(PROVIDER_LABELS) as ProviderId[]).filter((p) => p === "openrouter" || data.providers[p].connected);

  useEffect(() => {
    setModels([]);
    api<{ models: ModelInfo[] }>(`/models/${provider}`)
      .then((r) => setModels(r.models))
      .catch((e) => setError((e as Error).message));
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
        <select value={provider} onChange={(e) => (setProvider(e.target.value as ProviderId), setModel(""))}>
          {available.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
        {models.length > 0 ? (
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">{provider === "openrouter" ? "openrouter/free (default)" : "Choose a model…"}</option>
            {shown.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.free ? " · free" : ""}
              </option>
            ))}
          </select>
        ) : (
          <input placeholder="model id" value={model} onChange={(e) => setModel(e.target.value)} />
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
            if (provider !== "openrouter" && !model) return setError("Choose a model for this provider.");
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
