import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createQuiescentLegacyContinuitySnapshot,
  type LegacyContinuitySnapshot,
} from "../continuity-production-migration/continuity-production-migration.js";
import {
  ContinuityCommandError,
  openContinuitySemanticStore,
  previousRuntimeOwnerAlive,
  previousRuntimeOwnerAmbiguous,
  previousRuntimeOwnerMismatch,
  previousRuntimeOwnerProvenDead,
  previousRuntimeOwnerUnavailable,
  withImmediateTransaction,
  type GameCommand,
  type GamePermit,
  type GameTerminalReceipt,
  type PreviousRuntimeOwnerVerificationResult,
  type PreviousRuntimeOwnerVerifier,
} from "./continuity-semantic-store.js";
import { DatabaseSync } from "node:sqlite";

const eventId = (type: string, id: string, at: number) =>
  createHash("sha256").update(`${type}:${id}:${at}`).digest("hex");
const digest = "a".repeat(64);
const origin = {
  chatThreadId: "thread1",
  chatSurfaceSessionId: "chat1",
  playerId: "player1",
  companionId: "companion1",
  continuityId: "continuity1",
} as const;
const principal = { continuityId: "continuity1", companionId: "companion1", playerId: "player1" } as const;
const world = { integrationId: "stardew", saveId: "save1", worldId: "world1" } as const;
function snapshot(overrides: Record<string, unknown> = {}): LegacyContinuitySnapshot {
  return createQuiescentLegacyContinuitySnapshot({
    continuityId: "continuity1",
    legacyLedger: {
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
      events: [
        {
          eventId: eventId("session_created", "chat1", 10),
          type: "session_created",
          sessionId: "chat1",
          surface: "chat",
          occurredAtMs: 10,
        },
      ],
    },
    chatThreads: [
      {
        chatThreadId: "thread1",
        chatSurfaceSessionId: "chat1",
        companionId: "companion1",
        playerId: "player1",
        continuityId: "continuity1",
        lifecycle: "active",
        managementRevision: 7,
        trashRestoreLifecycle: null,
      },
    ],
    activeSelections: [{ chatThreadId: "thread1", chatSurfaceSessionId: "chat1", selectionRevision: 3 }],
    gameOwner: null,
    ...overrides,
  } as never);
}
function removeFixtureRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
function harness(now = 1000, previousRuntimeOwnerVerifier?: PreviousRuntimeOwnerVerifier) {
  const root = mkdtempSync(`${tmpdir()}/semantic-`);
  const store = openContinuitySemanticStore({ runtimeRoot: root, nowMs: () => now, previousRuntimeOwnerVerifier });
  let disposed = false;
  return {
    root,
    store,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      store.close();
      removeFixtureRoot(root);
    },
  };
}
function command(
  kind: GameCommand["kind"],
  op: string,
  revisions = { partition: 1, game: 0, lease: 0, fence: 1 },
): GameCommand {
  return {
    kind,
    principal,
    continuityId: "continuity1",
    operationId: op,
    gameSessionId: "game1",
    origin,
    world,
    bindingDigest: digest,
    expectedPartitionRevision: revisions.partition,
    expectedGameRevision: revisions.game,
    expectedLeaseRevision: revisions.lease,
    expectedSelectionRevision: 3,
    expectedFenceEpoch: revisions.fence,
    deadlineAtMs: 2000,
    runtimeInstanceId: "runtime1",
    ownerPid: 42,
    ownerProcessStartIdentity: "start1",
  };
}
function receipt(permit: GamePermit, overrides: Partial<GameTerminalReceipt> = {}): GameTerminalReceipt {
  return {
    kind:
      permit.kind === "game_enter"
        ? "runtime_bootstrapped"
        : permit.kind === "game_return"
          ? "runtime_torn_down"
          : permit.kind === "lease_release"
            ? "lease_released"
            : "recovery_completed",
    operationId: permit.operationId,
    gameSessionId: permit.gameSessionId,
    bindingDigest: permit.bindingDigest,
    origin: permit.origin,
    world: permit.world,
    runtimeInstanceId: "runtime1",
    ownerPid: 42,
    ownerProcessStartIdentity: "start1",
    occurredAtMs: 1000,
    ...overrides,
  };
}
function code(action: () => unknown, expected: string) {
  assert.throws(action, (e: unknown) => e instanceof ContinuityCommandError && e.code === expected);
}
function enter(h: ReturnType<typeof harness>) {
  h.store.adoptLegacyPartition(snapshot());
  const p = h.store.prepareGameCommand(command("game_enter", "enter"));
  return {
    p,
    r: h.store.commitGameTerminal({
      principal,
      permit: p,
      receipt: receipt(p),
      expectedPartitionRevision: 2,
      expectedGameRevision: 1,
      expectedLeaseRevision: 1,
      expectedSelectionRevision: 3,
      expectedFenceEpoch: 2,
    }),
  };
}

test("adoption preserves managementRevision and exact canonical snapshot facts", () => {
  const h = harness();
  try {
    const input = snapshot();
    const adopted = h.store.adoptLegacyPartition(input);
    assert.deepEqual(h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" }), adopted);
    assert.equal(adopted.threads[0]?.managementRevision, 7);
  } finally {
    h.store.close();
    h.dispose();
  }
});
test("principal mismatch rejects Chat, game enter, and recovery without payload override", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(snapshot());
    const wrong = { ...principal, playerId: "other" };
    code(
      () =>
        h.store.selectOpenExactChat({
          principal: wrong,
          continuityId: "continuity1",
          companionId: "companion1",
          playerId: "other",
          chatThreadId: "thread1",
          chatSurfaceSessionId: "chat1",
          expectedPartitionRevision: 1,
          expectedSelectionRevision: 3,
          expectedFenceEpoch: 1,
          operationId: "select",
        }),
      "exact_principal_required",
    );
    code(
      () =>
        h.store.transitionArchiveLifecycle({
          principal: wrong,
          continuityId: "continuity1",
          companionId: "companion1",
          playerId: "other",
          chatThreadId: "thread1",
          chatSurfaceSessionId: "chat1",
          expectedManagementRevision: 7,
          expectedFenceEpoch: 1,
          operationId: "archive",
          operation: "archive",
        }),
      "exact_principal_required",
    );
    code(
      () =>
        h.store.prepareGameCommand({
          ...command("game_enter", "wrong-enter"),
          principal: wrong,
          origin: { ...origin, playerId: "other" },
        }),
      "exact_principal_required",
    );
    recoveryState(h);
    code(
      () =>
        h.store.prepareGameCommand({
          ...command("game_recovery", "wrong-recovery", { partition: 5, game: 3, lease: 2, fence: 5 }),
          principal: wrong,
          origin: { ...origin, playerId: "other" },
          runtimeInstanceId: "runtime2",
          ownerPid: 43,
          ownerProcessStartIdentity: "start2",
        }),
      "exact_principal_required",
    );
  } finally {
    h.store.close();
    h.dispose();
  }
});

