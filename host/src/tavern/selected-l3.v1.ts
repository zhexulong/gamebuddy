export type SelectedL3TargetTaxonomy = Readonly<{
  schemaVersion: 1;
  id: "selected_l3_v1";
  must: readonly string[];
  later: readonly string[];
  unsupported: readonly string[];
}>;

/**
 * Approved Tavern target taxonomy. This declaration describes product scope
 * only; it does not declare browser operations, routes, navigation, mounting,
 * or release status.
 */
export const SELECTED_L3_V1: SelectedL3TargetTaxonomy = Object.freeze({
  schemaVersion: 1,
  id: "selected_l3_v1",
  must: Object.freeze([
    "companion-library",
    "manage-chats",
    "new-companion",
    "new-chat",
    "persona-scenario-greeting-selection",
    "effect-aware-causal-guard",
    "worldbook-catalog-binding",
    "character-worldbook-chat-import-export",
    "authenticated-reconnect",
    "memory-management",
  ]),
  later: Object.freeze([
    "response-regenerate-swipe-edit",
    "branch-checkpoint",
    "worldbook-full-editor",
    "background-sprite",
    "visual-novel-layout",
  ]),
  unsupported: Object.freeze([
    "group-chat",
    "multi-buddy-runtime",
    "talkativeness",
    "prompt-manager",
    "preset-workbench",
    "extensions",
    "scripts",
    "macros",
    "regex",
    "html-runtime",
  ]),
});
