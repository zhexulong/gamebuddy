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
        // The same two exceptions ADR-0007 records, in the same shape the seam gate
        // allows them:
        //   - `containment/runtime/contract/game-runtime`: the stable game-facing
        //     contract. The exemption names the exact module, not the directory,
        //     because a second module added under contract/ has no such permission
        //     (tools/check-host-game-physical-seam.mjs exempts only this module).
        //   - `bootstrap/roots/stardew-private-mod-profile-staging`: the staging
        //     provenance contract, which carries no process, transport, pipe, token or
        //     launch authority. The seam gate narrows it further, to its one lifecycle
        //     importer; a forbidden rule cannot express an importer-specific exception,
        //     so the seam gate owns that clause.
        // runtime/core and the auth transport are NOT exempt: the game layer has no
        // edge to either, and the slots were removed with the retired seam in
        // 3b12a18/3485dbf.
        pathNot:
          "^host/src/(?:containment/runtime/contract/game-runtime\\.ts|bootstrap/roots/stardew-private-mod-profile-staging)",
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
    // This graph cannot see type-only edges, and every rule below is blind to them.
    //
    // With this off, each TypeScript module is transpiled to JavaScript and the result
    // is parsed, so `import type` edges are erased before the graph exists. The rule
    // that matters here is `games-must-not-import-unapproved-generic-layers`: a
    // `games/**` type-only import of `containment/auth` is not in this graph at all --
    // `containment/auth/desktop-guardian-session.internal.ts` never appears among the
    // modules the graph reads -- and the rule reports passed over it. That is how the
    // edge fixed in 1634c8cc survived until the seam checker caught it.
    //
    // The authority for type-only edges is gates/product/check-host-game-physical-seam.mjs,
    // which reads source text (`import type`, `import("path").Type`, `require`,
    // import-equals). Its scope is the architecture question and nothing else: it judges
    // WHICH LAYER may reach which (games -> bootstrap/containment/composition, the
    // containment runtime's own vocabulary, the registration facade, raw desktop/native
    // modules), including the spellings this graph erases, and it fails closed on a computed
    // `import()` or `require()` it cannot resolve; but it builds no graph, so it cannot see a
    // cycle between any two modules that are not directly importing each other, and it judges
    // import paths rather than resolution, so a barrel, an alias or a bare specifier it does
    // not name is outside it -- those two gaps are this file's, by construction.
    //
    // Enabling it IS the eventual fix, and not a free switch. Measured 2026-11-25 with
    //   pnpm exec depcruise --config .dependency-cruiser.host-production.cjs \
    //     host/src/main.ts host/src/stardew-attachment.ts \
    //     host/src/farmhand-companion-preview.ts \
    //     host/src/composition/desktop-host-composition.ts --output-type json
    // and with the same command against a copy of this file whose only change is this
    // option flipped, on the same worktree minutes apart - so the delta is the durable
    // reading, not the absolute count: 261 modules / 683 edges / 2 circular violations
    // become 272 modules (+11) / 1082 edges (+58%) / 31 circular violations (+29). Every
    // one of the 29 added cycles closes through at least one type-only edge and therefore
    // never happens at run time. Restricting that rule to non-type-only edges still leaves
    // 24, because depcruise reports the run-time edge of a mixed cycle. So the blocker is
    // the type-only cycles that need adjudication -- either the cycles are removed or the
    // circular rule is rewritten to judge the run-time graph -- and never a baseline entry.
    // Until that is done this option stays off and the seam checker above owns the edges it
    // cannot see; gates/product/check-host-game-physical-seam.test.mjs fails when this
    // option changes without that reconciliation.
    tsPreCompilationDeps: false,
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "default"],
      mainFields: ["module", "main"],
    },
  },
};