test("same canonical snapshot replay is idempotent", () => {
  const h = harness();
  try {
    assert.deepEqual(h.store.adoptLegacyPartition(snapshot()), h.store.adoptLegacyPartition(snapshot()));
  } finally {
    h.store.close();
    h.dispose();
  }
});
test("adoption atomically rejects a tampered snapshot", () => {
  const h = harness();
  try {
    const value = snapshot();
    assert.throws(() => h.store.adoptLegacyPartition({ ...value, snapshotHash: "0".repeat(64) }), /hash/);
    assert.equal(h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" }), null);
  } finally {
    h.store.close();
    h.dispose();
  }
});
test("immediate transactions reject async callbacks", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.throws(() => withImmediateTransaction(db, () => Promise.resolve() as never), /async/);
  } finally {
    db.close();
  }
});
test("fixture disposal closes its owned store, supports a closed/reopened sequence, and removes only its root", () => {
  const h = harness();
  const root = h.root;
  try {
    h.store.adoptLegacyPartition(snapshot());
    h.store.close();
    const reopened = openContinuitySemanticStore({ runtimeRoot: root });
    try {
      assert.ok(reopened.readAuthoritativeSnapshot({ continuityId: "continuity1" }));
    } finally {
      reopened.close();
    }
  } finally {
    h.dispose();
    h.dispose();
  }
  assert.equal(existsSync(root), false);
});

