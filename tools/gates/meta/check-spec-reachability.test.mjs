import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { auditSpecReachability, evaluate, readBaseline } from "./check-spec-reachability.mjs";

// red-proof: inject  a `tools/` suite added to a synthetic tree that no reachable `node --test`
//                    command names -> `unreached_suite` names that file, beside an aggregate-run
//                    suite in the same tree that is green ("a suite no reachable command names is
//                    the finding" below). Also injected: a spec the config's `testIgnore` excludes
//                    (`unreached_spec`), the workflow step that runs the mounted zone deleted
//                    (`mounted_zone_unreached` behind every spec), and the config itself missing
//                    (`spec_population_unassessable` rather than a silent pass).

const roots = [];

/** One synthetic checkout: the workflow, the two manifests, the config and whatever files are asked for. */
function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), "spec-reachability-"));
  roots.push(root);
  const base = {
    "pnpm-workspace.yaml": "packages:\n  - dialogue-web\n",
    "package.json": JSON.stringify(
      {
        scripts: {
          "test:tool-corpus": "node tools/run-tool-test-corpus.mjs",
          "test:alpha": "node --test tools/alpha.test.mjs",
        },
      },
      null,
      2,
    ),
    ".github/workflows/ci.yml": [
      "jobs:",
      "  quality:",
      "    steps:",
      "      - run: pnpm test:tool-corpus",
      "      - run: pnpm --filter @gamebuddy/dialogue-web test:static",
      "      - run: pnpm --filter @gamebuddy/dialogue-web test:mounted",
      "",
    ].join("\n"),
    "dialogue-web/package.json": JSON.stringify(
      {
        name: "@gamebuddy/dialogue-web",
        scripts: {
          "test:static": "node --test tests/beta.test.mjs",
          "test:mounted": "playwright test --project=chromium --workers=1",
        },
      },
      null,
      2,
    ),
    "dialogue-web/playwright.config.ts": [
      "export default {",
      '  testDir: "./tests",',
      '  testMatch: "**/*.spec.ts",',
      "};",
      "",
    ].join("\n"),
    "dialogue-web/tests/good.spec.ts": 'import { test } from "./frontend-coverage";\n\ntest("a journey", () => {});\n',
    "dialogue-web/tests/beta.test.mjs": 'import test from "node:test";\n\ntest("beta", () => {});\n',
    "tools/alpha.test.mjs": 'import test from "node:test";\n\ntest("alpha", () => {});\n',
  };
  for (const [relativePath, contents] of Object.entries({ ...base, ...files })) {
    if (contents === null) continue;
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return root;
}

const read = (root) => auditSpecReachability({ root });
const codes = (findings) => findings.map((finding) => `${finding.code}:${finding.file ?? "-"}`);

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("a suite no reachable command names is the finding, and the aggregate's own corpus is reached", () => {
  const root = makeTree({ "tools/orphan.test.mjs": 'import test from "node:test";\n\ntest("orphan", () => {});\n' });
  const reading = read(root);
  const { findings } = evaluate({ reading, baseline: { files: [] } });
  assert.deepEqual(codes(findings), ["unreached_suite:tools/orphan.test.mjs"]);
  // `tools/alpha.test.mjs` is named by no workflow step either. It is reached because the aggregate
  // runner derives its corpus from `test:*` scripts, and the derivation is imported, not re-invented.
  assert.equal(reading.groups.find((group) => group.id === "tools_suites").population.length, 2);
  assert.equal(reading.unreached.filter((entry) => entry.file === "tools/alpha.test.mjs").length, 0);
});

test("deleting the workflow step that runs the mounted zone leaves every spec unreached", () => {
  const root = makeTree({
    ".github/workflows/ci.yml": [
      "jobs:",
      "  quality:",
      "    steps:",
      "      - run: pnpm test:tool-corpus",
      "      - run: pnpm --filter @gamebuddy/dialogue-web test:static",
      "",
    ].join("\n"),
  });
  const reading = read(root);
  const { findings } = evaluate({ reading, baseline: { files: [] } });
  assert.ok(codes(findings).includes("mounted_zone_unreached:-"), codes(findings).join(", "));
  assert.ok(codes(findings).includes("unreached_spec:dialogue-web/tests/good.spec.ts"));
  assert.equal(reading.groups.find((group) => group.id === "specs").population[0].reason, "mounted_zone_unreached");
});

test("a spec the config's own testIgnore excludes is named, not assumed to run", () => {
  const root = makeTree({
    "dialogue-web/playwright.config.ts": [
      "export default {",
      '  testDir: "./tests",',
      '  testMatch: "**/*.spec.ts",',
      '  testIgnore: ["**/skipped.spec.ts"],',
      "};",
      "",
    ].join("\n"),
    "dialogue-web/tests/skipped.spec.ts": 'import { test } from "./frontend-coverage";\n\ntest("skipped", () => {});\n',
  });
  const reading = read(root);
  const { findings } = evaluate({ reading, baseline: { files: [] } });
  assert.deepEqual(codes(findings), ["unreached_spec:dialogue-web/tests/skipped.spec.ts"]);
  assert.match(reading.unreached[0].reason, /spec_excluded_by_testIgnore/u);
});

test("the population is a scan: a new spec and a new suite join it without the gate being told", () => {
  const before = read(makeTree({}));
  const after = read(
    makeTree({
      "dialogue-web/tests/extra.spec.ts": 'import { test } from "./frontend-coverage";\n\ntest("extra", () => {});\n',
      "tools/extra.test.mjs": 'import test from "node:test";\n\ntest("extra", () => {});\n',
    }),
  );
  const count = (reading, id) => reading.groups.find((group) => group.id === id).population.length;
  assert.equal(count(after, "specs"), count(before, "specs") + 1);
  assert.equal(count(after, "tools_suites"), count(before, "tools_suites") + 1);
});

test("a recorded reading is held, and an entry that is reached now is stale", () => {
  const root = makeTree({ "tools/orphan.test.mjs": 'import test from "node:test";\n\ntest("orphan", () => {});\n' });
  const reading = read(root);
  const held = evaluate({ reading, baseline: { files: ["tools/orphan.test.mjs"] } });
  assert.deepEqual(held.findings, []);
  assert.equal(held.held, 1);

  const stale = evaluate({ reading, baseline: { files: ["tools/alpha.test.mjs"] } });
  assert.deepEqual(codes(stale.findings), [
    "unreached_suite:tools/orphan.test.mjs",
    "baseline_entry_stale:tools/alpha.test.mjs",
  ]);
});

test("a population that cannot be derived is a finding, never a silent pass", () => {
  const root = makeTree({ "dialogue-web/playwright.config.ts": "export default {};\n" });
  const reading = read(root);
  const { findings } = evaluate({ reading, baseline: { files: [] } });
  assert.ok(codes(findings).includes("spec_population_unassessable:-"), codes(findings).join(", "));
  assert.equal(reading.unassessed.length, 1);
  assert.match(reading.unassessed[0], /^unassessed: dialogue-web\/playwright\.config\.ts - /u);
});

test("the baseline file is read from the tree it is given, so a fixture cannot borrow the real one", () => {
  assert.deepEqual(readBaseline(makeTree({})), { files: [], note: null });
  const recorded = makeTree({
    "tools/spec-reachability-baseline.json": JSON.stringify({
      schema: "gamebuddy-spec-reachability-baseline/v1",
      files: ["tools/orphan.test.mjs"],
    }),
  });
  assert.deepEqual(readBaseline(recorded).files, ["tools/orphan.test.mjs"]);
});
