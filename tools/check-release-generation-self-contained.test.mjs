/**
 * Falsifiers for tools/check-release-generation-self-contained.mjs.
 *
 * Every case builds a throwaway `host/dist`-shaped root - a `current.json`, a `generations/<id>/` with a
 * `production-inventory.json` and the emitted modules the config declares - so the gate's rules are driven
 * through the real entry point and the publisher's own parsers, not through a re-implementation of them. The
 * module list is DERIVED from whichever config the case supplies, so a case cannot go quietly narrower than
 * the gate: the same `declaredModules` the gate uses to demand files is the one the fixture plants.
 *
 * The cases, named for the property each protects:
 *   * a generation holding every module it names, and every module the config declares, is passed;
 *   * deleting an emitted module reports BOTH the import that broke and the file the inventory still records;
 *   * a module the config declares and the generation lacks is named by its path - the 2026-11-07 defect,
 *     which no specifier inside the artifact could have pointed at;
 *   * a specifier that cannot be judged from the text is reported as `unassessed`, not skipped;
 *   * a path composed at runtime is correlated, and one whose anchor is unrecognised is unassessed;
 *   * an empty population is `blocked`, not passed;
 *   * the entry point exits 0 when passed and 1 when failed or blocked.
 *
 * red-proof: inject  deleting an emitted module from a generation copy -> `import_target_missing` naming
 *                    `main.js` and `composition/child.js`, plus `generation_file_missing`
 *                    ("deleting an emitted module reports the import that broke and the file the inventory
 *                    still records")
 * red-proof: history the 2026-11-07 artifact's shape - internally perfect, one module behind the source ->
 *                    `declared_dynamic_module_missing:composition/companion-session-reflection.js`
 *                    ("a module the current config declares and the generation lacks is named by its path")
 * red-proof: inject  a computed dynamic argument and an unanchored path composition -> `unassessed` names
 *                    both and the run still says so
 *                    ("an import whose argument is a variable is reported as unassessed, never skipped")
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { readArtifactConfig } from "../host/scripts/production-artifact.mjs";
import { auditReleaseGenerationSelfContained } from "./check-release-generation-self-contained.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPOSITORY_ROOT, "tools", "check-release-generation-self-contained.mjs");
const CONFIG_PATH = join(REPOSITORY_ROOT, "host", "production-artifact.config.json");

/** The smallest config the gate can be driven with: one entry, one verification root, one dynamic module. */
const CONFIG = Object.freeze({
  entryRoots: ["main.js"],
  verificationRoots: ["tavern/player-turn-acceptance.js"],
  bundledRuntime: { bootstrapPath: "bootstrap/entry/desktop-host-entry.internal.js" },
  externalRuntimeClosure: {
    dynamicExternalImports: [
      {
        package: "@cortexkit/pi-magic-context",
        module: "composition/companion-session-reflection.js",
        expression: '"@cortexkit/pi-magic-context/dreamer"',
        occurrence: 0,
      },
    ],
  },
});

/** Every module a config demands the generation hold - the same derivation the gate performs. */
function declaredModules(config) {
  return [
    ...new Set([
      ...config.entryRoots,
      ...config.verificationRoots,
      ...(typeof config.bundledRuntime?.bootstrapPath === "string" ? [config.bundledRuntime.bootstrapPath] : []),
      ...(config.externalRuntimeClosure?.dynamicExternalImports ?? []).map((rule) => rule.module),
    ]),
  ].sort();
}

const MAIN = 'import { child } from "./composition/child.js";\nexport const entry = child;\n';
const CHILD = "export const child = 1;\n";

/**
 * A throwaway output root holding one generation whose inventory records exactly `records` as emitted, and
 * whose directory holds exactly `modules`. Splitting the two is what lets a case inject the inventory/disk
 * disagreement the gate reads in both directions.
 */
function plantGeneration({ config = CONFIG, modules, records, files = {} } = {}) {
  const declared = declaredModules(config);
  const planted = [...new Set(modules ?? ["main.js", "composition/child.js", ...declared])];
  const root = mkdtempSync(join(tmpdir(), "release-generation-self-contained-"));
  const generation = "g-fixture-1";
  const artifactRoot = join(root, "generations", generation);
  writeFileSync(
    join(root, "current.json"),
    `${JSON.stringify({ schema: "gamebuddy-host-production-current/v2", generation })}\n`,
  );
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(
    join(artifactRoot, "production-inventory.json"),
    `${JSON.stringify({
      entries: (records ?? planted).map((path) => ({
        path,
        type: "file",
        mode: "666",
        sha256: "0".repeat(64),
        origin: { kind: "typescript_emit" },
      })),
    })}\n`,
  );
  const contents = { "main.js": MAIN, "composition/child.js": CHILD, ...files };
  for (const module of planted) {
    const path = join(artifactRoot, ...module.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents[module] ?? "export {};\n");
  }
  return { root, artifactRoot, generation, declared };
}

test("a generation holding every module it names and every module the config declares is passed", async () => {
  const planted = plantGeneration();
  try {
    const reading = await auditReleaseGenerationSelfContained({ outputRoot: planted.root, config: CONFIG });
    assert.deepEqual(reading.violations, []);
    assert.equal(reading.status, "passed");
    assert.equal(reading.population, new Set(["main.js", "composition/child.js", ...planted.declared]).size);
    assert.equal(reading.declarations, planted.declared.length);
    assert.equal(reading.imports, 1);
    assert.deepEqual(reading.unassessed, []);
  } finally {
    rmSync(planted.root, { recursive: true, force: true });
  }
});