test("Game return resumes only its durable exact origin and terminal retry replays", () => {
  const h = harness();
  try {
    enter(h);
    const p = h.store.prepareGameCommand(
      command("game_return", "return", { partition: 3, game: 2, lease: 1, fence: 3 }),
    );
    const terminal = {
      principal,
      permit: p,
      receipt: receipt(p),
      expectedPartitionRevision: 4,
      expectedGameRevision: 2,
      expectedLeaseRevision: 2,
      expectedSelectionRevision: 3,
      expectedFenceEpoch: 4,
    };
    const first = h.store.commitGameTerminal(terminal);
    assert.equal(first.originChatState, "active");
    assert.equal(first.gameState, "ended");
    assert.equal(first.leaseState, null);
    assert.deepEqual(h.store.commitGameTerminal(terminal), first);
  } finally {
    h.store.close();
    h.dispose();
  }
});
test("same operation payload replays prepared permit and different payload conflicts", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(snapshot());
    const c = command("game_enter", "same");
    assert.deepEqual(h.store.prepareGameCommand(c), h.store.prepareGameCommand(c));
    code(() => h.store.prepareGameCommand({ ...c, bindingDigest: "b".repeat(64) }), "operation_payload_conflict");
  } finally {
    h.store.close();
    h.dispose();
  }
});
test("lease release never leaves active Game lease-less", () => {
  const h = harness();
  try {
    enter(h);
    const p = h.store.prepareGameCommand(
      command("lease_release", "release", { partition: 3, game: 2, lease: 1, fence: 3 }),
    );
    const r = h.store.commitGameTerminal({
      principal,
      permit: p,
      receipt: receipt(p),
      expectedPartitionRevision: 4,
      expectedGameRevision: 2,
      expectedLeaseRevision: 1,
      expectedSelectionRevision: 3,
      expectedFenceEpoch: 4,
    });
    assert.equal(r.gameState, "recovery_required");
    assert.equal(r.leaseState, "recovery_required");
  } finally {
    h.store.close();
    h.dispose();
  }
});
function recoveryState(h: ReturnType<typeof harness>) {
  enter(h);
  const release = h.store.prepareGameCommand(
    command("lease_release", "release", { partition: 3, game: 2, lease: 1, fence: 3 }),
  );
  h.store.commitGameTerminal({
    principal,
    permit: release,
    receipt: receipt(release),
    expectedPartitionRevision: 4,
    expectedGameRevision: 2,
    expectedLeaseRevision: 1,
    expectedSelectionRevision: 3,
    expectedFenceEpoch: 4,
  });
}
function recoveryCommand() {
  return {
    ...command("game_recovery", "recover", { partition: 5, game: 3, lease: 2, fence: 5 }),
    runtimeInstanceId: "runtime2",
    ownerPid: 43,
    ownerProcessStartIdentity: "start2",
    recoveryRequestId: "request1",
  };
}
const deadVerifier: PreviousRuntimeOwnerVerifier = {
  verifyPreviousRuntimeOwner: (owner) => previousRuntimeOwnerProvenDead(owner),
};
test("recovery verifier uses durable owner and replacement commits only from a valid terminal receipt", () => {
  const seen: unknown[] = [];
  const verifier: PreviousRuntimeOwnerVerifier = {
    verifyPreviousRuntimeOwner: (owner) => {
      seen.push(owner);
      return previousRuntimeOwnerProvenDead(owner);
    },
  };
  const invalid = harness(1000, verifier);
  try {
    recoveryState(invalid);
    const p = invalid.store.prepareGameCommand(recoveryCommand());
    assert.deepEqual(seen[0], {
      ownerToken: "pending",
      runtimeInstanceId: "runtime1",
      ownerPid: 42,
      ownerProcessStartIdentity: "start1",
    });
    code(
      () =>
        invalid.store.commitGameTerminal({
          principal,
          permit: p,
          receipt: receipt(p),
          expectedPartitionRevision: 6,
          expectedGameRevision: 3,
          expectedLeaseRevision: 2,
          expectedSelectionRevision: 3,
          expectedFenceEpoch: 6,
        }),
      "receipt_invalid",
    );
    assert.equal(
      invalid.store.readAuthoritativeSnapshot({ continuityId: "continuity1" })?.lease?.runtimeInstanceId,
      "runtime1",
    );
  } finally {
    invalid.store.close();
    invalid.dispose();
  }
  const valid = harness(1000, verifier);
  try {
    recoveryState(valid);
    const p = valid.store.prepareGameCommand(recoveryCommand());
    assert.equal(
      valid.store.commitGameTerminal({
        principal,
        permit: p,
        receipt: receipt(p, { runtimeInstanceId: "runtime2", ownerPid: 43, ownerProcessStartIdentity: "start2" }),
        expectedPartitionRevision: 6,
        expectedGameRevision: 3,
        expectedLeaseRevision: 2,
        expectedSelectionRevision: 3,
        expectedFenceEpoch: 6,
      }).leaseState,
      "owned",
    );
    assert.equal(
      valid.store.readAuthoritativeSnapshot({ continuityId: "continuity1" })?.lease?.runtimeInstanceId,
      "runtime2",
    );
  } finally {
    valid.store.close();
    valid.dispose();
  }
});
test("unavailable throw alive ambiguous mismatch verifier fail closed", () => {
  for (const verifier of [
    undefined,
    { verifyPreviousRuntimeOwner: () => previousRuntimeOwnerUnavailable() },
    {
      verifyPreviousRuntimeOwner: () => {
        throw Error("x");
      },
    },
    { verifyPreviousRuntimeOwner: (owner) => previousRuntimeOwnerAlive(owner) },
    { verifyPreviousRuntimeOwner: (owner) => previousRuntimeOwnerAmbiguous(owner) },
    { verifyPreviousRuntimeOwner: () => previousRuntimeOwnerMismatch() },
  ] as readonly (PreviousRuntimeOwnerVerifier | undefined)[]) {
    const h = harness(1000, verifier);
    try {
      recoveryState(h);
      code(() => h.store.prepareGameCommand(recoveryCommand()), "game_transition_invalid");
    } finally {
      h.store.close();
      h.dispose();
    }
  }
});
test("recovery rejects a forged proven-dead result assembled from every public unavailable-factory field", () => {
  const unavailable = previousRuntimeOwnerUnavailable();
  const discoveredKeys = Reflect.ownKeys(unavailable);
  assert.deepEqual(Object.getOwnPropertySymbols(unavailable), []);
  assert.deepEqual(Object.getOwnPropertyNames(unavailable).sort(), ["owner", "status"]);
  assert(Object.isFrozen(unavailable));
  const verifier: PreviousRuntimeOwnerVerifier = {
    verifyPreviousRuntimeOwner: (owner) => {
      const discovered = Object.fromEntries(
        discoveredKeys.map((key) => [key, unavailable[key as keyof typeof unavailable]]),
      );
      return Object.freeze({ ...discovered, status: "proven_dead", owner }) as PreviousRuntimeOwnerVerificationResult;
    },
  };
  const h = harness(1000, verifier);
  try {
    recoveryState(h);
    const before = h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" });
    code(() => h.store.prepareGameCommand(recoveryCommand()), "game_transition_invalid");
    assert.deepEqual(h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" }), before);
  } finally {
    h.store.close();
    h.dispose();
  }
});
test("caller liveness fields do not influence verifier", () => {
  const seen: unknown[] = [];
  const h = harness(1000, {
    verifyPreviousRuntimeOwner: (owner) => {
      seen.push(owner);
      return previousRuntimeOwnerProvenDead(owner);
    },
  });
  try {
    recoveryState(h);
    h.store.prepareGameCommand({
      ...recoveryCommand(),
      processDead: false,
      processStartIdentityMatches: false,
    } as unknown as GameCommand);
    assert.equal((seen[0] as { runtimeInstanceId: string }).runtimeInstanceId, "runtime1");
    code(
      () =>
        h.store.prepareGameCommand({
          ...recoveryCommand(),
          operationId: "same",
          runtimeInstanceId: "runtime1",
          ownerPid: 42,
          ownerProcessStartIdentity: "start1",
          expectedPartitionRevision: 6,
          expectedGameRevision: 3,
          expectedLeaseRevision: 2,
          expectedFenceEpoch: 6,
        }),
      "game_transition_invalid",
    );
  } finally {
    h.store.close();
    h.dispose();
  }
});
test("terminal enforces expected fence token, epoch, and receipt identity bindings", () => {
  const h = harness();
  try {
    enter(h);
    const p = h.store.prepareGameCommand(
      command("game_return", "return", { partition: 3, game: 2, lease: 1, fence: 3 }),
    );
    const base = {
      principal,
      permit: p,
      receipt: receipt(p),
      expectedPartitionRevision: 4,
      expectedGameRevision: 2,
      expectedLeaseRevision: 2,
      expectedSelectionRevision: 3,
      expectedFenceEpoch: 4,
    };
    code(() => h.store.commitGameTerminal({ ...base, expectedFenceEpoch: 3 }), "fence_conflict");
    code(() => h.store.commitGameTerminal({ ...base, permit: { ...p, fenceToken: "other" } }), "permit_conflict");
    code(
      () => h.store.commitGameTerminal({ ...base, receipt: receipt(p, { runtimeInstanceId: "wrong" }) }),
      "receipt_invalid",
    );
  } finally {
    h.store.close();
    h.dispose();
  }
});
const permitMutations: readonly [string, (p: GamePermit) => GamePermit][] = [
  ["operation", (p) => ({ ...p, operationId: "other" })],
  ["kind", (p) => ({ ...p, kind: "game_return" })],
  ["payload digest", (p) => ({ ...p, payloadDigest: "b".repeat(64) })],
  ["deadline", (p) => ({ ...p, deadlineAtMs: 3000 })],
  ["game session", (p) => ({ ...p, gameSessionId: "othergame" })],
  ["origin", (p) => ({ ...p, origin: { ...p.origin, chatThreadId: "otherthread" } })],
  ["world", (p) => ({ ...p, world: { ...p.world, worldId: "otherworld" } })],
  ["binding", (p) => ({ ...p, bindingDigest: "b".repeat(64) })],
  ["fence epoch", (p) => ({ ...p, fenceEpoch: p.fenceEpoch + 1 })],
  ["fence token", (p) => ({ ...p, fenceToken: "other" })],
  ["runtime owner", (p) => ({ ...p, runtimeInstanceId: "other" })],
  ["owner pid", (p) => ({ ...p, ownerPid: 99 })],
  ["owner process identity", (p) => ({ ...p, ownerProcessStartIdentity: "otherstart" })],
];
function assertExactEnterPending(h: ReturnType<typeof harness>) {
  const durable = h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" });
  assert.equal(durable?.gameSessions[0]?.state, "pending");
  assert.equal(durable?.lease?.state, "owned");
}
for (const [name, mutate] of permitMutations) {
  test(`terminal rejects forged ${name} permit and preserves durable pending intent`, () => {
    const h = harness();
    try {
      h.store.adoptLegacyPartition(snapshot());
      const p = h.store.prepareGameCommand(command("game_enter", "enter"));
      code(
        () =>
          h.store.commitGameTerminal({
            principal,
            permit: mutate(p),
            receipt: receipt(p),
            expectedPartitionRevision: 2,
            expectedGameRevision: 1,
            expectedLeaseRevision: 1,
            expectedSelectionRevision: 3,
            expectedFenceEpoch: 2,
          }),
        "permit_conflict",
      );
      assertExactEnterPending(h);
      h.store.abortGameCommand({ principal, permit: p, expectedFenceEpoch: 2 });
    } finally {
      h.store.close();
      h.dispose();
    }
  });
}
for (const [name, mutate] of permitMutations) {
  test(`abort rejects forged ${name} permit and preserves durable pending intent`, () => {
    const h = harness();
    try {
      h.store.adoptLegacyPartition(snapshot());
      const p = h.store.prepareGameCommand(command("game_enter", "enter"));
      code(() => h.store.abortGameCommand({ principal, permit: mutate(p), expectedFenceEpoch: 2 }), "permit_conflict");
      assertExactEnterPending(h);
      h.store.abortGameCommand({ principal, permit: p, expectedFenceEpoch: 2 });
    } finally {
      h.store.close();
      h.dispose();
    }
  });
}
test("expired prepare writes nothing and late receipt persistently requires recovery", () => {
  const expired = harness(3000);
  try {
    expired.store.adoptLegacyPartition(snapshot());
    code(() => expired.store.prepareGameCommand(command("game_enter", "expired")), "invalid_command");
    assert.equal(expired.store.readAuthoritativeSnapshot({ continuityId: "continuity1" })?.gameSessions.length, 0);
  } finally {
    expired.store.close();
    expired.dispose();
  }
  const h = harness();
  try {
    enter(h);
    const p = h.store.prepareGameCommand(command("game_return", "late", { partition: 3, game: 2, lease: 1, fence: 3 }));
    h.store.close();
    const reopened = openContinuitySemanticStore({ runtimeRoot: h.root, nowMs: () => 3000 });
    code(
      () =>
        reopened.commitGameTerminal({
          principal,
          permit: p,
          receipt: receipt(p, { occurredAtMs: 2000 }),
          expectedPartitionRevision: 4,
          expectedGameRevision: 2,
          expectedLeaseRevision: 2,
          expectedSelectionRevision: 3,
          expectedFenceEpoch: 4,
        }),
      "deadline_expired",
    );
    reopened.close();
    const durable = openContinuitySemanticStore({ runtimeRoot: h.root, nowMs: () => 3000 });
    const readback = durable.readAuthoritativeSnapshot({ continuityId: "continuity1" });
    assert.equal(readback?.gameSessions[0]?.state, "recovery_required");
    assert.equal(readback?.lease?.state, "recovery_required");
    durable.close();
  } finally {
    h.dispose();
  }
});
test("terminal operation replays durable projection after deadline", () => {
  const h = harness();
  try {
    const { p } = enter(h);
    h.store.close();
    const reopened = openContinuitySemanticStore({ runtimeRoot: h.root, nowMs: () => 3000 });
    const terminal = {
      principal,
      permit: p,
      receipt: receipt(p),
      expectedPartitionRevision: 2,
      expectedGameRevision: 1,
      expectedLeaseRevision: 1,
      expectedSelectionRevision: 3,
      expectedFenceEpoch: 2,
    };
    const replay = reopened.commitGameTerminal(terminal);
    assert.equal(replay.gameState, "active");
    assert.equal(replay.leaseState, "owned");
    reopened.close();
  } finally {
    h.dispose();
  }
});

test("prepared revision vectors persist exact prepare-after values and survive conflict and reopen", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(snapshot());
    h.store.prepareGameCommand(command("game_enter", "enter-vector"));
    const enterVector = h.store.readPreparedGameOperationVector({ principal, operationId: "enter-vector" });
    assert.deepEqual(enterVector, {
      partitionRevision: 2,
      gameRevision: 1,
      leaseRevision: 1,
      selectionRevision: 3,
      fenceEpoch: 2,
    });
    h.store.commitGameTerminal({
      principal,
      permit: h.store.prepareGameCommand(command("game_enter", "enter-vector")),
      receipt: receipt(h.store.prepareGameCommand(command("game_enter", "enter-vector"))),
      expectedPartitionRevision: 2,
      expectedGameRevision: 1,
      expectedLeaseRevision: 1,
      expectedSelectionRevision: 3,
      expectedFenceEpoch: 2,
    });
    h.store.prepareGameCommand(command("game_return", "return-vector", { partition: 3, game: 2, lease: 1, fence: 3 }));
    const returnVector = h.store.readPreparedGameOperationVector({ principal, operationId: "return-vector" });
    assert.deepEqual(returnVector, {
      partitionRevision: 4,
      gameRevision: 2,
      leaseRevision: 2,
      selectionRevision: 3,
      fenceEpoch: 4,
    });
    code(
      () =>
        h.store.prepareGameCommand({
          ...command("game_return", "return-vector", { partition: 3, game: 2, lease: 1, fence: 3 }),
          bindingDigest: "b".repeat(64),
        }),
      "operation_payload_conflict",
    );
    assert.deepEqual(
      h.store.readPreparedGameOperationVector({ principal, operationId: "return-vector" }),
      returnVector,
    );
    h.store.close();
    const reopened = openContinuitySemanticStore({ runtimeRoot: h.root, nowMs: () => 1000 });
    assert.deepEqual(
      reopened.readPreparedGameOperationVector({ principal, operationId: "return-vector" }),
      returnVector,
    );
    reopened.close();
  } finally {
    h.dispose();
  }
});

