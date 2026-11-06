import { useEffect, useRef, useState } from "react";
import type { CampaignConfig, Customer, Issued, PopupApi, PopupAppApi } from "./api";

type Step = "closed" | "email" | "phone" | "done";
type Remembered = "dismissed" | "subscribed";

const DISMISS_MS = 24 * 60 * 60 * 1000;
const POST_LOGIN_DELAY_MS = 700;

/** Guests are remembered per device; signed-in customers per account (a short hash, not the email itself). */
function emailKey(email: string): string {
  let h = 0x811c9dc5;
  for (const ch of email.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(36);
}
const storageKey = (id: string, customer?: Customer | null) => (customer ? `popup:${id}:c:${emailKey(customer.email)}` : `popup:${id}`);

function suppressed(id: string, customer?: Customer | null): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey(id, customer)) ?? "null");
    return v?.state === "subscribed" || (v?.state === "dismissed" && Date.now() - v.at < DISMISS_MS);
  } catch {
    return false;
  }
}
function remember(id: string, state: Remembered, customer?: Customer | null) {
  try {
    const v = JSON.stringify({ state, at: Date.now() });
    localStorage.setItem(storageKey(id), v);
    if (customer) localStorage.setItem(storageKey(id, customer), v);
  } catch { /* private mode */ }
}
/** On a theme's account page: show once per browser session, not on every visit to that page. */
function firstPostLoginView(id: string): boolean {
  try {
    const k = `popup:${id}:post-login`;
    if (sessionStorage.getItem(k)) return false;
    sessionStorage.setItem(k, "1");
    return true;
  } catch {
    return true;
  }
}
function visitorId(): string {
  try {
    let v = localStorage.getItem("popup:visitor");
    if (!v) { v = crypto.randomUUID(); localStorage.setItem("popup:visitor", v); }
    return v;
  } catch {
    return crypto.randomUUID();
  }
}

/**
 * Two steps, like the best-converting capture popups: email first (low friction), then an optional phone number
 * with explicit SMS consent, then the code. One API call at the end issues the code.
 *
 * Guests see it after a delay or on exit intent. Signed-in customers see it on the screen they land on right after
 * signing in, with their account email already filled in.
 */
