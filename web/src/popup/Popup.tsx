import { useEffect, useRef, useState } from "react";
import type { CampaignConfig, Issued, PopupApi } from "./api";

type Step = "closed" | "email" | "phone" | "done";

const storageKey = (id: string) => `popup:${id}`;
const DISMISS_MS = 24 * 60 * 60 * 1000;

function suppressed(id: string): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey(id)) ?? "null");
    return v?.state === "subscribed" || (v?.state === "dismissed" && Date.now() - v.at < DISMISS_MS);
  } catch {
    return false;
  }
}
function remember(id: string, state: "dismissed" | "subscribed") {
  try { localStorage.setItem(storageKey(id), JSON.stringify({ state, at: Date.now() })); } catch { /* private mode */ }
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
 */
export function Popup({ api, delayMs, onReady }: { api: PopupApi; delayMs: number; onReady: (open: () => void) => void }) {
  const [campaign, setCampaign] = useState<CampaignConfig | null>(null);
  const [step, setStep] = useState<Step>("closed");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const shown = useRef(false);

  const open = (c: CampaignConfig | null = campaign) => {
    if (!c || step !== "closed") return;
    setStep("email");
    if (!shown.current) { shown.current = true; api.event(c.id, "view"); }
  };

  useEffect(() => {
    let timer: number | undefined;
    const onExit = (e: MouseEvent) => { if (e.clientY <= 0) openRef.current(); };
    api.config().then((c) => {
      if (!c) return;
      setCampaign(c);
      if (suppressed(c.id)) return;
      timer = window.setTimeout(() => openRef.current(), delayMs);
      document.addEventListener("mouseout", onExit);   // exit intent on desktop
    }).catch(() => {});
    return () => { window.clearTimeout(timer); document.removeEventListener("mouseout", onExit); };
  }, []);

  const openRef = useRef(() => {});
  openRef.current = () => open();
  useEffect(() => onReady(() => openRef.current()), []);

  useEffect(() => {
    if (step === "closed") return;
    dialog.current?.querySelector<HTMLElement>("input, button")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step]);

  if (!campaign || step === "closed") return null;

  function close() {
    if (campaign && step !== "done") { remember(campaign.id, "dismissed"); api.event(campaign.id, "close"); }
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
      remember(campaign.id, "subscribed");
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
            <h2 id="popup-title">{campaign.headline}</h2>
            <p>{campaign.body}</p>
            <input type="email" required autoComplete="email" placeholder="Email address" aria-label="Email address"
              value={email} onChange={(e) => setEmail(e.target.value)} />
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