test("operation payload conflict leaves durable pending ownership unchanged", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(snapshot());
    const first = h.store.prepareGameOperation(command("game_enter", "operation-conflict"));
    code(
      () =>
        h.store.prepareGameOperation({ ...command("game_enter", "operation-conflict"), bindingDigest: "b".repeat(64) }),
      "operation_payload_conflict",
    );
    assert.deepEqual(h.store.readGameOperation({ principal, operationId: "operation-conflict" }), first.readback);
  } finally {
    h.store.close();
    h.dispose();
  }
});
test("legacy prepare remains a permit adapter", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(snapshot());
    const input = command("game_enter", "legacy-adapter");
    const permit = h.store.prepareGameCommand(input);
    const operation = h.store.prepareGameOperation(input);
    assert.equal(operation.outcome, "effect_pending");
    assert.ok(!("permit" in operation));
    assert.equal(permit.operationId, "legacy-adapter");
    assert.equal(permit.fenceEpoch, 2);
  } finally {
    h.store.close();
    h.dispose();
  }
});

test("operation commit consumes its durable prepared vector for enter, return, release, and recovery across reopen", () => {
  const h = harness(1000, deadVerifier);
  try {
    h.store.adoptLegacyPartition(snapshot());
    const enterOp = h.store.prepareGameOperation(command("game_enter", "op-enter"));
    assert.equal(enterOp.outcome, "effect_owned");
    if (!("permit" in enterOp)) throw Error("missing permit");
    assert.equal(
      h.store.commitGameOperation({ principal, permit: enterOp.permit, receipt: receipt(enterOp.permit) }).gameState,
      "active",
    );
    const returnOp = h.store.prepareGameOperation(
      command("game_return", "op-return", { partition: 3, game: 2, lease: 1, fence: 3 }),
    );
    if (!("permit" in returnOp)) throw Error("missing permit");
    assert.equal(
      h.store.commitGameOperation({ principal, permit: returnOp.permit, receipt: receipt(returnOp.permit) }).gameState,
      "ended",
    );
    h.store.close();
    const reopened = openContinuitySemanticStore({
      runtimeRoot: h.root,
      nowMs: () => 1000,
      previousRuntimeOwnerVerifier: deadVerifier,
    });
    try {
      const enter2 = reopened.prepareGameOperation({
        ...command("game_enter", "op-enter-2", { partition: 5, game: 0, lease: 0, fence: 5 }),
        gameSessionId: "game2",
      });
      assert.equal(enter2.outcome, "effect_owned");
      if (!("permit" in enter2)) throw Error("missing permit");
      reopened.commitGameOperation({ principal, permit: enter2.permit, receipt: receipt(enter2.permit) });
      const release = reopened.prepareGameOperation({
        ...command("lease_release", "op-release", { partition: 7, game: 2, lease: 1, fence: 7 }),
        gameSessionId: "game2",
      });
      if (!("permit" in release)) throw Error("missing permit");
      assert.equal(
        reopened.commitGameOperation({ principal, permit: release.permit, receipt: receipt(release.permit) }).status,
        "terminal",
      );
      const recover = reopened.prepareGameOperation({
        ...recoveryCommand(),
        operationId: "op-recover",
        gameSessionId: "game2",
        expectedPartitionRevision: 9,
        expectedGameRevision: 3,
        expectedLeaseRevision: 2,
        expectedFenceEpoch: 9,
      });
      if (!("permit" in recover)) throw Error("missing permit");
      const final = reopened.commitGameOperation({
        principal,
        permit: recover.permit,
        receipt: receipt(recover.permit, {
          runtimeInstanceId: "runtime2",
          ownerPid: 43,
          ownerProcessStartIdentity: "start2",
        }),
      });
      assert.equal(final.leaseState, "owned");
      assert.deepEqual(
        reopened.commitGameOperation({
          principal,
          permit: recover.permit,
          receipt: receipt(recover.permit, {
            runtimeInstanceId: "runtime2",
            ownerPid: 43,
            ownerProcessStartIdentity: "start2",
          }),
        }),
        final,
      );
    } finally {
      reopened.close();
    }
  } finally {
    h.dispose();
  }
});

