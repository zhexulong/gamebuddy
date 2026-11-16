// red-proof: inject  removing containment from the game-free generic layer set -> `× reports exact generic-to-game and
//   Stardew raw-module violations` (tools/check-host-game-physical-seam.test.mjs)
// red-proof: history the tree before this rule's own unit, where
//   `host/src/containment/runtime/contract/game-runtime.ts` declared
//   `FarmhandBridgeConnectionNotAvailableError` -> `generic_runtime_names_game` naming that
//   file, its line and the identifier, token `farmhand` (re-run of the checker on that tree)
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkHostGamePhysicalSeam } from "./check-host-game-physical-seam.mjs";

async function withFixture(files, run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-game-seam-"));
  try {
    await Promise.all(
      Object.entries(files).map(async ([path, source]) => {
        const target = join(root, path);
        await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
        await writeFile(target, source);
      }),
    );
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const roots = {
  "host/src/bootstrap/entry.ts": "export { value } from '../games/stardew/value.js';\n",
  "host/src/containment/reverse.ts": "import '../games/stardew/value.js';\n",
  // composition is the composition root: ADR-0007 allows it to import one
  // selected game adapter, so this edge is legal and must not be reported.
  "host/src/composition/selected-adapter.ts": "export * from '../games/stardew/value.js';\n",
  "host/src/games/stardew/value.ts": "export const value = 1;\n",
};

test("passes the relocated production graph and allows the narrow Stardew containment contract", () => {
  const report = checkHostGamePhysicalSeam();
  assert.equal(report.verdict, "passed");
  assert.equal(report.violations.length, 0);
});

test("a host/src holding no production module is blocked, never passed over zero files", async () => {
  await withFixture({ "host/src/app.test.ts": "export const value = 1;\n" }, (root) => {
    const report = checkHostGamePhysicalSeam({ root });
    assert.equal(report.verdict, "blocked");
    assert.match(report.blocked[0], /host_game_physical_seam_read_nothing: examined 0 production module/u);
  });
});

test("allows the Stardew lifecycle process owner and approved provenance contract", async () => {
  await withFixture(
    {
      "host/src/games/stardew/lifecycle/stardew-process-implementations.ts":
        "import { spawn } from 'node:child_process';\nexport const owner = spawn;\n",
      // The game layer legitimately reaches only the staging provenance contract.
      // It must NOT reach the containment auth transport: that allowance was removed
      // with the retired desktop-session guardian seam, so this fixture asserts the
      // live graph rather than an inert permission.
      "host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.internal.ts": [
        "import { createProductionStagingDependencies } from '../../../bootstrap/roots/stardew-private-mod-profile-staging.js';",
        "export const owner = { createProductionStagingDependencies };\n",
      ].join("\n"),
      "host/src/bootstrap/roots/stardew-private-mod-profile-staging.ts":
        "export function createProductionStagingDependencies() {}\n",
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "passed");
      assert.equal(report.violations.length, 0);
    },
  );
});

// The removed allowance must not silently come back. A game-layer import of the
// containment auth transport is blocked, including a type-only import.
test("blocks a game-layer import of the containment auth transport", async () => {
  await withFixture(
    {
      "host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.internal.ts": [
        "import type { DesktopGuardianSession } from '../../../containment/auth/desktop-guardian-session.internal.js';",
        "export const owner = {} as unknown as DesktopGuardianSession;\n",
      ].join("\n"),
      "host/src/containment/auth/desktop-guardian-session.internal.ts":
        "export type DesktopGuardianSession = unknown;\n",
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "blocked");
      assert.equal(report.violations.length, 1);
      assert.equal(report.violations[0]?.kind, "game_imports_generic_layer");
    },
  );
});

test("allows Stardew installation registration mutation only from its lifecycle owner facade consumer", async () => {
  await withFixture(
    {
      "host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.internal.ts":
        "import { withStardewLifecycleInstallationRegistrationOwner } from '../../../stardew-installation-registration.internal.js';\nexport const owner = withStardewLifecycleInstallationRegistrationOwner;\n",
      "host/src/stardew-installation-registration.internal.ts":
        "export function withStardewLifecycleInstallationRegistrationOwner() {}\n",
    },
    (root) => {
      assert.equal(checkHostGamePhysicalSeam({ root }).verdict, "passed");
    },
  );
});

