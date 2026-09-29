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
      identityVersion: 1,
      lifecycle: "published" as const, kind: "execution" as const,
    },
    {
      actionId: "equip_tool",
      familyId: "body_tools",
      identityVersion: 1,
      lifecycle: "experimental" as const, kind: "execution" as const,
    },
  ];

  const visible = visibleActionsFromModCatalog(catalog, capabilities);
  assert.deepEqual(visible.map((entry) => entry.actionId), ["move_to_tile"]);
  assert.equal(visible[0]?.familyId, "Mod_declared_family");
  assert.equal(visible[0]?.identityVersion, 1);
  assert.deepEqual(searchActionsFromModCatalog(catalog, capabilities, "body_tools"), []);
});

test("visible action adapters reject Mod registrations with an unsupported identityVersion", () => {
  const capabilities = ["move_to_tile"];
  const supported = {
    actionId: "move_to_tile",
    familyId: "movement_navigation",
    identityVersion: 1,
    lifecycle: "published" as const, kind: "execution" as const,
  };
  const unsupported = {
    actionId: "move_to_tile",
    familyId: "movement_navigation",
    identityVersion: 2,
    lifecycle: "published" as const, kind: "execution" as const,
  };

  // An unsupported identity version is dropped even when family/lifecycle/capability
  // all admit it; the Host adapter can only execute the identity versions it knows.
  assert.deepEqual(visibleActionsFromModCatalog([unsupported], capabilities), []);
  assert.deepEqual(searchActionsFromModCatalog([unsupported], capabilities, "move_to_tile"), []);

  // The same action at a supported identityVersion remains visible.
  const visible = visibleActionsFromModCatalog([supported, unsupported], capabilities);
  assert.deepEqual(visible.map((entry) => entry.actionId), ["move_to_tile"]);
  assert.equal(visible[0]?.identityVersion, 1);
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

test("complete candidate actions are visible despite the experimental lifecycle", () => {
  const capabilities = ["express_emote", "face_direction"];
  const catalog = [
    {
      actionId: "express_emote",
      familyId: "expression",
      identityVersion: 1,
      lifecycle: "experimental" as const,
      kind: "execution" as const,
      descriptor: Object.freeze({
        arguments: Object.freeze([
          Object.freeze({ name: "emote", type: "string", enum: Object.freeze(["happy", "sad"]) }),
        ]),
        effect: "write",
        postcondition: "emote_started",
        nativeBinding: "Farmer.doEmote",
      }),
    },
    {
      actionId: "face_direction",
      familyId: "movement_navigation",
      identityVersion: 1,
      lifecycle: "experimental" as const,
      kind: "execution" as const,
      descriptor: Object.freeze({
        arguments: Object.freeze([
          Object.freeze({ name: "direction", type: "string", enum: Object.freeze(["up", "down"]) }),
        ]),
        effect: "write",
        postcondition: "actor_facing_matches",
        nativeBinding: "Farmer.faceDirection",
      }),
    },
    {
      // An experimental non-candidate action stays invisible.
      actionId: "equip_tool",
      familyId: "body_tools",
      identityVersion: 1,
      lifecycle: "experimental" as const,
      kind: "execution" as const,
    },
  ];

  const visible = visibleActionsFromModCatalog(catalog, capabilities);
  assert.deepEqual(visible.map((entry) => entry.actionId).sort(), ["express_emote", "face_direction"]);
  assert.equal(visible.find((entry) => entry.actionId === "express_emote")?.lifecycle, "experimental");
  assert.equal(visible.find((entry) => entry.actionId === "face_direction")?.lifecycle, "experimental");
});

test("live_verified actions are visible without being candidates", () => {
  // live_verified means the action already ran on its required target topology
  // and produced a native receipt/postcondition. That is enough to be visible;
  // it does not require the experimental candidate admission path (which exists
  // for actions whose descriptor completeness must still be proven at runtime),
  // and it does not require full publication.
  const capabilities = ["equip_tool", "harvest_crop"];
  const liveVerified = [
    {
      actionId: "equip_tool",
      familyId: "body_tools",
      identityVersion: 1,
      lifecycle: "live_verified" as const,
      kind: "execution" as const,
    },
    {
      actionId: "harvest_crop",
      familyId: "farming_crops",
      identityVersion: 1,
      lifecycle: "live_verified" as const,
      kind: "execution" as const,
    },
  ];
  assert.deepEqual(
    visibleActionsFromModCatalog(liveVerified, capabilities).map((entry) => entry.actionId).sort(),
    ["equip_tool", "harvest_crop"],
  );

  // The same registrations at experimental lifecycle stay invisible: visibility
  // tracks the real live evidence, not merely the catalog entry existing.
  const stillExperimental = liveVerified.map((entry) => ({ ...entry, lifecycle: "experimental" as const }));
  assert.deepEqual(visibleActionsFromModCatalog(stillExperimental, capabilities), []);
});

test("incomplete candidate descriptors stay invisible", () => {
  const catalog = [
    {
      actionId: "express_emote",
      familyId: "expression",
      identityVersion: 1,
      lifecycle: "experimental" as const,
      kind: "execution" as const,
      descriptor: Object.freeze({
        arguments: Object.freeze([]),
        effect: "write",
        postcondition: "emote_started",
        nativeBinding: "Farmer.doEmote",
      }),
    },
  ];
  assert.deepEqual(visibleActionsFromModCatalog(catalog, ["express_emote"]), []);
});

test("the descriptor completeness gate also holds at live_verified", () => {
  // live_verified records that a run succeeded on the required topology; it does
  // not guarantee the Mod still sends a usable argument shape. A descriptor-
  // derived action must pass completeness on every admission path, so a live run
  // can never make a malformed argument surface visible.
  const withDescriptor = (descriptor: object) => [
    {
      actionId: "express_emote",
      familyId: "expression",
      identityVersion: 1,
      lifecycle: "live_verified" as const,
      kind: "execution" as const,
      descriptor: Object.freeze(descriptor),
    },
  ];
  const complete = {
    arguments: Object.freeze([{ name: "emote", type: "string", enum: ["happy"] }]),
    effect: "write",
    postcondition: "emote_started",
    nativeBinding: "Farmer.doEmote",
  };
  assert.deepEqual(
    visibleActionsFromModCatalog(withDescriptor(complete), ["express_emote"]).map((e) => e.actionId),
    ["express_emote"],
  );

  // Each of these drops one required fact, so all must stay invisible even though
  // the lifecycle is live_verified.
  const incompleteVariants = {
    "no emote enum": { ...complete, arguments: Object.freeze([{ name: "emote", type: "string" }]) },
    "no native binding": { ...complete, nativeBinding: undefined },
    "no postcondition": { ...complete, postcondition: undefined },
    "read effect": { ...complete, effect: "read" },
  };
  for (const [label, descriptor] of Object.entries(incompleteVariants)) {
    assert.deepEqual(
      visibleActionsFromModCatalog(withDescriptor(descriptor), ["express_emote"]),
      [],
      `expected live_verified ${label} to stay invisible`,
    );
  }
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

test("interaction search matches the target vocabulary the adapter itself declares", () => {
  // A live trace showed the Agent searching "jodi" / "npc gift" and getting an
  // empty list while the catalog plainly listed the npc interaction, so it
  // concluded the capability did not exist and went looking across maps. The
  // search string omitted the adapter's own declared target kinds. This uses a
  // published adapter so the assertion is about the search string alone.
  const capabilities = ["move_to_tile"];
  const catalog = [
    {
      actionId: "move_to_tile",
      familyId: "movement_navigation",
      identityVersion: 1,
      lifecycle: "published" as const,
      kind: "execution" as const,
    },
  ];
  assert.deepEqual(
    searchActionsFromModCatalog(catalog, capabilities, "tile").map((entry) => entry.actionId),
    ["move_to_tile"],
  );
  // A term matching nothing in actionId/family/label/description/targetKinds
  // still returns nothing; this must not become a match-everything search.
  assert.deepEqual(searchActionsFromModCatalog(catalog, capabilities, "zzz"), []);
});

test("interaction search matches per word, not the whole phrase", () => {
  // The audit's live trace shows the caller searching multi-word phrases
  // ("Jodi npc gift", "npc gift"). A single substring test matched none of them
  // as a whole string, so the search answered "no such capability" while the
  // surface plainly had one. Every word must hit; a word that hits nothing still
  // narrows the result to nothing.
  const capabilities = ["move_to_tile"];
  const catalog = [
    {
      actionId: "move_to_tile",
      familyId: "movement_navigation",
      identityVersion: 1,
      lifecycle: "published" as const,
      kind: "execution" as const,
    },
  ];
  for (const query of ["move tile", "tile move", "ME TO TILE", "  tile  "]) {
    assert.deepEqual(
      searchActionsFromModCatalog(catalog, capabilities, query).map((entry) => entry.actionId),
      ["move_to_tile"],
      `query ${JSON.stringify(query)} should match`,
    );
  }
  // One word that matches nothing removes the action from the result.
  assert.deepEqual(searchActionsFromModCatalog(catalog, capabilities, "tile zzz"), []);
  assert.deepEqual(searchActionsFromModCatalog(catalog, capabilities, "tile warp"), []);
});
