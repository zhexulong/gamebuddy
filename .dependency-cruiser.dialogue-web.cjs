const path = require("node:path");

/**
 * Frontend layer boundaries for dialogue-web (design/32, design/104,
 * architecture/product-surfaces.md).
 *
 * Chat, Chats, Characters, Game, Settings, Memory and World Info are peer
 * surfaces: the AppBar selects which one occupies the main region, and each
 * owns its own assembly, lifecycle and error handling. No surface may import
 * another surface's assembler, and no contract, shared-UI or support layer may
 * depend on a surface.
 *
 * The zones below are path patterns, so a new `components/*Surface.tsx` is
 * classified the moment it is added; a new file that matches no zone fails
 * `tools/check-dialogue-web-boundaries.test.mjs` rather than escaping the
 * boundary rules silently. Every `dialogue-web/src` file belongs to exactly one
 * zone; `main.tsx` is the browser boot shell and is intentionally unzoned.
 *
 * Layer model:
 *   chat-contract        reference-pipeline-api + reference-pipeline-session
 *   platform-contract    management-pipeline-api/session + composed-reference-game-browser-api
 *   composed-root        components/ComposedReferenceGameApp   — the one assembler
 *   surface              components/*Surface                   — the peer surface bodies
 *   surface-support      panels, views, models and labels the surfaces share
 *   shared-ui            props-driven presentation primitives
 *   shared               i18n / types                          — leaf utilities
 *
 * Rules fire as `error`. tools/check-dialogue-web-boundaries.test.mjs owns the
 * golden zone manifest, the drift ledger (must be empty) and negative tests
 * proving every rule fires.
 */
const CHAT_CONTRACT = "^dialogue-web/src/reference-pipeline-(api|session)\\.ts$";
const PLATFORM_CONTRACT =
  "^dialogue-web/src/(management-pipeline-(api|session)|composed-reference-game-browser-api)\\.ts$";
const COMPOSED_ROOT = "^dialogue-web/src/components/ComposedReferenceGameApp\\.tsx$";
const SURFACE = "^dialogue-web/src/components/[^/]*Surface\\.tsx$";
const SURFACE_SUPPORT =
  "^dialogue-web/src/((game-(lifecycle-controls|presentation)|composed-problem-view|pi-settings-model)\\.ts|components/(CharacterCardImport|CharactersPanel|CharactersSurfacePanel|CompanionInspectorDrawer|GameDiagnosticsDisclosure|GameStatePanel|StardewInstallationDiscovery|SurfaceModelSettings|composed-reference-game-view|management-panels|management-surface-panels|character-domain-labels|memory-notebook-labels|png-character-card|turn-failure-text)\\.tsx?)$";
const SHARED_UI =
  "^dialogue-web/src/(components/(MessageBubble|Timeline|ProblemView|SkipLink|Composer|MarkdownMessage|SurfaceView|AppBar|ContextDrawer)\\.tsx|components/drawers/ChatsDrawer\\.tsx)$";
const SHARED = "^dialogue-web/src/(i18n|types)\\.ts$";

module.exports = {
  forbidden: [
    {
      name: "no-surface-to-other-surface",
      comment: "Peer surfaces own independent lifecycles; no surface may import another surface's assembler.",
      severity: "error",
      from: { path: SURFACE },
      to: { path: SURFACE },
    },
    {
      name: "no-surface-support-to-surface",
      comment: "Panels, views, models and labels are shared by surfaces and must not depend on one.",
      severity: "error",
      from: { path: SURFACE_SUPPORT },
      to: { path: SURFACE },
    },
    {
      name: "no-contract-imports-ui",
      comment:
        "The wire contracts stay dependency-free and React-free: they must not import the shell, a surface, its support or shared UI.",
      severity: "error",
      from: { path: `(${CHAT_CONTRACT}|${PLATFORM_CONTRACT})` },
      to: { path: `(${COMPOSED_ROOT}|${SURFACE}|${SURFACE_SUPPORT}|${SHARED_UI})` },
    },
    {
      name: "no-chat-contract-internal-dependency",
      comment:
        "The Chat wire contract stays dependency-free: its own members must not import each other (api and session remain standalone).",
      severity: "error",
      from: { path: CHAT_CONTRACT },
      to: { path: CHAT_CONTRACT },
    },
    {
      name: "no-shared-ui-imports-surfaces",
      comment:
        "Shared presentation primitives carry no surface lifecycle and must not import the shell, a surface or its support.",
      severity: "error",
      from: { path: SHARED_UI },
      to: { path: `(${COMPOSED_ROOT}|${SURFACE}|${SURFACE_SUPPORT})` },
    },
    {
      name: "no-shared-imports-modules",
      comment:
        "Shared leaf utilities must not import the shell, surfaces, support, shared UI or a wire contract.",
      severity: "error",
      from: { path: SHARED },
      to: {
        path: `(${COMPOSED_ROOT}|${SURFACE}|${SURFACE_SUPPORT}|${SHARED_UI}|${CHAT_CONTRACT}|${PLATFORM_CONTRACT})`,
      },
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
