import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkWorkflowExpressions, inspectWorkflow } from "./check-workflow-expressions.mjs";

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

/**
 * The cases above hand `inspectWorkflow` a string. These drive the gate - its own directory listing, its own
 * extension filter, its own report - over a temporary workflows directory, because "the matcher notices" and "the
 * gate fails" are two different claims and only the second is what CI depends on. They are the falsifier named in
 * `tools/lib/harness-conformance.mjs`.
 *
 * red-proof: inject  narrow the extension filter so the gate lists no file -> the synthetic-directory case fails
 *                   with `examined 0` (`15 pass / 3 fail` across this file and check-vendored-bundle-leaks.test.mjs)
 */
test("the gate itself reports a forbidden shape in a synthetic workflows directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "gb-workflow-expr-"));
  try {
    writeFileSync(
      join(root, "release.yml"),
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: echo x",
        "        env:",
        "          GAMEBUDDY_SIGNING_THUMBPRINT: ${{ env.GAMEBUDDY_SIGNING_THUMBPRINT }}",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = await checkWorkflowExpressions({ root });
    assert.equal(result.examined, 1, JSON.stringify(result));
    assert.equal(result.blocking.length, 1, JSON.stringify(result));
    assert.equal(result.blocking[0].rule, "self_reexport_through_env_context");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the gate itself examines only yaml files and says so when a directory holds none", async () => {
  const root = mkdtempSync(join(tmpdir(), "gb-workflow-empty-"));
  try {
    writeFileSync(join(root, "notes.txt"), "if: ${{ secrets.X }}\n", "utf8");
    const result = await checkWorkflowExpressions({ root });
    assert.equal(result.examined, 0, JSON.stringify(result));
    assert.deepEqual(result.blocking, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
