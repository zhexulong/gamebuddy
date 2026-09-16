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
      comment: "Generic infrastructure layers (bootstrap, containment, composition) must not depend on specific game implementations.",
      severity: "warn",
      from: {
        path: "^host/src/(?:bootstrap|containment|composition)/",
        pathNot: "(?:^|/)(?:test-fixtures|test-support)(?:/|$)|\\.test\\.(?:ts|tsx)$",
      },
      to: {
        path: "^host/src/games/",
      },
    },
    {
      name: "games-must-not-import-unapproved-generic-layers",
      comment: "Concrete games must only consume approved boundary contracts from generic layers.",
      severity: "warn",
      from: {
        path: "^host/src/games/",
        pathNot: "(?:^|/)(?:test-fixtures|test-support)(?:/|$)|\\.test\\.(?:ts|tsx)$",
      },
      to: {
        path: "^host/src/(?:bootstrap|containment|composition)/",
        pathNot: "^host/src/(?:containment/auth/desktop-guardian-session\\.internal|bootstrap/roots/stardew-private-mod-profile-staging)",
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
