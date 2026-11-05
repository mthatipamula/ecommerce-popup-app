import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import "./demo.css";

interface Product { title: string; priceCents: number; productType: string }
interface Order { orderId: number; subtotalCents: number; discountCents: number; totalCents: number; discountCode: string | null }

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const SWATCH: Record<string, string> = { Shoes: "#0f766e", Apparel: "#1d4ed8", Gear: "#9a3412", Accessories: "#6d28d9" };

/** A stand-in for a Shopify storefront: catalogue, cart and a checkout that validates codes like Shopify does. */
function Store() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [checkout, setCheckout] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get("discount") ?? "");
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { fetch("/mock-shopify/products").then((r) => r.json()).then(setProducts); }, []);
  useEffect(() => {
    // /discount/<code> on Shopify applies the code to the cart; the simulated store reads ?discount=.
    if (code) setCart((c) => (Object.keys(c).length ? c : { "Tempo Racer 3 Running Shoe": 1 }));
  }, []);

  const items = Object.entries(cart).filter(([, q]) => q > 0);
  const subtotal = items.reduce((s, [t, q]) => s + (products.find((p) => p.title === t)?.priceCents ?? 0) * q, 0);
  const count = items.reduce((s, [, q]) => s + q, 0);

  async function placeOrder() {
    setError(null);
    const r = await fetch("/mock-shopify/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email || undefined, items: items.map(([title, qty]) => ({ title, qty })), discountCode: code || undefined }),
    });
    const body = await r.json();
    if (!r.ok) return setError(body.error ?? "Checkout failed");
    setOrder(body);
    setCart({});
  }

  return (
    <>
      <div className="banner">Simulated Shopify store for the demo · the popup below is the real widget, served exactly as on a live store</div>
      <header>
        <strong className="logo">NORTHWIND<span>RUNNING</span></strong>
        <nav>Shoes · Apparel · Gear</nav>
        <button className="cart" onClick={() => { setCheckout(true); setOrder(null); }}>Cart ({count})</button>
      </header>
      <section className="hero">
        <h1>Run further. Recover faster.</h1>
        <p>Performance gear tested on real miles.</p>
        <button onClick={() => window.PopupApp?.open()}>Show the popup again</button>
        <button className="ghost" onClick={() => { localStorage.clear(); location.reload(); }}>Reset as new visitor</button>
      </section>
      <main className="grid">
        {products.map((p) => (
          <article key={p.title}>
            <div className="img" style={{ background: SWATCH[p.productType] ?? "#334155" }}>{p.productType}</div>
            <h3>{p.title}</h3>
            <div className="price">{usd(p.priceCents)}</div>
            <button onClick={() => setCart((c) => ({ ...c, [p.title]: (c[p.title] ?? 0) + 1 }))}>Add to cart</button>
          </article>
        ))}
      </main>

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
              <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label>
              <label>Discount code<input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="RUN15-…" /></label>
              <div className="line total"><span>Subtotal</span><span>{usd(subtotal)}</span></div>
              {error && <p className="err">{error}</p>}
              <button disabled={!items.length} onClick={placeOrder}>Pay now</button>
            </div>
          )}
        </aside>
      )}
    </>
  );
}

declare global { interface Window { PopupApp?: { open(): void } } }
createRoot(document.getElementById("root")!).render(<Store />);
