import assert from "node:assert/strict";
import test from "node:test";
import type { ComposedReferenceGameBrowserRootV1 } from "./composed-reference-game-browser-api";
import { createReferencePipelineSession, ReferencePipelineSessionError } from "./reference-pipeline-session";
import { worldInfoBindingSource } from "./world-info-binding-source";

/**
 * The two selection generations a World Info command used to be built from.
 *
 * `mounted` is `session.snapshot.selection.generation` - the selection the shell is showing, and the one
 * `applySnapshot` holds the session to (`identityFingerprint` includes it, so a root naming another
 * selection is refused with `state_reconciliation_required` rather than adopted). `live` is
 * `root.chat.selection.generation` from a fresh `readState()`, which is the selection the Host is really
 * mounted on.
 *
 * The defect these cases pin: the panel answered its revision from the fresh root and its generation from
 * the mounted view, so one command carried the NEW selection's `worldInfo.revision` under the OLD
 * selection's generation. The Host checks the generation first, so the refusal named the generation - the
 * one fact that was stale - and said nothing about the revision, which described a different Chat; the
 * refusal's own re-read then moved the panel onto the new Chat, and the player's next press applied the
 * edit there. Neither side wins now: `worldInfoBindingSource` returns `selection_generation_conflict`.
 */

const COMPOSED_PROFILE_ID = "gamebuddy.composed.reference-game";

function chatSnapshot(
  generation: number,
  revision: string,
  selection: ComposedReferenceGameBrowserRootV1["chat"]["selection"] | null = {
    chatHandle: `chat-${generation}`,
    generation,
    stateRevision: `state-${generation}`,
  },
): ComposedReferenceGameBrowserRootV1["chat"] {
  return {
    apiVersion: 1,
    build: {
      browserContract: "tavern_browser_api/v1",
      profileId: "gamebuddy.chat-core.reference-pipeline",
    },
    csrfToken: `csrf-${generation}`,
    browserSession: { expiresAtMs: 1_700_000_000_000 },
    operations: [
      {
        operationId: "chat.submit",
        labelKey: "tavern.operation.submit",
        availability: "available",
        routeId: "chat.submit",
      },
    ],
    navigation: [],
    selection,
    chat: {
      companion: { name: "Companion", handle: "companion-1" },
      title: `chat ${generation}`,
      transcript: [],
      draft: { revision: 0, present: false },
      turn: null,
      worldInfo: {
        state: "selected",
        revision,
        items: [{ handle: "world-info-1", title: "Farm", summary: null, selected: true, pending: false }],
      },
    },
    memory: { readAvailable: true, mutationAvailable: true, projectionRevision: `memory-${generation}` },
    eventStream: null,
  };
}

function root(generation: number, revision: string): ComposedReferenceGameBrowserRootV1 {
  return {
    apiVersion: 1,
    build: { browserContract: "composed_reference_game_browser_api/v1", profileId: COMPOSED_PROFILE_ID },
    chat: chatSnapshot(generation, revision),
    game: null,
  };
}

void test("the mounted session refuses the root that names a moved selection", () => {
  const session = createReferencePipelineSession(chatSnapshot(3, "world-info-rev-3"));
  assert.throws(
    () => session.applySnapshot(chatSnapshot(5, "world-info-rev-5")),
    (error: unknown) =>
      error instanceof ReferencePipelineSessionError && error.code === "state_reconciliation_required",
    "the reducer adopts a snapshot only while its selection identity is unchanged",
  );
  assert.equal(session.snapshot.selection?.generation, 3);
});

void test("a fresh World Info revision is never paired with the mounted generation", () => {
  const source = worldInfoBindingSource(root(5, "world-info-rev-5"), 3);
  assert.deepEqual(source, {
    kind: "selection_generation_conflict",
    mountedSelectionGeneration: 3,
    liveSelectionGeneration: 5,
  });
  assert.equal(
    (source as { worldInfo?: unknown }).worldInfo,
    undefined,
    "a conflict hands out no bindable revision: neither generation is preferred",
  );
});

void test("one read gives one selection: the pair and the generation agree", () => {
  const source = worldInfoBindingSource(root(5, "world-info-rev-5"), 5);
  assert.equal(source.kind, "mounted");
  assert.equal(source.kind === "mounted" ? source.selectionGeneration : null, 5);
  assert.equal(source.kind === "mounted" ? source.worldInfo?.revision : null, "world-info-rev-5");
});

void test("a root with no selection names no generation rather than a stale one", () => {
  const snapshot = chatSnapshot(0, "world-info-rev-5", null);
  const source = worldInfoBindingSource(
    {
      apiVersion: 1,
      build: { browserContract: "composed_reference_game_browser_api/v1", profileId: COMPOSED_PROFILE_ID },
      chat: snapshot,
      game: null,
    },
    3,
  );
  assert.deepEqual(source, {
    kind: "selection_generation_conflict",
    mountedSelectionGeneration: 3,
    liveSelectionGeneration: 0,
  });
});

void test("no mounted session is a reconciliation failure, not generation zero", () => {
  assert.throws(
    () => worldInfoBindingSource(root(5, "world-info-rev-5"), null),
    (error: unknown) =>
      error instanceof ReferencePipelineSessionError && error.code === "state_reconciliation_required",
  );
});
