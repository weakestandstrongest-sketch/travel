import { defineConfig } from "vitest/config";

// vite.config.ts は root を web/ にしているので、テストは別の設定で動かす
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
