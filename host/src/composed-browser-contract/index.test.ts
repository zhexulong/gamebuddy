import assert from "node:assert/strict";
import test from "node:test";
import { Compile } from "typebox/compile";
import {
  COMPOSED_REFERENCE_GAME_BROWSER_API_V1,
  COMPOSED_REFERENCE_PROFILE_ID,
  ComposedReferenceGameBrowserFixtureV1,
  ComposedReferenceGameBrowserRootV1Schema,
  ComposedReferenceGameBrowserValidatorsV1,
  composeReferenceGameBrowserProfile,
  isComposedReferenceGameBrowserProfile,
} from "./index.js";
import { TavernBrowserFixtureV1 } from "../tavern/browser-contract/index.js";
import { GameBrowserFixtureV1, GAME_BROWSER_OPERATION_IDS_V1 } from "../game-browser-contract/index.js";
import { composeTavernProfile, isComposedTavernProfile } from "../tavern/browser-contract/index.js";
import { composeGameProfile } from "../game-browser-contract/index.js";

const referenceTavernProfile = composeTavernProfile({
  profileId: "gamebuddy.chat-core.reference-pipeline",
  releaseTier: "chat_core",
  routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status", "events"],
  operationIds: ["chat.submit", "chat.cancel"],
  navigationItemIds: ["chat"],
});

const gameProfileWithStateRead = composeGameProfile({
  profileId: "gamebuddy.game.preview",
  releaseTier: "game_preview",
  operationIds: ["game.prerequisites.read", "game.state.read", "game.launch", "game.attach", "game.stop", "game.disconnect"],
  navigationItemIds: ["game"],
});

const gameProfileWithoutStateRead = composeGameProfile({
  profileId: "gamebuddy.game.preview",
  releaseTier: "game_preview",
  operationIds: ["game.prerequisites.read", "game.launch"],
  navigationItemIds: ["game"],
});

// ─── Profile composition ────────────────────────────────────────────────────

test("composeReferenceGameBrowserProfile accepts the exact Chat-only reference input with null Game", () => {
  const profile = composeReferenceGameBrowserProfile({ tavernProfile: referenceTavernProfile });
  assert.equal(isComposedReferenceGameBrowserProfile(profile), true);
  assert.equal(profile.profileId, COMPOSED_REFERENCE_PROFILE_ID);
  assert.equal(profile.releaseTier, "chat_core");
  assert.equal(profile.gameProfile, null);
  // The exact Tavern profile member is the branded reference identity.
  assert.equal(isComposedTavernProfile(profile.tavernProfile), true);
  assert.equal(profile.tavernProfile.profileId, "gamebuddy.chat-core.reference-pipeline");
  assert.deepEqual(profile.tavernProfile.routeIds, [
    "bootstrap",
    "state.read",
    "draft.read",
    "chat.submit",
    "chat.cancel",
    "chat.submission_status",
    "events",
  ]);
  assert.deepEqual(profile.tavernProfile.operationIds, ["chat.submit", "chat.cancel"]);
  assert.deepEqual(profile.tavernProfile.navigationItemIds, ["chat"]);
});

test("composeReferenceGameBrowserProfile accepts an exact Game profile alongside the reference Tavern profile", () => {
  const profile = composeReferenceGameBrowserProfile({
    tavernProfile: referenceTavernProfile,
    gameProfile: gameProfileWithStateRead,
  });
  assert.equal(isComposedReferenceGameBrowserProfile(profile), true);
  assert.notEqual(profile.gameProfile, null);
  assert.equal(profile.gameProfile!.operationIds.includes("game.state.read"), true);
  assert.deepEqual(profile.gameProfile!.navigationItemIds, ["game"]);
});

test("composeReferenceGameBrowserProfile rejects a structural clone of the Tavern profile", () => {
  const structuralClone = Object.freeze({ ...referenceTavernProfile });
  assert.equal(isComposedTavernProfile(structuralClone), false);
  assert.throws(
    () => composeReferenceGameBrowserProfile({ tavernProfile: structuralClone }),
    /not a composed profile/,
  );
});

test("composeReferenceGameBrowserProfile rejects a structural clone of the Game profile", () => {
  const structuralClone = Object.freeze({ ...gameProfileWithStateRead });
  assert.throws(
    () =>
      composeReferenceGameBrowserProfile({
        tavernProfile: referenceTavernProfile,
        gameProfile: structuralClone,
      }),
    /not a composed profile/,
  );
});

