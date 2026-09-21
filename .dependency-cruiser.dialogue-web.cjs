const path = require("node:path");

/**
 * Chat ↔ Game surface boundaries for dialogue-web.
 *
 * Chat and Game are independent product surfaces (design/32, design/968):
 * they can start, stop, recover and run concurrently; neither may import the
 * other's runtime internals. The ONLY allowed cross-surface channel is the
 * frozen tavern_browser_api/v1 wire contract (`reference-pipeline-api.ts`),
 * which the composed game profile embeds for nested Chat operations.
 *
 * Surface model:
 *   shell            main.tsx                  — the only allowed assembler
 *   chat-side        chat wire contract + chat session reducer + chat-only
 *                    components + chat management (all one product side)
 *   game-surface     composed game API + game-only components
 *   shared           i18n / types              — leaf utilities
 *
 * Rules fire as `error`. tools/check-dialogue-web-boundaries.test.mjs owns
 * the golden zone manifest, the current drift ledger (edges Loop 2 must cut)
 * and negative tests proving these rules actually fire.
 */
const CHAT_RUNTIME =
  "^dialogue-web/src/(reference-pipeline-session\\.ts|components/(ReferenceApp|Composer|MessageBubble|Timeline|ProblemView|SkipLink|drawers/ChatsDrawer)\\.tsx)$";
const CHAT_CONTRACT = "^dialogue-web/src/reference-pipeline-api\\.ts$";
const MANAGEMENT =
  "^dialogue-web/src/(management-pipeline-(api|session)\\.ts|components/ManagementApp\\.tsx)$";
const GAME_SURFACE =
  "^dialogue-web/src/(composed-reference-game-browser-api\\.ts|components/(ComposedReferenceGameApp|StardewInstallationDiscovery)\\.tsx)$";
const SHARED = "^dialogue-web/src/(i18n|types)\\.ts$";

module.exports = {
  forbidden: [
    {
      name: "no-chat-side-to-game-surface",
      comment: "Chat runtime and chat management must never import Game surface modules.",
      severity: "error",
      from: { path: `(${CHAT_RUNTIME}|${MANAGEMENT})` },
      to: { path: GAME_SURFACE },
    },
    {
      name: "no-game-surface-to-chat-side",
      comment: "Game surface must only consume the frozen chat wire contract, never Chat runtime or management internals.",
      severity: "error",
      from: { path: GAME_SURFACE },
      to: { path: `(${CHAT_RUNTIME}|${MANAGEMENT})` },
    },
    {
      name: "no-contract-imports-surfaces",
      comment: "The shared wire contract stays dependency-free: it must not import any surface runtime.",
      severity: "error",
      from: { path: CHAT_CONTRACT },
      to: { path: `(${CHAT_RUNTIME}|${GAME_SURFACE}|${MANAGEMENT})` },
    },
    {
      name: "no-shared-imports-surfaces",
      comment: "Shared leaf utilities must not import surface modules.",
      severity: "error",
      from: { path: SHARED },
      to: { path: `(${CHAT_RUNTIME}|${GAME_SURFACE}|${CHAT_CONTRACT}|${MANAGEMENT})` },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    includeOnly: "^dialogue-web/src/",
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