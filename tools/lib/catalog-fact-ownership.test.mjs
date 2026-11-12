import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CATALOG_MODULE_PATH,
  DECLARED_EXEMPTIONS,
  findCatalogFactCopies,
  formatFinding,
  GATE_PATHS,
  loadDeclaredModels,
} from "./catalog-fact-ownership.mjs";

// red-proof: inject  a wrong price literal (`0.14 / 0.28 / 0.0028`, the rates that
// actually shipped for `deepseek-v4.1-flash`) beside that model in a production
// writer -> the gate reports `fact_mismatch` naming the path, the line, the field and
// both values, where the same file reading the catalog is green
// ("a wrong price beside the model it belongs to is a mismatch" below, plus its
// control). The DERIVED population is falsified too: renaming the model in the owner
// makes the gate report no derived id rather than staying silent
// ("the shipped model set is derived from the owner, so a rename changes the set").
//
// The red proofs are driven through a synthetic tree, not the real one, because a
// gate that can only fail on someone else's commit cannot be shown to fail at all.

const roots = [];

/** The repository the exemptions were read from, so each can be checked against a real file. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "catalog-fact-ownership-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return root;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A catalog module a synthetic tree can import, stating one model and its facts. */
function catalogModuleSource({ modelId = "test-model-flash", cost, contextWindow = 1_000_000 } = {}) {
  const rates = cost ?? { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 };
  return `export const TAVERN_PROVIDER_CATALOG = ${JSON.stringify(
    [
      {
        providerId: "cpa-oai",
        allowedPlayerModels: [{ modelId, contextWindow, cost: rates }],
      },
    ],
    null,
    2,
  )};
`;
}

/** Build a tree with the owner module in place, returning its root. */
function makeTree(extraFiles, catalogOptions) {
  return makeRepo({ [CATALOG_MODULE_PATH]: catalogModuleSource(catalogOptions), ...extraFiles });
}

const DECLARED_COST = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 };

test("the catalog is the owner: a reader that derives its price is clean", async () => {
  const root = makeTree({
    "host/src/reader.ts": [
      'import { catalogModelById } from "./tavern/provider-catalog.js";',
      "export function entry(modelId: string) {",
      "  const cost = catalogModelById(modelId)?.cost;",
      "  return { models: [{ id: modelId, name: modelId, ...(cost === undefined ? {} : { cost }) }] };",
      "}",
      "",
    ].join("\n"),
  });
  const { models, disagreements } = await loadDeclaredModels({ root });
  assert.deepEqual([...models.keys()], ["test-model-flash"]);
  assert.deepEqual(disagreements, []);
  assert.deepEqual(findCatalogFactCopies({ root, models, exemptions: [] }), []);
});

test("a wrong price beside the model it belongs to is a mismatch, named with both values", async () => {
  // The rates that shipped for `deepseek-v4.1-flash`: the PREVIOUS model generation's,
  // 2.1x low on input, 4.3x low on output, an order of magnitude low on cacheRead, and
  // a `cacheWrite` no catalog entry states.
  const root = makeTree({
    "host/src/writer.ts": [
      "export const entry = {",
      '  models: [{ id: "test-model-flash", name: "test-model-flash",',
      "    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 } }],",
      "};",
      "",
    ].join("\n"),
  });
  const { models } = await loadDeclaredModels({ root });
  const findings = findCatalogFactCopies({ root, models, exemptions: [] });
  assert.equal(findings.length, 1);
  const finding = findings[0];
  assert.equal(finding.modelId, "test-model-flash");
  assert.equal(finding.field, "cost");
  assert.equal(finding.path, "host/src/writer.ts");
  assert.equal(finding.line, 3);
  assert.equal(finding.matches, false);
  assert.deepEqual(finding.declared, DECLARED_COST);
  assert.deepEqual(finding.spelled, { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 });
  // The message names the file, the line, the field AND both values - a reader must
  // not have to visit three files to learn what disagreed.
  assert.equal(
    formatFinding(finding),
    "catalog_fact_ownership:fact_mismatch:test-model-flash:cost:host/src/writer.ts:3: " +
      'catalog={"input":0.3,"output":1.2,"cacheRead":0.006,"cacheWrite":0} ' +
      'spelled={"input":0.14,"output":0.28,"cacheRead":0.0028,"cacheWrite":0.14}',
  );
});

