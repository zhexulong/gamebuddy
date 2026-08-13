import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonicalSha256,
  collectQuiescentLegacyContinuitySnapshot,
  createQuiescentLegacyContinuitySnapshot,
  validateQuiescentLegacyContinuitySnapshot,
  type CurrentV3Ledger,
  type ExistingGameOwner,
  type LegacyPartitionReader,
} from "./continuity-production-migration.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const event = (
  type:
    | "session_created"
    | "surface_suspended"
    | "surface_resumed"
    | "surface_return_started"
    | "surface_recovery_required"
    | "surface_ended",
  sessionId: string,
  surface: "chat" | "game",
  occurredAtMs: number,
) => ({ eventId: hash(`${type}:${sessionId}:${occurredAtMs}`), type, sessionId, surface, occurredAtMs });
const origin = {
  chatThreadId: "thread1",
  chatSurfaceSessionId: "chat1",
  playerId: "player1",
  companionId: "companion1",
  continuityId: "continuity1",
};
const world = { integrationId: "stardew", saveId: "save1", worldId: "world1" };
function facts() {
  const ledger: CurrentV3Ledger = {
    schemaVersion: 3,
    continuityId: "continuity1",
    companionId: "companion1",
    playerId: "player1",
    sessions: [
      {
        sessionId: "chat1",
        surface: "chat",
        state: "active",
        createdAtMs: 10,
        updatedAtMs: 10,
        origin: null,
        world: null,
        returnChatSessionId: null,
      },
    ],
    events: [event("session_created", "chat1", "chat", 10)],
  };
  return {
    continuityId: "continuity1",
    legacyLedger: ledger,
    chatThreads: [{ ...origin, lifecycle: "active" as const, managementRevision: 4, trashRestoreLifecycle: null }],
    activeSelections: [{ chatThreadId: "thread1", chatSurfaceSessionId: "chat1", selectionRevision: 7 }],
    gameOwner: null,
  };
}
function build(overrides: Partial<ReturnType<typeof facts>> = {}) {
  return createQuiescentLegacyContinuitySnapshot({ ...facts(), ...overrides });
}

test("canonical snapshot hash is independent of object key and source collection order", () => {
  const left = build();
  const factsWithHistory = facts();
  const ended = {
    sessionId: "chat2",
    surface: "chat" as const,
    state: "ended" as const,
    createdAtMs: 11,
    updatedAtMs: 12,
    origin: null,
    world: null,
    returnChatSessionId: null,
  };
  const right = build({
    legacyLedger: {
      ...factsWithHistory.legacyLedger,
      sessions: [ended, ...factsWithHistory.legacyLedger.sessions],
      events: [
        event("surface_ended", "chat2", "chat", 12),
        event("session_created", "chat2", "chat", 11),
        ...factsWithHistory.legacyLedger.events,
      ],
    },
    chatThreads: [
      {
        chatThreadId: "thread2",
        chatSurfaceSessionId: "chat2",
        companionId: "companion1",
        playerId: "player1",
        continuityId: "continuity1",
        lifecycle: "archived",
        managementRevision: 2,
        trashRestoreLifecycle: null,
      },
      ...factsWithHistory.chatThreads,
    ],
  } as never);
  const reordered = build({
    legacyLedger: {
      ...right.legacyLedger,
      sessions: [...right.legacyLedger.sessions].reverse(),
      events: [...right.legacyLedger.events].reverse(),
    },
    chatThreads: [...right.chatThreads].reverse(),
    activeSelections: [...facts().activeSelections].reverse(),
  } as never);
  assert.equal(right.snapshotHash, reordered.snapshotHash);
  assert.equal(left.snapshotHash, build().snapshotHash);
  assert.equal(
    left.snapshotHash,
    canonicalSha256({
      snapshotVersion: 1,
      continuityId: left.continuityId,
      companionId: left.companionId,
      playerId: left.playerId,
      legacyLedger: left.legacyLedger,
      chatThreads: left.chatThreads,
      activeSelection: left.activeSelection,
      gameOwner: left.gameOwner,
    }),
  );
  validateQuiescentLegacyContinuitySnapshot(left);
  assert.throws(
    () => validateQuiescentLegacyContinuitySnapshot({ ...left, snapshotHash: "0".repeat(64) }),
    /hash_mismatch/,
  );
});

test("injected readers are collected without legacy mutation", async () => {
  const source = facts();
  let calls = 0;
  const reader: LegacyPartitionReader = {
    async readCurrentV3Ledger() {
      calls++;
      return source.legacyLedger;
    },
    async readExactChatThreadMetadata() {
      calls++;
      return source.chatThreads;
    },
    async readActiveSelections() {
      calls++;
      return source.activeSelections;
    },
    async readExistingGameOwner() {
      calls++;
      return source.gameOwner;
    },
  };
  const before = JSON.stringify(source);
  const snapshot = await collectQuiescentLegacyContinuitySnapshot("continuity1", reader);
  assert.equal(calls, 4);
  assert.equal(JSON.stringify(source), before);
  assert.notEqual(snapshot.legacyLedger, source.legacyLedger);
  assert.ok(Object.isFrozen(snapshot));
});