test("operation abort persists exact terminal projection and enter cleanup is safely readable after reopen", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(snapshot());
    const prepared = h.store.prepareGameOperation(command("game_enter", "abort-operation"));
    if (!("permit" in prepared)) throw Error("missing permit");
    const aborted = h.store.abortGameOperation({ principal, permit: prepared.permit, reason: "cancelled" });
    assert.deepEqual(aborted, {
      continuityId: "continuity1",
      revision: 2,
      fenceEpoch: 2,
      operationId: "abort-operation",
      gameSessionId: "game1",
      gameState: "absent",
      originChatState: "active",
      leaseState: null,
      pending: false,
      status: "aborted",
      abortReason: "cancelled",
    });
    assert.deepEqual(h.store.readGameOperation({ principal, operationId: "abort-operation" }), aborted);
    assert.deepEqual(h.store.abortGameOperation({ principal, permit: prepared.permit, reason: "cancelled" }), aborted);
    h.store.close();
    const reopened = openContinuitySemanticStore({ runtimeRoot: h.root, nowMs: () => 1000 });
    assert.deepEqual(reopened.readGameOperation({ principal, operationId: "abort-operation" }), aborted);
    assert.deepEqual(reopened.prepareGameOperation(command("game_enter", "abort-operation")).readback, aborted);
    reopened.close();
  } finally {
    h.dispose();
  }
});

test("terminal replay requires a canonically identical receipt", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(snapshot());
    const prepared = h.store.prepareGameOperation(command("game_enter", "receipt-replay"));
    if (!("permit" in prepared)) throw Error("missing permit");
    const terminal = { principal, permit: prepared.permit, receipt: receipt(prepared.permit) };
    const succeeded = h.store.commitGameOperation(terminal);
    assert.deepEqual(h.store.commitGameOperation(terminal), succeeded);
    for (const changed of [
      receipt(prepared.permit, { kind: "runtime_torn_down" }),
      receipt(prepared.permit, { occurredAtMs: 999 }),
      receipt(prepared.permit, { runtimeInstanceId: "other" }),
      receipt(prepared.permit, { bindingDigest: "b".repeat(64) }),
      receipt(prepared.permit, { origin: { ...origin, chatThreadId: "other" } }),
      receipt(prepared.permit, { world: { ...world, worldId: "other" } }),
    ])
      code(() => h.store.commitGameOperation({ ...terminal, receipt: changed }), "permit_conflict");
    h.store.close();
    const reopened = openContinuitySemanticStore({ runtimeRoot: h.root, nowMs: () => 3000 });
    try {
      assert.deepEqual(reopened.commitGameOperation(terminal), succeeded);
      code(
        () => reopened.commitGameOperation({ ...terminal, receipt: receipt(prepared.permit, { occurredAtMs: 998 }) }),
        "permit_conflict",
      );
    } finally {
      reopened.close();
    }
  } finally {
    h.dispose();
  }
});
function assertTerminalReplayRecoveryFailure(root: string, permit: GamePermit): void {
  const expired = openContinuitySemanticStore({ runtimeRoot: root, nowMs: () => 3000 });
  try {
    const original = receipt(permit, { occurredAtMs: 2000 });
    code(() => expired.commitGameOperation({ principal, permit, receipt: original }), "deadline_expired");
    const read = expired.readGameOperation({ principal, operationId: "failure-replay" });
    assert.equal(read?.status, "recovery_required");
    assert.equal(read?.abortReason, null);
    assert.equal(read?.recoveryReason, "deadline_expired");
    assert.equal(read?.recoveryErrorCode, "deadline_expired");
    assert.deepEqual(read?.recoveryFacts, {
      prepared: { partitionRevision: 2, gameRevision: 1, leaseRevision: 1, selectionRevision: 3, fenceEpoch: 2 },
      final: { partitionRevision: 2, gameRevision: 2, leaseRevision: 2, selectionRevision: 3, fenceEpoch: 2 },
    });
    code(() => expired.commitGameOperation({ principal, permit, receipt: original }), "deadline_expired");
    code(
      () => expired.commitGameOperation({ principal, permit, receipt: receipt(permit, { occurredAtMs: 1999 }) }),
      "permit_conflict",
    );
  } finally {
    expired.close();
  }
}
test("terminal replay persists recovery failures", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(snapshot());
    const prepared = h.store.prepareGameOperation(command("game_enter", "failure-replay"));
    if (!("permit" in prepared)) throw Error("missing permit");
    h.store.close();
    assertTerminalReplayRecoveryFailure(h.root, prepared.permit);
  } finally {
    h.dispose();
  }
});
test("abort operation replay requires its durable abort reason", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(snapshot());
    const prepared = h.store.prepareGameOperation(command("game_enter", "abort-reason"));
    if (!("permit" in prepared)) throw Error("missing permit");
    h.store.abortGameOperation({ principal, permit: prepared.permit, reason: "cancelled" });
    code(
      () => h.store.abortGameOperation({ principal, permit: prepared.permit, reason: "host_shutdown" }),
      "permit_conflict",
    );
  } finally {
    h.store.close();
    h.dispose();
  }
});

