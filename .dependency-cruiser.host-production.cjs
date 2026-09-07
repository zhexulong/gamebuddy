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