test("a copy that AGREES is still a finding: a second owner drifts on its own", async () => {
  const root = makeTree({
    "host/src/writer.ts": [
      "export const entry = {",
      '  models: [{ id: "test-model-flash", contextWindow: 1000000 }],',
      "};",
      "",
    ].join("\n"),
  });
  const { models } = await loadDeclaredModels({ root });
  const findings = findCatalogFactCopies({ root, models, exemptions: [] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].matches, true);
  assert.match(formatFinding(findings[0]), /^catalog_fact_ownership:second_spelling:test-model-flash:contextWindow:/u);
});

test("a wrong window is a mismatch, and the copy is compared exactly - no tolerance", async () => {
  const root = makeTree({
    "host/src/writer.ts": 'export const entry = { models: [{ id: "test-model-flash", contextWindow: 1_000_001 }] };\n',
  });
  const { models } = await loadDeclaredModels({ root });
  const findings = findCatalogFactCopies({ root, models, exemptions: [] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].declared, 1_000_000);
  assert.equal(findings[0].spelled, 1_000_001);
  assert.equal(findings[0].matches, false);
});

test("a literal in a record whose id is an EXPRESSION is reported as unowned", async () => {
  // This is the gameplay worker's shape: one writer, whatever model the caller names.
  const root = makeTree({
    "host/src/writer.ts": [
      "export function entry(config: { modelId: string }) {",
      "  return { models: [{ id: config.modelId, cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 } }] };",
      "}",
      "",
    ].join("\n"),
  });
  const { models } = await loadDeclaredModels({ root });
  const findings = findCatalogFactCopies({ root, models, exemptions: [] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].computedId, true);
  assert.equal(findings[0].modelId, null);
  assert.equal(findings[0].declared, null);
  assert.match(formatFinding(findings[0]), /^catalog_fact_ownership:unowned_literal:computed-id:cost:/u);
});

test("an id spelled as a file-local constant resolves to that model, so a drift is NAMED", async () => {
  // The strengthening this resolution buys: before it, a catalog model whose id was written
  // through a const was reported as an unowned literal with `catalog=null`, so the gate never
  // printed the number it disagreed with - the reader had to go and compare it by hand.
  const root = makeTree({
    "host/src/writer.ts": [
      'const MODEL_ID = "test-model-flash";',
      "export const entry = { models: [{ id: MODEL_ID,",
      "  cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 } }] };",
      "",
    ].join("\n"),
  });
  const { models } = await loadDeclaredModels({ root });
  const findings = findCatalogFactCopies({ root, models, exemptions: [] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].modelId, "test-model-flash");
  assert.equal(findings[0].computedId, false);
  assert.equal(findings[0].matches, false);
  assert.deepEqual(findings[0].declared, DECLARED_COST);
  assert.match(formatFinding(findings[0]), /^catalog_fact_ownership:fact_mismatch:test-model-flash:cost:/u);
});

test("a fixture whose model id is a file-local constant no catalog entry describes is not this gate's business", async () => {
  // The shipped defect of 2026-11-04: `host/src/provider-turn-header.test.ts` writes a models.json
  // for a synthetic model id the product does not sell, at the tiny window Pi requires. The id was
  // written through a const, so the gate could not read it and reported the fixture as "whatever the
  // caller names" - `unowned_literal:computed-id:contextWindow: ... :115: catalog=null spelled=8192`.
  // The id IS knowable, and the catalog does not describe it, which is the literal-id answer.
  const root = makeTree({
    "host/src/fixture.test.ts": [
      'const MODEL_ID = "turn-header-test-model";',
      'const KEY_ENV = "GAMEBUDDY_TURN_HEADER_TEST_KEY";',
      "export const entry = { models: [{ id: MODEL_ID, contextWindow: 8192 }] };",
      "",
    ].join("\n"),
  });
  const { models } = await loadDeclaredModels({ root });
  assert.deepEqual(findCatalogFactCopies({ root, models, exemptions: [] }), []);
});

