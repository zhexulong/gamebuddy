import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ACTION_POLICY,
  parseActionPolicy,
  RETIRED_ACTION_POLICY_MIGRATIONS,
  searchActionsFromModCatalog,
  visibleActionsFromModCatalog,
} from "./action-registry.js";
import { TEST_MOD_REGISTRATIONS } from "./stardew-test-fixtures.js";

test("action visibility requires the authenticated Mod catalog", () => {
  const capabilities = ["move_to_tile", "equip_tool", "travel"];

  assert.deepEqual(visibleActionsFromModCatalog([], capabilities), []);
  assert.deepEqual(
    visibleActionsFromModCatalog(TEST_MOD_REGISTRATIONS, capabilities).map((entry) => entry.actionId),
    ["move_to_tile", "equip_tool", "travel"],
  );
});

test("the Mod-owned family and lifecycle constrain local typed adapters", () => {
  const capabilities = ["move_to_tile", "equip_tool"];
  const catalog = [
    {
      actionId: "move_to_tile",
      familyId: "Mod_declared_family",
      identityVersion: 9,
      lifecycle: "published" as const,
    },
    {
      actionId: "equip_tool",
      familyId: "body_tools",
      identityVersion: 1,
      lifecycle: "experimental" as const,
    },
  ];

  const visible = visibleActionsFromModCatalog(catalog, capabilities);
  assert.deepEqual(visible.map((entry) => entry.actionId), ["move_to_tile"]);
  assert.equal(visible[0]?.familyId, "Mod_declared_family");
  assert.equal(visible[0]?.identityVersion, 9);
  assert.deepEqual(searchActionsFromModCatalog(catalog, capabilities, "body_tools"), []);
});

test("policy only subtracts from the current Mod catalog", () => {
  const policy = { ...DEFAULT_ACTION_POLICY, deniedActions: ["equip_tool"] } as const;
  const visible = visibleActionsFromModCatalog(TEST_MOD_REGISTRATIONS, ["move_to_tile", "equip_tool"], policy);
  assert.deepEqual(visible.map((entry) => entry.actionId), ["move_to_tile"]);

  const unknownDeny = parseActionPolicy({ policyVersion: 1, deniedActions: ["future_action"], deniedFamilies: [] });
  assert.deepEqual(
    visibleActionsFromModCatalog(TEST_MOD_REGISTRATIONS, ["move_to_tile"], unknownDeny).map((entry) => entry.actionId),
    ["move_to_tile"],
  );
});

test("retired action identifiers require an explicit fail-closed migration", () => {
  assert.deepEqual(RETIRED_ACTION_POLICY_MIGRATIONS.collect_resource, [
    "chop_tree_source",
    "break_rock_source",
    "pickup_item",
  ]);
  assert.throws(
    () => parseActionPolicy({ policyVersion: 1, deniedActions: ["collect_resource"], deniedFamilies: [] }),
    /retired_action_policy_identifier_requires_explicit_migration/,
  );
});
