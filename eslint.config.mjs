// @ts-check
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/dist/**", "**/.wrangler/**", "**/node_modules/**"] },
  js.configs.recommended,
  tseslint.configs.strict,
  tseslint.configs.stylistic,
  {
    files: ["**/*.ts"],
    rules: {
      // 使わない引数は _ で始めて明示する
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Node で動くスクリプト（WebSocket は Node 22 以降のグローバル）
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, WebSocket: "readonly" } },
  },
  prettier,
);
