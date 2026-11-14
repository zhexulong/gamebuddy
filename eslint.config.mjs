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
      // name, and `region` is the role a named <section> already has. A `<ul>` that scrolls itself is a tab
      // stop for the same reason, and it cannot take `region`: the role would replace the list semantics its
      // rows are read through, so the tag is named here rather than the role.
      "jsx-a11y/no-noninteractive-tabindex": ["error", { tags: ["section", "pre", "ul"], roles: ["region"] }],
      // A modal dialog handling Escape is a legitimate key interaction; the rule flags it because `dialog` and
      // `aside` are non-interactive tags. A `<form>` carries `preventImeFormSubmit` because an input method's
      // confirming Enter must not submit the form (`ime-enter-gate`), and an `<img>` is here for `onError`,
      // which this rule counts among image events: a failed load is the boundary's answer, not a player's press.
      "jsx-a11y/no-noninteractive-element-interactions": [
        "error",
        { aside: ["onKeyDown"], dialog: ["onClick", "onKeyDown"], form: ["onKeyDown"], img: ["onError"] },
      ],
      // `role="list"` is the one redundant role this product spells out: `list-style: none` drops the list
      // semantics in Safari, and the explicit role is the only thing that restores them. Both reports in
      // `CharacterCardImport` state that reason at the element.
      "jsx-a11y/no-redundant-roles": ["error", { ul: ["list"] }],
    },
  },
);
