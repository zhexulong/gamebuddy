import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkHostProductionImportBoundary,
  EXPECTED_S5_BLOCKED_FINDINGS,
  validateHostProductionImportBoundaryBaseline,
} from "./check-host-production-import-boundary.mjs";

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-import-boundary-"));
  await Promise.all(
    Object.entries(files).map(async ([path, source]) => {
      const target = join(root, path);
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true }),
      );
      await writeFile(target, source);
    }),
  );
  return root;
}
async function withFixture(files, run) {
  const root = await fixture(files);
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const roots = ["host/src/main.ts", "host/src/dialogue-web-main.ts"];

test("accepts only the exact frozen S5 blocked baseline and rejects clean, novel, or missing findings", () => {
  const blocked = {
    verdict: "blocked",
    violations: EXPECTED_S5_BLOCKED_FINDINGS.map(([kind, importer, specifier, line, detail]) => ({
      kind,
      importer,
      specifier,
      line,
      detail,
    })),
  };
  assert.deepEqual(validateHostProductionImportBoundaryBaseline(blocked), {
    accepted: true,
    mode: "expected_s5_blocked",
  });
  assert.equal(validateHostProductionImportBoundaryBaseline({ verdict: "passed", violations: [] }).accepted, false);
  assert.equal(
    validateHostProductionImportBoundaryBaseline({ verdict: "blocked", violations: blocked.violations.slice(1) })
      .accepted,
    false,
  );
  assert.equal(
    validateHostProductionImportBoundaryBaseline({
      verdict: "blocked",
      violations: [
        ...blocked.violations,
        { kind: "novel", importer: "host/src/main.ts", specifier: null, line: 1, detail: "novel" },
      ],
    }).accepted,
    false,
  );
  assert.deepEqual(
    validateHostProductionImportBoundaryBaseline({ verdict: "passed", violations: [] }, { requireClean: true }),
    { accepted: true, mode: "clean" },
  );
  assert.equal(validateHostProductionImportBoundaryBaseline(blocked, { requireClean: true }).accepted, false);
});

test("follows static relative imports and re-exports, reporting each banned legacy authority edge exactly", async () => {
  await withFixture(
    {
      "host/src/main.ts": 'import "./safe";\n',
      "host/src/dialogue-web-main.ts": 'export { value } from "./relay";\n',
      "host/src/safe.ts": 'export * from "./continuity-authority-coordinator/worker";\n',
      "host/src/relay.ts": 'export { value } from "./game-origin-authority/origin";\n',
      "host/src/continuity-authority-coordinator/worker.ts": "export const value = 1;\n",
      "host/src/game-origin-authority/origin.ts": "export const value = 2;\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.equal(report.verdict, "blocked");
      assert.deepEqual(
        report.violations.map(({ kind, importer, specifier, line, detail }) => ({
          kind,
          importer,
          specifier,
          line,
          detail,
        })),
        [
          {
            kind: "banned_legacy_module",
            importer: "host/src/relay.ts",
            specifier: "./game-origin-authority/origin",
            line: 1,
            detail: "legacy_authority_module:game-origin-authority/",
          },
          {
            kind: "banned_legacy_module",
            importer: "host/src/safe.ts",
            specifier: "./continuity-authority-coordinator/worker",
            line: 1,
            detail: "legacy_authority_module:continuity-authority-coordinator/",
          },
        ],
      );
    },
  );
});

test("fails closed on unresolved relative and dynamic imports with importer, specifier, and source line", async () => {
  await withFixture(
    {
      "host/src/main.ts": 'import "./missing";\nconst later = import("./lazy");\n',
      "host/src/dialogue-web-main.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.equal(report.verdict, "blocked");
      assert.deepEqual(report.violations, [
        {
          kind: "unresolved_relative_import",
          importer: "host/src/main.ts",
          specifier: "./missing",
          line: 1,
          detail: "relative_source_not_found",
        },
        {
          kind: "unresolved_dynamic_import",
          importer: "host/src/main.ts",
          specifier: null,
          line: 2,
          detail: "dynamic_imports_are_not_statically_resolvable",
        },
      ]);
    },
  );
});

test("fails closed on non-relative static imports without traversing unsafe specifiers, while allowing node builtins", async () => {
  await withFixture(
    {
      "host/src/main.ts": [
        'export { coordinator } from "file:///outside/continuity-semantic-production-coordinator.internal.ts";',
        'import "/outside/continuity-semantic-production-coordinator.internal.ts";',
        'import "#coordinator-internal";',
        'export { value } from "host-internal-alias";',
        'import "external-package";',
        'import { readFileSync } from "node:fs";',
        "void readFileSync;",
      ].join("\n"),
      "host/src/dialogue-web-main.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.equal(report.verdict, "blocked");
      assert.deepEqual(report.inspectedFiles, ["host/src/dialogue-web-main.ts", "host/src/main.ts"]);
      assert.deepEqual(report.violations, [
        {
          kind: "unresolved_nonrelative_import",
          importer: "host/src/main.ts",
          specifier: "file:///outside/continuity-semantic-production-coordinator.internal.ts",
          line: 1,
          detail: "nonrelative_specifier_not_permitted",
        },
        {
          kind: "unresolved_nonrelative_import",
          importer: "host/src/main.ts",
          specifier: "/outside/continuity-semantic-production-coordinator.internal.ts",
          line: 2,
          detail: "nonrelative_specifier_not_permitted",
        },
        {
          kind: "unresolved_nonrelative_import",
          importer: "host/src/main.ts",
          specifier: "#coordinator-internal",
          line: 3,
          detail: "nonrelative_specifier_not_permitted",
        },
        {
          kind: "unresolved_nonrelative_import",
          importer: "host/src/main.ts",
          specifier: "host-internal-alias",
          line: 4,
          detail: "nonrelative_specifier_not_permitted",
        },
        {
          kind: "unresolved_nonrelative_import",
          importer: "host/src/main.ts",
          specifier: "external-package",
          line: 5,
          detail: "nonrelative_specifier_not_permitted",
        },
      ]);
    },
  );
});

test("blocks relative paths that escape canonical host/src before traversal, including slash variants", async () => {
  await withFixture(
    {
      "host/src/main.ts": [
        'import "../../node_modules/external/index.js";',
        'import "..\\\\..\\\\node_modules\\\\external\\\\index.js";',
      ].join("\n"),
      "host/src/dialogue-web-main.ts": "export {};\n",
      "node_modules/external/index.js": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.inspectedFiles, ["host/src/dialogue-web-main.ts", "host/src/main.ts"]);
      assert.deepEqual(report.violations, [
        {
          kind: "relative_import_escapes_host_source",
          importer: "host/src/main.ts",
          specifier: "../../node_modules/external/index.js",
          line: 1,
          detail: "relative_target_outside_host_src",
        },
        {
          kind: "relative_import_escapes_host_source",
          importer: "host/src/main.ts",
          specifier: "..\\..\\node_modules\\external\\index.js",
          line: 2,
          detail: "relative_target_outside_host_src",
        },
      ]);
    },
  );
});

