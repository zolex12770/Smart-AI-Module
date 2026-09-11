import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["**/node_modules/**","**/dist/**","**/.next/**","**/migrations/**","**/*.d.ts",".local-tools/**",".claude/**","coverage/**"] },
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
    extends: [tseslint.configs.base],
    rules: {
      "@typescript-eslint/no-shadow": "error",
      "no-fallthrough": "error",
      "no-constant-binary-expression": "error",
      "no-self-compare": "error",
      "no-unmodified-loop-condition": "error",
      "require-atomic-updates": "error",
      "no-template-curly-in-string": "error",
      "array-callback-return": "error",
    },
  },
);
