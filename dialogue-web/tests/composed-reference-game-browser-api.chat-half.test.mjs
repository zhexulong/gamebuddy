import assert from "node:assert/strict";
import test from "node:test";

import {
  ComposedReferenceGameProtocolError,
  validateComposedReferenceGameRoot,
} from "../src/composed-reference-game-browser-api.ts";

/**
 * The Chat half's three answers at the mirror, split from `composed-reference-game-browser-api.test.mjs`.
 *
 * That file is over the `.mjs` ceiling and carries the Game half's readings; this one names the same source
 * module and owns the Chat half's, so neither reading has to be deleted to make room for the other.
 *
 * The fact: the composed root's two halves are peer surfaces, and each answers three ways - a projection, `null`
 * for a Host whose profile mounts no such surface, and an ABSENT member for a Host that mounts one and could not
 * read it (`readChatHalf`/`readGameHalf` in `host/src/composed-reference-game-browser.ts`). The mirror is the one
 * layer a degraded root has to survive, so it must keep the absence instead of flattening it into `null`: a shell
 * that lost the difference could not tell its surface why it has nothing to draw.
 */

const HANDLE = "A".repeat(43);
/** A canonical unpadded 32-byte token that is not `HANDLE`: two sessions, one root. */
const OTHER_TOKEN = "E".repeat(43);

function chatSnapshot() {
  return {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken: HANDLE,
    browserSession: { expiresAtMs: 1000 },
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: HANDLE, generation: 1, stateRevision: HANDLE },
    chat: {
      companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
      title: "Exact Chat",
      transcript: [],
      draft: { revision: 0, present: false },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  };
}

function gameSnapshot() {
  return {
    apiVersion: 1,
    build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
    csrfToken: HANDLE,
    browserSession: { expiresAtMs: 1000 },
    game: {
      prerequisites: { status: "unknown", detectedGame: null },
      instance: { status: "none", gameTitle: null, generation: 0 },
      compatibility: { status: "unchecked", message: null },
      attachment: { status: "none", generation: 0 },
      connectionStatus: "none",
      actionAuthority: "unavailable",
      role: null,
      companionName: null,
      selectedWorld: null,
      selectedSave: null,
      capabilitySummary: { status: "not_measured", reason: "no_attached_runtime" },
      latestOutcome: "none",
    },
  };
}

function root(game = gameSnapshot()) {
  return {
    apiVersion: 1,
    build: {
      browserContract: "composed_reference_game_browser_api/v1",
      profileId: "gamebuddy.composed.reference-game",
    },
    chat: chatSnapshot(),
    game,
  };
}

test("the mirror keeps a Chat half that could not be read, and one a profile mounts none of", () => {
  const withoutChat = root();
  delete withoutChat.chat;
  const unread = validateComposedReferenceGameRoot(withoutChat);
  assert.equal(Object.hasOwn(unread, "chat"), false, "the absence survives validation; it is not flattened");
  assert.equal(unread.game.game.connectionStatus, "none", "and the Game half is still the document's");

  const none = validateComposedReferenceGameRoot({ ...root(), chat: null });
  assert.equal(Object.hasOwn(none, "chat"), true);
  assert.equal(none.chat, null);

  // Neither half: a well-formed root with nothing to draw. The shell is what decides that is no page
  // (`use-composed-bootstrap`), not the mirror - the wire is allowed to say it.
  const neither = validateComposedReferenceGameRoot({ apiVersion: 1, build: withoutChat.build });
  assert.equal(Object.hasOwn(neither, "chat"), false);
  assert.equal(Object.hasOwn(neither, "game"), false);

  // An invented member standing in for the missing half is a refusal, not a degraded mount.
  assert.throws(
    () => validateComposedReferenceGameRoot({ ...withoutChat, chatProblem: "unread" }),
    ComposedReferenceGameProtocolError,
  );
});

test("the mirror binds the two halves to one browser session only when both are there", () => {
  const withoutChat = root();
  delete withoutChat.chat;

  // A pair from two sessions is a page that would act as one session with another's token.
  assert.throws(
    () => validateComposedReferenceGameRoot(root({ ...gameSnapshot(), csrfToken: OTHER_TOKEN })),
    ComposedReferenceGameProtocolError,
  );
  // With the Chat half absent there is no pair to compare, and the Game half's own route is where its session is
  // bound (`readGameState` compares against the token this client holds).
  assert.equal(
    Object.hasOwn(
      validateComposedReferenceGameRoot({ ...withoutChat, game: { ...gameSnapshot(), csrfToken: OTHER_TOKEN } }),
      "game",
    ),
    true,
  );
});
