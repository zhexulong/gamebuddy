const path = require("node:path");
const { ZONES } = require("./.dependency-cruiser.dialogue-web.zones.cjs");

/**
 * Frontend layer boundaries for dialogue-web (design/32, design/104,
 * architecture/product-surfaces.md).
 *
 * Chat, Chats, Characters, Game, Settings, Memory and World Info are peer surfaces:
 * the AppBar selects which one occupies the main region, and each owns its own
 * assembly, lifecycle and error handling. No module composes a surface but the
 * assembler, the wire contracts stay free of components, and nothing sits on a cycle.
 *
 * No file is listed here. Each zone comes from something the tree already owns - the
 * assembler from the browser entry, the surfaces from the filename convention they
 * follow, the contracts from the modules that declare themselves one - and
 * `.dependency-cruiser.dialogue-web.zones.cjs` holds that derivation for this config and
 * for `tools/check-dialogue-web-boundaries.test.mjs` alike. The revision before this one
 * listed files instead: 48 of 78 modules, so the 30 it missed carried no boundary rule,
 * and the gate that measures it could only name the first of them.
 *
 * Rules fire as `error`. The gate proves each rule fires on a fixture, holds the drift
 * ledger (must be empty) and reports the population it examined.
 */
module.exports = {
  forbidden: [
    {
      name: "no-module-to-surface",
      comment:
        "Peer surfaces are composed by the assembler alone: no other module may import one, so a surface cannot be reached from a peer surface, a panel, a primitive or a leaf utility.",
      severity: "error",
      from: { path: ZONES.module, pathNot: ZONES.assembler },
      to: { path: ZONES.surface },
    },
    {
      name: "no-chat-contract-internal-dependency",
      comment:
        "The Chat wire contract stays dependency-free: its own members must not import each other (api and session remain standalone).",
      severity: "error",
      from: { path: ZONES.chatContract },
      to: { path: ZONES.chatContract },
    },
    {
      name: "no-contract-imports-components",
      comment:
        "The wire contracts stay React-free: a contract that reaches a component imports React - and a surface's lifecycle - into the wire boundary. Transitive, so no intermediate module can launder the edge.",
      severity: "error",
      from: { path: `(${ZONES.chatContract}|${ZONES.platformContract})` },
      to: { path: ZONES.components, reachable: true },
    },
    {
      name: "no-circular",
      comment:
        "No module under dialogue-web/src may sit on a dependency cycle: a leaf that imports upward (a utility importing the contract that imports the utility) breaks every layer above it.",
      severity: "error",
      from: { path: ZONES.module },
      to: { path: ZONES.module, circular: true },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    includeOnly: ZONES.module,
    tsConfig: {
      fileName: path.join(__dirname, "dialogue-web", "tsconfig.json"),
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