test("deleting an emitted module reports the import that broke and the file the inventory still records", async () => {
  const planted = plantGeneration();
  try {
    rmSync(join(planted.artifactRoot, "composition", "child.js"));
    const reading = await auditReleaseGenerationSelfContained({ outputRoot: planted.root, config: CONFIG });
    assert.equal(reading.status, "failed");
    assert.deepEqual(reading.violations, [
      "generation_file_missing:composition/child.js",
      "import_target_missing:main.js:./composition/child.js:composition/child.js",
    ]);
  } finally {
    rmSync(planted.root, { recursive: true, force: true });
  }
});

test("a module the current config declares and the generation lacks is named by its path", async () => {
  // The 2026-11-07 defect: the artifact is internally perfect and one day behind the source, so nothing
  // inside it points at the module it lacks. Every finding below is about the DECLARED module; the artifact's
  // own 174 modules and 404 imports are all satisfied, which is why only the declaration side can name this.
  const planted = plantGeneration();
  try {
    rmSync(join(planted.artifactRoot, "composition", "companion-session-reflection.js"));
    const reading = await auditReleaseGenerationSelfContained({ outputRoot: planted.root, config: CONFIG });
    assert.equal(reading.status, "failed");
    assert.deepEqual(reading.violations, [
      'declared_dynamic_module_missing:composition/companion-session-reflection.js:@cortexkit/pi-magic-context:"@cortexkit/pi-magic-context/dreamer"',
      "generation_file_missing:composition/companion-session-reflection.js",
    ]);
  } finally {
    rmSync(planted.root, { recursive: true, force: true });
  }
});

test("an import whose argument is a variable is reported as unassessed, never skipped", async () => {
  const planted = plantGeneration({
    files: { "main.js": 'const target = "./composition/child.js";\nexport const loaded = await import(target);\n' },
  });
  try {
    const reading = await auditReleaseGenerationSelfContained({ outputRoot: planted.root, config: CONFIG });
    assert.equal(reading.status, "passed");
    assert.equal(reading.imports, 0);
    assert.equal(reading.unassessed.length, 1, JSON.stringify(reading.unassessed));
    assert.match(reading.unassessed[0], /^dynamic_specifier_computed:main\.js:/u);
  } finally {
    rmSync(planted.root, { recursive: true, force: true });
  }
});

test("a path composed from the module's own directory is correlated, and one without an anchor is unassessed", async () => {
  const planted = plantGeneration({
    files: {
      "main.js":
        'import { dirname, join, resolve } from "node:path";\nimport { fileURLToPath } from "node:url";\n' +
        'export const a = join(import.meta.dirname, "composition", "child.js");\n' +
        'export const b = resolve(dirname(fileURLToPath(import.meta.url)), "composition", "gone.js");\n' +
        'export const c = join(someRoot, "composition", "child.js");\n',
    },
  });
  try {
    const reading = await auditReleaseGenerationSelfContained({ outputRoot: planted.root, config: CONFIG });
    assert.equal(reading.status, "failed");
    assert.deepEqual(reading.violations, ["import_target_missing:main.js:composition/gone.js:composition/gone.js"]);
    assert.equal(reading.unassessed.length, 1, JSON.stringify(reading.unassessed));
    assert.match(reading.unassessed[0], /^composed_path_unresolved:main\.js:join\(someRoot/u);
  } finally {
    rmSync(planted.root, { recursive: true, force: true });
  }
});

test("an inventory recording no emitted module is blocked, not passed", async () => {
  const planted = plantGeneration({ records: [] });
  try {
    const reading = await auditReleaseGenerationSelfContained({ outputRoot: planted.root, config: CONFIG });
    assert.equal(reading.status, "blocked");
    assert.equal(reading.population, 0);
    assert.deepEqual(reading.violations, []);
  } finally {
    rmSync(planted.root, { recursive: true, force: true });
  }
});

test("a checkout with no published generation is not_measured, never a pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "release-generation-empty-"));
  try {
    const reading = await auditReleaseGenerationSelfContained({ outputRoot: root, config: CONFIG });
    assert.equal(reading.status, "not_measured");
    assert.equal(reading.reason, "generation_not_published");
    assert.deepEqual(reading.violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the entry point exits 0 when passed and 1 when failed or blocked", async () => {
  // Driven with the repository's own config through the CLI's own `--config`, so the green case also proves
  // the real declaration set is satisfiable by a generation that holds all of it.
  const realConfig = await readArtifactConfig(join(REPOSITORY_ROOT, "host"));
  const planted = plantGeneration({ config: realConfig });
  try {
    copyFileSync(CONFIG_PATH, join(planted.root, "config.json"));
    const args = [GATE, "--root", planted.root, "--config", join(planted.root, "config.json"), "--quiet"];
    const stdout = execFileSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(JSON.parse(stdout).status, "passed");
    rmSync(join(planted.artifactRoot, "composition", "child.js"));
    assert.throws(
      () => execFileSync(process.execPath, args, { encoding: "utf8", stdio: "pipe" }),
      (error) => error.status === 1,
    );
  } finally {
    rmSync(planted.root, { recursive: true, force: true });
  }
  const blocked = plantGeneration({ config: realConfig, records: [] });
  try {
    copyFileSync(CONFIG_PATH, join(blocked.root, "config.json"));
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [GATE, "--root", blocked.root, "--config", join(blocked.root, "config.json"), "--quiet"],
          { encoding: "utf8", stdio: "pipe" },
        ),
      (error) => error.status === 1 && /blocked/u.test(String(error.stderr)),
    );
  } finally {
    rmSync(blocked.root, { recursive: true, force: true });
  }
});
