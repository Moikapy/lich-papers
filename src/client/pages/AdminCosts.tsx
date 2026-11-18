import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { RequireAuth } from "./RequireAuth";

interface CostReport {
  since: number;
  days: number;
  totals: { app_cost_usd: number; app_calls: number; user_paid_calls: number; user_paid_tokens: number };
  by_day: { day: string; app_cost_usd: number; calls: number }[];
  by_source: { billed_to: string; provider: string | null; model: string | null; calls: number; prompt_tokens: number; completion_tokens: number; cost_usd: number; basis: string }[];
  top_users: { id: string; email: string; plan: string; calls: number; app_cost_usd: number }[];
  plans: { free: number; pro: number; comp: number };
  pro_revenue_usd_month: number;
  fallback_this_month: { users: number; messages: number };
  unpriced_models: string[];
}

const usd = (n: number) => (n === 0 ? "$0" : n < 0.0001 ? "<$0.0001" : n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const num = (n: number) => n.toLocaleString();

const BASIS: Record<string, string> = {
  user: "their key",
  list: "list price",
  flat: "flat plan",
  free: "free model",
  unknown: "no price",
};

const PAYER: Record<string, string> = {
  user: "User's own key",
  pro: "Pro (your OpenRouter)",
  trial: "Free trial",
  fallback: "Fallback",
  decision: "Clef decisions",
};

/** Admin-only: what the app pays for AI, from usage logs and list prices. */
export function AdminCostsPage() {
  return (
    <RequireAuth>
      <AdminCosts />
    </RequireAuth>
  );
}

function AdminCosts() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<CostReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    api<CostReport>(`/admin/costs?days=${days}`)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError && e.status === 403 ? "This page is for admins only." : (e as Error).message));
  }, [days]);

  if (error) return <p className="error">{error}</p>;

  const perPaying = data && data.plans.pro ? data.totals.app_cost_usd / data.plans.pro : null;

  return (
    <div className="list-page admin-costs">
      <div className="row spread">
        <h1>AI costs</h1>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="stat-grid">
            <Stat label="You paid for AI" value={usd(data.totals.app_cost_usd)} hint={`${num(data.totals.app_calls)} replies and decisions`} />
            <Stat label="Pro revenue / month" value={usd(data.pro_revenue_usd_month)} hint={`${data.plans.pro} paying${data.plans.comp ? `, ${data.plans.comp} complimentary` : ""}`} />
            <Stat label="AI cost per paying user" value={perPaying === null ? "–" : usd(perPaying)} hint={`over ${data.days} days`} />
            <Stat label="Fallback this month" value={num(data.fallback_this_month.messages)} hint={`messages from ${plural(data.fallback_this_month.users, "user")}`} />
            <Stat label="On users' own keys" value={num(data.totals.user_paid_calls)} hint={`${num(data.totals.user_paid_tokens)} tokens, $0 to you`} />
            <Stat label="Accounts" value={num(data.plans.free + data.plans.pro + data.plans.comp)} hint={`${data.plans.free} free`} />
          </div>

          {data.unpriced_models.length > 0 && (
            <p className="notice">Couldn't price: {data.unpriced_models.join(", ")}. Their cost isn't in the totals.</p>
          )}

          <section className="card">
            <h3>By source</h3>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Paid by</th>
                    <th>Provider / model</th>
                    <th className="num">Calls</th>
                    <th className="num">Tokens in / out</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_source.map((s, i) => (
                    <tr key={i}>
                      <td>{PAYER[s.billed_to] ?? s.billed_to}</td>
                      <td>
                        <code>{s.provider ?? "?"}</code> {s.model}
                      </td>
                      <td className="num">{num(s.calls)}</td>
                      <td className="num">
                        {num(s.prompt_tokens)} / {num(s.completion_tokens)}
                      </td>
                      <td className="num">
                        {s.billed_to === "user" || s.basis === "unknown" ? "–" : usd(s.cost_usd)} <span className="muted small">{BASIS[s.basis] ?? s.basis}</span>
                      </td>
                    </tr>
                  ))}
                  {!data.by_source.length && (
                    <tr>
                      <td colSpan={5} className="muted">
                        No usage in this period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <h3>Top users by cost to you</h3>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Plan</th>
                    <th className="num">Calls</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.top_users.map((u) => (
                    <tr key={u.id}>
                      <td>{u.email}</td>
                      <td>{u.plan}</td>
                      <td className="num">{num(u.calls)}</td>
                      <td className="num">{usd(u.app_cost_usd)}</td>
                    </tr>
                  ))}
                  {!data.top_users.length && (
                    <tr>
                      <td colSpan={4} className="muted">
                        Nobody has used app-paid AI in this period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <h3>By day</h3>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Day (UTC)</th>
                    <th className="num">App-paid calls</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.by_day].reverse().map((d) => (
                    <tr key={d.day}>
                      <td>{d.day}</td>
                      <td className="num">{num(d.calls)}</td>
                      <td className="num">{usd(d.app_cost_usd)}</td>
                    </tr>
                  ))}
                  {!data.by_day.length && (
                    <tr>
                      <td colSpan={3} className="muted">
                        No app-paid usage in this period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <p className="muted small">
            Estimates from logged token counts and list prices (OpenRouter's model prices, Workers AI's published rates). Ollama Cloud is a flat
            plan, so it shows as $0 per message. Pro spend is also capped per subscriber on OpenRouter.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat card">
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  );
}
