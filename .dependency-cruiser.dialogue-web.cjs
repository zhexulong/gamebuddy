const path = require("node:path");

/**
 * Chat ↔ Game ↔ Management surface boundaries for dialogue-web.
 *
 * Chat, Game and Management are independent product surfaces (design/32,
 * design/968, design/114): each owns its own assembly, lifecycle and error
 * handling. A surface may NEVER import another surface's runtime assembler.
 *
 * The ONLY legal cross-surface sharing is:
 *   - the frozen `tavern_browser_api/v1` wire contract (reference-pipeline-api)
 *     plus its identity-bound session reducer (reference-pipeline-session),
 *     both dependency-free and React-free; and
 *   - shared presentation primitives (MessageBubble, Timeline, ProblemView,
 *     SkipLink, Composer, ChatsDrawer) that are props-driven and carry no
 *     surface lifecycle.
 *
 * Surface model:
 *   shell                main.tsx                — the only allowed assembler
 *   chat-contract        reference-pipeline-api + reference-pipeline-session
 *   chat-runtime         components/ReferenceApp  — Chat surface assembler
 *   game-surface         composed game API + Game-only components
 *   management-surface   management API + Management-only components
 *   shared-ui            props-driven presentation primitives
 *   shared               i18n / types            — leaf utilities
 *
 * Rules fire as `error`. tools/check-dialogue-web-boundaries.test.mjs owns
 * the golden zone manifest, the drift ledger (must be empty) and negative
 * tests proving every rule fires.
 */
const CHAT_CONTRACT = "^dialogue-web/src/(reference-pipeline-api|reference-pipeline-session)\\.ts$";
const CHAT_RUNTIME = "^dialogue-web/src/components/ReferenceApp\\.tsx$";
const GAME_SURFACE =
  "^dialogue-web/src/(composed-reference-game-browser-api\\.ts|components/(ComposedReferenceGameApp|StardewInstallationDiscovery)\\.tsx)$";
const MANAGEMENT_SURFACE =
  "^dialogue-web/src/(management-pipeline-(api|session)\\.ts|components/ManagementApp\\.tsx)$";
const SHARED_UI =
  "^dialogue-web/src/components/(MessageBubble|Timeline|ProblemView|SkipLink|Composer|drawers/ChatsDrawer)\\.tsx$";
const SHARED = "^dialogue-web/src/(i18n|types)\\.ts$";

module.exports = {
  forbidden: [
    {
      name: "no-chat-runtime-to-game-surface",
      comment: "Chat runtime assembler must never import Game surface modules.",
      severity: "error",
      from: { path: CHAT_RUNTIME },
      to: { path: GAME_SURFACE },
    },
    {
      name: "no-chat-runtime-to-management-surface",
      comment: "Chat runtime assembler must never import Management surface modules.",
      severity: "error",
      from: { path: CHAT_RUNTIME },
      to: { path: MANAGEMENT_SURFACE },
    },
    {
      name: "no-game-surface-to-chat-runtime",
      comment: "Game surface must only consume the frozen chat wire contract and shared UI, never the Chat runtime assembler.",
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
      comment: "Management surface must only consume wire contracts and shared UI, never the Chat runtime assembler.",
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
      comment: "The wire contract stays dependency-free and React-free: it must not import any surface or shared UI.",
      severity: "error",
      from: { path: CHAT_CONTRACT },
      to: { path: `(${CHAT_RUNTIME}|${GAME_SURFACE}|${MANAGEMENT_SURFACE}|${SHARED_UI})` },
    },
    {
      name: "no-contract-internal-dependency",
      comment: "The wire contract stays dependency-free: its own members must not import each other (api and session remain standalone).",
      severity: "error",
      from: { path: CHAT_CONTRACT },
      to: { path: CHAT_CONTRACT },
    },
    {
      name: "no-shared-ui-imports-surfaces",
      comment: "Shared presentation primitives carry no surface lifecycle and must not import surface assemblers.",
      severity: "error",
      from: { path: SHARED_UI },
      to: { path: `(${CHAT_RUNTIME}|${GAME_SURFACE}|${MANAGEMENT_SURFACE})` },
    },
    {
      name: "no-shared-imports-surfaces",
      comment: "Shared leaf utilities must not import surface modules.",
      severity: "error",
      from: { path: SHARED },
      to: { path: `(${CHAT_RUNTIME}|${GAME_SURFACE}|${MANAGEMENT_SURFACE}|${CHAT_CONTRACT}|${SHARED_UI})` },
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