test("applies the same relative and builtin policy to TypeScript import-equals require", async () => {
  await withFixture(
    {
      "host/src/main.ts": [
        'import internal = require("./continuity");',
        'import bare = require("external-package");',
        'import builtin = require("node:fs");',
        "void internal; void bare; void builtin;",
      ].join("\n"),
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/continuity.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "banned_legacy_module",
          importer: "host/src/main.ts",
          specifier: "./continuity",
          line: 1,
          detail: "legacy_authority_module:continuity.ts",
        },
        {
          kind: "unresolved_require_style_import",
          importer: "host/src/main.ts",
          specifier: "external-package",
          line: 2,
          detail: "require_style_specifier_not_permitted",
        },
      ]);
    },
  );
});

test("blocks unbound direct require literals under the static reference policy", async () => {
  await withFixture(
    {
      "host/src/main.ts":
        'require("./continuity");\nrequire("node:fs");\nrequire("external-package");\nrequire(dynamicSpecifier);\n',
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/continuity.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "banned_legacy_module",
          importer: "host/src/main.ts",
          specifier: "./continuity",
          line: 1,
          detail: "legacy_authority_module:continuity.ts",
        },
        {
          kind: "unresolved_require_style_import",
          importer: "host/src/main.ts",
          specifier: "external-package",
          line: 3,
          detail: "require_style_specifier_not_permitted",
        },
        {
          kind: "unresolved_dynamic_require",
          importer: "host/src/main.ts",
          specifier: null,
          line: 4,
          detail: "dynamic_requires_are_not_statically_resolvable",
        },
      ]);
    },
  );
});

