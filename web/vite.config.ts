import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const api = process.env.API_URL ?? "http://localhost:8080";

// The demo storefront and the merchant dashboard (built after the popup bundle, into the same dist/).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: { input: { demo: resolve("demo/index.html"), dashboard: resolve("dashboard/index.html") } },
  },
  server: {
    proxy: Object.fromEntries(["/v1", "/admin", "/mock-shopify", "/webhooks", "/popup.js"].map((p) => [p, api])),
  },
});
