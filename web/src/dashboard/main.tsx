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

function useApi() {
  const [token, setToken] = useState(() => localStorage.getItem("admin-token") ?? "demo-admin-token");
  const call = useCallback(async <T,>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
    const r = await fetch(path, {
      method: init?.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(b.message ?? b.error ?? `${r.status}`);
    }
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

      <NewCampaign call={call} onCreated={refresh} />

      <section className="panel">
        <h2>Campaigns</h2>
        <p className="muted">A scheduled campaign takes over from the always-on one during its dates, then the always-on one comes back.</p>
        <table>
          <thead><tr><th>Name</th><th>Status</th><th>Schedule</th><th>Offer</th><th>Views</th><th>Sign-ups</th><th>Redeemed</th><th>Revenue</th><th>Flagged / blocked</th><th>By</th><th /></tr></thead>
          <tbody>
            {o?.campaigns.map((c) => {
              const s = o.stats.find((x) => x.campaignId === c.id);
              const p = phase(c);
              return (
                <tr key={c.id}>
                  <td title={c.headline}>{c.name}{c.id === o.liveCampaignId && <span className="pill live">showing now</span>}</td>
                  <td><span className={`pill ${p}`}>{p}</span></td>
                  <td>{scheduleLabel(c.startsAt, c.endsAt)}</td>
                  <td>{c.discountPercent}%</td>
                  <td>{s?.views ?? 0}</td><td>{s?.signups ?? 0}</td><td>{s?.redemptions ?? 0}</td><td>{usd(s?.revenueCents ?? 0)}</td>
                  <td>{s?.flagged ?? 0} / {s?.blocked ?? 0}</td>
                  <td>{c.createdBy}</td>
                  <td>{c.status === "active" || (c.status === "scheduled" && p !== "ended")
                    ? <button className="small ghost" onClick={() => act(`/admin/campaigns/${c.id}/pause`)}>Pause</button>
                    : p === "ended" ? null
                    : <button className="small" onClick={() => act(`/admin/campaigns/${c.id}/activate`)}>{c.startsAt ? "Schedule" : "Activate"}</button>}</td>
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

type ScheduleKind = "always" | "date" | "days";
const DAY_MS = 86_400_000;
const fmtDay = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Whole days in the merchant's time zone: from midnight on the start date to midnight after the last day. */
function scheduleWindow(kind: ScheduleKind, date: string, days: number): { startsAt: string; endsAt: string } | null {
  if (kind === "always" || !date) return null;
  const [y, m, d] = date.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + (kind === "date" ? 1 : days));   // calendar days, so DST changes don't shift it
  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
}

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

type Call = ReturnType<typeof useApi>["call"];

function NewCampaign({ call, onCreated }: { call: Call; onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    name: "Welcome 20%", headline: "Take 20% off today", cta: "Unlock my 20% off", discountPercent: 20, codePrefix: "WELCOME20",
    body: "Sign up for Northwind Running news and get 20% off your order.",
  });
  const [kind, setKind] = useState<ScheduleKind>("date");
  const [date, setDate] = useState(todayLocal);
  const [days, setDays] = useState(15);
  const [goLive, setGoLive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: k === "discountPercent" ? Number(e.target.value) : e.target.value });

  const win = scheduleWindow(kind, date, days);
  const ended = win ? Date.parse(win.endsAt) <= Date.now() : false;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    let created: Campaign | null = null;
    try {
      created = await call<Campaign>("/admin/campaigns", { method: "POST", body: { ...f, ...(win ?? {}) } });
      if (goLive) await call(`/admin/campaigns/${created.id}/activate`, { method: "POST" });
      setMsg({ ok: true, text: `Created "${created.name}"${goLive ? (win ? `, scheduled for ${scheduleLabel(win.startsAt, win.endsAt)}` : " and live now") : " as a draft"}.` });
    } catch (err) {
      const text = (err as Error).message;
      setMsg({ ok: false, text: created ? `Saved "${created.name}" as a draft, but it couldn't go live: ${text}` : text });
    } finally {
      setBusy(false);
      await onCreated();
    }
  }

  if (!open) {
    return (
      <section className="panel new-campaign closed">
        <div><h2>New campaign</h2><p className="muted">Create a popup offer, e.g. "Welcome 20%" for one day or for 15 days in a row.</p></div>
        <button onClick={() => setOpen(true)}>+ New campaign</button>
      </section>
    );
  }

  return (
    <section className="panel new-campaign">
      <h2>New campaign</h2>
      <form onSubmit={submit}>
        <div className="fields">
          <label>Name<input value={f.name} onChange={set("name")} maxLength={120} required /></label>
          <label>Discount %<input type="number" min={1} max={90} value={f.discountPercent} onChange={set("discountPercent")} required /></label>
          <label>Code prefix<input value={f.codePrefix} onChange={set("codePrefix")} maxLength={12} pattern="[A-Za-z0-9]*" title="Letters and digits only" /></label>
          <label className="wide">Headline<input value={f.headline} onChange={set("headline")} maxLength={60} required /></label>
          <label className="wide">Text<textarea value={f.body} onChange={set("body")} maxLength={140} rows={2} required /></label>
          <label>Button<input value={f.cta} onChange={set("cta")} maxLength={24} required /></label>
        </div>

        <fieldset className="schedule">
          <legend>When should it run?</legend>
          <label className="radio"><input type="radio" checked={kind === "always"} onChange={() => setKind("always")} /> Always on</label>
          <label className="radio"><input type="radio" checked={kind === "date"} onChange={() => setKind("date")} /> On a specific date</label>
          <label className="radio"><input type="radio" checked={kind === "days"} onChange={() => setKind("days")} /> For consecutive days</label>
          {kind !== "always" && (
            <div className="schedule-inputs">
              <label>{kind === "date" ? "Date" : "Start date"}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
              {kind === "days" && <label>Number of days<input type="number" min={2} max={366} value={days} onChange={(e) => setDays(Number(e.target.value))} required /></label>}
            </div>
          )}
          <p className="muted summary">
            {win
              ? <>Runs <strong>{scheduleLabel(win.startsAt, win.endsAt)}</strong>, midnight to midnight in your time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}). Codes only work during these dates; outside them the always-on campaign shows instead.</>
              : <>Shows until you pause it, and replaces the current always-on campaign.</>}
          </p>
        </fieldset>

        <label className="radio"><input type="checkbox" checked={goLive} onChange={(e) => setGoLive(e.target.checked)} /> {win ? "Schedule it now" : "Make it live now"} (otherwise saved as a draft)</label>
        {ended && <p className="err">Those dates are already over.</p>}
        {msg && <p className={msg.ok ? "ok-msg" : "err"}>{msg.text}</p>}
        <div className="actions">
          <button disabled={busy || ended}>{busy ? "Creating…" : "Create campaign"}</button>
          <button type="button" className="ghost" onClick={() => { setOpen(false); setMsg(null); }}>Close</button>
        </div>
      </form>
    </section>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="kpi"><div className="label">{label}</div><div className="value">{value}</div>{sub && <div className="sub">{sub}</div>}</div>;
}

createRoot(document.getElementById("root")!).render(<App />);
