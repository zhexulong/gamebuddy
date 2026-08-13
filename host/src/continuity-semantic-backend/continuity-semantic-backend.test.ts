import assert from "node:assert/strict";
import test from "node:test";
import { createContinuitySemanticBackend, type ContinuitySemanticBackendStore } from "./continuity-semantic-backend.js";
import type { ContinuityAuthorityCommand } from "../continuity-authority-coordinator/continuity-authority-coordinator.js";
import type {
  GameAbortReason,
  GameCommandKind,
  GamePermit,
} from "../continuity-semantic-store/continuity-semantic-store.js";

const principal = Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" });
const origin = Object.freeze({
  continuityId: principal.continuityId,
  companionId: principal.companionId,
  playerId: principal.playerId,
  chatThreadId: "thread_01",
  chatSurfaceSessionId: "chat_01",
});
const readback = Object.freeze({
  continuityId: principal.continuityId,
  revision: 2,
  fenceEpoch: 2,
  operationId: "op_01",
  gameSessionId: "game_01",
  gameState: "pending",
  originChatState: "active",
  leaseState: "owned" as const,
  pending: true,
  status: "pending" as const,
  abortReason: null,
});
const chatReadback = Object.freeze({
  continuityId: principal.continuityId,
  revision: 2,
  fenceEpoch: 2,
  operationId: "chat_op",
  activeSelection: null,
  thread: Object.freeze({
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "chat_01",
    companionId: principal.companionId,
    lifecycle: "active" as const,
    managementRevision: 1,
    trashRestoreLifecycle: null,
  }),
});
const permitFor = (kind: GameCommandKind): GamePermit =>
  Object.freeze({
    kind,
    continuityId: principal.continuityId,
    operationId: "op_01",
    payloadDigest: "a".repeat(64),
    gameSessionId: "game_01",
    origin,
    world: Object.freeze({ integrationId: "stardew", saveId: "save_01", worldId: "world_01" }),
    bindingDigest: "b".repeat(64),
    fenceEpoch: 2,
    fenceToken: "token",
    deadlineAtMs: 999,
    runtimeInstanceId: "runtime_01",
    ownerPid: 7,
    ownerProcessStartIdentity: "start_01",
  });
const gameCommand = (kind: GameCommandKind): Extract<ContinuityAuthorityCommand, { kind: "game" }> => ({
  kind: "game",
  principal,
  input: {
    kind,
    principal,
    continuityId: principal.continuityId,
    operationId: "op_01",
    gameSessionId: "game_01",
    origin,
    world: permitFor(kind).world,
    bindingDigest: "b".repeat(64),
    expectedPartitionRevision: 1,
    expectedGameRevision: 1,
    expectedLeaseRevision: 1,
    expectedSelectionRevision: 1,
    expectedFenceEpoch: 1,
    deadlineAtMs: 999,
    runtimeInstanceId: "runtime_01",
    ownerPid: 7,
    ownerProcessStartIdentity: "start_01",
  },
});

function fakeStore(overrides: Partial<ContinuitySemanticBackendStore> = {}): ContinuitySemanticBackendStore {
  return {
    selectOpenExactChat: () => chatReadback,
    transitionArchiveLifecycle: () => chatReadback,
    prepareGameOperation: () => ({ outcome: "completed", readback }),
    commitGameOperation: () => readback,
    abortGameOperation: () => readback,
    failGameOperation: () => readback,
    ...overrides,
  };
}

test("maps exact chat operations directly to completed results", () => {
  const calls: string[] = [];
  let selected: unknown;
  const backend = createContinuitySemanticBackend(
    fakeStore({
      selectOpenExactChat(input) {
        selected = input;
        calls.push(`select:${input.operationId}`);
        return chatReadback;
      },
      transitionArchiveLifecycle(input) {
        calls.push(`archive:${input.operationId}`);
        return chatReadback;
      },
    }),
  );
  const select = {
    kind: "chat_select_open",
    principal,
    input: {
      principal,
      continuityId: principal.continuityId,
      companionId: principal.companionId,
      playerId: principal.playerId,
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "chat_01",
      expectedPartitionRevision: 7,
      expectedSelectionRevision: 1,
      expectedFenceEpoch: 1,
      operationId: "select_01",
    },
  } as const;
  const archive = {
    kind: "archive_lifecycle",
    principal,
    input: {
      principal,
      continuityId: principal.continuityId,
      companionId: principal.companionId,
      playerId: principal.playerId,
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "chat_01",
      expectedManagementRevision: 1,
      expectedFenceEpoch: 1,
      operationId: "archive_01",
      operation: "archive",
    },
  } as const;
  assert.deepEqual(backend.prepare(select), { state: "completed", result: chatReadback });
  assert.deepEqual(backend.prepare(archive), { state: "completed", result: chatReadback });
  assert.deepEqual(calls, ["select:select_01", "archive:archive_01"]);
  assert.equal(selected, select.input);
  assert.equal((selected as { expectedPartitionRevision: number }).expectedPartitionRevision, 7);
});

