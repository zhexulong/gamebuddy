const path = require("node:path");

/**
 * Chat ↔ Game ↔ Management surface boundaries for dialogue-web.
 *
 * Chat, Game and Management are independent product surfaces (design/32,
 * design/968, design/114): they can start, stop, recover and run concurrently;
 * none may import another's runtime internals. The ONLY allowed cross-surface
 * channel is a frozen wire contract (tavern_browser_api/v1 for Chat, the
 * composed reference-game boundary for Game, management-pipeline for
 * Management) — never another surface's session reducer or component tree.
 *
 * Surface model:
 *   shell                main.tsx                — the only allowed assembler
 *   chat-contract        reference-pipeline-api  — dependency-free wire contract
 *   chat-runtime         session reducer + chat-only components
 *   game-surface         composed game API + game-only components
 *   management-surface   management API + management-only components
 *   shared               i18n / types            — leaf utilities
 *
 * Rules fire as `error`. tools/check-dialogue-web-boundaries.test.mjs owns
 * the golden zone manifest, the current drift ledger (edges the decoupling
 * work must cut) and negative tests proving these rules actually fire.
 */
const CHAT_RUNTIME =
  "^dialogue-web/src/(reference-pipeline-session\\.ts|components/(ReferenceApp|Composer|MessageBubble|Timeline|ProblemView|SkipLink|drawers/ChatsDrawer)\\.tsx)$";
const CHAT_CONTRACT = "^dialogue-web/src/reference-pipeline-api\\.ts$";
const MANAGEMENT_SURFACE =
  "^dialogue-web/src/(management-pipeline-(api|session)\\.ts|components/ManagementApp\\.tsx)$";
const GAME_SURFACE =
  "^dialogue-web/src/(composed-reference-game-browser-api\\.ts|components/(ComposedReferenceGameApp|StardewInstallationDiscovery)\\.tsx)$";
const SHARED = "^dialogue-web/src/(i18n|types)\\.ts$";

module.exports = {
  forbidden: [
    {
      name: "no-chat-runtime-to-game-surface",
      comment: "Chat runtime internals must never import Game surface modules.",
      severity: "error",
      from: { path: CHAT_RUNTIME },
      to: { path: GAME_SURFACE },
    },
    {
      name: "no-chat-runtime-to-management-surface",
      comment: "Chat runtime internals must never import Management surface modules.",
      severity: "error",
      from: { path: CHAT_RUNTIME },
      to: { path: MANAGEMENT_SURFACE },
    },
    {
      name: "no-game-surface-to-chat-runtime",
      comment: "Game surface must only consume the frozen chat wire contract, never Chat runtime internals.",
      severity: "error",
      from: { path: GAME_SURFACE },
      to: { path: CHAT_RUNTIME },
    },
    {
      name: "no-game-surface-to-management-surface",
      comment: "Game surface must never import Management internals.",
      severity: "error",
      from: { path: GAME_SURFACE },
      to: { path: MANAGEMENT_SURFACE },
    },
    {
      name: "no-management-surface-to-chat-runtime",
      comment: "Management surface must only consume wire contracts, never Chat runtime internals.",
      severity: "error",
      from: { path: MANAGEMENT_SURFACE },
      to: { path: CHAT_RUNTIME },
    },
    {
      name: "no-management-surface-to-game-surface",
      comment: "Management surface must never import Game internals.",
      severity: "error",
      from: { path: MANAGEMENT_SURFACE },
      to: { path: GAME_SURFACE },
    },
    {
      name: "no-contract-imports-surfaces",
      comment: "The shared wire contract stays dependency-free: it must not import any surface runtime.",
      severity: "error",
      from: { path: CHAT_CONTRACT },
      to: { path: `(${CHAT_RUNTIME}|${GAME_SURFACE}|${MANAGEMENT_SURFACE})` },
    },
    {
      name: "no-shared-imports-surfaces",
      comment: "Shared leaf utilities must not import surface modules.",
      severity: "error",
      from: { path: SHARED },
      to: { path: `(${CHAT_RUNTIME}|${GAME_SURFACE}|${CHAT_CONTRACT}|${MANAGEMENT_SURFACE})` },
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