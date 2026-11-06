import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import type { Customer, PopupAppApi } from "../popup/api";
import "./demo.css";

interface Product { title: string; priceCents: number; productType: string }
interface Order { orderId: number; subtotalCents: number; discountCents: number; totalCents: number; discountCode: string | null }
interface PastOrder { id: number; totalCents: number; discountCode: string | null; createdAt: string }
interface Session { token: string; customer: Customer }

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const SWATCH: Record<string, string> = { Shoes: "#0f766e", Apparel: "#1d4ed8", Gear: "#9a3412", Accessories: "#6d28d9" };
const SESSION_KEY = "demo:session";
const catId = (cat: string) => `shop-${cat.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

function loadSession(): Session | null {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null"); } catch { return null; }
}
function saveSession(s: Session | null) {
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
}

/** The popup script loads async; run `fn` as soon as it has registered window.PopupApp. */
function withPopup(fn: (app: PopupAppApi) => void) {
  if (window.PopupApp) return fn(window.PopupApp);
  window.addEventListener("popupapp:ready", () => window.PopupApp && fn(window.PopupApp), { once: true });
}

/**
 * A stand-in for a Shopify storefront: catalogue, customer accounts, cart and a checkout that validates codes like
 * Shopify does. Signing in lands on the account screen, where the popup greets the customer by name.
 */
function Store() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [checkout, setCheckout] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get("discount") ?? "");
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [session, setSession] = useState<Session | null>(loadSession);
  const [view, setView] = useState<"shop" | "account">("shop");
  const [auth, setAuth] = useState<"signin" | "register" | null>(null);
  const [orders, setOrders] = useState<PastOrder[]>([]);
  const customer = session?.customer ?? null;
  const authHeader: Record<string, string> = session ? { Authorization: `Bearer ${session.token}` } : {};

  useEffect(() => { fetch("/mock-shopify/products").then((r) => r.json()).then(setProducts); }, []);

  // A returning, still signed-in customer: confirm the session and tell the popup who it is (no post-login popup).
  useEffect(() => {
    if (!session) return;
    refreshAccount(session).then((ok) => { if (ok) withPopup((app) => app.identify(session.customer)); });
  }, []);

  async function refreshAccount(s: Session): Promise<boolean> {
    const r = await fetch("/mock-shopify/account/me", { headers: { Authorization: `Bearer ${s.token}` } }).catch(() => null);
    if (!r?.ok) { if (r?.status === 401) signedOut(); return false; }
    setOrders((await r.json()).orders);
    return true;
  }

  function signedIn(s: Session) {
    saveSession(s);
    setSession(s);
    setAuth(null);
    setView("account");
    refreshAccount(s);
    // The post-login screen: the popup opens here for the signed-in customer.
    withPopup((app) => app.identify(s.customer, { postLogin: true }));
  }

  function signedOut() {
    saveSession(null);
    setSession(null);
    setOrders([]);
    setView("shop");
    withPopup((app) => app.identify(null));
  }

  async function signOut() {
    if (session) await fetch("/mock-shopify/account/logout", { method: "POST", headers: authHeader }).catch(() => {});
    signedOut();
  }

  // /discount/<code> on Shopify applies the code to the cart; the simulated store reads ?discount=. The cart itself
  // starts empty: the customer adds items. Look the code up so the cart can show the discounted total before paying.
  const [applied, setApplied] = useState<{ code: string; percent: number } | { code: string; error: string } | null>(null);
  useEffect(() => {
    const c = code.trim();
    if (!c) return setApplied(null);
    let live = true;
    const t = setTimeout(async () => {
      const r = await fetch(`/mock-shopify/discount/${encodeURIComponent(c)}`).catch(() => null);
      const body = r ? await r.json().catch(() => ({})) : {};
      if (!live) return;
      setApplied(r?.ok ? { code: c, percent: body.percent } : { code: c, error: body.error ?? "Could not check this code" });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [code]);

  // One section per product line, in catalogue order (Shoes, Apparel, Gear, Accessories).
  const categories = [...new Set(products.map((p) => p.productType))];
  const items = Object.entries(cart).filter(([, q]) => q > 0);
  const subtotal = items.reduce((s, [t, q]) => s + (products.find((p) => p.title === t)?.priceCents ?? 0) * q, 0);
  const count = items.reduce((s, [, q]) => s + q, 0);
  const percent = applied && "percent" in applied && applied.code === code.trim() ? applied.percent : 0;
  const discount = Math.round((subtotal * percent) / 100); // same rounding as checkout
  const total = subtotal - discount;

  async function placeOrder() {
    setError(null);
    const r = await fetch("/mock-shopify/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify({
        email: customer ? undefined : email || undefined,
        items: items.map(([title, qty]) => ({ title, qty })), discountCode: code || undefined,
      }),
    });
    const body = await r.json();
    if (!r.ok) return setError(body.error ?? "Checkout failed");
    setOrder(body);
    setCart({});
    if (session) refreshAccount(session);
  }

  return (
    <>
      <div className="banner">Simulated Shopify store for the demo · the popup below is the real widget, served exactly as on a live store</div>
      <header>
        <strong className="logo" role="button" tabIndex={0} onClick={() => setView("shop")}>NORTHWIND<span>RUNNING</span></strong>
        <nav>{categories.map((cat, i) => <span key={cat}>{i > 0 && " · "}<a href={`#${catId(cat)}`} onClick={() => setView("shop")}>{cat}</a></span>)}</nav>
        {customer
          ? <button className="ghost account-btn" onClick={() => setView("account")}>Hi, {customer.firstName}</button>
          : <button className="ghost account-btn" onClick={() => setAuth("signin")}>Sign in</button>}
        <button className="cart" onClick={() => { setCheckout(true); setOrder(null); }}>Cart ({count})</button>
      </header>

      {view === "account" && customer ? (
        <section className="account">
          <div>
            <p className="eyebrow">My account</p>
            <h1>Welcome back, {customer.firstName}</h1>
            <p className="muted">Signed in as {customer.email}</p>
          </div>
          <div className="account-card">
            <h2>Your orders</h2>
            {orders.length === 0 && <p className="muted">No orders yet.</p>}
            {orders.map((o) => (
              <div key={o.id} className="line">
                <span>#{o.id} · {new Date(o.createdAt).toLocaleDateString()}{o.discountCode && <span className="ok"> · {o.discountCode}</span>}</span>
                <span>{usd(o.totalCents)}</span>
              </div>
            ))}
          </div>
          <div className="account-actions">
            <button onClick={() => setView("shop")}>Continue shopping</button>
            <button className="ghost" onClick={() => window.PopupApp?.open()}>Show my offer</button>
            <button className="ghost" onClick={signOut}>Sign out</button>
          </div>
        </section>
      ) : (
        <>
          <section className="hero">
            <h1>Run further. Recover faster.</h1>
            <p>Performance gear tested on real miles.</p>
            <button onClick={() => window.PopupApp?.open()}>{customer ? "Show my offer" : "Show the popup again"}</button>
          </section>
          <main className="catalogue">
            {categories.map((cat) => (
              <section key={cat} id={catId(cat)} className="category">
                <h2>{cat}</h2>
                <div className="grid">
                  {products.filter((p) => p.productType === cat).map((p) => (
                    <article key={p.title}>
                      <div className="img" style={{ background: SWATCH[p.productType] ?? "#334155" }}>{p.productType}</div>
                      <h3>{p.title}</h3>
                      <div className="price">{usd(p.priceCents)}</div>
                      <button onClick={() => setCart((c) => ({ ...c, [p.title]: (c[p.title] ?? 0) + 1 }))}>Add to cart</button>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </main>
        </>
      )}

      {auth && <AuthDrawer mode={auth} onMode={setAuth} onClose={() => setAuth(null)} onSignedIn={signedIn} />}

      {checkout && (
        <aside className="drawer">
          <button className="close" onClick={() => setCheckout(false)} aria-label="Close">×</button>
          {order ? (
            <div>
              <h2>Order #{order.orderId} confirmed</h2>
              <p>Subtotal {usd(order.subtotalCents)}</p>
              {order.discountCode && <p className="ok">Discount {order.discountCode}: −{usd(order.discountCents)}</p>}
              <p><strong>Total {usd(order.totalCents)}</strong></p>
              <p className="muted">Shopify sent the signed <code>orders/create</code> webhook; the dashboard now shows this code as redeemed.</p>
            </div>
          ) : (
            <div>
              <h2>Checkout</h2>
              {items.length === 0 && <p className="muted">Your cart is empty.</p>}
              {items.map(([t, q]) => <div key={t} className="line"><span>{q} × {t}</span><span>{usd((products.find((p) => p.title === t)?.priceCents ?? 0) * q)}</span></div>)}
              {customer
                ? <p className="muted signed-as">Signed in as {customer.email}</p>
                : <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label>}
              <label>Discount code<input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="RUN15-…" /></label>
              {applied && "error" in applied && applied.code === code.trim() && <p className="err">{applied.error}</p>}
              <div className="line"><span>Subtotal</span><span>{usd(subtotal)}</span></div>
              {percent > 0 && <div className="line ok"><span>Discount {code.trim()} ({percent}% off)</span><span>−{usd(discount)}</span></div>}
              <div className="line total"><span>Total</span><span>{usd(total)}</span></div>
              {error && <p className="err">{error}</p>}
              <button disabled={!items.length} onClick={placeOrder}>Pay now</button>
            </div>
          )}
        </aside>
      )}
    </>
  );
}

/** Sign in / create account, like Shopify's customer account pages. */
function AuthDrawer({ mode, onMode, onClose, onSignedIn }: {
  mode: "signin" | "register"; onMode: (m: "signin" | "register") => void; onClose: () => void; onSignedIn: (s: Session) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const register = mode === "register";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/mock-shopify/account/${register ? "register" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(register ? { email, password, firstName } : { email, password }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? "Something went wrong");
      onSignedIn(body);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="drawer" aria-label={register ? "Create account" : "Sign in"}>
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <form onSubmit={submit}>
        <h2>{register ? "Create account" : "Sign in"}</h2>
        {register && <label>First name<input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" required /></label>}
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          autoComplete={register ? "new-password" : "current-password"} minLength={register ? 8 : undefined} required /></label>
        {error && <p className="err">{error}</p>}
        <button disabled={busy}>{busy ? "Please wait…" : register ? "Create account" : "Sign in"}</button>
        <p className="muted switch">
          {register ? "Already have an account? " : "New here? "}
          <button type="button" className="linkish" onClick={() => onMode(register ? "signin" : "register")}>
            {register ? "Sign in" : "Create an account"}
          </button>
        </p>
      </form>
    </aside>
  );
}

declare global { interface Window { PopupApp?: PopupAppApi } }
createRoot(document.getElementById("root")!).render(<Store />);
