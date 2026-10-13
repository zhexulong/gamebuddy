/**
 * stylesheet contracts.
 *
 * `csstools/value-no-unknown-custom-properties` replaces the hand-written
 * "every var(--x) is declared" walker that used to live in
 * `dialogue-web/tests/style-tokens-gate.test.mjs` (gate 2.1): a `var(--x)`
 * whose `--x` is declared nowhere is guaranteed-invalid, so the declaration
 * that reads it is dropped at computed-value time instead of falling back.
 */
export default {
  plugins: ["stylelint-value-no-unknown-custom-properties"],
  rules: {
    "csstools/value-no-unknown-custom-properties": true,
  },
};