for (const kind of ["game_enter", "game_return", "lease_release", "game_recovery"] as const)
  test(`executor receipt-less ${kind} failure durably requires recovery and exactly replays`, () => {
    const h = harness(1000, deadVerifier);
    try {
      h.store.adoptLegacyPartition(snapshot());
      let prepared;
      if (kind === "game_enter") prepared = h.store.prepareGameOperation(command(kind, `failure-${kind}`));
      else {
        const entered = h.store.prepareGameOperation(command("game_enter", `enter-${kind}`));
        if (!("permit" in entered)) throw Error("missing permit");
        h.store.commitGameOperation({ principal, permit: entered.permit, receipt: receipt(entered.permit) });
        if (kind === "lease_release")
          prepared = h.store.prepareGameOperation(
            command(kind, `failure-${kind}`, { partition: 3, game: 2, lease: 1, fence: 3 }),
          );
        else if (kind === "game_return")
          prepared = h.store.prepareGameOperation(
            command(kind, `failure-${kind}`, { partition: 3, game: 2, lease: 1, fence: 3 }),
          );
        else {
          const released = h.store.prepareGameOperation(
            command("lease_release", `release-${kind}`, { partition: 3, game: 2, lease: 1, fence: 3 }),
          );
          if (!("permit" in released)) throw Error("missing permit");
          h.store.commitGameOperation({ principal, permit: released.permit, receipt: receipt(released.permit) });
          prepared = h.store.prepareGameOperation({
            ...recoveryCommand(),
            operationId: `failure-${kind}`,
            expectedPartitionRevision: 5,
            expectedGameRevision: 3,
            expectedLeaseRevision: 2,
            expectedFenceEpoch: 5,
          });
        }
      }
      if (!("permit" in prepared)) throw Error("missing permit");
      const first = h.store.failGameOperation({ principal, permit: prepared.permit, reason: "effect_failed" });
      assert.equal(first.status, "recovery_required");
      assert.equal(first.recoveryReason, "effect_failed");
      assert.equal(first.recoveryErrorCode, "effect_failed");
      assert.equal(first.abortReason, null);
      assert.equal(first.gameState, "recovery_required");
      assert.equal(first.leaseState, "recovery_required");
      assert.deepEqual(
        h.store.failGameOperation({ principal, permit: prepared.permit, reason: "effect_failed" }),
        first,
      );
      assert.equal(
        h.store.prepareGameOperation(
          kind === "game_recovery"
            ? {
                ...recoveryCommand(),
                operationId: `failure-${kind}`,
                expectedPartitionRevision: 5,
                expectedGameRevision: 3,
                expectedLeaseRevision: 2,
                expectedFenceEpoch: 5,
              }
            : kind === "game_enter"
              ? command(kind, `failure-${kind}`)
              : command(kind, `failure-${kind}`, { partition: 3, game: 2, lease: 1, fence: 3 }),
        ).outcome,
        "recovery_required",
      );
      code(
        () =>
          h.store.failGameOperation({
            principal: { ...principal, playerId: "wrong" },
            permit: prepared.permit,
            reason: "effect_failed",
          }),
        "exact_principal_required",
      );
      code(
        () =>
          h.store.failGameOperation({
            principal,
            permit: { ...prepared.permit, fenceToken: "forged" },
            reason: "effect_failed",
          }),
        "permit_conflict",
      );
      code(
        () => h.store.failGameOperation({ principal, permit: prepared.permit, reason: "other" as never }),
        "invalid_command",
      );
    } finally {
      h.store.close();
      h.dispose();
    }
  });

