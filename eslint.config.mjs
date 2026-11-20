import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/DerivedData/**",
      "**/.build/**",
      "**/coverage/**",
      "artifacts/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "packages/contracts/schemas/**"
    ]
  },
  {
    files: ["apps/windows-friend/**/*.mjs", "apps/windows-recorder/**/*.mjs"],
    languageOptions: {
      globals: Object.fromEntries(["process", "Buffer", "URL", "console", "setTimeout", "clearTimeout",
        "setImmediate", "setInterval", "clearInterval", "AbortSignal", "fetch", "Response", "structuredClone"]
        .map((name) => [name, "readonly"]))
    }
  },
  {
    files: ["apps/windows-friend/template/app/client.js", "apps/windows-recorder/template/app/client.js"],
    languageOptions: {
      globals: Object.fromEntries(["document", "location", "sessionStorage", "history", "fetch", "setInterval", "TextEncoder"]
        .map((name) => [name, "readonly"]))
    }
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module"
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error"
    }
  },
  {
    files: ["packages/review-engine/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          "patterns": ["@qb-study/storage", "@qb-study/storage/*"]
        }
      ]
    }
  },
  {
    files: ["apps/browser-extension/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          "patterns": ["node:*", "@qb-study/storage", "@qb-study/storage/*"]
        }
      ]
    }
  }
);
