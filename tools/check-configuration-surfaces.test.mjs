/**
 * Falsifiers for the configuration-surface census.
 *
 * Each case builds a throwaway tree with a contract union, a web tree and a spec tree, so the assertion is about what the
 * gate READS rather than about this repository's current state (the CLI run covers that).
 *
 * red-proof: inject rename the only mention of an operation inside the fake `dialogue-web/src` -> the gate returns
 * `unreachable:web` naming that operation and `status: "failed"`; with `--fail` the CLI exits 1. Measured on the real tree
 * 2026-11-08: renaming `settings.game-prompt.update` in both web modules produced
 * `! unreachable:web settings.game-prompt.update` and `status:"failed"`; files restored byte-for-byte (`git diff` empty).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkConfigurationSurfaces, contractOperationIds } from "./check-configuration-surfaces.mjs";

const CONTRACT_BODY = (ids) =>
  `const OperationId = Type.Union([\n${ids.map((id) => `  Type.Literal("${id}"),`).join("\n")}\n]);\n`;

function tree({ ids, web = {}, specs = {} }) {
  const root = mkdtempSync(join(tmpdir(), "configuration-surfaces-"));
  const write = (relative, body) => {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body, "utf8");
  };
  write("host/src/tavern/browser-contract/index.ts", CONTRACT_BODY(ids));
  for (const [relative, body] of Object.entries(web)) write(`dialogue-web/src/${relative}`, body);
  for (const [relative, body] of Object.entries(specs)) write(`dialogue-web/tests/${relative}`, body);
  return root;
}

const run = (root) =>
  checkConfigurationSurfaces({
    contractPath: join(root, "host/src/tavern/browser-contract/index.ts"),
    web: join(root, "dialogue-web/src"),
    specs: join(root, "dialogue-web/tests"),
  });

test("the population is the contract's own union, not a list in this gate", () => {
  const root = tree({ ids: ["chat.submit", "world-info.bind"] });
  try {
    assert.deepEqual(contractOperationIds(join(root, "host/src/tavern/browser-contract/index.ts")), [
      "chat.submit",
      "world-info.bind",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an operation dialogue-web never names is unreachable, and it is named", () => {
  const root = tree({
    ids: ["chat.submit", "world-info.bind"],
    web: { "components/App.tsx": `export const submit = "chat.submit";\n` },
  });
  try {
    const result = run(root);
    assert.equal(result.examined, 2, "examined both declared operations");
    assert.equal(result.status, "failed");
    assert.deepEqual(
      result.violations,
      [{ code: "unreachable:web", operation: "world-info.bind" }],
      "the operation that no module names is the one reported",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every operation named somewhere in the web tree passes, and the counts are printed", () => {
  const root = tree({
    ids: ["chat.submit", "draft.save"],
    web: { "management-pipeline-api.ts": `const a = "chat.submit"; const b = "draft.save";\n` },
    specs: { "submit.spec.ts": `test("chat.submit", () => {});\n` },
  });
  try {
    const result = run(root);
    assert.equal(result.status, "passed");
    assert.deepEqual(result.violations, []);
    assert.equal(result.examined, 2);
    assert.deepEqual(
      result.informational.noSpecNamesTheId,
      ["draft.save"],
      "the spec census is reported, not enforced",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a contract with no operation union blocks rather than passing", () => {
  const root = tree({ ids: [] });
  try {
    const result = run(root);
    assert.equal(result.status, "blocked");
    assert.equal(result.examined, 0);
    assert.deepEqual(
      result.violations.map((violation) => violation.code),
      ["contract_operation_ids_not_found"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
