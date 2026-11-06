import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";
import "./dashboard.css";

interface Stats {
  campaignId: string; name: string; status: string; discountPercent: number; views: number; signups: number; smsOptIns: number;
  redemptions: number; revenueCents: number; flagged: number; blocked: number; poolSize: number; signupRate: number; redemptionRate: number;
}
interface Campaign {
  id: string; name: string; status: string; headline: string; discountPercent: number; createdBy: string;
  startsAt: string | null; endsAt: string | null;
}
interface Overview { provider: string; model: string | null; campaigns: Campaign[]; stats: Stats[]; liveCampaignId: string | null }
interface Signup { id: number; email: string; phone: string | null; sms_consent: boolean; code: string; abuse_status: string; code_status: string; created_at: string }
interface Rec { id: number; campaign_id: string; discount_percent: number; rationale: string; status: string }
interface ToolCall { tool: string; input: unknown; result: any; error?: string }
interface AgentResult { agent: string; provider: string; output: string; toolCalls: ToolCall[]; runId: number }

const usd = (c: number) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const TOKEN_KEY = "admin-token";
// Locally the stack runs with this token, so the dashboard opens straight away; a deployed one has its own.
const LOCAL_TOKEN = "demo-admin-token";

function readToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) ?? LOCAL_TOKEN; } catch { return LOCAL_TOKEN; }
}
function storeToken(t: string | null) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
}

type Api = ReturnType<typeof useApi>;

/** Admin API calls with the merchant's token. A 401 (missing, wrong or rotated token) sends them to the sign-in screen. */
function useApi() {
  const [token, setToken] = useState(readToken);
  const [signedIn, setSignedIn] = useState(true);
  const call = useCallback(async <T,>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
    const r = await fetch(path, {
      method: init?.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    if (r.status === 401) { setSignedIn(false); throw new Error("Sign in again: the admin token was not accepted."); }
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(b.message ?? b.error ?? `${r.status}`);
    }
    return r.json();
  }, [token]);

  /** Checks a token against the API before keeping it. Resolves to an error message, or null when it works. */
  const signIn = useCallback(async (t: string): Promise<string | null> => {
    try {
      const r = await fetch("/admin/overview", { headers: { Authorization: `Bearer ${t}` } });
      if (r.status === 401) return "That token wasn't accepted. Check it and try again.";
      if (!r.ok) return `The dashboard API returned ${r.status}. Try again in a moment.`;
    } catch {
      return "Couldn't reach the dashboard API. Check your connection and try again.";
    }
    storeToken(t); setToken(t); setSignedIn(true);
    return null;
  }, []);
  const signOut = useCallback(() => { storeToken(null); setToken(""); setSignedIn(false); }, []);

  return { call, signedIn, signIn, signOut };
}

function SignIn({ api }: { api: Api }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = value.trim();
    if (!t) { setError("Paste your admin token."); return; }
    setBusy(true); setError(await api.signIn(t)); setBusy(false);
  }
  return (
    <main className="signin">
      <form className="panel" onSubmit={submit}>
        <h1>Popup dashboard</h1>
        <p className="muted">Sign in with the store's admin token.</p>
        <label htmlFor="token">Admin token</label>
        <input id="token" type="password" autoComplete="current-password" autoFocus value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }} aria-invalid={!!error} aria-describedby="token-help" />
        {error && <div className="error" role="alert">{error}</div>}
        <button disabled={busy}>{busy ? "Checking…" : "Sign in"}</button>
        <p id="token-help" className="muted help">
          On GCP, get it with <code>gcloud secrets versions access latest --secret popup-admin-token</code>.
          Running locally, it's <code>{LOCAL_TOKEN}</code>. This browser remembers it until you sign out.
        </p>
      </form>
    </main>
  );
}

function Root() {
  const api = useApi();
  return api.signedIn ? <App api={api} /> : <SignIn api={api} />;
}

const PROMPTS = [
  "Welcome 20% off for 15 days starting tomorrow",
  "Draft a Black Friday popup for Northwind Running with 20% off",
  "Check the latest sign-ups for fraud",
  "Is our discount too generous? Review the live campaign's offer",
  "How is the popup performing this week?",
];

