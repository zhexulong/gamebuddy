import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  openProductionContinuityStore,
  type ProductionBootstrapInput,
  type ProductionGameRequest,
  type ProductionGameTerminalReceipt,
} from "./continuity-semantic-production-store.js";

const principal = { continuityId: "continuity1", companionId: "companion1", playerId: "player1" } as const;
const bootstrap: ProductionBootstrapInput = { principal, bootstrapOperationId: "bootstrap1", authorityGeneration: 1, authorityRootIdentity: "a".repeat(64) };
const owner = { ownerToken: "owner-token", runtimeInstanceId: "runtime-1", ownerPid: process.pid, ownerProcessStartIdentity: "start-1" } as const;
const game = (operationId: string, kind: "enter" | "close", expected: any, gameSessionId = "game-session"): ProductionGameRequest => ({ principal, operationId, requestId: `request-${operationId}`, kind, gameSessionId, world: { integrationId: "stardew", saveId: "save-1", worldId: "world-1" }, bindingDigest: "d".repeat(64), owner, deadlineAtMs: Date.now() + 60_000, expected });
const receipt = (permit: any, kind: "runtime_bootstrapped" | "runtime_torn_down"): ProductionGameTerminalReceipt => ({ kind, operationId: permit.operationId, requestId: permit.requestId, gameSessionId: permit.gameSessionId, bindingDigest: permit.bindingDigest, world: permit.world, owner: permit.owner, fenceToken: permit.fenceToken, occurredAtMs: Date.now() });

test("independent Game enter and close never read or mutate Chat", () => {
  const root = mkdtempSync(`${tmpdir()}/production-game-`);
  const control = openProductionContinuityStore({ runtimeRoot: root });
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const entered = store.prepareGame(game("enter", "enter", { partitionRevision: 1, gameRevision: 0, leaseRevision: 0, fenceEpoch: 1 }));
    assert.equal(entered.outcome, "effect_owned");
    assert.ok(entered.permit);
    const active = store.commitGameTerminal({ principal, permit: entered.permit!, receipt: receipt(entered.permit!, "runtime_bootstrapped") });
    assert.equal(active.gameState, "active");
    assert.throws(() => store.prepareGame(game("second", "enter", active.vector, "second-game")), /game_transition_invalid/);
    const closing = store.prepareGame(game("close", "close", active.vector));
    assert.ok(closing.permit);
    const closed = store.commitGameTerminal({ principal, permit: closing.permit!, receipt: receipt(closing.permit!, "runtime_torn_down") });
    assert.equal(closed.gameState, "ended");
  } finally { control.close(); rmSync(root, { recursive: true, force: true }); }
});
