import { createRoot } from "react-dom/client";
import { Popup } from "./Popup";
import { createApi, type Customer, type PopupAppApi } from "./api";
import css from "./popup.css?inline";

/**
 * Storefront entry point. The Shopify theme app extension adds:
 *   <script async src="https://<cdn>/popup.js" data-shop="{{ shop.permanent_domain }}"></script>
 * The popup renders inside a shadow root, so the theme's CSS can't break it and its CSS can't leak into the theme.
 */
declare global { interface Window { PopupApp?: PopupAppApi } }

const script = document.currentScript as HTMLScriptElement | null;
const shop = script?.dataset.shop ?? "";
const base = script?.dataset.api ?? (script ? new URL(script.src).origin : "");
const delayMs = Number(script?.dataset.delay ?? 4000);
// Theme-rendered customer (Liquid): present only when a customer is signed in.
const initialCustomer: Customer | null = script?.dataset.customerEmail
  ? { email: script.dataset.customerEmail, firstName: script.dataset.customerFirstName || null }
  : null;
// Shopify sends customers to the account page after sign-in; that is where the signed-in popup appears.
const postLoginPage = script?.dataset.pageType === "customers/account";

function mount() {
  if (!shop || document.getElementById("popup-app-root")) return;
  const host = document.createElement("div");
  host.id = "popup-app-root";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  shadow.appendChild(style);
  const el = document.createElement("div");
  shadow.appendChild(el);
  createRoot(el).render(
    <Popup api={createApi(base, shop)} delayMs={delayMs} initialCustomer={initialCustomer} postLoginPage={postLoginPage}
      onReady={(app) => { window.PopupApp = app; window.dispatchEvent(new Event("popupapp:ready")); }} />,
  );
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