function App({ api }: { api: Api }) {
  const { call } = api;
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

  async function act(path: string, method = "POST") {
    try { await call(path, { method }); await refresh(); } catch (e) { setError((e as Error).message); }
  }
  function removeCampaign(c: Campaign, s?: Stats) {
    const used = (s?.signups ?? 0) > 0;
    const msg = used
      ? `Remove "${c.name}"? It stops showing and leaves this list. The ${s!.signups} code(s) already sent to shoppers keep working, and its results stay in the totals.`
      : `Remove "${c.name}"? It has no sign-ups, so it will be deleted.`;
    if (window.confirm(msg)) act(`/admin/campaigns/${c.id}`, "DELETE");
  }
  async function ask(text = prompt) {
    setRunning(true); setResult(null);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;   // schedules are days in the merchant's time zone
    try { setResult(await call<AgentResult>("/admin/agents/orchestrator", { method: "POST", body: { input: text, timezone } })); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setRunning(false); }
  }

  const live = o?.stats.find((s) => s.campaignId === o.liveCampaignId);
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
        <button className="ghost small" onClick={api.signOut}>Sign out</button>
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
        <p className="muted">
          Create campaigns here: say the offer and when it runs, e.g. "Welcome 20% on Nov 20" or "for 15 days from Dec 1" (no dates = always on).
          The orchestrator hands work to four specialists: campaign, offer, abuse and insights. Nothing goes live until you click Activate or Schedule.
        </p>
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
        <p className="muted">A scheduled campaign takes over from the always-on one during its dates, then the always-on one comes back.</p>
        <table>
          <thead><tr><th>Name</th><th>Status</th><th>Actions</th><th>Schedule</th><th>Offer</th><th>Views</th><th>Sign-ups</th><th>Redeemed</th><th>Revenue</th><th>Flagged / blocked</th><th>By</th></tr></thead>
          <tbody>
            {o?.campaigns.map((c) => {
              const s = o.stats.find((x) => x.campaignId === c.id);
              const p = phase(c);
              return (
                <tr key={c.id}>
                  <td title={c.headline}>{c.name}{c.id === o.liveCampaignId && <span className="pill live">showing now</span>}</td>
                  <td><span className={`pill ${p}`}>{p}</span></td>
                  <td className="actions">
                    {c.status === "active" || (c.status === "scheduled" && p !== "ended")
                      ? <button className="small ghost" onClick={() => act(`/admin/campaigns/${c.id}/pause`)}>Pause</button>
                      : p !== "ended" && <button className="small" onClick={() => act(`/admin/campaigns/${c.id}/activate`)}>{c.startsAt ? "Schedule" : "Activate"}</button>}
                    <button className="small ghost danger" onClick={() => removeCampaign(c, s)}>Remove</button>
                  </td>
                  <td>{scheduleLabel(c.startsAt, c.endsAt)}</td>
                  <td>{c.discountPercent}%</td>
                  <td>{s?.views ?? 0}</td><td>{s?.signups ?? 0}</td><td>{s?.redemptions ?? 0}</td><td>{usd(s?.revenueCents ?? 0)}</td>
                  <td>{s?.flagged ?? 0} / {s?.blocked ?? 0}</td>
                  <td>{c.createdBy}</td>
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

// ------------------------------------------------------------------ scheduling

const DAY_MS = 86_400_000;
const fmtDay = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

function scheduleLabel(startsAt: string | null, endsAt: string | null): string {
  if (!startsAt || !endsAt) return "Always on";
  const start = new Date(startsAt), last = new Date(new Date(endsAt).getTime() - 1);
  const days = Math.round((new Date(endsAt).getTime() - start.getTime()) / DAY_MS);
  return days <= 1 ? fmtDay(start) : `${fmtDay(start)} → ${fmtDay(last)} · ${days} days`;
}

/** What the merchant cares about: is it showing, waiting for its dates, or over? */
function phase(c: Campaign): string {
  if (c.status !== "scheduled" || !c.startsAt || !c.endsAt) return c.status;
  const now = Date.now();
  if (now < Date.parse(c.startsAt)) return "upcoming";
  if (now >= Date.parse(c.endsAt)) return "ended";
  return "running";
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="kpi"><div className="label">{label}</div><div className="value">{value}</div>{sub && <div className="sub">{sub}</div>}</div>;
}

createRoot(document.getElementById("root")!).render(<Root />);
