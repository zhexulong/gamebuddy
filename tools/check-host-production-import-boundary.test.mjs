import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkHostProductionImportBoundary,
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

test("requires a clean report without an expected blocked baseline", () => {
  assert.deepEqual(validateHostProductionImportBoundaryBaseline({ verdict: "passed", violations: [] }), {
    accepted: true,
    mode: "clean",
  });
  assert.deepEqual(validateHostProductionImportBoundaryBaseline({ verdict: "blocked", violations: [] }), {
    accepted: false,
    reason: "production_import_boundary_violations",
  });
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

test("allows declared external package roots and slash subpaths without accepting lookalike prefixes", async () => {
  await withFixture(
    {
      "host/production-artifact.config.json": JSON.stringify({ externalRuntimeClosure: { packages: ["typebox", "@scope/declared"], dynamicExternalImports: [] } }),
      "host/src/main.ts": ['import "typebox/compile";', 'import "typebox/format";', 'import "typebox-untrusted/compile";', 'import "typeboxx/compile";', 'import "@scope/sibling";'].join("\n"),
      "host/src/dialogue-web-main.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations.map(({ specifier }) => specifier), ["typebox-untrusted/compile", "typeboxx/compile", "@scope/sibling"]);
    },
  );
});

test("allows only declared external packages and exact declared Magic Context dynamic imports", async () => {
  await withFixture(
    {
      "host/production-artifact.config.json": JSON.stringify({
        externalRuntimeClosure: {
          packages: ["@cortexkit/pi-magic-context", "declared-package"],
          dynamicExternalImports: [
            {
              package: "@cortexkit/pi-magic-context",
              module: "main.js",
              expression: "pathToFileURL(magicContextEntry).href",
              occurrence: 0,
            },
          ],
        },
      }),
      "host/src/main.ts": [
        'import "declared-package";',
        "const bridge = await import(pathToFileURL(magicContextEntry).href);",
        "void bridge;",
      ].join("\n"),
      "host/src/dialogue-web-main.ts": "export {};\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.equal(report.verdict, "passed");
    },
  );
});

test("fails closed on unresolved relative and arbitrary dynamic imports with importer, specifier, and source line", async () => {
  await withFixture(
    {
      "host/src/main.ts": 'import "./missing";\nconst later = import(arbitrarySpecifier);\n',
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
        'Module["createRequire"](import.meta.url)("./continuity");',
        'const computedFactory = Module["createRequire"](import.meta.url); computedFactory("./continuity");',
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
        {
          kind: "banned_legacy_module",
          importer: "host/src/main.ts",
          specifier: "./continuity",
          line: 6,
          detail: "legacy_authority_module:continuity.ts",
        },
        {
          kind: "banned_legacy_module",
          importer: "host/src/main.ts",
          specifier: "./continuity",
          line: 7,
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

test("ignores erased import type authority contracts but rejects runtime authority imports", async () => {
  await withFixture(
    {
      "host/src/main.ts": 'import "./consumer";\n',
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/consumer.ts": [
        'import type { SemanticStore } from "./continuity-semantic-store/continuity-semantic-production-store";',
        'import { semanticStore } from "./continuity-semantic-store/continuity-semantic-production-store";',
        'import SemanticStoreDefault from "./continuity-semantic-store/continuity-semantic-production-store";',
        'import * as SemanticStoreNamespace from "./continuity-semantic-store/continuity-semantic-production-store";',
        "void semanticStore; void SemanticStoreDefault; void SemanticStoreNamespace;",
      ].join("\n"),
      "host/src/continuity-semantic-store/continuity-semantic-production-store.ts": "export const semanticStore = 1;\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(
        report.violations.map(({ kind, importer, specifier, line }) => ({ kind, importer, specifier, line })),
        [
          {
            kind: "unauthorized_semantic_authority_import",
            importer: "host/src/consumer.ts",
            specifier: "./continuity-semantic-store/continuity-semantic-production-store",
            line: 2,
          },
          {
            kind: "unauthorized_semantic_authority_import",
            importer: "host/src/consumer.ts",
            specifier: "./continuity-semantic-store/continuity-semantic-production-store",
            line: 3,
          },
          {
            kind: "unauthorized_semantic_authority_import",
            importer: "host/src/consumer.ts",
            specifier: "./continuity-semantic-store/continuity-semantic-production-store",
            line: 4,
          },
        ],
      );
    },
  );
});

test("excludes erased TypeScript type references while retaining mixed runtime authority edges", async () => {
  const authority = "host/src/continuity-semantic-store/continuity-semantic-production-store.ts";
  const erasedOnly = {
    "host/src/main.ts": 'import "./consumer";\n',
    "host/src/dialogue-web-main.ts": "export {};\n",
    "host/src/consumer.ts": [
      'type Direct = import("./continuity-semantic-store/continuity-semantic-production-store").SemanticStore;',
      'type Query = typeof import("./continuity-semantic-store/continuity-semantic-production-store");',
      'import { type SemanticStore } from "./continuity-semantic-store/continuity-semantic-production-store";',
      'export { type SemanticStore } from "./continuity-semantic-store/continuity-semantic-production-store";',
      "export type { Direct, Query, SemanticStore };",
    ].join("\n"),
    [authority]: "export const semanticStore = 1; export type SemanticStore = typeof semanticStore;\n",
  };
  await withFixture(erasedOnly, (root) => {
    const report = checkHostProductionImportBoundary({ root, roots });
    assert.equal(report.verdict, "passed", JSON.stringify(report.violations));
    assert.deepEqual(report.inspectedFiles, ["host/src/consumer.ts", "host/src/dialogue-web-main.ts", "host/src/main.ts"]);
  });
  await withFixture(
    {
      ...erasedOnly,
      "host/src/consumer.ts": [
        'import { type SemanticStore, semanticStore } from "./continuity-semantic-store/continuity-semantic-production-store";',
        'export { type SemanticStore, semanticStore } from "./continuity-semantic-store/continuity-semantic-production-store";',
        "void semanticStore;",
      ].join("\n"),
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(
        report.violations.map(({ kind, importer, specifier, line }) => ({ kind, importer, specifier, line })),
        [
          { kind: "unauthorized_semantic_authority_import", importer: "host/src/consumer.ts", specifier: "./continuity-semantic-store/continuity-semantic-production-store", line: 1 },
          { kind: "unauthorized_semantic_authority_import", importer: "host/src/consumer.ts", specifier: "./continuity-semantic-store/continuity-semantic-production-store", line: 2 },
        ],
      );
    },
  );
});

test("treats runtime dynamic-import member access as an ingress, not an erased type query", async () => {
  await withFixture(
    {
      "host/src/main.ts": 'import "./consumer";\n',
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/consumer.ts": 'import("./tavern/chat-thread-store").then(({ acceptP4MountedPlayerMessage }) => void acceptP4MountedPlayerMessage);\n',
      "host/src/tavern/chat-thread-store.ts": "export const acceptP4MountedPlayerMessage = 1;\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "unresolved_dynamic_import",
          importer: "host/src/consumer.ts",
          specifier: null,
          line: 1,
          detail: "dynamic_imports_are_not_statically_resolvable",
        },
      ]);
    },
  );
});

test("recognizes all current erased import-type forms but never erases executable member access", async () => {
  await withFixture(
    {
      "host/src/main.ts": [
        'type A = import("./legacy").Thing;',
        'type B = typeof import("./legacy");',
        'type C = { field: import("./legacy").Thing };',
        'type D = () => Promise<import("./legacy").Thing>;',
        'const value: import("./legacy").Thing | null = null;',
        'void import("./legacy").then(() => undefined);',
      ].join("\n"),
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/legacy.ts": "export type Thing = string;\n",
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.deepEqual(report.violations, [
        {
          kind: "unresolved_dynamic_import",
          importer: "host/src/main.ts",
          specifier: null,
          line: 6,
          detail: "dynamic_imports_are_not_statically_resolvable",
        },
      ]);
    },
  );
});

test("does not mistake private methods named require for CommonJS ingress, but follows private require bindings", async () => {
  await withFixture(
    {
      "host/src/main.ts": [
        "class Ledger {",
        "  mark() { return this.#require({ requestId: 'safe' }); }",
        "  #require(dispatch) { return dispatch; }",
        "}",
        "class CommonJsHolder {",
        "  #load = require;",
        "  load() { return this.#load('./continuity'); }",
        "}",
        "void Ledger; void CommonJsHolder;",
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
          line: 7,
          detail: "legacy_authority_module:continuity.ts",
        },
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

test("allows semantic provisioning and store imports only from coordinator internal construction", async () => {
  await withFixture(
    {
      "host/src/main.ts":
        'import "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator";\n',
      "host/src/dialogue-web-main.ts": "export {};\n",
      "host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.ts":
        'import "./continuity-semantic-production-coordinator.internal";\n',
      "host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts":
        'import "../continuity-semantic-provisioning/continuity-semantic-provisioning";\n',
      "host/src/continuity-semantic-provisioning/continuity-semantic-provisioning.ts":
        'import "../continuity-semantic-store/continuity-semantic-production-store";\n',
      "host/src/continuity-semantic-store/continuity-semantic-production-store.ts": "export {};\n",
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

test("enforces P4a, P4b, and P4c exclusive facade → bridge → coordinator/store composition topology", async () => {
  const p4Facade = "host/src/tavern/p4-durable-turn-acceptance.ts";
  const p4Bridge = "host/src/tavern/p4-durable-turn-acceptance.internal.ts";
  const p4bFacade = "host/src/tavern/p4-provider-attempt.ts";
  const p4bBridge = "host/src/tavern/p4-provider-attempt.internal.ts";
  const p4cFacade = "host/src/tavern/p4-provider-start.ts";
  const p4cBridge = "host/src/tavern/p4-provider-start.internal.ts";
  const p5Facade = "host/src/tavern/p5-presentation-commit.ts";
  const p5Bridge = "host/src/tavern/p5-presentation-commit.internal.ts";
  const transitionAuthority = "host/src/tavern/chat-thread-store.p4-p5-transition-authority.internal.ts";
  const coordinator = "host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts";
  const store = "host/src/tavern/chat-thread-store.ts";
  const intended = {
    "host/src/main.ts": "export {};\n",
    "host/src/dialogue-web-main.ts": "export {};\n",
    [p4Facade]: 'import "./p4-durable-turn-acceptance.internal";\n',
    [p4Bridge]: [
      'import type { HostDeploymentManifest } from "../deployment-manifest.js";',
      'import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";',
      'import { acceptMountedP4DurableTurn, consumeMountedP4Admission } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";',
      'import { acceptP4MountedPlayerMessage, type AcceptedQueuedTurn } from "./chat-thread-store.js";',
      'type P4MountedAcceptanceCommand = Readonly<{ text: string; locale: string; idempotencyKey: string; expectedDraftRevision: number }>;',
      'export async function acceptMountedP4DurableTurnFromFacade(manifest: HostDeploymentManifest, lease: MountedChatRuntimeLease, command: P4MountedAcceptanceCommand): Promise<AcceptedQueuedTurn> {',
      '  return acceptMountedP4DurableTurn(manifest, lease, admission => consumeMountedP4Admission(admission, binding => acceptP4MountedPlayerMessage(binding, command)));',
      '}',
    ].join("\n"),
    [p4bFacade]: 'import "./p4-provider-attempt.internal";\n',
    [p4bBridge]: [
      'import type { HostDeploymentManifest } from "../deployment-manifest.js";',
      'import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";',
      'import { claimMountedP4Attempt, consumeMountedP4AttemptAdmission } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";',
      'import { claimP4MountedAttempt, type AttemptStartingTurn } from "./chat-thread-store.js";',
      'export async function claimMountedP4ProviderAttemptFromFacade(manifest: HostDeploymentManifest, lease: MountedChatRuntimeLease): Promise<AttemptStartingTurn> {',
      '  return claimMountedP4Attempt(manifest, lease, admission => consumeMountedP4AttemptAdmission(admission, binding => claimP4MountedAttempt(binding)));',
      '}',
    ].join("\n"),
    [p4cFacade]: 'import "./p4-provider-start.internal";\n',
    [p5Facade]: 'import "./p5-presentation-commit.internal";\n',
    [p5Bridge]: [
      'import type { HostDeploymentManifest } from "../deployment-manifest.js";',
      'import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";',
      'import { createP4ProviderStartFacade } from "./p4-provider-start.js";',
      'export async function startMountedP5PresentationCommitFromFacade(manifest: HostDeploymentManifest, lease: MountedChatRuntimeLease) {',
      '  return createP4ProviderStartFacade(manifest, lease).start();',
      '}',
    ].join("\n"),
    [transitionAuthority]: "export const transitionAuthority = 1;\n",
    [p4cBridge]: [
      'import type { HostDeploymentManifest } from "../deployment-manifest.js";',
      'import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";',
      'import { startMountedP4Attempt, consumeMountedP4AttemptInvocationAdmission } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";',
      'import { runMountedP4ProviderStartLedger } from "./p4-provider-start-execution.js";',
      'export async function startMountedP4ProviderStartFromFacade(manifest: HostDeploymentManifest, lease: MountedChatRuntimeLease) {',
      '  return startMountedP4Attempt(manifest, lease, invocation => consumeMountedP4AttemptInvocationAdmission(invocation, scope => runMountedP4ProviderStartLedger(scope)));',
      '} ',
    ].join("\n"),
    "host/src/tavern/p4-provider-start-execution.ts": "export async function runMountedP4ProviderStartLedger(scope: unknown) { return scope; }\n",
    [coordinator]: "export const acceptMountedP4DurableTurn = 1; export const consumeMountedP4Admission = 2; export const claimMountedP4Attempt = 3; export const consumeMountedP4AttemptAdmission = 4; export const startMountedP4Attempt = 5; export const consumeMountedP4AttemptInvocationAdmission = 6;\n",
    [store]: "export const acceptP4MountedPlayerMessage = 3; export const claimP4MountedAttempt = 4;\n",
  };
  await withFixture(intended, (root) => {
    const report = checkHostProductionImportBoundary({ root, roots });
    assert.equal(report.verdict, "passed", JSON.stringify(report.violations));
    assert.deepEqual(report.inspectedFiles, [
      coordinator,
      "host/src/dialogue-web-main.ts",
      "host/src/main.ts",
      store,
      p4Bridge,
      p4Facade,
      p4bBridge,
      p4bFacade,
      "host/src/tavern/p4-provider-start-execution.ts",
      p4cBridge,
      p4cFacade,
      p5Bridge,
      p5Facade,
    ]);
  });
  for (const [name, consumerSource, expectedKind] of [
    ["bridge", 'import "./tavern/p4-durable-turn-acceptance.internal";\n', "unauthorized_p4_bridge_import"],
    ["attempt-bridge", 'import "./tavern/p4-provider-attempt.internal";\n', "unauthorized_p4_bridge_import"],
    ["coordinator", 'import "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal";\n', "unauthorized_coordinator_internal_import"],
    ["store", 'import { acceptP4MountedPlayerMessage } from "./tavern/chat-thread-store";\n', "unauthorized_p4_store_ingress_import"],
    ["attempt-store", 'import { claimP4MountedAttempt } from "./tavern/chat-thread-store";\n', "unauthorized_p4_store_ingress_import"],
    ["transition-authority", 'import "./tavern/chat-thread-store.p4-p5-transition-authority.internal";\n', "unauthorized_p4_p5_transition_authority_import"],
    ["string-named-store", 'import { "acceptP4MountedPlayerMessage" as raw } from "./tavern/chat-thread-store";\nvoid raw;\n', "unauthorized_p4_store_ingress_import"],
  ]) {
    await withFixture({ ...intended, "host/src/main.ts": consumerSource }, (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.ok(report.violations.some((item) => item.kind === expectedKind), name);
    });
  }
  for (const [name, consumerSource] of [
    [
      "computed-create-require-store",
      [
        'import * as Module from "node:module";',
        'const load = Module["createRequire"](import.meta.url);',
        'const { acceptP4MountedPlayerMessage: raw } = load("./tavern/chat-thread-store.js");',
        "void raw;",
      ].join("\\n"),
    ],
    [
      "computed-module-require-store",
      [
        'const load = module["require"];',
        'const { acceptP4MountedPlayerMessage: raw } = load("./tavern/chat-thread-store.js");',
        "void raw;",
      ].join("\\n"),
    ],
  ]) {
    await withFixture({ ...intended, "host/src/main.ts": consumerSource }, (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.ok(
        report.violations.some((item) => item.kind === "unauthorized_p4_store_ingress_import"),
        name,
      );
    });
  }
  for (const [name, facadeSource, expectedKind] of [
    ["coordinator", 'import "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal";\n', "unauthorized_coordinator_internal_import"],
    ["store", 'import { acceptP4MountedPlayerMessage } from "./chat-thread-store";\n', "unauthorized_p4_store_ingress_import"],
    [
      "computed-object-descriptor-loader",
      [
        'const descriptor = Object[("getOwn" + "PropertyDescriptor") as "getOwnPropertyDescriptor"](process, "getBuiltinModule");',
        'const builtin = descriptor!.value as typeof process.getBuiltinModule;',
        'const raw = builtin("node:module")[("create" + "Require") as "createRequire"](import.meta.url)("./chat-thread-store.js");',
        "void raw;",
      ].join("\\n"),
      "unresolved_dynamic_require",
    ],
    [
      "parenthesized-process-descriptor-loader",
      [
        "const processRef = (process);",
        'const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule")!.value as any;',
        'const raw = builtin("node:module").createRequire(import.meta.url)("./chat-thread-store.js").acceptP4MountedPlayerMessage;',
        "void raw;",
      ].join("\\n"),
      "unresolved_dynamic_require",
    ],
    [
      "erased-wrapper-process-descriptor-loader",
      [
        "const processRef = ((process as typeof process) satisfies typeof process)!;",
        'const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule")!.value as any;',
        'const raw = builtin("node:module").createRequire(import.meta.url)("./chat-thread-store.js").acceptP4MountedPlayerMessage;',
        "void raw;",
      ].join("\\n"),
      "unresolved_dynamic_require",
    ],
    [
      "computed-global-process-loader",
      [
        'const builtin = globalThis.process[("getBuiltin" + "Module") as keyof typeof globalThis.process] as any;',
        'const raw = builtin("node:module").createRequire(import.meta.url)("./chat-thread-store.js");',
        "void raw;",
      ].join("\\n"),
      "unresolved_dynamic_require",
    ],
    [
      "computed-global-process-acquisition-loader",
      [
        'const processRef = globalThis[("pro" + "cess") as "process"];',
        'const descriptor = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule");',
        'const raw = (descriptor!.value as any)("node:module").createRequire(import.meta.url)("./chat-thread-store.js");',
        "void raw;",
      ].join("\\n"),
      "unresolved_dynamic_require",
    ],
    [
      "static-global-process-alias-loader",
      [
        'const processRef = globalThis["process"];',
        'const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule")!.value as any;',
        'const raw = builtin("node:module").createRequire(import.meta.url)("./chat-thread-store.js").acceptP4MountedPlayerMessage;',
        "void raw;",
      ].join("\\n"),
      "unresolved_dynamic_require",
    ],
    [
      "nested-global-process-alias-loader",
      [
        "const processRef = globalThis.global.process;",
        'const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule")!.value as any;',
        'const raw = builtin("node:module").createRequire(import.meta.url)("./chat-thread-store.js").acceptP4MountedPlayerMessage;',
        "void raw;",
      ].join("\\n"),
      "unresolved_dynamic_require",
    ],
    [
      "parenthesized-nested-global-process-alias-loader",
      [
        "const processRef = (globalThis).global.process;",
        'const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule")!.value as any;',
        'const raw = builtin("node:module").createRequire(import.meta.url)("./chat-thread-store.js").acceptP4MountedPlayerMessage;',
        "void raw;",
      ].join("\\n"),
      "unresolved_dynamic_require",
    ],
    [
      "erased-wrapper-nested-global-process-alias-loader",
      [
        "const processRef = ((globalThis as typeof globalThis) satisfies typeof globalThis)!.global.process;",
        'const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule")!.value as any;',
        'const raw = builtin("node:module").createRequire(import.meta.url)("./chat-thread-store.js").acceptP4MountedPlayerMessage;',
        "void raw;",
      ].join("\\n"),
      "unresolved_dynamic_require",
    ],
  ]) {
    await withFixture({ ...intended, [p4Facade]: facadeSource }, (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.ok(report.violations.some((item) => item.kind === expectedKind), name);
    });
  }
  for (const p5BridgeSource of [
    'import { createP4ProviderStartFacade } from "./p4-provider-start.js"; export async function startMountedP5PresentationCommitFromFacade(manifest, lease) { return createP4ProviderStartFacade(manifest, lease).start(); } export const leaked = createP4ProviderStartFacade;\n',
    'import { startMountedP4ProviderStartFromFacade } from "./p4-provider-start.internal.js"; export async function startMountedP5PresentationCommitFromFacade(manifest, lease) { return startMountedP4ProviderStartFromFacade(manifest, lease); }\n',
  ]) {
    await withFixture({ ...intended, [p5Bridge]: p5BridgeSource }, (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.ok(report.violations.some((item) => item.kind === "invalid_p5_bridge_implementation"));
    });
  }
  for (const bridgeSource of [
    'export { acceptMountedP4DurableTurn } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal";\n',
    'import { acceptP4MountedPlayerMessage as leak } from "./chat-thread-store"; export { leak };\n',
    'import { acceptP4MountedPlayerMessage as leak } from "./chat-thread-store"; export { leak as renamed };\n',
    'import { acceptP4MountedPlayerMessage as leak } from "./chat-thread-store"; export default leak;\n',
    'import * as leak from "./chat-thread-store"; export { leak };\n',
    'import leak from "./chat-thread-store"; export { leak };\n',
    'import { acceptP4MountedPlayerMessage as raw } from "./chat-thread-store"; const second = raw; export { second as acceptMountedP4DurableTurnFromFacade };\n',
    'import { acceptP4MountedPlayerMessage as raw } from "./chat-thread-store"; const second = raw; const third = second; export { third as acceptMountedP4DurableTurnFromFacade };\n',
    'import { acceptP4MountedPlayerMessage as raw } from "./chat-thread-store"; const second = raw; const third = second; export default third;\n',
    'import { acceptP4MountedPlayerMessage as raw } from "./chat-thread-store"; const second = raw, third = second; export { third as acceptMountedP4DurableTurnFromFacade };\n',
    'import { acceptP4MountedPlayerMessage as raw } from "./chat-thread-store";\nconst second = raw;\nconst third = second;\nexport { third as acceptMountedP4DurableTurnFromFacade };\n',
    'import { acceptMountedP4DurableTurn as raw } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal"; let second = raw; export { second as acceptMountedP4DurableTurnFromFacade };\n',
    'import { consumeMountedP4Admission as raw } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal"; var second = raw; export { second as acceptMountedP4DurableTurnFromFacade };\n',
    'import { "acceptP4MountedPlayerMessage" as raw } from "./chat-thread-store"; const leaked = raw as typeof raw; export { leaked as acceptMountedP4DurableTurnFromFacade };\n',
    'import { acceptP4MountedPlayerMessage as raw } from "./chat-thread-store"; const leaked = raw satisfies typeof raw; export { leaked as acceptMountedP4DurableTurnFromFacade };\n',
    'import { acceptP4MountedPlayerMessage as raw } from "./chat-thread-store"; const leaked = raw!; export { leaked as acceptMountedP4DurableTurnFromFacade };\n',
    'import { acceptP4MountedPlayerMessage as raw } from "./chat-thread-store"; const leaked = (raw); export { leaked as acceptMountedP4DurableTurnFromFacade };\n',
  ]) {
    await withFixture({ ...intended, [p4Bridge]: bridgeSource }, (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.ok(report.violations.some((item) => item.kind === "invalid_p4_bridge_runtime_export_surface"));
    });
  }
  await withFixture({ ...intended, [p4Bridge]: `${intended[p4Bridge]}\nexport type { AcceptedQueuedTurn } from "./chat-thread-store.js";` }, (root) => {
    assert.equal(checkHostProductionImportBoundary({ root, roots }).verdict, "passed");
  });
  for (const [name, bridgeSource, expectedKind] of [
    [
      "direct-raw-wrapper",
      [
        'import type { HostDeploymentManifest } from "../deployment-manifest.js";',
        'import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";',
        'import { acceptP4MountedPlayerMessage, type AcceptedQueuedTurn } from "./chat-thread-store.js";',
        'type P4MountedAcceptanceCommand = Readonly<{ text: string; locale: string; idempotencyKey: string; expectedDraftRevision: number }>;',
        'export async function acceptMountedP4DurableTurnFromFacade(manifest: HostDeploymentManifest, lease: MountedChatRuntimeLease, command: P4MountedAcceptanceCommand): Promise<AcceptedQueuedTurn> {',
        '  return acceptP4MountedPlayerMessage({ runtimeRoot: manifest.runtimeRoot, playerId: manifest.principal.playerId, companionId: manifest.principal.companionId, continuityId: manifest.principal.continuityId, chatThreadId: lease.chatThreadId, chatSurfaceSessionId: lease.chatSurfaceSessionId, selectionGeneration: lease.browserProjection.selectionGeneration }, command);',
        '}',
      ].join("\\n"),
      "invalid_p4_bridge_implementation",
    ],
    [
      "lexical-computed-module-loader",
      [
        'import * as Module from "node:module";',
        'const member = "createRequire";',
        'const raw = Module[member](import.meta.url)("./chat-thread-store.js");',
        'export async function acceptMountedP4DurableTurnFromFacade() { return raw; }',
      ].join("\\n"),
      "unresolved_dynamic_require",
    ],
    [
      "process-builtin-loader",
      [
        'const raw = process.getBuiltinModule("node:module").createRequire(import.meta.url)("./chat-thread-store.js");',
        'export async function acceptMountedP4DurableTurnFromFacade() { return raw; }',
      ].join("\\n"),
      "unresolved_dynamic_require",
    ],
    [
      "process-builtin-loader-alias",
      [
        'const { getBuiltinModule: builtin } = process;',
        'const raw = builtin("node:module").createRequire(import.meta.url)("./chat-thread-store.js");',
        'export async function acceptMountedP4DurableTurnFromFacade() { return raw; }',
      ].join("\\n"),
      "unresolved_dynamic_require",
    ],
    [
      "reflect-process-builtin-loader",
      [
        'const raw = Reflect.get(process, "getBuiltinModule")("node:module").createRequire(import.meta.url)("./chat-thread-store.js");',
        'export async function acceptMountedP4DurableTurnFromFacade() { return raw; }',
      ].join("\\n"),
      "unresolved_dynamic_require",
    ],
    [
      "reflect-computed-process-builtin-loader",
      [
        'const raw = Reflect["get"](process, "getBuiltinModule")("node:module").createRequire(import.meta.url)("./chat-thread-store.js");',
        'export async function acceptMountedP4DurableTurnFromFacade() { return raw; }',
      ].join("\\n"),
      "unresolved_dynamic_require",
    ],
    [
      "reflect-node-module-loader",
      [
        'import * as Module from "node:module";',
        'const raw = Reflect.get(Module, "createRequire")(import.meta.url)("./chat-thread-store.js");',
        'export async function acceptMountedP4DurableTurnFromFacade() { return raw; }',
      ].join("\\n"),
      "unresolved_dynamic_require",
    ],
    [
      "computed-object-descriptor-process-loader",
      [
        'const descriptor = Object[("getOwn" + "PropertyDescriptor") as "getOwnPropertyDescriptor"](process, "getBuiltinModule");',
        'const builtin = descriptor!.value as typeof process.getBuiltinModule;',
        'const raw = builtin("node:module")[("create" + "Require") as "createRequire"](import.meta.url)("./chat-thread-store.js");',
        'export async function acceptMountedP4DurableTurnFromFacade() { return raw; }',
      ].join("\\n"),
      "unresolved_dynamic_require",
    ],
  ]) {
    await withFixture({ ...intended, [p4Bridge]: bridgeSource }, (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.ok(report.violations.some((item) => item.kind === expectedKind), name);
    });
  }
  await withFixture(
    {
      ...intended,
      [p4Bridge]: intended[p4Bridge].replace(
        "command: P4MountedAcceptanceCommand): Promise<AcceptedQueuedTurn>",
        'command: P4MountedAcceptanceCommand = (void acceptP4MountedPlayerMessage({ runtimeRoot: manifest.runtimeRoot, playerId: manifest.principal.playerId, companionId: manifest.principal.companionId, continuityId: manifest.principal.continuityId, chatThreadId: lease.chatThreadId, chatSurfaceSessionId: lease.chatSurfaceSessionId, selectionGeneration: lease.browserProjection.selectionGeneration }, { text: "bypass", locale: "en-US", idempotencyKey: "abcdefghijklmnopqrstuv", expectedDraftRevision: 0 }), { text: "bypass", locale: "en-US", idempotencyKey: "abcdefghijklmnopqrstuv", expectedDraftRevision: 0 }))): Promise<AcceptedQueuedTurn>',
      ),
    },
    (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.ok(report.violations.some((item) => item.kind === "invalid_p4_bridge_implementation"));
    },
  );
  for (const [name, bridgeSource] of [
    [
      "direct-create-require",
      [
        'import { createRequire } from "node:module";',
        'const raw = createRequire(import.meta.url)("./chat-thread-store.js");',
        "export async function acceptMountedP4DurableTurnFromFacade() { return raw; }",
      ].join("\\n"),
    ],
    [
      "create-require-loader-alias",
      [
        'import { createRequire } from "node:module";',
        "const load = createRequire(import.meta.url);",
        'const raw = load("./chat-thread-store.js");',
        "export async function acceptMountedP4DurableTurnFromFacade() { return raw; }",
      ].join("\\n"),
    ],
    [
      "direct-computed-module-require",
      [
        'const raw = module["require"]("./chat-thread-store.js");',
        "export async function acceptMountedP4DurableTurnFromFacade() { return raw; }",
      ].join("\\n"),
    ],
    [
      "computed-module-require-loader-alias",
      [
        'const load = module["require"];',
        'const raw = load("./chat-thread-store.js");',
        "export async function acceptMountedP4DurableTurnFromFacade() { return raw; }",
      ].join("\\n"),
    ],
  ]) {
    await withFixture({ ...intended, [p4Bridge]: bridgeSource }, (root) => {
      const report = checkHostProductionImportBoundary({ root, roots });
      assert.ok(report.violations.some((item) => item.kind === "invalid_p4_bridge_store_edge"), name);
    });
  }
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
        'export { value } from "./continuity-semantic-store/continuity-semantic-production-store";',
        "const created = createSemanticProductionBackend();",
        "type Legacy = SemanticProductionBackend;",
        "type Operations = SemanticProductionBackendOperations;",
        "// createSemanticProductionBackend SemanticProductionBackend SemanticProductionBackendOperations",
        'const text = "createSemanticProductionBackend SemanticProductionBackend SemanticProductionBackendOperations";',
      ].join("\n"),
      "host/src/continuity-semantic-provisioning/continuity-semantic-provisioning.ts": "export {};\n",
      "host/src/continuity-semantic-store/continuity-semantic-production-store.ts": "export const value = 1;\n",
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
          specifier: "./continuity-semantic-store/continuity-semantic-production-store",
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