test("blocks createRequire assignment aliases without mistaking ordinary text", async () => {
  await withFixture(
    {
      "host/src/main.ts": [
        'import { createRequire } from "node:module";',
        "const factory = createRequire;",
        "let require; require = factory(import.meta.url);",
        'require("./continuity");',
        'require("node:fs");',
        'require("external-package");',
        "require(dynamicSpecifier);",
        'const text = "require(\\\"external-package\\\")";',
        'const api = { require() {} }; api.require("external-package");',
      ].join("\n"),
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/continuity.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "banned_legacy_module",
          importer: "host/src/main.ts",
          specifier: "./continuity",
          line: 4,
          detail: "legacy_authority_module:continuity.ts",
        },
        {
          kind: "unresolved_require_style_import",
          importer: "host/src/main.ts",
          specifier: "external-package",
          line: 6,
          detail: "require_style_specifier_not_permitted",
        },
        {
          kind: "unresolved_dynamic_require",
          importer: "host/src/main.ts",
          specifier: null,
          line: 7,
          detail: "dynamic_requires_are_not_statically_resolvable",
        },
      ]);
    },
  );
});

test("blocks CommonJS module and createRequire ingress variants while allowing a module builtin", async () => {
  await withFixture(
    {
      "host/src/main.ts": [
        'module.require("./continuity");',
        'const load = require; load("./continuity");',
        'import * as Module from "node:module"; Module.createRequire(import.meta.url)("./continuity");',
        'const { createRequire: makeRequire } = require("node:module"); const factory = makeRequire; factory(import.meta.url)("./continuity");',
        'module.require("node:fs");',
        "module.require(dynamicSpecifier);",
        "class NotAnIngress { require() {} }",
      ].join("\n"),
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/continuity.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "banned_legacy_module",
          importer: "host/src/main.ts",
          specifier: "./continuity",
          line: 1,
          detail: "legacy_authority_module:continuity.ts",
        },
        {
          kind: "banned_legacy_module",
          importer: "host/src/main.ts",
          specifier: "./continuity",
          line: 2,
          detail: "legacy_authority_module:continuity.ts",
        },
        {
          kind: "banned_legacy_module",
          importer: "host/src/main.ts",
          specifier: "./continuity",
          line: 3,
          detail: "legacy_authority_module:continuity.ts",
        },
        {
          kind: "banned_legacy_module",
          importer: "host/src/main.ts",
          specifier: "./continuity",
          line: 4,
          detail: "legacy_authority_module:continuity.ts",
        },
        {
          kind: "unresolved_dynamic_require",
          importer: "host/src/main.ts",
          specifier: null,
          line: 6,
          detail: "dynamic_requires_are_not_statically_resolvable",
        },
      ]);
    },
  );
});