export function Popup({ api, delayMs, initialCustomer = null, postLoginPage = false, onReady }: {
  api: PopupApi; delayMs: number; initialCustomer?: Customer | null; postLoginPage?: boolean; onReady: (app: PopupAppApi) => void;
}) {
  const [campaign, setCampaign] = useState<CampaignConfig | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(initialCustomer);
  const [step, setStep] = useState<Step>("closed");
  const [email, setEmail] = useState(initialCustomer?.email ?? "");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const shown = useRef(false);

  // Callbacks handed to the page (PopupApp) and timers outlive renders, so they read the latest state from refs.
  const campaignRef = useRef<CampaignConfig | null>(null);
  const customerRef = useRef<Customer | null>(initialCustomer);
  const stepRef = useRef<Step>("closed");
  stepRef.current = step;
  const pendingPostLogin = useRef(false);

  const show = () => {
    const c = campaignRef.current;
    if (!c || stepRef.current !== "closed") return;
    setError(null);
    setCopied(false);
    setStep("email");
    if (!shown.current) { shown.current = true; api.event(c.id, "view"); }
  };

  const showAfterLogin = () => {
    const c = campaignRef.current, cust = customerRef.current;
    if (!cust) return;
    if (!c) { pendingPostLogin.current = true; return; }   // config still loading: open once it arrives
    if (suppressed(c.id, cust)) return;                     // already has this offer's code, or just said no
    window.setTimeout(show, POST_LOGIN_DELAY_MS);
  };

  const identify = (cust: Customer | null, opts?: { postLogin?: boolean }) => {
    customerRef.current = cust;
    setCustomer(cust);
    if (cust) {
      setEmail(cust.email);
      if (opts?.postLogin) showAfterLogin();
    } else {
      // Signed out: forget the account email and hide anything shown for the account.
      setEmail("");
      setIssued(null);
      setStep("closed");
    }
  };

  useEffect(() => {
    let timer: number | undefined;
    const onExit = (e: MouseEvent) => { if (e.clientY <= 0 && !customerRef.current) show(); };
    api.config().then((c) => {
      if (!c) return;
      campaignRef.current = c;
      setCampaign(c);
      if (customerRef.current) {
        if (pendingPostLogin.current || (postLoginPage && firstPostLoginView(c.id))) {
          pendingPostLogin.current = false;
          showAfterLogin();
        }
        return;
      }
      if (suppressed(c.id)) return;
      timer = window.setTimeout(() => { if (!customerRef.current) show(); }, delayMs);
      document.addEventListener("mouseout", onExit);   // exit intent on desktop
    }).catch(() => {});
    return () => { window.clearTimeout(timer); document.removeEventListener("mouseout", onExit); };
  }, []);

  // Hand the page stable functions that always call the latest closures.
  const latest = useRef({ show, identify });
  latest.current = { show, identify };
  useEffect(() => onReady({
    open: () => latest.current.show(),
    identify: (c, o) => latest.current.identify(c, o),
  }), []);

  useEffect(() => {
    if (step === "closed") return;
    dialog.current?.querySelector<HTMLElement>("input:not([readonly]), button")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step]);

  if (!campaign || step === "closed") return null;

  function close() {
    if (campaign && step !== "done") { remember(campaign.id, "dismissed", customer); api.event(campaign.id, "close"); }
    setStep("closed");
  }

  async function submit(withPhone: boolean) {
    if (!campaign) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.submit({
        campaignId: campaign.id, email, phone: withPhone && phone ? phone : null,
        smsConsent: withPhone && consent, visitorId: visitorId(),
      });
      setIssued(res);
      setStep("done");
      remember(campaign.id, "subscribed", customer);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const t = campaign.theme;
  const style = { "--p": t.primary ?? "#111827", "--bg": t.background ?? "#ffffff", "--fg": t.text ?? "#111827" } as React.CSSProperties;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="card" role="dialog" aria-modal="true" aria-labelledby="popup-title" ref={dialog} style={style}>
        <button className="x" aria-label="Close" onClick={close}>×</button>
        <div className="badge">{campaign.discountPercent}% OFF</div>

        {step === "email" && (
          <form onSubmit={(e) => { e.preventDefault(); setStep("phone"); }}>
            {customer && <div className="greet">{customer.firstName ? `Welcome back, ${customer.firstName}!` : "Welcome back!"}</div>}
            <h2 id="popup-title">{campaign.headline}</h2>
            <p>{campaign.body}</p>
            {customer
              ? <div className="signed-in">Your code will be saved for <strong>{customer.email}</strong></div>
              : <input type="email" required autoComplete="email" placeholder="Email address" aria-label="Email address"
                  value={email} onChange={(e) => setEmail(e.target.value)} />}
            <button className="cta" type="submit">{campaign.cta}</button>
            <button type="button" className="link" onClick={close}>No thanks</button>
          </form>
        )}

        {step === "phone" && (
          <form onSubmit={(e) => { e.preventDefault(); submit(true); }}>
            <h2 id="popup-title">One more step</h2>
            <p>Add your mobile number for text-only drops and restock alerts.</p>
            <input type="tel" autoComplete="tel" placeholder="Mobile number" aria-label="Mobile number"
              value={phone} onChange={(e) => setPhone(e.target.value)} />
            <label className="consent">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>I agree to receive recurring automated marketing texts at this number. Consent is not a condition of purchase.
                Msg &amp; data rates may apply. Reply STOP to unsubscribe.</span>
            </label>
            {error && <div className="error" role="alert">{error}</div>}
            <button className="cta" type="submit" disabled={busy || !phone || !consent}>{busy ? "Getting your code…" : "Get my code"}</button>
            <button type="button" className="link" disabled={busy} onClick={() => submit(false)}>Skip, just email me</button>
          </form>
        )}

        {step === "done" && issued && (
          <div>
            <h2 id="popup-title">{issued.returning ? "Welcome back!" : "You're in!"}</h2>
            <p>Here's your {issued.discountPercent}% off code. It works once, at checkout.</p>
            <div className="code" aria-label="Discount code">{issued.code}</div>
            <button className="cta" onClick={() => { navigator.clipboard?.writeText(issued.code); setCopied(true); }}>
              {copied ? "Copied!" : "Copy code"}
            </button>
            <a className="link" href={issued.applyUrl}>Apply it to my cart</a>
          </div>
        )}
      </div>
    </div>
  );
}
