import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@qb-study/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
      "@qb-study/question-normalizer": fileURLToPath(
        new URL("../../packages/question-normalizer/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
