import assert from "node:assert/strict";
import test from "node:test";
import { createTestWindowsOwnerDeathVerification } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.windows-owner-death.test-support.js";
import type {
  ProductionGameReadback,
  ProductionGameRecoveryTarget,
} from "../continuity-semantic-store/continuity-semantic-production-store.js";
import { settleDurableGameRecoveryOnStartup } from "./continuity-semantic-production-coordinator.internal.js";

const owner = Object.freeze({
  ownerToken: "owner_01",
  runtimeInstanceId: "runtime_01",
  ownerPid: 42,
  ownerProcessStartIdentity: "start_01",
});
const permit = Object.freeze({
  principal: Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" }),
  // The durable intent row owns this id. Nothing in the startup path may mint one.
  operationId: "operation_01",
  requestId: "request_01",
  kind: "enter" as const,
  gameSessionId: "session_01",
  world: Object.freeze({ integrationId: "stardew", saveId: "save_01", worldId: "world_01" }),
  bindingDigest: "a".repeat(64),
  owner,
  deadlineAtMs: 1_700_000_000_000,
  expected: Object.freeze({ partitionRevision: 3, gameRevision: 1, leaseRevision: 2, fenceEpoch: 3 }),
  payloadDigest: "b".repeat(64),
  fenceToken: "fence_012345678901234567890123",
  prepared: Object.freeze({ partitionRevision: 4, gameRevision: 1, leaseRevision: 2, fenceEpoch: 4 }),
});
const readback = Object.freeze({
  operationId: permit.operationId,
  requestId: permit.requestId,
  status: "recovery_required" as const,
  gameSessionId: permit.gameSessionId,
  gameState: "recovery_required" as const,
  leaseState: "recovery_required" as const,
  vector: permit.prepared,
  receipt: null,
  recoveryReason: "effect_failed" as const,
});
const target = Object.freeze({ owner, permit, readback }) satisfies ProductionGameRecoveryTarget;
const recovered = Object.freeze({
  ...readback,
  status: "terminal" as const,
  gameState: "ended" as const,
  leaseState: null,
  recoveryReason: null,
}) satisfies ProductionGameReadback;

/** Every startup settlement writes one bounded diagnostic line; these tests read it back. */
async function captureDiagnostics<T>(run: () => Promise<T>): Promise<Readonly<{ result: T; diagnostics: string }>> {
  let diagnostics = "";
  const stderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    diagnostics += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return Object.freeze({ result: await run(), diagnostics });
  } finally {
    process.stderr.write = stderrWrite;
  }
}

test("startup settlement recovers the recovery-required Game state a proven-dead owner left behind", async () => {
  const settled: string[] = [];
  const { result, diagnostics } = await captureDiagnostics(() =>
    settleDurableGameRecoveryOnStartup(
      async () => target,
      async (operationId) => {
        settled.push(operationId);
        return recovered;
      },
      Object.freeze({
        verify: async (exactOwner) => createTestWindowsOwnerDeathVerification(exactOwner, "proven_dead"),
      }),
    ),
  );
  assert.deepEqual(settled, ["operation_01"]);
  assert.strictEqual(result, recovered);
  // The recovery is silent to the player but never silent to an operator: who owned the lease, which
  // operation owed the recovery, why it owed it, and what the OS said about the owner.
  assert.match(diagnostics, /^\[game-recovery\] /u);
  assert.match(diagnostics, /operation=operation_01/u);
  assert.match(diagnostics, /session=session_01/u);
  assert.match(diagnostics, /owner_pid=42/u);
  assert.match(diagnostics, /reason=effect_failed/u);
  assert.match(diagnostics, /owner=proven_dead/u);
});

test("startup settlement refuses a living owner as a single-instance conflict and recovers nothing", async () => {
  let recoveries = 0;
  const { diagnostics } = await captureDiagnostics(async () => {
    await assert.rejects(
      settleDurableGameRecoveryOnStartup(
        async () => target,
        async () => {
          recoveries++;
          return recovered;
        },
        Object.freeze({
          verify: async (exactOwner) => createTestWindowsOwnerDeathVerification(exactOwner, "alive"),
        }),
      ),
      /game_recovery_blocked_owner_alive/u,
    );
  });
  assert.equal(recoveries, 0);
  // What the player is told is a second copy of this app, not a recovery state and not an unavailable game.
  assert.match(diagnostics, /another GameBuddy is already running/u);
  assert.doesNotMatch(diagnostics, /recovery required|unavailable/iu);
});

for (const outcome of ["mismatch", "ambiguous", "unavailable"] as const)
  test(`startup settlement reads an ${outcome} owner verdict as unknown and recovers nothing`, async () => {
    let recoveries = 0;
    const { diagnostics } = await captureDiagnostics(async () => {
      await assert.rejects(
        settleDurableGameRecoveryOnStartup(
          async () => target,
          async () => {
            recoveries++;
            return recovered;
          },
          Object.freeze({
            verify: async (exactOwner) => createTestWindowsOwnerDeathVerification(exactOwner, outcome),
          }),
        ),
        /game_recovery_blocked_owner_unknown/u,
      );
    });
    assert.equal(recoveries, 0, `${outcome} is not a death, so no recovery may run`);
    assert.match(diagnostics, new RegExp(`owner=${outcome}`, "u"));
    assert.doesNotMatch(diagnostics, /another GameBuddy is already running/u);
  });

test("startup settlement names the durable operation, so two Hosts cannot settle it under different ids", async () => {
  const forwarded: string[] = [];
  const runOnce = () =>
    settleDurableGameRecoveryOnStartup(
      // A second Host re-reads the same durable row rather than carrying anything over from the first.
      async () => Object.freeze({ ...target, readback: Object.freeze({ ...readback }) }),
      async (operationId) => {
        forwarded.push(operationId);
        return recovered;
      },
      Object.freeze({
        verify: async (exactOwner) => createTestWindowsOwnerDeathVerification(exactOwner, "proven_dead"),
      }),
    );
  await runOnce();
  await runOnce();
  assert.deepEqual(forwarded, [readback.operationId, readback.operationId]);
  // Stated as an identity too: an id minted per startup would differ between the two runs, while the
  // store resolves a recovery target by exact id and would then find no operation at all.
  assert.equal(new Set(forwarded).size, 1);
});

test("startup settlement leaves a root that owes no recovery untouched and unlogged", async () => {
  let recoveries = 0;
  const { result, diagnostics } = await captureDiagnostics(() =>
    settleDurableGameRecoveryOnStartup(
      async () => null,
      async () => {
        recoveries++;
        return recovered;
      },
      Object.freeze({
        verify: async (exactOwner) => createTestWindowsOwnerDeathVerification(exactOwner, "proven_dead"),
      }),
    ),
  );
  assert.equal(result, null);
  assert.equal(recoveries, 0);
  assert.equal(diagnostics, "");
});