test("blocks module.require aliases in direct CommonJS sources while allowing builtins", async () => {
  await withFixture(
    {
      "host/src/main.ts": [
        'const load = module.require; load("./continuity");',
        'const Module = module; Module.require("./continuity");',
        'const { require: destructuredLoad } = module; destructuredLoad("./continuity");',
        'const builtinLoad = module.require; builtinLoad("node:fs");',
        "const dynamicLoad = module.require; dynamicLoad(dynamicSpecifier);",
        'const text = "const load = module.require; load(\\\"./continuity\\\")";',
        'const api = { require() {} }; api.require("./continuity");',
      ].join("\n"),
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/continuity.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "banned_legacy_module",
          importer: "host/src/main.ts",
          specifier: "./continuity",
          line: 1,
          detail: "legacy_authority_module:continuity.ts",
        },
        {
          kind: "banned_legacy_module",
          importer: "host/src/main.ts",
          specifier: "./continuity",
          line: 2,
          detail: "legacy_authority_module:continuity.ts",
        },
        {
          kind: "banned_legacy_module",
          importer: "host/src/main.ts",
          specifier: "./continuity",
          line: 3,
          detail: "legacy_authority_module:continuity.ts",
        },
        {
          kind: "unresolved_dynamic_require",
          importer: "host/src/main.ts",
          specifier: null,
          line: 5,
          detail: "dynamic_requires_are_not_statically_resolvable",
        },
      ]);
    },
  );
});

test("blocks module namespace createRequire aliases from ESM and CommonJS ingress", async () => {
  await withFixture(
    {
      "host/src/main.ts": [
        'import * as Module from "node:module";',
        "const { createRequire: factory } = Module;",
        'factory(import.meta.url)("./continuity");',
        'const CommonJsModule = require("node:module");',
        'CommonJsModule.createRequire(import.meta.url)("./continuity");',
        'CommonJsModule.createRequire(import.meta.url)("node:fs");',
        'const text = "CommonJsModule.createRequire(import.meta.url)(\\\"./continuity\\\")";',
        'const api = { createRequire() {} }; api.createRequire(import.meta.url)("./continuity");',
      ].join("\n"),
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/continuity.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "banned_legacy_module",
          importer: "host/src/main.ts",
          specifier: "./continuity",
          line: 3,
          detail: "legacy_authority_module:continuity.ts",
        },
        {
          kind: "banned_legacy_module",
          importer: "host/src/main.ts",
          specifier: "./continuity",
          line: 5,
          detail: "legacy_authority_module:continuity.ts",
        },
      ]);
    },
  );
});

test("blocks default node:module createRequire imports while allowing node builtins", async () => {
  await withFixture(
    {
      "host/src/main.ts": [
        'import Module from "node:module";',
        'Module.createRequire(import.meta.url)("./continuity");',
        'Module.createRequire(import.meta.url)("node:fs");',
      ].join("\n"),
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/continuity.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "banned_legacy_module",
          importer: "host/src/main.ts",
          specifier: "./continuity",
          line: 2,
          detail: "legacy_authority_module:continuity.ts",
        },
      ]);
    },
  );
});

test("traverses default node:module createRequire imports in transitive sources", async () => {
  await withFixture(
    {
      "host/src/main.ts": 'import "./relay";\n',
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/relay.ts": [
        'import Module from "node:module";',
        'Module.createRequire(import.meta.url)("./nested");',
      ].join("\n"),
      "host/src/nested.ts": 'import "./continuity";\n',
      "host/src/continuity.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "banned_legacy_module",
          importer: "host/src/nested.ts",
          specifier: "./continuity",
          line: 1,
          detail: "legacy_authority_module:continuity.ts",
        },
      ]);
      assert.deepEqual(report.inspectedFiles, [
        "host/src/continuity.ts",
        "host/src/dialogue-web-main.ts",
        "host/src/main.ts",
        "host/src/nested.ts",
        "host/src/relay.ts",
      ]);
    },
  );
});