test("composeReferenceGameBrowserProfile rejects a branded but non-reference Tavern profile", () => {
  const otherTavernProfile = composeTavernProfile({
    profileId: "gamebuddy.tavern.browser.v1",
    releaseTier: "tavern_management",
    routeIds: ["bootstrap", "state.read"],
    operationIds: [],
    navigationItemIds: [],
  });
  assert.throws(
    () => composeReferenceGameBrowserProfile({ tavernProfile: otherTavernProfile }),
    /not the exact reference profile/,
  );
});

test("composeReferenceGameBrowserProfile rejects a Game profile missing game.state.read", () => {
  assert.throws(
    () =>
      composeReferenceGameBrowserProfile({
        tavernProfile: referenceTavernProfile,
        gameProfile: gameProfileWithoutStateRead,
      }),
    /must include game\.state\.read/,
  );
});

test("composeReferenceGameBrowserProfile rejects partial or malformed inputs", () => {
  assert.throws(() => composeReferenceGameBrowserProfile(null), /plain object/);
  assert.throws(() => composeReferenceGameBrowserProfile([]), /plain object/);
  assert.throws(() => composeReferenceGameBrowserProfile("reference"), /plain object/);
  assert.throws(() => composeReferenceGameBrowserProfile({}), /must have tavernProfile/);
  assert.throws(() => composeReferenceGameBrowserProfile({ tavernProfile: referenceTavernProfile, extra: true }), /unexpected key/);
  assert.throws(
    () => composeReferenceGameBrowserProfile({ tavernProfile: { ...referenceTavernProfile }, gameProfile: null }),
    /not a composed profile/,
  );
});

test("composeReferenceGameBrowserProfile brands only its own frozen objects; structural clones are not composed", () => {
  const profile = composeReferenceGameBrowserProfile({
    tavernProfile: referenceTavernProfile,
    gameProfile: gameProfileWithStateRead,
  });
  assert.equal(isComposedReferenceGameBrowserProfile(profile), true);
  assert.equal(isComposedReferenceGameBrowserProfile(Object.freeze({ ...profile })), false);
  assert.equal(isComposedReferenceGameBrowserProfile({ ...profile }), false);
  assert.equal(isComposedReferenceGameBrowserProfile(null), false);
  assert.equal(isComposedReferenceGameBrowserProfile({}), false);
  assert.equal(isComposedReferenceGameBrowserProfile([]), false);
});

test("profile input cannot be modified or expanded after composition", () => {
  const profile = composeReferenceGameBrowserProfile({ tavernProfile: referenceTavernProfile });
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.tavernProfile), true);
  assert.equal(Object.isFrozen(profile.tavernProfile.routeIds), true);
  assert.equal(Object.isFrozen(profile.tavernProfile.operationIds), true);
  assert.equal(Object.isFrozen(profile.tavernProfile.navigationItemIds), true);
  // A later mutation of the original branded profile members must not change
  // the composed profile because the members are the frozen originals.
  assert.equal(profile.tavernProfile.profileId, "gamebuddy.chat-core.reference-pipeline");
});

// ─── Root snapshot schema ───────────────────────────────────────────────────

test("ComposedReferenceGameBrowserRootV1 accepts the Chat-only fixture with game null", () => {
  const validator = Compile(ComposedReferenceGameBrowserRootV1Schema);
  const root = ComposedReferenceGameBrowserFixtureV1.chatOnly();
  assert.equal(validator.Check(root), true);
  assert.equal(root.game, null);
  assert.equal(root.apiVersion, 1);
  assert.equal(root.build.browserContract, COMPOSED_REFERENCE_GAME_BROWSER_API_V1);
  assert.equal(root.build.profileId, COMPOSED_REFERENCE_PROFILE_ID);
  // The nested chat is a valid TavernStateSnapshotV1 (owning fixture).
  assert.equal(TavernBrowserFixtureV1.snapshot().apiVersion, root.chat.apiVersion);
});

test("ComposedReferenceGameBrowserRootV1 accepts the full fixture with a Game nested snapshot", () => {
  const validator = Compile(ComposedReferenceGameBrowserRootV1Schema);
  const root = ComposedReferenceGameBrowserFixtureV1.withGame();
  assert.equal(validator.Check(root), true);
  assert.notEqual(root.game, null);
  // The nested game is the exact owning GameBrowserStateV1 fixture.
  const gameState = GameBrowserFixtureV1.state();
  assert.deepEqual(root.game, gameState);
  assert.equal(ComposedReferenceGameBrowserValidatorsV1.ComposedReferenceGameBrowserRootV1Schema.Check(root), true);
});