test("a name that is not a same-file constant is still a computed id", async () => {
  // The boundary that keeps the recorded shape covered: an id that arrives from another module,
  // a parameter or a property access cannot be resolved here, so a literal beside it still prices
  // whatever the caller names.
  const root = makeTree({
    "host/src/writer.ts": [
      'import { MODEL_ID } from "./ids.js";',
      "export const entry = { models: [{ id: MODEL_ID, contextWindow: 131072 }] };",
      "",
    ].join("\n"),
  });
  const { models } = await loadDeclaredModels({ root });
  const findings = findCatalogFactCopies({ root, models, exemptions: [] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].computedId, true);
  assert.equal(findings[0].modelId, null);
  assert.match(formatFinding(findings[0]), /^catalog_fact_ownership:unowned_literal:computed-id:contextWindow:/u);
});

test("a model the catalog does not describe is not this gate's business", async () => {
  // The catalog is not the owner of an id it does not declare, so there is no value
  // to compare a copy against - and inventing one is the defect this gate exists for.
  const root = makeTree({
    "host/src/writer.ts":
      'export const entry = { models: [{ id: "someone-elses-model", cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } }] };\n',
  });
  const { models } = await loadDeclaredModels({ root });
  assert.deepEqual(findCatalogFactCopies({ root, models, exemptions: [] }), []);
});

test("a comment or a doc line that names the fact is documentation, not a declaration", async () => {
  const root = makeTree({
    "host/src/notes.ts": [
      "// cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 } was the defect",
      "/* contextWindow: 131072 */",
      'export const entry = { models: [{ id: "test-model-flash" }] };',
      "",
    ].join("\n"),
  });
  const { models } = await loadDeclaredModels({ root });
  assert.deepEqual(findCatalogFactCopies({ root, models, exemptions: [] }), []);
});

test("a regex assertion pinning a fact next to the model id is caught", async () => {
  // The shape `model-runtime.private.test.ts` had: the only way to pin a serialized document.
  const root = makeTree({
    "host/src/writer.test.ts": [
      'import { catalogModelById } from "./tavern/provider-catalog.js";',
      "export function check(models: string, modelId: string) {",
      '  if (modelId !== "test-model-flash") return;',
      '  return /"contextWindow": 131072/.test(models);',
      "}",
      "",
    ].join("\n"),
  });
  const { models } = await loadDeclaredModels({ root });
  const findings = findCatalogFactCopies({ root, models, exemptions: [] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].modelId, "test-model-flash");
  assert.equal(findings[0].field, "contextWindow");
  assert.equal(findings[0].spelled, 131_072);
  assert.equal(findings[0].declared, 1_000_000);
});

test("an exemption silences exactly the model and field it names, and nothing else", async () => {
  const root = makeTree({
    "host/src/pinned.ts": 'export const entry = { models: [{ id: "test-model-flash", contextWindow: 131072 }] };\n',
  });
  const { models } = await loadDeclaredModels({ root });
  const scoped = [
    { path: "host/src/pinned.ts", modelId: "test-model-flash", fields: ["contextWindow"], reason: "a pinned document" },
  ];
  assert.deepEqual(findCatalogFactCopies({ root, models, exemptions: scoped }), []);
  // The same exemption does not cover a DIFFERENT field of the same file, nor the same
  // field of a different file.
  assert.equal(findCatalogFactCopies({ root, models, exemptions: [] }).length, 1);
  const otherField = [
    { path: "host/src/pinned.ts", modelId: "test-model-flash", fields: ["cost"], reason: "wrong field" },
  ];
  assert.equal(findCatalogFactCopies({ root, models, exemptions: otherField }).length, 1);
  const otherPath = [
    { path: "host/src/elsewhere.ts", modelId: "test-model-flash", fields: ["contextWindow"], reason: "wrong path" },
  ];
  assert.equal(findCatalogFactCopies({ root, models, exemptions: otherPath }).length, 1);
});

