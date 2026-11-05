import { createRoot } from "react-dom/client";
import { Popup } from "./Popup";
import { createApi } from "./api";
import css from "./popup.css?inline";

/**
 * Storefront entry point. The Shopify theme app extension adds:
 *   <script async src="https://<cdn>/popup.js" data-shop="{{ shop.permanent_domain }}"></script>
 * The popup renders inside a shadow root, so the theme's CSS can't break it and its CSS can't leak into the theme.
 */
declare global { interface Window { PopupApp?: { open(): void } } }

const script = document.currentScript as HTMLScriptElement | null;
const shop = script?.dataset.shop ?? "";
const base = script?.dataset.api ?? (script ? new URL(script.src).origin : "");
const delayMs = Number(script?.dataset.delay ?? 4000);

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
    <Popup api={createApi(base, shop)} delayMs={delayMs} onReady={(open) => { window.PopupApp = { open }; }} />,
  );
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
