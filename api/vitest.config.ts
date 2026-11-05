import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { env: { SERVE_WEB: "false", LOG_LEVEL: "warn", LLM_PROVIDER: "offline" }, fileParallelism: false, testTimeout: 20000 },
});