test("maps every game prepare outcome and effect kind without altering readback", () => {
  const cases: readonly [
    GameCommandKind,
    "effect_owned" | "effect_pending" | "completed" | "aborted" | "recovery_required",
    string,
  ][] = [
    ["game_enter", "effect_owned", "bootstrap_game_runtime"],
    ["game_return", "effect_owned", "teardown_game_runtime"],
    ["lease_release", "effect_owned", "release_game_runtime"],
    ["game_recovery", "effect_owned", "recover_game_runtime"],
    ["game_enter", "effect_pending", ""],
    ["game_enter", "completed", ""],
    ["game_enter", "aborted", ""],
    ["game_enter", "recovery_required", ""],
  ];
  for (const [kind, outcome, effectKind] of cases) {
    const permit = permitFor(kind);
    const backend = createContinuitySemanticBackend(
      fakeStore({
        prepareGameOperation: () =>
          outcome === "effect_owned" ? { outcome, permit, readback } : { outcome, readback },
      }),
    );
    const result = backend.prepare(gameCommand(kind));
    if (outcome === "effect_owned") {
      assert.equal(result.state, "effect_owned");
      if (result.state === "effect_owned") {
        assert.equal(result.permit, permit);
        assert.equal(result.effect.kind, effectKind);
        assert.equal(result.effect.permit, permit);
      }
    } else if (outcome === "effect_pending") assert.deepEqual(result, { state: "effect_pending", result: readback });
    else assert.deepEqual(result, { state: "completed", result: readback });
  }
});

test("projects the exact permit origin principal for terminal store operations", () => {
  const calls: unknown[] = [];
  const permit = permitFor("game_enter");
  const receipt = Object.freeze({
    kind: "runtime_bootstrapped" as const,
    operationId: permit.operationId,
    gameSessionId: permit.gameSessionId,
    bindingDigest: permit.bindingDigest,
    origin: permit.origin,
    world: permit.world,
    runtimeInstanceId: permit.runtimeInstanceId,
    ownerPid: permit.ownerPid,
    ownerProcessStartIdentity: permit.ownerProcessStartIdentity,
    occurredAtMs: 1,
  });
  const backend = createContinuitySemanticBackend(
    fakeStore({
      commitGameOperation(input) {
        calls.push(input);
        return readback;
      },
      abortGameOperation(input) {
        calls.push(input);
        return readback;
      },
      failGameOperation(input) {
        calls.push(input);
        return readback;
      },
    }),
  );
  const reason: GameAbortReason = "host_shutdown";
  assert.equal(backend.commit(permit, receipt), readback);
  assert.equal(backend.abort(permit, reason), readback);
  assert.deepEqual(
    backend.effectFailed(
      Object.freeze({ continuityId: "wrong", companionId: "wrong", playerId: "wrong" }),
      permit,
      "effect_failed",
    ),
    { state: "effect_failed", result: readback },
  );
  for (const call of calls as Array<{ principal: unknown; permit: unknown }>) {
    assert.deepEqual(call.principal, principal);
    assert.equal(call.permit, permit);
  }
  assert.equal((calls[0] as { receipt: unknown }).receipt, receipt);
  assert.equal((calls[1] as { reason: unknown }).reason, reason);
  assert.equal((calls[2] as { reason: unknown }).reason, "effect_failed");
});

test("passes store errors through directly and exposes no lifecycle mount", () => {
  const prepareFailure = new Error("prepare_failure");
  const commitFailure = new Error("commit_failure");
  const abortFailure = new Error("abort_failure");
  const failFailure = new Error("fail_failure");
  const permit = permitFor("game_enter");
  const backend = createContinuitySemanticBackend(
    fakeStore({
      prepareGameOperation() {
        throw prepareFailure;
      },
      commitGameOperation() {
        throw commitFailure;
      },
      abortGameOperation() {
        throw abortFailure;
      },
      failGameOperation() {
        throw failFailure;
      },
    }),
  );
  assert.throws(
    () => backend.prepare(gameCommand("game_enter")),
    (error: Error) => error === prepareFailure,
  );
  assert.throws(
    () => backend.commit(permit, {} as never),
    (error: Error) => error === commitFailure,
  );
  assert.throws(
    () => backend.abort(permit, "cancelled"),
    (error: Error) => error === abortFailure,
  );
  assert.throws(
    () => backend.effectFailed(principal, permit, "effect_failed"),
    (error: Error) => error === failFailure,
  );
  assert.ok(Object.isFrozen(backend));
  assert.equal("open" in backend, false);
  assert.equal("close" in backend, false);
  assert.equal("adopt" in backend, false);
});
