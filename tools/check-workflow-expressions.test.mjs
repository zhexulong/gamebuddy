import assert from "node:assert/strict";
import test from "node:test";
import { inspectWorkflow } from "./check-workflow-expressions.mjs";

/**
 * Both cases are real: each shipped in one commit and was caught by nothing until a human read the file. The gate is only worth
 * its lines if it fires on exactly those shapes and stays quiet on the ones GitHub accepts.
 */

const inspect = (text) => inspectWorkflow({ text, file: "workflow.yml" });

test("secrets in an if: condition is blocking, because GitHub rejects the whole file", () => {
  const result = inspect(
    ["      - name: Assemble", "        if: ${{ secrets.SIGNING_PFX != '' }}", "        run: node build.mjs"].join(
      "\n",
    ),
  );
  assert.equal(result.blocking.length, 1, JSON.stringify(result.blocking));
  assert.equal(result.blocking[0].rule, "forbidden_context_in_if");
  assert.equal(result.blocking[0].line, 2);
});

test("secrets in env: or with: is fine, which is what the fix uses", () => {
  const result = inspect(
    [
      "    env:",
      "      HAS_CERT: ${{ secrets.SIGNING_PFX != '' }}",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "        with:",
      "          token: ${{ secrets.GITHUB_TOKEN }}",
      "      - run: echo ok",
      "        if: env.HAS_CERT == 'true'",
    ].join("\n"),
  );
  assert.deepEqual(result.blocking, []);
});

test("a key re-exporting itself through the env context is blocking, because it can only be empty", () => {
  const result = inspect(
    [
      "      - run: echo x",
      "        env:",
      "          GAMEBUDDY_SIGNING_THUMBPRINT: ${{ env.GAMEBUDDY_SIGNING_THUMBPRINT }}",
    ].join("\n"),
  );
  assert.equal(result.blocking.length, 1, JSON.stringify(result.blocking));
  assert.equal(result.blocking[0].rule, "self_reexport_through_env_context");
});

test("an env context read of a DIFFERENT key is not flagged", () => {
  const result = inspect(["      - run: echo x", "        env:", "          TARGET: ${{ env.SOURCE }}"].join("\n"));
  assert.deepEqual(result.blocking, []);
});

test("a run body that mentions secrets. is not a condition and is not flagged", () => {
  const result = inspect(["      - run: |", "          echo 'if: ${{ secrets.X }}' is documentation"].join("\n"));
  assert.deepEqual(result.blocking, []);
});
test("a CRLF copy is examined exactly like an LF one", () => {
  // The red proof found this: a trailing `\r` made the anchored rule stop matching and the gate reported the file valid.
  const lines = ["      - run: echo x", "        env:", "          KEY: ${{ env.KEY }}"];
  const crlf = inspectWorkflow({ text: lines.join("\r\n"), file: "crlf.yml" });
  const lf = inspectWorkflow({ text: lines.join("\n"), file: "lf.yml" });
  assert.equal(crlf.blocking.length, 1);
  assert.equal(crlf.blocking.length, lf.blocking.length);
});