test("legacy terminal and recovery rows without a canonical receipt digest fail closed without mutation", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(snapshot());
    const prepared = h.store.prepareGameOperation(command("game_enter", "legacy-null-digest"));
    if (!("permit" in prepared)) throw Error("missing permit");
    const terminal = { principal, permit: prepared.permit, receipt: receipt(prepared.permit) };
    const succeeded = h.store.commitGameOperation(terminal);
    const path = `${h.root}/gamebuddy-continuity-v1.sqlite`;
    h.store.close();
    let db = new DatabaseSync(path);
    db.prepare(
      "UPDATE game_command_intent SET terminal_receipt_digest=NULL WHERE continuity_id=? AND operation_id=?",
    ).run("continuity1", "legacy-null-digest");
    db.close();
    const reopened = openContinuitySemanticStore({ runtimeRoot: h.root, nowMs: () => 1000 });
    const before = reopened.readAuthoritativeSnapshot({ continuityId: "continuity1" });
    code(() => reopened.commitGameOperation(terminal), "permit_conflict");
    assert.deepEqual(reopened.readAuthoritativeSnapshot({ continuityId: "continuity1" }), before);
    reopened.close();
    assert.equal(succeeded.status, "terminal");
  } finally {
    h.dispose();
  }
  const failed = harness();
  try {
    failed.store.adoptLegacyPartition(snapshot());
    const prepared = failed.store.prepareGameOperation(command("game_enter", "legacy-recovery-null-digest"));
    if (!("permit" in prepared)) throw Error("missing permit");
    failed.store.close();
    const expired = openContinuitySemanticStore({ runtimeRoot: failed.root, nowMs: () => 3000 });
    const terminal = { principal, permit: prepared.permit, receipt: receipt(prepared.permit, { occurredAtMs: 2000 }) };
    code(() => expired.commitGameOperation(terminal), "deadline_expired");
    expired.close();
    const path = `${failed.root}/gamebuddy-continuity-v1.sqlite`;
    const db = new DatabaseSync(path);
    db.prepare(
      "UPDATE game_command_intent SET terminal_receipt_digest=NULL WHERE continuity_id=? AND operation_id=?",
    ).run("continuity1", "legacy-recovery-null-digest");
    db.close();
    const reopened = openContinuitySemanticStore({ runtimeRoot: failed.root, nowMs: () => 3000 });
    const before = reopened.readAuthoritativeSnapshot({ continuityId: "continuity1" });
    code(() => reopened.commitGameOperation(terminal), "permit_conflict");
    assert.deepEqual(reopened.readAuthoritativeSnapshot({ continuityId: "continuity1" }), before);
    reopened.close();
  } finally {
    failed.dispose();
  }
});
test("legacy abortGameCommand is the fixed cancelled canonical abort adapter and replays its persisted readback", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(snapshot());
    const prepared = h.store.prepareGameOperation(command("game_enter", "legacy-abort"));
    if (!("permit" in prepared)) throw Error("missing permit");
    const first = h.store.abortGameCommand({ principal, permit: prepared.permit, expectedFenceEpoch: 2 });
    assert.deepEqual(first, h.store.readGameOperation({ principal, operationId: "legacy-abort" }));
    assert.equal(first.status, "aborted");
    assert.equal(first.abortReason, "cancelled");
    assert.deepEqual(h.store.abortGameCommand({ principal, permit: prepared.permit, expectedFenceEpoch: 2 }), first);
    code(
      () => h.store.abortGameCommand({ principal, permit: prepared.permit, expectedFenceEpoch: 3 }),
      "fence_conflict",
    );
  } finally {
    h.store.close();
    h.dispose();
  }
});

type PhysicalFixtureMode = "malformed-game-session" | "malformed-game-lease" | "malformed-game-intent";
function runPhysicalFixture(mode: PhysicalFixtureMode): void {
  const root = mkdtempSync(`${tmpdir()}/semantic-schema-`);
  const worker = fileURLToPath(new URL("./continuity-semantic-store-physical-fixture-worker.js", import.meta.url));
  const result = spawnSync(process.execPath, [worker, root, mode], { encoding: "utf8" });
  let message: { ok?: boolean; error?: string } | null = null;
  try {
    message = JSON.parse(result.stdout) as { ok?: boolean; error?: string };
  } catch {
    /* exit assertion reports raw worker output */
  }
  assert.equal(existsSync(root), false, `physical fixture worker leaked ${root}`);
  assert.equal(result.status, 0, `physical fixture worker failed: ${result.stderr || result.stdout}`);
  assert.deepEqual(message, { ok: true, mode });
}
test("independent Game physical session signature rejects mutation without changing the fixture", () => {
  runPhysicalFixture("malformed-game-session");
});
test("independent Game physical lease signature rejects mutation without changing the fixture", () => {
  runPhysicalFixture("malformed-game-lease");
});
test("independent Game physical intent signature rejects mutation without changing the fixture", () => {
  runPhysicalFixture("malformed-game-intent");
});

function register(h: ReturnType<typeof harness>, overrides: Record<string, unknown> = {}) {
  return h.store.registerExactChat({
    principal,
    continuityId: principal.continuityId,
    companionId: principal.companionId,
    playerId: principal.playerId,
    chatThreadId: "freshthread",
    chatSurfaceSessionId: "freshchat",
    expectedPartitionRevision: 1,
    expectedFenceEpoch: 1,
    operationId: "register-fresh",
    ...overrides,
  });
}
test("register exact Chat is inert, canonical-replayable, isolated, and survives reopen", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(
      snapshot({
        legacyLedger: { ...snapshot().legacyLedger, sessions: [], events: [] },
        chatThreads: [],
        activeSelections: [],
      }),
    );
    const first = register(h);
    assert.equal(first.activeSelection, null);
    assert.equal(first.thread.managementRevision, 1);
    assert.equal(h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" })?.sessions[0]?.state, "suspended");
    assert.deepEqual(register(h), first);
    code(() => register(h, { chatThreadId: "other" }), "operation_payload_conflict");
    assert.deepEqual(
      h.store.readChatCatalog({ principal }).threads.map((t) => t.chatThreadId),
      ["freshthread"],
    );
    h.store.close();
    const reopened = openContinuitySemanticStore({ runtimeRoot: h.root });
    assert.equal(reopened.readChatCatalog({ principal }).threads[0]?.chatSurfaceSessionId, "freshchat");
    reopened.close();
  } finally {
    h.dispose();
  }
});
test("register exact Chat rejects stale principal and binding collisions without mutation", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(
      snapshot({
        legacyLedger: { ...snapshot().legacyLedger, sessions: [], events: [] },
        chatThreads: [],
        activeSelections: [],
      }),
    );
    code(
      () => register(h, { principal: { ...principal, playerId: "wrong" }, playerId: "wrong" }),
      "exact_principal_required",
    );
    code(() => register(h, { expectedPartitionRevision: 2 }), "game_revision_conflict");
    register(h);
    code(
      () =>
        h.store.registerExactChat({
          principal,
          continuityId: "continuity1",
          companionId: "companion1",
          playerId: "player1",
          chatThreadId: "freshthread",
          chatSurfaceSessionId: "otherchat",
          expectedPartitionRevision: 2,
          expectedFenceEpoch: 2,
          operationId: "collision",
        }),
      "exact_chat_binding_required",
    );
    assert.equal(h.store.readChatCatalog({ principal }).threads.length, 1);
  } finally {
    h.store.close();
    h.dispose();
  }
});
test("selection atomically activates target, suspends prior, and rejects lifecycle or active game", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(
      snapshot({
        legacyLedger: { ...snapshot().legacyLedger, sessions: [], events: [] },
        chatThreads: [],
        activeSelections: [],
      }),
    );
    register(h);
    h.store.registerExactChat({
      principal,
      continuityId: "continuity1",
      companionId: "companion1",
      playerId: "player1",
      chatThreadId: "secondthread",
      chatSurfaceSessionId: "secondchat",
      expectedPartitionRevision: 2,
      expectedFenceEpoch: 2,
      operationId: "register-second",
    });
    let r = h.store.selectOpenExactChat({
      principal,
      continuityId: "continuity1",
      companionId: "companion1",
      playerId: "player1",
      chatThreadId: "freshthread",
      chatSurfaceSessionId: "freshchat",
      expectedPartitionRevision: 3,
      expectedSelectionRevision: 0,
      expectedFenceEpoch: 3,
      operationId: "select-first",
    });
    assert.equal(r.activeSelection?.selectionRevision, 1);
    r = h.store.selectOpenExactChat({
      principal,
      continuityId: "continuity1",
      companionId: "companion1",
      playerId: "player1",
      chatThreadId: "secondthread",
      chatSurfaceSessionId: "secondchat",
      expectedPartitionRevision: 4,
      expectedSelectionRevision: 1,
      expectedFenceEpoch: 4,
      operationId: "select-second",
    });
    assert.equal(r.activeSelection?.chatThreadId, "secondthread");
    const snapshotAfter = h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" })!;
    assert.equal(snapshotAfter.sessions.find((s) => s.sessionId === "freshchat")?.state, "suspended");
    assert.equal(snapshotAfter.sessions.find((s) => s.sessionId === "secondchat")?.state, "active");
    h.store.transitionArchiveLifecycle({
      principal,
      continuityId: "continuity1",
      companionId: "companion1",
      playerId: "player1",
      chatThreadId: "freshthread",
      chatSurfaceSessionId: "freshchat",
      expectedManagementRevision: 1,
      expectedFenceEpoch: 5,
      operationId: "archive-fresh",
      operation: "archive",
    });
    code(
      () =>
        h.store.selectOpenExactChat({
          principal,
          continuityId: "continuity1",
          companionId: "companion1",
          playerId: "player1",
          chatThreadId: "freshthread",
          chatSurfaceSessionId: "freshchat",
          expectedPartitionRevision: 6,
          expectedSelectionRevision: 2,
          expectedFenceEpoch: 6,
          operationId: "select-archived",
        }),
      "lifecycle_transition_invalid",
    );
  } finally {
    h.store.close();
    h.dispose();
  }
});