test("allows read-only Stardew installation registration from the production lifecycle coordinator", async () => {
  await withFixture(
    {
      "host/src/stardew-production-lifecycle-coordinator.internal.ts":
        "import { readStardewInstallationRegistration } from './stardew-installation-registration.internal.js';\nexport const coordinator = readStardewInstallationRegistration;\n",
      "host/src/stardew-installation-registration.internal.ts":
        "export function readStardewInstallationRegistration() {}\nexport function withStardewLifecycleInstallationRegistrationOwner() {}\n",
    },
    (root) => assert.equal(checkHostGamePhysicalSeam({ root }).verdict, "passed"),
  );
});

test("rejects Stardew installation registration mutation outside its lifecycle composer", async () => {
  await withFixture(
    {
      "host/src/games/stardew/lifecycle/other.ts":
        "import { withStardewLifecycleInstallationRegistrationOwner } from '../../../stardew-installation-registration.internal.js';\n",
      "host/src/stardew-installation-registration.internal.ts":
        "export function withStardewLifecycleInstallationRegistrationOwner() {}\n",
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "blocked");
      assert.equal(report.violations[0].kind, "stardew_registration_import_not_owner");
    },
  );
});

test("rejects detectable aliases and re-exports of the Stardew registration mutation facade", async () => {
  await withFixture(
    {
      "host/src/games/stardew/lifecycle/alias.ts":
        "import { withStardewLifecycleInstallationRegistrationOwner as mutation } from '../../../stardew-installation-registration.internal.js';\n",
      "host/src/games/stardew/lifecycle/reexport.ts":
        "export { withStardewLifecycleInstallationRegistrationOwner as mutation } from '../../../stardew-installation-registration.internal.js';\n",
      "host/src/stardew-installation-registration.internal.ts":
        "export function withStardewLifecycleInstallationRegistrationOwner() {}\n",
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "blocked");
      assert.equal(report.violations.filter(({ kind }) => kind === "stardew_registration_import_not_owner").length, 2);
    },
  );
});

test("rejects raw builtins and staging provenance from non-owner Stardew lifecycle siblings", async () => {
  await withFixture(
    {
      "host/src/games/stardew/lifecycle/other.ts":
        "import 'node:child_process';\nimport { createProductionStagingDependencies } from '../../../bootstrap/roots/stardew-private-mod-profile-staging.js';\n",
      "host/src/bootstrap/roots/stardew-private-mod-profile-staging.ts":
        "export function createProductionStagingDependencies() {}\n",
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "blocked");
      assert.equal(report.violations.filter(({ kind }) => kind === "game_imports_desktop_raw_module").length, 1);
      assert.equal(report.violations.filter(({ kind }) => kind === "game_imports_generic_layer").length, 1);
    },
  );
});

test("rejects the approved provenance exception outside the Stardew lifecycle", async () => {
  await withFixture(
    {
      "host/src/games/game2/owner.ts":
        "import { createProductionStagingDependencies } from '../../bootstrap/roots/stardew-private-mod-profile-staging.js';\n",
      "host/src/bootstrap/roots/stardew-private-mod-profile-staging.ts":
        "export function createProductionStagingDependencies() {}\n",
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "blocked");
      assert.equal(report.violations[0].kind, "game_imports_generic_layer");
    },
  );
});

test("rejects Stardew process implementations under generic Windows containment", async () => {
  await withFixture(
    {
      "host/src/containment/windows/stardew-process-implementations.ts": "export const forbidden = true;\n",
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "blocked");
      assert.equal(report.violations[0].kind, "stardew_implementation_in_generic_windows");
      assert.equal(
        report.violations[0].detail,
        "stardew_process_implementations_must_live_under_games_stardew_lifecycle",
      );
    },
  );
});

