import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", ".changeset/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      // Shipped code must never log; use the integrator-supplied logger (ADR 0004).
      "no-console": "error",
      "no-eval": "error",
      "no-new-func": "error",
      "no-implied-eval": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs", "**/*.config.{js,ts,mjs}"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
    rules: { "no-console": "off" },
  },
)
