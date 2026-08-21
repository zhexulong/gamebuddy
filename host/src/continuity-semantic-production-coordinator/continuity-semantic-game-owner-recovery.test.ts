import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createTestWindowsOwnerDeathVerification } from "../continuity-semantic-owner-death/continuity-semantic-owner-death.test-support.js";
import type { ProductionGameRecoveryTarget } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import { orchestrateExplicitGameRecovery } from "./continuity-semantic-game-owner-recovery.internal.js";

const owner = Object.freeze({ ownerToken: "owner_01", runtimeInstanceId: "runtime_01", ownerPid: 42, ownerProcessStartIdentity: "638400000000000000" });
const permit = Object.freeze({
  principal: Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" }),
  operationId: "operation_01", requestId: "request_01", kind: "close" as const, gameSessionId: "session_01",
  world: Object.freeze({ integrationId: "stardew", saveId: "save_01", worldId: "world_01" }), bindingDigest: "a".repeat(64), owner,
  deadlineAtMs: Date.now() + 60_000, expected: Object.freeze({ partitionRevision: 3, gameRevision: 1, leaseRevision: 2, fenceEpoch: 3 }),
  payloadDigest: "b".repeat(64), fenceToken: "fence_012345678901234567890123", prepared: Object.freeze({ partitionRevision: 4, gameRevision: 1, leaseRevision: 2, fenceEpoch: 4 }),
});
const target = Object.freeze({ owner, permit, readback: Object.freeze({ operationId: permit.operationId, requestId: permit.requestId, status: "recovery_required" as const, gameSessionId: permit.gameSessionId, gameState: "recovery_required" as const, leaseState: "recovery_required" as const, vector: permit.prepared, receipt: null, recoveryReason: "effect_failed" as const }) }) satisfies ProductionGameRecoveryTarget;

test("recovery reads the exact durable target, calls the verifier once, and forwards its opaque proof", async () => {
  let verified: unknown; let calls = 0; let forwarded: unknown;
  const result = await orchestrateExplicitGameRecovery(
    Object.freeze({ request: "recover_dead_owner" as const, operationId: permit.operationId }),
    async (operationId) => { assert.equal(operationId, permit.operationId); return target; },
    async (received, proof) => { assert.strictEqual(received, target); forwarded = proof; return Object.freeze({ ...target.readback, status: "terminal" as const, gameState: "ended" as const, leaseState: null }); },
    Object.freeze({ verify: async (exactOwner) => { calls++; verified = exactOwner; return createTestWindowsOwnerDeathVerification(exactOwner, "proven_dead"); } }),
  );
  assert.strictEqual(verified, owner);
  assert.equal(calls, 1);
  assert.ok(forwarded);
  assert.equal(result.status, "terminal");
});

test("malformed recovery request is rejected before target, verifier, or store work", async () => {
  let calls = 0;
  await assert.rejects(() => orchestrateExplicitGameRecovery(
    Object.freeze({ request: "recover_dead_owner", operationId: "bad", extra: true }) as never,
    async () => { calls++; return target; }, async () => { calls++; return target.readback; },
    Object.freeze({ verify: async () => { calls++; return createTestWindowsOwnerDeathVerification(owner, "proven_dead"); } }),
  ), /semantic_game_recovery_request_rejected/);
  assert.equal(calls, 0);
});

test("recovery coordinator production sources have no launch or product-surface imports", () => {
  const sourceRoot = fileURLToPath(new URL("../../src/continuity-semantic-production-coordinator/", import.meta.url));
  for (const name of ["continuity-semantic-game-owner-recovery.internal.ts", "continuity-semantic-game-owner-recovery.ts"]) {
    const source = readFileSync(`${sourceRoot}${name}`, "utf8");
    const imports = [...source.matchAll(/(?:from\s+["']|import\s*\(\s*["'])([^"']+)/g)].map((match) => match[1]!);
    for (const specifier of imports) assert.doesNotMatch(specifier, /(?:integration-|launcher|adapter|chat|tavern|browser|voice|farmhand|portfolio|tools|fixture)/i, `${name}: ${specifier}`);
  }
});