test("traverses factory-produced CommonJS relative imports in transitive sources", async () => {
  await withFixture(
    {
      "host/src/main.ts": 'require("./relay");\n',
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/relay.ts": [
        'const Module = require("node:module");',
        "const { createRequire: factory } = Module;",
        'factory(import.meta.url)("./nested");',
      ].join("\n"),
      "host/src/nested.ts": 'import "./continuity";\n',
      "host/src/continuity.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "banned_legacy_module",
          importer: "host/src/nested.ts",
          specifier: "./continuity",
          line: 1,
          detail: "legacy_authority_module:continuity.ts",
        },
      ]);
      assert.deepEqual(report.inspectedFiles, [
        "host/src/continuity.ts",
        "host/src/dialogue-web-main.ts",
        "host/src/main.ts",
        "host/src/nested.ts",
        "host/src/relay.ts",
      ]);
    },
  );
});

test("blocks module.require aliases in transitive CommonJS sources", async () => {
  await withFixture(
    {
      "host/src/main.ts": 'require("./relay");\n',
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/relay.ts": [
        "const Module = module;",
        "const { require: load } = Module;",
        'load("./continuity");',
      ].join("\n"),
      "host/src/continuity.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "banned_legacy_module",
          importer: "host/src/relay.ts",
          specifier: "./continuity",
          line: 3,
          detail: "legacy_authority_module:continuity.ts",
        },
      ]);
      assert.deepEqual(report.inspectedFiles, [
        "host/src/continuity.ts",
        "host/src/dialogue-web-main.ts",
        "host/src/main.ts",
        "host/src/relay.ts",
      ]);
    },
  );
});

test("does not mistake member calls or class/object methods named import for dynamic imports", async () => {
  await withFixture(
    {
      "host/src/main.ts": [
        "const imports = { import() {} };",
        'imports.import("./not-a-module");',
        "class Loader { import() {} }",
        "new Loader().import();",
        "export {};",
      ].join("\n"),
      "host/src/dialogue-web-main.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.equal(report.verdict, "passed");
      assert.deepEqual(report.violations, []);
    },
  );
});

test("does not mistake the st-card async import method declaration for a dynamic import", async () => {
  await withFixture(
    {
      "host/src/main.ts": [
        "export class StCardImportService {",
        "  async import(importId: string, input: string | Uint8Array): Promise<PersistedStCardImport> {",
        "    return { importId } as PersistedStCardImport;",
        "  }",
        "}",
        "class GenericLoader {",
        "  protected async import<T extends string>(id: T): Promise<T> { return id; }",
        "}",
      ].join("\n"),
      "host/src/dialogue-web-main.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.equal(report.verdict, "passed");
      assert.deepEqual(report.violations, []);
    },
  );
});

test("fails closed on dynamic imports within template interpolation expressions", async () => {
  await withFixture(
    {
      "host/src/main.ts": 'const request = `load ${import("./lazy")}`;\nexport {};\n',
      "host/src/dialogue-web-main.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "unresolved_dynamic_import",
          importer: "host/src/main.ts",
          specifier: null,
          line: 1,
          detail: "dynamic_imports_are_not_statically_resolvable",
        },
      ]);
    },
  );
});

test("detects explicit legacy adoption functions only in the transitive production closure", async () => {
  await withFixture(
    {
      "host/src/main.ts": 'import { run } from "./reachable"; run();\n',
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/reachable.ts": "export const run = () => adoptLegacyPartition();\n",
      "host/src/unused.ts": "adoptLegacyPartition();\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "banned_legacy_adoption_function",
          importer: "host/src/reachable.ts",
          specifier: "adoptLegacyPartition",
          line: 1,
          detail: "legacy_adoption_function",
        },
      ]);
    },
  );
});

test("does not mistake comments, ordinary strings, or unrooted tests for imports or legacy authority", async () => {
  await withFixture(
    {
      "host/src/main.ts":
        '// import "./continuity"; adoptLegacyPartition()\nconst text = "import(\\\"./missing\\\") game-surface-lease";\nexport {};\n',
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/ignored.test.ts": 'import "./continuity"; adoptLegacyPartition();\n',
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.equal(report.verdict, "passed");
      assert.deepEqual(report.violations, []);
      assert.deepEqual(report.inspectedFiles, ["host/src/dialogue-web-main.ts", "host/src/main.ts"]);
    },
  );
});

