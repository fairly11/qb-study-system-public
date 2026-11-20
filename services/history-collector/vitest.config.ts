import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@qb-study/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
      "@qb-study/storage/history-collector": fileURLToPath(
        new URL("../../packages/storage/src/history-collector.ts", import.meta.url),
      ),
      "@qb-study/storage/notion-sync": fileURLToPath(
        new URL("../../packages/storage/src/notion-sync.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