test("fails closed for malformed version, Chat pairing/selection, event integrity, and unresolved Game ownership", () => {
  assert.throws(() => build({ legacyLedger: { ...facts().legacyLedger, schemaVersion: 2 as never } }), /current_v3/);
  assert.throws(
    () => build({ chatThreads: [{ ...facts().chatThreads[0]!, chatSurfaceSessionId: "missing" as string }] }),
    /chat_thread_session_mismatch/,
  );
  assert.throws(() => build({ activeSelections: [] }), /active_chat_selection_mismatch/);
  assert.throws(
    () =>
      build({
        activeSelections: [...facts().activeSelections, { ...facts().activeSelections[0]!, selectionRevision: 8 }],
      }),
    /multiple_active/,
  );
  assert.throws(() => build({ legacyLedger: { ...facts().legacyLedger, events: [] } }), /event_integrity/);
  assert.throws(
    () =>
      build({
        legacyLedger: { ...facts().legacyLedger, events: [{ ...facts().legacyLedger.events[0]!, surface: "game" }] },
      }),
    /event_session_mismatch/,
  );
  assert.throws(
    () =>
      build({
        legacyLedger: {
          ...facts().legacyLedger,
          events: [{ ...facts().legacyLedger.events[0]!, type: "surface_resumed" }],
        },
      }),
    /transition/,
  );
  assert.throws(
    () =>
      build({
        legacyLedger: { ...facts().legacyLedger, events: [{ ...facts().legacyLedger.events[0]!, occurredAtMs: 9 }] },
      }),
    /event_session_mismatch/,
  );
  const game = {
    sessionId: "game1",
    surface: "game" as const,
    state: "active" as const,
    createdAtMs: 11,
    updatedAtMs: 11,
    origin,
    world,
    returnChatSessionId: "chat1",
  };
  const gameLedger = {
    schemaVersion: 3 as const,
    continuityId: "continuity1",
    companionId: "companion1",
    playerId: "player1",
    sessions: [{ ...facts().legacyLedger.sessions[0]!, state: "suspended" as const, updatedAtMs: 11 }, game],
    events: [
      event("session_created", "chat1", "chat", 10),
      event("surface_suspended", "chat1", "chat", 11),
      event("session_created", "game1", "game", 11),
    ],
  };
  const owner: ExistingGameOwner = {
    gameSessionId: "game1",
    bindingDigest: "a".repeat(64),
    ownerToken: "token1",
    runtimeInstanceId: "runtime1",
    ownerPid: 1,
    ownerProcessStartIdentity: "start1",
    origin,
    world,
    state: "owned",
  };
  const base = {
    ...facts(),
    legacyLedger: gameLedger,
    chatThreads: [{ ...facts().chatThreads[0]!, lifecycle: "archived" as const }],
    activeSelections: [],
    gameOwner: owner,
  };
  assert.throws(() => createQuiescentLegacyContinuitySnapshot({ ...base, gameOwner: null }), /owner_presence/);
  assert.throws(
    () =>
      createQuiescentLegacyContinuitySnapshot({
        ...base,
        gameOwner: { ...owner, origin: { ...origin, playerId: "other" } },
      }),
    /invalid_game_owner_scope/,
  );
  const accepted = createQuiescentLegacyContinuitySnapshot(base);
  assert.deepEqual(accepted.gameOwner, owner);
});

test("rejects missing, blank, or mismatched durable partition player identity", () => {
  assert.throws(() => build({ legacyLedger: { ...facts().legacyLedger, playerId: "" } as never }), /current_v3/);
  assert.throws(
    () => build({ chatThreads: [{ ...facts().chatThreads[0]!, playerId: "other" }] }),
    /chat_thread_metadata/,
  );
  assert.throws(
    () => build({ legacyLedger: { ...facts().legacyLedger, companionId: "other" } as never }),
    /chat_thread_metadata/,
  );
});

test("preserves trash restore target and recovery-required Game transition", () => {
  const game = {
    sessionId: "game1",
    surface: "game" as const,
    state: "recovery_required" as const,
    createdAtMs: 11,
    updatedAtMs: 12,
    origin,
    world,
    returnChatSessionId: "chat1",
  };
  const owner: ExistingGameOwner = {
    gameSessionId: "game1",
    bindingDigest: "a".repeat(64),
    ownerToken: "token1",
    runtimeInstanceId: "runtime1",
    ownerPid: 1,
    ownerProcessStartIdentity: "start1",
    origin,
    world,
    state: "recovery_required",
  };
  const value = createQuiescentLegacyContinuitySnapshot({
    ...facts(),
    legacyLedger: {
      schemaVersion: 3,
      continuityId: "continuity1",
      companionId: "companion1",
      playerId: "player1",
      sessions: [{ ...facts().legacyLedger.sessions[0]!, state: "suspended", updatedAtMs: 11 }, game],
      events: [
        event("session_created", "chat1", "chat", 10),
        event("surface_suspended", "chat1", "chat", 11),
        event("session_created", "game1", "game", 11),
        event("surface_recovery_required", "game1", "game", 12),
      ],
    },
    chatThreads: [{ ...facts().chatThreads[0]!, lifecycle: "trashed", trashRestoreLifecycle: "archived" }],
    activeSelections: [],
    gameOwner: owner,
  });
  assert.equal(value.chatThreads[0]?.trashRestoreLifecycle, "archived");
  assert.equal(value.legacyLedger.events.at(-1)?.type, "surface_recovery_required");
  validateQuiescentLegacyContinuitySnapshot(value);
  assert.throws(
    () =>
      createQuiescentLegacyContinuitySnapshot({
        ...facts(),
        chatThreads: [{ ...facts().chatThreads[0]!, lifecycle: "trashed", trashRestoreLifecycle: null }],
      }),
    /invalid_chat_thread_metadata/,
  );
  assert.throws(
    () =>
      createQuiescentLegacyContinuitySnapshot({
        ...facts(),
        chatThreads: [{ ...facts().chatThreads[0]!, lifecycle: "active", trashRestoreLifecycle: "archived" }],
      }),
    /invalid_chat_thread_metadata/,
  );
});