test("rejects supplied roots outside canonical host/src without traversal", async () => {
  await withFixture(
    {
      "host/src/main.ts": "export {};\n",
      "host/src/dialogue-web-main.ts": "export {};\n",
      "outside.ts": 'import "./host/src/continuity";\n',
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots: ["outside.ts"] });
      assert.deepEqual(report.inspectedFiles, []);
      assert.deepEqual(report.violations, [
        { kind: "invalid_root", importer: "outside.ts", specifier: null, line: 1, detail: "root_outside_host_src" },
      ]);
    },
  );
});

test("rejects supplied symlink roots resolving outside canonical host/src", async (t) => {
  const root = await fixture({ "host/src/main.ts": "export {};\n", "outside.ts": "export {};\n" });
  try {
    try {
      await symlink(join(root, "outside.ts"), join(root, "host/src/linked.ts"));
    } catch (error) {
      t.skip(`symlinks unavailable: ${error.code}`);
      return;
    }
    const report = checkHostProductionImportBoundary({ root, roots: ["host/src/linked.ts"] });
    assert.deepEqual(report.inspectedFiles, []);
    assert.deepEqual(report.violations, [
      {
        kind: "invalid_root",
        importer: "host/src/linked.ts",
        specifier: null,
        line: 1,
        detail: "root_outside_host_src",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows semantic provisioning and store imports only from the production coordinator", async () => {
  await withFixture(
    {
      "host/src/main.ts": 'import "./continuity-semantic-production-coordinator/entry";\n',
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/continuity-semantic-production-coordinator/entry.ts": [
        'import "../continuity-semantic-provisioning/continuity-semantic-provisioning";',
        'import "../continuity-semantic-store/continuity-semantic-store";',
      ].join("\n"),
      "host/src/continuity-semantic-provisioning/continuity-semantic-provisioning.ts": "export {};\n",
      "host/src/continuity-semantic-store/continuity-semantic-store.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.equal(report.verdict, "passed");
      assert.deepEqual(report.violations, []);
    },
  );
});

test("allows only the public coordinator to import its shared internal implementation", async () => {
  await withFixture(
    {
      "host/src/main.ts":
        'import "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator";\n',
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.ts":
        'import "./continuity-semantic-production-coordinator.internal";\n',
      "host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts":
        "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.equal(report.verdict, "passed");
    },
  );
});

test("blocks production closure imports of test-only coordinator support and direct internal imports", async () => {
  await withFixture(
    {
      "host/src/main.ts": 'import "./consumer";\n',
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/consumer.ts": [
        'import "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.test-support";',
        'import "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal";',
      ].join("\n"),
      "host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.test-support.ts":
        "export {};\n",
      "host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts":
        "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "production_reaches_test_only_module",
          importer: "host/src/consumer.ts",
          specifier:
            "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.test-support",
          line: 1,
          detail: "test_only_module_in_production_closure",
        },
        {
          kind: "unauthorized_coordinator_internal_import",
          importer: "host/src/consumer.ts",
          specifier: "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal",
          line: 2,
          detail:
            "coordinator_internal_import_requires:continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.ts",
        },
      ]);
    },
  );
});

test("allows the designated provisioner to import the production-store internal module", async () => {
  await withFixture(
    {
      "host/src/main.ts": 'import "./continuity-semantic-production-coordinator/entry";\n',
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/continuity-semantic-production-coordinator/entry.ts":
        'import "../continuity-semantic-provisioning/continuity-semantic-provisioning";\n',
      "host/src/continuity-semantic-provisioning/continuity-semantic-provisioning.ts":
        'import "../continuity-semantic-store/continuity-semantic-store.production-internal.js";\n',
      "host/src/continuity-semantic-store/continuity-semantic-store.production-internal.ts": "export {};\n",
      "host/src/continuity-semantic-store/continuity-semantic-store.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.equal(report.verdict, "passed");
      assert.deepEqual(report.violations, []);
    },
  );
});

