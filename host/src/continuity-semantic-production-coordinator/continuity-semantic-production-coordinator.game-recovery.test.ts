import assert from "node:assert/strict";
import test from "node:test";
import { createTestWindowsOwnerDeathVerification } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.windows-owner-death.test-support.js";
import type { ProductionGameRecoveryTarget } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import { orchestrateExplicitGameRecovery } from "./continuity-semantic-production-coordinator.internal.js";

const owner = Object.freeze({
  ownerToken: "owner_01",
  runtimeInstanceId: "runtime_01",
  ownerPid: 42,
  ownerProcessStartIdentity: "start_01",
});
const permit = Object.freeze({
  principal: Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" }),
  operationId: "operation_01",
  requestId: "request_01",
  kind: "close" as const,
  gameSessionId: "session_01",
  world: Object.freeze({ integrationId: "stardew", saveId: "save_01", worldId: "world_01" }),
  bindingDigest: "a".repeat(64),
  owner,
  deadlineAtMs: Date.now() + 60_000,
  expected: Object.freeze({ partitionRevision: 3, gameRevision: 1, leaseRevision: 2, fenceEpoch: 3 }),
  payloadDigest: "b".repeat(64),
  fenceToken: "fence_012345678901234567890123",
  prepared: Object.freeze({ partitionRevision: 4, gameRevision: 1, leaseRevision: 2, fenceEpoch: 4 }),
});
const target = Object.freeze({
  owner,
  permit,
  readback: Object.freeze({
    operationId: permit.operationId,
    requestId: permit.requestId,
    status: "recovery_required" as const,
    gameSessionId: permit.gameSessionId,
    gameState: "recovery_required" as const,
    leaseState: "recovery_required" as const,
    vector: permit.prepared,
    receipt: null,
    recoveryReason: "effect_failed" as const,
  }),
}) satisfies ProductionGameRecoveryTarget;

for (const outcome of ["alive", "mismatch", "ambiguous", "unavailable"] as const)
  test(`Game recovery forwards ${outcome} proof only to fail-closed store transaction`, async () => {
    let verified: unknown,
      forwarded = 0;
    await assert.rejects(
      orchestrateExplicitGameRecovery(
        Object.freeze({ request: "recover_dead_owner" as const, operationId: permit.operationId }),
        async (operationId) => {
          assert.equal(operationId, permit.operationId);
          return target;
        },
        async (_target, proof) => {
          forwarded++;
          assert.strictEqual(_target, target);
          assert.ok(proof);
          throw new Error("recovery_owner_not_proven_dead");
        },
        Object.freeze({
          verify: async (exactOwner) => {
            verified = exactOwner;
            return createTestWindowsOwnerDeathVerification(exactOwner, outcome);
          },
        }),
      ),
      /recovery_owner_not_proven_dead/,
    );
    assert.strictEqual(verified, owner);
    assert.equal(forwarded, 1);
  });

test("Game recovery invokes verifier with exact durable owner and forwards only its opaque proven-dead result", async () => {
  let verified: unknown, forwarded: unknown;
  const result = await orchestrateExplicitGameRecovery(
    Object.freeze({ request: "recover_dead_owner" as const, operationId: permit.operationId }),
    async () => target,
    async (receivedTarget, proof) => {
      assert.strictEqual(receivedTarget, target);
      forwarded = proof;
      return Object.freeze({
        ...target.readback,
        status: "terminal" as const,
        gameState: "ended" as const,
        leaseState: null,
      });
    },
    Object.freeze({
      verify: async (exactOwner) => {
        verified = exactOwner;
        return createTestWindowsOwnerDeathVerification(exactOwner, "proven_dead");
      },
    }),
  );
  assert.strictEqual(verified, owner);
  assert.ok(forwarded);
  assert.equal(result.status, "terminal");
});

test("Game recovery rejects any request other than explicit recover_dead_owner before verifier or store", async () => {
  let calls = 0;
  await assert.rejects(
    orchestrateExplicitGameRecovery(
      Object.freeze({ request: "recover_dead_owner", operationId: "bad", extra: true }) as never,
      async () => {
        calls++;
        return target;
      },
      async () => {
        calls++;
        return target.readback;
      },
      Object.freeze({
        verify: async () => {
          calls++;
          return createTestWindowsOwnerDeathVerification(owner, "proven_dead");
        },
      }),
    ),
    /semantic_game_recovery_request_rejected/,
  );
  assert.equal(calls, 0);
});
