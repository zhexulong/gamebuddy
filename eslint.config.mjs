import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.build-staging/**",
      "**/test-results/**",
      "**/*.d.ts",
      "vendor/**",
      "ref/**",
    ],
  },
  {
    files: ["dialogue-web/src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { caughtErrors: "all", argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/only-throw-error": "error",
    },
  },
  {
    files: ["dialogue-web/src/**/*.tsx"],
    extends: [jsxA11y.flatConfigs.recommended],
    rules: {
      // A scrollable region that can take focus is the accepted fix for axe's
      // `scrollable-region-focusable`; each of these carries its own accessible
      // name, and `region` is the role a named <section> already has.
      "jsx-a11y/no-noninteractive-tabindex": ["error", { tags: ["section", "pre"], roles: ["region"] }],
      // A modal `<aside role="dialog">` handling Escape is a legitimate key
      // interaction; the rule flags it because `aside` is a non-interactive tag.
      "jsx-a11y/no-noninteractive-element-interactions": ["error", { aside: ["onKeyDown"] }],
    },
  },
);