test("reports exact generic-to-game and Stardew raw-module violations", async () => {
  await withFixture(
    {
      ...roots,
      "host/src/games/stardew/raw.ts": [
        "import '../../windows-bootstrap-guardian/index.js';",
        "import 'node:child_process';",
      ].join("\n"),
      "host/src/windows-bootstrap-guardian/index.ts": "export const raw = true;\n",
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "blocked");
      assert.deepEqual(
        report.violations.map(({ kind, importer, specifier, line, detail }) => ({
          kind,
          importer: importer.replace(/^.*?host\//, "host/"),
          specifier,
          line,
          detail,
        })),
        [
          {
            kind: "game_imports_desktop_raw_module",
            importer: "host/src/games/stardew/raw.ts",
            specifier: "node:child_process",
            line: 2,
            detail: "stardew_must_not_import_desktop_guardian_process_or_native_modules",
          },
          {
            kind: "generic_layer_imports_game",
            importer: "host/src/bootstrap/entry.ts",
            specifier: "../games/stardew/value.js",
            line: 1,
            detail: "bootstrap_containment_and_composition_must_not_import_games",
          },
          {
            kind: "generic_layer_imports_game",
            importer: "host/src/containment/reverse.ts",
            specifier: "../games/stardew/value.js",
            line: 1,
            detail: "bootstrap_containment_and_composition_must_not_import_games",
          },
          {
            kind: "game_imports_desktop_raw_module",
            importer: "host/src/games/stardew/raw.ts",
            specifier: "../../windows-bootstrap-guardian/index.js",
            line: 1,
            detail: "stardew_must_not_import_desktop_guardian_process_or_native_modules",
          },
        ],
      );
    },
  );
});

test("protects arbitrary game under games/ (e.g. games/game2) with equal compliance rules", async () => {
  await withFixture(
    {
      "host/src/bootstrap/entry.ts": "export { value } from '../games/game2/value.js';\n",
      "host/src/containment/reverse.ts": "import '../games/game2/value.js';\n",
      "host/src/composition/reverse.ts": "export * from '../games/game2/value.js';\n",
      "host/src/games/game2/value.ts": "export const value = 2;\n",
      "host/src/games/game2/raw.ts": "import 'child_process';\n",
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "blocked");
      const kinds = report.violations.map((v) => v.kind);
      assert.ok(kinds.includes("generic_layer_imports_game"));
      assert.ok(kinds.includes("game_imports_desktop_raw_module"));
      assert.equal(report.inspectedFiles.length, 5);
    },
  );
});

test("rejects explicit desktop, guardian, windows, and native raw path variants", async () => {
  const variants = ["desktop", "guardian", "windows", "native"];
  await withFixture(
    Object.fromEntries([
      ...variants.map((name) => [`host/src/games/stardew/${name}.ts`, `import '../../${name}/entry.js';`]),
      ...variants.map((name) => [`host/src/${name}/entry.ts`, "export const raw = true;\n"]),
    ]),
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "blocked");
      assert.equal(
        report.violations.filter(({ kind }) => kind === "game_imports_desktop_raw_module").length,
        variants.length,
      );
    },
  );
});

test("excludes test-support and fixture directories from production traversal", async () => {
  await withFixture(
    {
      "host/src/games/stardew/real.ts": "export const value = 1;\n",
      "host/src/games/stardew/test-support/ignored.ts": "import '../../bootstrap/entry.js';\n",
      "host/src/games/stardew/test-fixtures/ignored.ts": "import '../../bootstrap/entry.js';\n",
      "host/src/games/stardew/__fixtures__/ignored.ts": "import '../../bootstrap/entry.js';\n",
      "host/src/games/stardew/fixture/ignored.ts": "import '../../bootstrap/entry.js';\n",
      "host/src/games/stardew/fixtures/ignored.ts": "import '../../bootstrap/entry.js';\n",
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "passed");
      assert.deepEqual(report.inspectedFiles, ["host/src/games/stardew/real.ts"]);
    },
  );
});

test("excludes test and test-support sources from production traversal", async () => {
  await withFixture(
    {
      "host/src/games/stardew/real.ts": "export const value = 1;\n",
      "host/src/games/stardew/ignored.test.ts": "import '../../bootstrap/entry.js';\n",
      "host/src/games/stardew/ignored.test-support.ts": "import '../../bootstrap/entry.js';\n",
      "host/src/games/stardew/ignored.test-support-internal.ts": "import '../../bootstrap/entry.js';\n",
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "passed");
      assert.deepEqual(report.inspectedFiles, ["host/src/games/stardew/real.ts"]);
    },
  );
});

