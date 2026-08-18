import assert from "node:assert/strict";
import test from "node:test";
import { SELECTED_L3_V1 } from "./selected-l3.v1.js";

test("selected L3 v1 is immutable approved target taxonomy only", () => {
  assert.deepEqual(SELECTED_L3_V1, {
    schemaVersion: 1,
    id: "selected_l3_v1",
    must: [
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
    ],
    later: [
      "response-regenerate-swipe-edit",
      "branch-checkpoint",
      "worldbook-full-editor",
      "background-sprite",
      "visual-novel-layout",
    ],
    unsupported: [
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
    ],
  });
  assert.equal(Object.isFrozen(SELECTED_L3_V1), true);
  assert.equal(Object.isFrozen(SELECTED_L3_V1.must), true);
  assert.equal("routes" in SELECTED_L3_V1, false);
  assert.equal("navigation" in SELECTED_L3_V1, false);
  assert.equal("flows" in SELECTED_L3_V1, false);
  assert.equal("bootstrap" in SELECTED_L3_V1, false);
});
