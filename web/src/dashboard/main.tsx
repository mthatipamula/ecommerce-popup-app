import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";
import "./dashboard.css";

interface Stats {
  campaignId: string; name: string; status: string; discountPercent: number; views: number; signups: number; smsOptIns: number;
  redemptions: number; revenueCents: number; flagged: number; blocked: number; poolSize: number; signupRate: number; redemptionRate: number;
}
interface Campaign { id: string; name: string; status: string; headline: string; discountPercent: number; createdBy: string }
interface Overview { provider: string; model: string | null; campaigns: Campaign[]; stats: Stats[] }
interface Signup { id: number; email: string; phone: string | null; sms_consent: boolean; code: string; abuse_status: string; code_status: string; created_at: string }
interface Rec { id: number; campaign_id: string; discount_percent: number; rationale: string; status: string }
interface ToolCall { tool: string; input: unknown; result: any; error?: string }
interface AgentResult { agent: string; provider: string; output: string; toolCalls: ToolCall[]; runId: number }

const usd = (c: number) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function useApi() {
  const [token, setToken] = useState(() => localStorage.getItem("admin-token") ?? "demo-admin-token");
  const call = useCallback(async <T,>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
    const r = await fetch(path, {
      method: init?.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status}`);
    return r.json();
  }, [token]);
  return { call, token, setToken: (t: string) => { localStorage.setItem("admin-token", t); setToken(t); } };
}

const PROMPTS = [
  "Draft a Black Friday popup for Northwind Running with 20% off",
  "Check the latest sign-ups for fraud",
  "Is our discount too generous? Review the live campaign's offer",
  "How is the popup performing this week?",
];

function App() {
  const { call } = useApi();
  const [o, setO] = useState<Overview | null>(null);
  const [signups, setSignups] = useState<Signup[]>([]);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [prompt, setPrompt] = useState(PROMPTS[0]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [ov, su, rc] = await Promise.all([call<Overview>("/admin/overview"), call<Signup[]>("/admin/signups?limit=15"), call<Rec[]>("/admin/recommendations")]);
      setO(ov); setSignups(su); setRecs(rc); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [call]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); }, [refresh]);

  async function act(path: string) {
    try { await call(path, { method: "POST" }); await refresh(); } catch (e) { setError((e as Error).message); }
  }
  async function ask(text = prompt) {
    setRunning(true); setResult(null);
    try { setResult(await call<AgentResult>("/admin/agents/orchestrator", { method: "POST", body: { input: text } })); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setRunning(false); }
  }

  const live = o?.stats.find((s) => s.status === "active");
  const totals = (o?.stats ?? []).reduce((t, s) => ({
    views: t.views + s.views, signups: t.signups + s.signups, sms: t.sms + s.smsOptIns, redemptions: t.redemptions + s.redemptions, revenue: t.revenue + s.revenueCents,
  }), { views: 0, signups: 0, sms: 0, redemptions: 0, revenue: 0 });

  return (
    <div className="app">
      <header>
        <h1>Popup dashboard <span className="shop">northwind-running.myshopify.com</span></h1>
        <span className={`pill ${o?.provider === "offline" ? "warn" : "ok"}`}>
          Agents: {o ? (o.provider === "offline" ? "offline mode (no model)" : `${o.provider} · ${o.model}`) : "…"}
        </span>
        <a href="/demo/" target="_blank" rel="noreferrer">Open storefront ↗</a>
      </header>
      {error && <div className="error">{error}</div>}

      <section className="kpis">
        <Kpi label="Popup views" value={totals.views.toLocaleString()} />
        <Kpi label="Sign-ups" value={totals.signups.toLocaleString()} sub={totals.views ? pct(totals.signups / totals.views) + " of views" : ""} />
        <Kpi label="SMS opt-ins" value={totals.sms.toLocaleString()} />
        <Kpi label="Codes redeemed" value={totals.redemptions.toLocaleString()} sub={totals.signups ? pct(totals.redemptions / totals.signups) + " of sign-ups" : ""} />
        <Kpi label="Attributed revenue" value={usd(totals.revenue)} />
        <Kpi label="Codes ready (live pool)" value={(live?.poolSize ?? 0).toLocaleString()} />
      </section>

      <section className="panel agents">
        <h2>Ask the agents</h2>
        <p className="muted">The orchestrator hands work to four specialists: campaign, offer, abuse and insights. Nothing goes live without your click.</p>
        <div className="chips">{PROMPTS.map((p) => <button key={p} className="chip" onClick={() => { setPrompt(p); ask(p); }} disabled={running}>{p}</button>)}</div>
        <form onSubmit={(e) => { e.preventDefault(); ask(); }}>
          <input value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Request for the agents" />
          <button disabled={running}>{running ? "Working…" : "Run"}</button>
        </form>
        {result && (
          <div className="result">
            <pre>{result.output}</pre>
            <details open>
              <summary>Trace: {result.toolCalls.length} tool call(s)</summary>
              <ol className="trace">
                {result.toolCalls.map((t, i) => (
                  <li key={i}>
                    <code>{t.tool}</code>
                    {t.result?.agent && <span className="sub"> → {t.result.agent} (run #{t.result.runId})</span>}
                    {t.error && <span className="err"> failed: {t.error}</span>}
                  </li>
                ))}
              </ol>
            </details>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Campaigns</h2>
        <table>
          <thead><tr><th>Name</th><th>Status</th><th>Offer</th><th>Views</th><th>Sign-ups</th><th>Redeemed</th><th>Revenue</th><th>Flagged / blocked</th><th>By</th><th /></tr></thead>
          <tbody>
            {o?.campaigns.map((c) => {
              const s = o.stats.find((x) => x.campaignId === c.id);
              return (
                <tr key={c.id}>
                  <td title={c.headline}>{c.name}</td>
                  <td><span className={`pill ${c.status}`}>{c.status}</span></td>
                  <td>{c.discountPercent}%</td>
                  <td>{s?.views ?? 0}</td><td>{s?.signups ?? 0}</td><td>{s?.redemptions ?? 0}</td><td>{usd(s?.revenueCents ?? 0)}</td>
                  <td>{s?.flagged ?? 0} / {s?.blocked ?? 0}</td>
                  <td>{c.createdBy}</td>
                  <td>{c.status === "active"
                    ? <button className="small ghost" onClick={() => act(`/admin/campaigns/${c.id}/pause`)}>Pause</button>
                    : <button className="small" onClick={() => act(`/admin/campaigns/${c.id}/activate`)}>Activate</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {recs.some((r) => r.status === "proposed") && (
        <section className="panel">
          <h2>Offer recommendations</h2>
          {recs.filter((r) => r.status === "proposed").map((r) => (
            <div key={r.id} className="rec">
              <strong>{r.discount_percent}% off</strong> <span>{r.rationale}</span>
              <button className="small" onClick={() => act(`/admin/recommendations/${r.id}/apply`)}>Apply as new version</button>
              <button className="small ghost" onClick={() => act(`/admin/recommendations/${r.id}/dismiss`)}>Dismiss</button>
            </div>
          ))}
        </section>
      )}

      <section className="panel">
        <h2>Latest sign-ups</h2>
        <table>
          <thead><tr><th>When</th><th>Email</th><th>Phone</th><th>SMS</th><th>Code</th><th>Code status</th><th>Review</th></tr></thead>
          <tbody>
            {signups.map((s) => (
              <tr key={s.id}>
                <td>{new Date(s.created_at).toLocaleTimeString()}</td><td>{s.email}</td><td>{s.phone ?? "—"}</td><td>{s.sms_consent ? "✓" : ""}</td>
                <td><code>{s.code}</code></td><td><span className={`pill ${s.code_status}`}>{s.code_status}</span></td>
                <td><span className={`pill ${s.abuse_status}`}>{s.abuse_status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="kpi"><div className="label">{label}</div><div className="value">{value}</div>{sub && <div className="sub">{sub}</div>}</div>;
}

createRoot(document.getElementById("root")!).render(<App />);