test("resolves supported source extensions, index modules, require and import-equals edges", async () => {
  await withFixture(
    {
      "host/src/games/stardew/entry.ts": [
        "import value from './folder/index.mjs';",
        "import alias = require('./alias.cjs');",
        "export { value as other } from './other.jsx';",
        "const loaded = require('./loaded.mts');",
      ].join("\n"),
      "host/src/games/stardew/folder/index.mjs": "export default 1;\n",
      "host/src/games/stardew/alias.cjs": "module.exports = 1;\n",
      "host/src/games/stardew/other.jsx": "export const value = 1;\n",
      "host/src/games/stardew/loaded.mts": "export const value = 1;\n",
    },
    (root) => assert.equal(checkHostGamePhysicalSeam({ root }).verdict, "passed"),
  );
});

test("fails closed for unresolved, ambiguous, escaped, and non-relative internal edges", async () => {
  await withFixture(
    {
      "host/src/games/stardew/entry.ts": [
        "import './missing.js';",
        "import './ambiguous.js';",
        "import '../../../outside.js';",
        "import 'host/internal.js';",
      ].join("\n"),
      "host/src/games/stardew/ambiguous.ts": "export const a = 1;\n",
      "host/src/games/stardew/ambiguous.js": "export const a = 1;\n",
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "blocked");
      assert.deepEqual(
        report.violations.map(({ kind }) => kind),
        [
          "unresolved_relative_import",
          "ambiguous_relative_import",
          "relative_import_escapes_source_root",
          "unresolved_non_relative_import",
        ],
      );
    },
  );
});

test("fails closed on dynamic imports and require calls in the inspected production seam", async () => {
  await withFixture(
    {
      "host/src/games/stardew/dynamic.ts": [
        "export async function load(name: string) { return import(name); }",
        "export function requireLoaded(name: string) { return require(name); }",
        "export function computed(name: string) { return import('./' + name); }",
      ].join("\n"),
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "blocked");
      assert.equal(report.violations.length, 3);
      assert.ok(
        report.violations.every(
          ({ kind, detail }) =>
            kind === "unresolved_dynamic_import" && detail === "dynamic_imports_are_not_statically_resolvable",
        ),
      );
    },
  );
});

// A type-only `import("path").Type` is an architecture edge like any other. The
// checker recorded import/export declarations, import-equals and `require`/`import`
// calls but not `ImportTypeNode`, so this spelling was a full blind spot: the same
// forbidden layer was blocked one way and reported `passed` the other.
test("blocks a game-layer type-only import() of a generic layer", async () => {
  await withFixture(
    {
      "host/src/games/stardew/lifecycle/probe.ts": [
        "export type X = import('../../../containment/runtime/core/contained-game-runtime.js').ContainedGameRuntime;",
        "export type Y = import('../../../containment/auth/desktop-guardian-session.internal.js').DesktopGuardianSession;",
      ].join("\n"),
      "host/src/containment/runtime/core/contained-game-runtime.ts": "export type ContainedGameRuntime = unknown;\n",
      "host/src/containment/auth/desktop-guardian-session.internal.ts":
        "export type DesktopGuardianSession = unknown;\n",
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "blocked");
      const kinds = report.violations.map((violation) => violation.kind);
      assert.ok(
        kinds.includes("game_imports_generic_layer"),
        `expected a generic-layer violation, got ${JSON.stringify(kinds)}`,
      );
    },
  );
});

// The registration plan's gate 10 requires production import tests to reject
// registration-core/storage imports from flat host/src producers (run manifest,
// operational gate evidence, the launcher, ...). Those modules are directly under
// host/src, so while the inspected set was limited to the three generic layers plus
// games they were traversed for placement only and never evaluated as importers --
// the registration rule could not fire for them at all.
test("inspects flat host/src producers and rejects a non-owner registration import", async () => {
  await withFixture(
    {
      "host/src/run-manifest.ts":
        "import { withStardewLifecycleInstallationRegistrationOwner } from './stardew-installation-registration.internal.js';\nexport const owner = withStardewLifecycleInstallationRegistrationOwner;\n",
      "host/src/stardew-installation-registration.internal.ts":
        "export function withStardewLifecycleInstallationRegistrationOwner() {}\n",
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "blocked");
      assert.ok(
        report.inspectedFiles.includes("host/src/run-manifest.ts"),
        `a flat host/src producer must be inspected, got ${JSON.stringify(report.inspectedFiles)}`,
      );
      const kinds = report.violations.map((violation) => violation.kind);
      assert.ok(
        kinds.includes("stardew_registration_import_not_owner"),
        `expected a registration-owner violation, got ${JSON.stringify(kinds)}`,
      );
    },
  );
});

