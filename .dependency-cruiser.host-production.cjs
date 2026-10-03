const path = require("node:path");

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-host-production-circular-dependencies",
      comment: "Host production roots must not form an import cycle.",
      severity: "error",
      from: {
        path: "^host/src/",
        pathNot: "(?:^|/)(?:test-fixtures|test-support)(?:/|$)|\\.test\\.(?:ts|tsx)$",
      },
      to: {
        circular: true,
        path: "^host/src/",
        pathNot: "(?:^|/)(?:test-fixtures|test-support)(?:/|$)|\\.test\\.(?:ts|tsx)$",
      },
    },
    {
      name: "generic-layers-must-not-import-games",
      comment: "ADR-0007: bootstrap and containment must not depend on specific game implementations. Composition is EXCLUDED because the same ADR allows it the composition root to bind one selected game adapter (composition -> runtime/core + one selected game adapter + private platform modules).",
      severity: "error",
      from: {
        path: "^host/src/(?:bootstrap|containment)/",
        pathNot: "(?:^|/)(?:test-fixtures|test-support)(?:/|$)|\\.test\\.(?:ts|tsx)$",
      },
      to: {
        path: "^host/src/games/",
      },
    },
    {
      name: "games-must-not-import-unapproved-generic-layers",
      comment: "Concrete games must only consume approved boundary contracts from generic layers.",
      severity: "error",
      from: {
        path: "^host/src/games/",
        pathNot: "(?:^|/)(?:test-fixtures|test-support)(?:/|$)|\\.test\\.(?:ts|tsx)$",
      },
      to: {
        path: "^host/src/(?:bootstrap|containment|composition)/",
        // Exactly the one exception ADR-0007 records: the staging provenance
        // contract, which carries no process, transport, pipe, token or launch
        // authority. `containment/runtime/contract` is ADR-permitted for the game
        // layer and is excluded here only so this rule does not double-report the
        // seam checker's own allowlist. runtime/core and the auth transport are NOT
        // exempt: the game layer has no edge to either, and the slots were removed
        // with the retired seam in 3b12a18/3485dbf.
        pathNot: "^host/src/(?:containment/runtime/contract|bootstrap/roots/stardew-private-mod-profile-staging)",
      },
    },
    {
      name: "no-test-fixtures-in-production",
      comment: "Production modules must never import test fixtures or test support: the fixture tree is compiled into the production artifact only if some production root reaches it.",
      severity: "error",
      from: {
        path: "^host/src/",
        pathNot: "(?:^|/)(?:test-fixtures|test-support)(?:/|$)|\\.test\\.(?:ts|tsx)$|\\.test-fixtures\\.ts$|fixture-worker\\.ts$",
      },
      to: {
        path: "^host/src/(?:test-fixtures|test-support)/",
        pathNot: "\\.test\\.(?:ts|tsx)$",
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    includeOnly: "^host/src/",
    tsConfig: {
      fileName: path.join(__dirname, "host", "tsconfig.production.json"),
    },
    tsPreCompilationDeps: false,
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "default"],
      mainFields: ["module", "main"],
    },
  },
};