test("selection rejects pending Game without any durable mutation", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(snapshot());
    h.store.prepareGameCommand(command("game_enter", "pending"));
    const before = h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" });
    code(
      () =>
        h.store.selectOpenExactChat({
          principal,
          continuityId: "continuity1",
          companionId: "companion1",
          playerId: "player1",
          chatThreadId: "thread1",
          chatSurfaceSessionId: "chat1",
          expectedPartitionRevision: 2,
          expectedSelectionRevision: 3,
          expectedFenceEpoch: 2,
          operationId: "select-pending",
        }),
      "game_transition_invalid",
    );
    assert.deepEqual(h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" }), before);
  } finally {
    h.store.close();
    h.dispose();
  }
});
test("archive and trash reject the current active selection without durable mutation", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(snapshot());
    for (const operation of ["archive", "trash"] as const) {
      const before = h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" });
      code(
        () =>
          h.store.transitionArchiveLifecycle({
            principal,
            continuityId: "continuity1",
            companionId: "companion1",
            playerId: "player1",
            chatThreadId: "thread1",
            chatSurfaceSessionId: "chat1",
            expectedManagementRevision: 7,
            expectedFenceEpoch: 1,
            operationId: `${operation}-active`,
            operation,
          }),
        "lifecycle_transition_invalid",
      );
      assert.deepEqual(h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" }), before);
    }
  } finally {
    h.store.close();
    h.dispose();
  }
});
test("game enter rejects non-selected, suspended, and archived origin without durable mutation", () => {
  const h = harness();
  try {
    h.store.adoptLegacyPartition(
      snapshot({
        legacyLedger: { ...snapshot().legacyLedger, sessions: [], events: [] },
        chatThreads: [],
        activeSelections: [],
      }),
    );
    register(h);
    h.store.registerExactChat({
      principal,
      continuityId: "continuity1",
      companionId: "companion1",
      playerId: "player1",
      chatThreadId: "secondthread",
      chatSurfaceSessionId: "secondchat",
      expectedPartitionRevision: 2,
      expectedFenceEpoch: 2,
      operationId: "register-second",
    });
    const secondOrigin = { ...origin, chatThreadId: "secondthread", chatSurfaceSessionId: "secondchat" };
    const before = h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" });
    code(
      () =>
        h.store.prepareGameCommand({
          ...command("game_enter", "non-selected", { partition: 3, game: 0, lease: 0, fence: 3 }),
          origin: secondOrigin,
          expectedSelectionRevision: 0,
        }),
      "game_transition_invalid",
    );
    assert.deepEqual(h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" }), before);
    h.store.selectOpenExactChat({
      principal,
      continuityId: "continuity1",
      companionId: "companion1",
      playerId: "player1",
      chatThreadId: "freshthread",
      chatSurfaceSessionId: "freshchat",
      expectedPartitionRevision: 3,
      expectedSelectionRevision: 0,
      expectedFenceEpoch: 3,
      operationId: "select-first",
    });
    const suspendedBefore = h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" });
    code(
      () =>
        h.store.prepareGameCommand({
          ...command("game_enter", "suspended", { partition: 4, game: 0, lease: 0, fence: 4 }),
          origin: secondOrigin,
          expectedSelectionRevision: 1,
        }),
      "game_transition_invalid",
    );
    assert.deepEqual(h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" }), suspendedBefore);
    h.store.transitionArchiveLifecycle({
      principal,
      continuityId: "continuity1",
      companionId: "companion1",
      playerId: "player1",
      chatThreadId: "secondthread",
      chatSurfaceSessionId: "secondchat",
      expectedManagementRevision: 1,
      expectedFenceEpoch: 4,
      operationId: "archive-second",
      operation: "archive",
    });
    const archivedBefore = h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" });
    code(
      () =>
        h.store.prepareGameCommand({
          ...command("game_enter", "archived", { partition: 5, game: 0, lease: 0, fence: 5 }),
          origin: secondOrigin,
          expectedSelectionRevision: 1,
        }),
      "game_transition_invalid",
    );
    assert.deepEqual(h.store.readAuthoritativeSnapshot({ continuityId: "continuity1" }), archivedBefore);
  } finally {
    h.store.close();
    h.dispose();
  }
});