// The generic runtime's README says the layer "Does not know: Game names, game rules,
// installation or recipe facts". A source that cannot import a game can still NAME one,
// which is exactly how `FarmhandBridgeConnectionNotAvailableError` - a refusal about one
// game's bridge connection authority - ended up in the contract every game shares.
test("names the generic runtime source that uses the game's own vocabulary", async () => {
  await withFixture(
    {
      "host/src/games/stardew/value.ts": "export const value = 1;\n",
      "host/src/containment/runtime/contract/game-runtime.ts": [
        "export class FarmhandBridgeConnectionNotAvailableError extends Error {}",
        'export const code = "stardew_farmhand_bridge_connection_not_available";',
      ].join("\n"),
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "blocked");
      assert.equal(report.vocabulary.examined, 1);
      assert.deepEqual(report.vocabulary.gameIdentities, ["stardew"]);
      assert.deepEqual(
        report.violations
          .filter(({ kind }) => kind === "generic_runtime_names_game")
          .map(({ importer, line, detail, token, identifier }) => ({ importer, line, detail, token, identifier })),
        [
          {
            importer: "host/src/containment/runtime/contract/game-runtime.ts",
            line: 1,
            detail: "containment_runtime_must_not_name_a_game",
            token: "farmhand",
            identifier: "FarmhandBridgeConnectionNotAvailableError",
          },
          {
            importer: "host/src/containment/runtime/contract/game-runtime.ts",
            line: 2,
            detail: "containment_runtime_must_not_name_a_game",
            token: "stardew",
            identifier: "stardew_farmhand_bridge_connection_not_available",
          },
        ],
      );
    },
  );
});

// The vocabulary is read from `games/`, not listed, so a second game is covered the day
// its directory exists rather than the day someone remembers to add it.
test("derives the game identity from games/, so a second game needs no new word in this gate", async () => {
  await withFixture(
    {
      "host/src/games/game2/value.ts": "export const value = 2;\n",
      "host/src/containment/runtime/core/run-state.ts": 'export const phase = "game2_transition";\n',
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "blocked");
      assert.deepEqual(report.vocabulary.gameIdentities, ["game2"]);
      assert.deepEqual(
        report.violations.map(({ kind, token, identifier }) => ({ kind, token, identifier })),
        [{ kind: "generic_runtime_names_game", token: "game2", identifier: "game2_transition" }],
      );
    },
  );
});

test("a generic runtime holding no production source is blocked, never passed over zero files", async () => {
  await withFixture(
    {
      "host/src/games/stardew/value.ts": "export const value = 1;\n",
      // Containment exists, its runtime layer does not: that is the rule having no
      // population under a tree that carries the layer, not a fixture modelling none.
      "host/src/containment/auth/guardian.ts": "export const guardian = 1;\n",
      "host/src/containment/runtime/idle.test.ts": "export const value = 1;\n",
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "blocked");
      assert.equal(report.vocabulary.examined, 0);
      assert.match(
        report.blocked[0],
        /generic_runtime_vocabulary_read_nothing: examined 0 production source\(s\) under host\/src\/containment\/runtime\//u,
      );
    },
  );
});

// The stated limit, held: comments are outside the semantic surface, so the layer may
// still explain which fact is NOT its own - `contained-game-runtime.ts` does exactly that
// about an unlaunched role's empty Job.
test("a comment that names the game to say the layer does not own the fact is not the defect", async () => {
  await withFixture(
    {
      "host/src/games/stardew/value.ts": "export const value = 1;\n",
      "host/src/containment/runtime/core/run-state.ts": [
        "/** A stardew fact: the cabin owner owns the empty Job, and this layer does not. */",
        "export const phase = 1;",
      ].join("\n"),
    },
    (root) => {
      const report = checkHostGamePhysicalSeam({ root });
      assert.equal(report.verdict, "passed");
      assert.equal(report.vocabulary.examined, 1);
    },
  );
});