test("the shipped model set is derived from the owner, so a rename changes the set", async () => {
  // The derivation falsifier: the gate must answer from the catalog it is given, not
  // from a constant. Renaming the model in the owner makes the OLD id unknown while the
  // new one is derived - and a copy keyed to the old id is then no longer reported,
  // because the catalog is no longer its owner. A gate with a hardcoded id would keep
  // reporting the old name here.
  const writer = 'export const entry = { models: [{ id: "test-model-flash", contextWindow: 131072 }] };\n';
  const before = makeTree({ "host/src/writer.ts": writer });
  const beforeModels = (await loadDeclaredModels({ root: before })).models;
  assert.deepEqual([...beforeModels.keys()], ["test-model-flash"]);
  assert.equal(findCatalogFactCopies({ root: before, models: beforeModels, exemptions: [] }).length, 1);

  const renamed = makeRepo({
    [CATALOG_MODULE_PATH]: catalogModuleSource({ modelId: "renamed-model-flash" }),
    "host/src/writer.ts": writer,
  });
  const renamedModels = (await loadDeclaredModels({ root: renamed })).models;
  assert.deepEqual([...renamedModels.keys()], ["renamed-model-flash"]);
  assert.equal(
    findCatalogFactCopies({ root: renamed, models: renamedModels, exemptions: [] }).length,
    0,
    "the derived set moved with the owner: the old id is no longer catalogued",
  );
});

test("two catalog entries describing one id at different rates are a NAMED disagreement", async () => {
  // No single upstream number is then "the" price, so the gate must say so instead of
  // silently taking whichever entry the lookup happened to reach first.
  const root = makeRepo({
    [CATALOG_MODULE_PATH]: `export const TAVERN_PROVIDER_CATALOG = ${JSON.stringify([
      {
        providerId: "cpa-oai",
        allowedPlayerModels: [
          { modelId: "test-model-flash", cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 } },
        ],
      },
      {
        providerId: "other",
        allowedPlayerModels: [
          { modelId: "test-model-flash", cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } },
        ],
      },
    ])}\n`,
  });
  const { disagreements } = await loadDeclaredModels({ root });
  assert.equal(disagreements.length, 1);
  assert.equal(disagreements[0].modelId, "test-model-flash");
  assert.equal(disagreements[0].field, "cost");
  assert.deepEqual(disagreements[0].first, DECLARED_COST);
  assert.deepEqual(disagreements[0].second, { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 });
});

/**
 * Every declared exemption that points at a real file must still be earned, and must
 * still be scoped.
 *
 * Earning: the occurrence it waives is still in that file - a stale exemption fails
 * rather than quietly widening. Scoping: that same text in a sibling file is still
 * reported, so an exemption cannot become a repeal of the rule.
 */
for (const exemption of DECLARED_EXEMPTIONS.filter((entry) => !GATE_PATHS.includes(entry.path))) {
  test(`an exemption is earned and scoped: ${exemption.path}`, async () => {
    const absolute = join(repoRoot, exemption.path);
    const source = readFileSync(absolute, "utf8");
    const { models } = await loadDeclaredModels({ root: repoRoot });
    const live = findCatalogFactCopies({ root: repoRoot, models, exemptions: [exemption] });
    // It must waive something: the same tree WITHOUT it reports at least one finding.
    const waived = findCatalogFactCopies({ root: repoRoot, models, exemptions: [] }).filter(
      (finding) =>
        finding.path === exemption.path && (exemption.fields === undefined || exemption.fields.includes(finding.field)),
    );
    assert.ok(
      waived.length > 0,
      `${exemption.path} no longer holds a ${exemption.fields?.join("/") ?? "declared-fact"} copy, ` +
        "so the exemption no longer earns its place",
    );
    assert.equal(live.filter((finding) => finding.path === exemption.path).length, 0);
    assert.ok(source.length > 0);
    assert.equal(exemption.reason.trim(), exemption.reason, `${exemption.path} needs a trimmed one-line reason`);
    assert.ok(
      exemption.reason.length > 0 && !exemption.reason.includes("\n"),
      `${exemption.path} needs a one-line reason saying why the repeat is legitimate`,
    );
  });
}

test("the gate's own files are exempt, so it can spell the names it looks for", () => {
  for (const path of GATE_PATHS)
    assert.ok(
      DECLARED_EXEMPTIONS.some((entry) => entry.path === path),
      path,
    );
});
