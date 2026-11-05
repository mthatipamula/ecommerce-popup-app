import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The storefront popup: one self-contained IIFE (React included) that a Shopify theme app extension loads.
export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: { entry: "src/popup/index.tsx", name: "PopupApp", formats: ["iife"], fileName: () => "popup.js" },
    cssCodeSplit: false,
    target: "es2019",
  },
});