test("ComposedReferenceGameBrowserRootV1 accepts every valid game connectionStatus", () => {
  const validator = Compile(ComposedReferenceGameBrowserRootV1Schema);
  const validStatuses = [
    "none",
    "discovering",
    "launch_pending",
    "attach_pending",
    "compatibility_warning",
    "awaiting_confirmation",
    "connecting",
    "connected_idle",
    "active",
    "stopping",
    "reconnecting",
    "stopped",
    "failed",
    "disconnected",
  ] as const;
  const gameState = GameBrowserFixtureV1.state();
  for (const connectionStatus of validStatuses) {
    const root = { ...ComposedReferenceGameBrowserFixtureV1.chatOnly(), game: { ...gameState, game: { ...gameState.game, connectionStatus } } };
    assert.equal(validator.Check(root), true, `connectionStatus=${connectionStatus}`);
  }
});

test("ComposedReferenceGameBrowserRootV1 rejects unknown root fields", () => {
  const validator = Compile(ComposedReferenceGameBrowserRootV1Schema);
  const root = ComposedReferenceGameBrowserFixtureV1.chatOnly();
  assert.equal(validator.Check({ ...root, csrfToken: "QWxhZGRpbjpvcGVuIHNlc2FtZQ" }), false);
  assert.equal(validator.Check({ ...root, browserSession: { expiresAtMs: 1 } }), false);
  assert.equal(validator.Check({ ...root, extra: true }), false);
  assert.equal(validator.Check({ ...root, operations: [] }), false);
});

test("ComposedReferenceGameBrowserRootV1 rejects invalid nested Chat output", () => {
  const validator = Compile(ComposedReferenceGameBrowserRootV1Schema);
  const root = ComposedReferenceGameBrowserFixtureV1.chatOnly();
  assert.equal(validator.Check({ ...root, chat: { ...root.chat, apiVersion: 2 } }), false);
  assert.equal(validator.Check({ ...root, chat: { ...root.chat, csrfToken: "too-short" } }), false);
  assert.equal(validator.Check({ ...root, chat: { ...root.chat, rawPrompt: "secret" } }), false);
});

test("ComposedReferenceGameBrowserRootV1 rejects invalid nested Game output", () => {
  const validator = Compile(ComposedReferenceGameBrowserRootV1Schema);
  const root = ComposedReferenceGameBrowserFixtureV1.withGame();
  assert.equal(validator.Check({ ...root, game: { ...root.game!, game: { ...root.game!.game, connectionStatus: "invented" } } }), false);
  assert.equal(validator.Check({ ...root, game: { ...root.game!, pid: 1234 } }), false);
  assert.equal(validator.Check({ ...ComposedReferenceGameBrowserFixtureV1.chatOnly(), game: { ...GameBrowserFixtureV1.state(), game: { ...GameBrowserFixtureV1.state().game, role: "farmhand" } } }), false);
});

test("ComposedReferenceGameBrowserValidatorsV1 exposes the compiled root validator", () => {
  assert.equal(
    ComposedReferenceGameBrowserValidatorsV1.ComposedReferenceGameBrowserRootV1Schema.Check(
      ComposedReferenceGameBrowserFixtureV1.chatOnly(),
    ),
    true,
  );
  assert.equal(
    ComposedReferenceGameBrowserValidatorsV1.ComposedReferenceGameBrowserRootV1Schema.Check(
      ComposedReferenceGameBrowserFixtureV1.withGame(),
    ),
    true,
  );
});

test("fixture chat/game members are the owning-contract fixtures only", () => {
  const chatOnly = ComposedReferenceGameBrowserFixtureV1.chatOnly();
  assert.deepEqual(chatOnly.chat, TavernBrowserFixtureV1.snapshot());
  const withGame = ComposedReferenceGameBrowserFixtureV1.withGame();
  assert.deepEqual(withGame.chat, TavernBrowserFixtureV1.snapshot());
  assert.deepEqual(withGame.game, GameBrowserFixtureV1.state());
  // No top-level session/CSRF duplication: they remain nested facts.
  assert.equal("csrfToken" in chatOnly, false);
  assert.equal("browserSession" in chatOnly, false);
});