test("blocks non-provisioner imports of the raw production-store internal module", async () => {
  await withFixture(
    {
      "host/src/main.ts": 'import "./continuity-semantic-production-coordinator/entry";\n',
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/continuity-semantic-production-coordinator/entry.ts": 'import "../consumer";\n',
      "host/src/consumer.ts":
        'import "./continuity-semantic-store/continuity-semantic-store.production-internal.js";\n',
      "host/src/continuity-semantic-store/continuity-semantic-store.production-internal.ts": "export {};\n",
      "host/src/continuity-semantic-store/continuity-semantic-store.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "unauthorized_production_store_internal_import",
          importer: "host/src/consumer.ts",
          specifier: "./continuity-semantic-store/continuity-semantic-store.production-internal.js",
          line: 1,
          detail:
            "production_store_internal_import_requires:continuity-semantic-provisioning/continuity-semantic-provisioning.ts",
        },
        {
          kind: "unauthorized_semantic_authority_import",
          importer: "host/src/consumer.ts",
          specifier: "./continuity-semantic-store/continuity-semantic-store.production-internal.js",
          line: 1,
          detail: "semantic_authority_import_requires:continuity-semantic-production-coordinator/",
        },
      ]);
    },
  );
});

test("blocks non-coordinator semantic authority imports, the semantic backend, and legacy backend mint identifiers", async () => {
  await withFixture(
    {
      "host/src/main.ts": [
        'import "./consumer";',
        'import "./continuity-semantic-backend/continuity-semantic-backend";',
      ].join("\n"),
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/consumer.ts": [
        'import "./continuity-semantic-provisioning/continuity-semantic-provisioning";',
        'export { value } from "./continuity-semantic-store/continuity-semantic-store";',
        "const created = createSemanticProductionBackend();",
        "type Legacy = SemanticProductionBackend;",
        "type Operations = SemanticProductionBackendOperations;",
        "// createSemanticProductionBackend SemanticProductionBackend SemanticProductionBackendOperations",
        'const text = "createSemanticProductionBackend SemanticProductionBackend SemanticProductionBackendOperations";',
      ].join("\n"),
      "host/src/continuity-semantic-provisioning/continuity-semantic-provisioning.ts": "export {};\n",
      "host/src/continuity-semantic-store/continuity-semantic-store.ts": "export const value = 1;\n",
      "host/src/continuity-semantic-backend/continuity-semantic-backend.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "unauthorized_semantic_authority_import",
          importer: "host/src/consumer.ts",
          specifier: "./continuity-semantic-provisioning/continuity-semantic-provisioning",
          line: 1,
          detail: "semantic_authority_import_requires:continuity-semantic-production-coordinator/",
        },
        {
          kind: "unauthorized_semantic_authority_import",
          importer: "host/src/consumer.ts",
          specifier: "./continuity-semantic-store/continuity-semantic-store",
          line: 2,
          detail: "semantic_authority_import_requires:continuity-semantic-production-coordinator/",
        },
        {
          kind: "banned_legacy_backend_mint_identifier",
          importer: "host/src/consumer.ts",
          specifier: "createSemanticProductionBackend",
          line: 3,
          detail: "legacy_backend_mint_identifier",
        },
        {
          kind: "banned_legacy_backend_mint_identifier",
          importer: "host/src/consumer.ts",
          specifier: "SemanticProductionBackend",
          line: 4,
          detail: "legacy_backend_mint_identifier",
        },
        {
          kind: "banned_legacy_backend_mint_identifier",
          importer: "host/src/consumer.ts",
          specifier: "SemanticProductionBackendOperations",
          line: 5,
          detail: "legacy_backend_mint_identifier",
        },
        {
          kind: "banned_semantic_backend_module",
          importer: "host/src/main.ts",
          specifier: "./continuity-semantic-backend/continuity-semantic-backend",
          line: 2,
          detail: "semantic_authority_module:continuity-semantic-backend/",
        },
      ]);
    },
  );
});
