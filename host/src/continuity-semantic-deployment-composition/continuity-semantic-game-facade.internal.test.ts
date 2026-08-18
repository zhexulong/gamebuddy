import assert from "node:assert/strict";
import test from "node:test";

import {
  mintBindingToken,
  releaseReservedGameRuntimeMaterialization,
  type GameRuntimeBindingExecution,
} from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.internal.js";
import type { GameRuntimeBinding } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import type {
  GameRuntimeMaterializer,
  MaterializedGameRuntime,
} from "../continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.internal.js";
import type { SemanticGameProductionAuthority } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type {
  ProductionGamePermit,
  ProductionGameTerminalReceipt,
} from "../continuity-semantic-store/continuity-semantic-production-store.js";
import { constructKnownUnmountedGameSemanticFacade } from "./continuity-semantic-game-facade.internal.js";

const permit = Object.freeze({ operationId: "close_01" }) as ProductionGamePermit;
const teardownReceipt = Object.freeze({
  operationId: "close_01",
  kind: "runtime_torn_down",
}) as ProductionGameTerminalReceipt;

function execution(): GameRuntimeBindingExecution {
  return Object.freeze({
    principal: Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" }),
    runtimeRoot: "runtime",
    connection: Object.freeze({}),
    world: Object.freeze({ integrationId: "test", saveId: "save_01", worldId: "world_01" }),
    launch: Object.freeze({}),
    ownerIdentity: Object.freeze({}),
    bindingFacts: Object.freeze({
      bindingDigest: "a".repeat(64),
      runtimeInstanceId: "runtime_01",
      owner: Object.freeze({
        ownerToken: "owner_01",
        runtimeInstanceId: "runtime_01",
        ownerPid: 1,
        ownerProcessStartIdentity: "1",
      }),
    }),
  }) as GameRuntimeBindingExecution;
}

test("Game facade forwards only the exact dead-owner recovery request and then closes safely", async () => {
  const requests: unknown[] = [];
  let gameCloseCalls = 0;
  let bindingCloseCalls = 0;
  const binding = Object.freeze({
    executeWithBinding: async <T>(callback: (token: never) => Promise<T> | T): Promise<T> =>
      callback(mintBindingToken(execution()) as never),
    close: async (): Promise<void> => {
      bindingCloseCalls += 1;
    },
  }) as GameRuntimeBinding;
  const authority = Object.freeze({
    authority: "SEMANTIC" as const,
    prepareEnter: async () => Object.freeze({}),
    commitEnter: async () => Object.freeze({}),
    failEnter: async () => Object.freeze({}),
    prepareClose: async () => permit,
    commitClose: async () => Object.freeze({}),
    failClose: async () => Object.freeze({}),
    recoverDeadOwner: async (request: unknown) => {
      requests.push(request);
      return Object.freeze({});
    },
    close: async () => {
      gameCloseCalls += 1;
    },
  }) as unknown as SemanticGameProductionAuthority;
  const facade = constructKnownUnmountedGameSemanticFacade(
    binding,
    authority,
    Object.freeze({}) as GameRuntimeMaterializer,
  );
  const request = Object.freeze({ request: "recover_dead_owner" as const, operationId: "operation_01" });
  await facade.recoverDeadOwner(request);
  assert.deepEqual(requests, [request]);
  await facade.close();
  assert.equal(gameCloseCalls, 1);
  assert.equal(bindingCloseCalls, 1);
});

test("Game facade retains recovery failure while its caller can still close the facade", async () => {
  let gameCloseCalls = 0;
  let bindingCloseCalls = 0;
  const binding = Object.freeze({
    executeWithBinding: async <T>(callback: (token: never) => Promise<T> | T): Promise<T> =>
      callback(mintBindingToken(execution()) as never),
    close: async (): Promise<void> => {
      bindingCloseCalls += 1;
    },
  }) as GameRuntimeBinding;
  const authority = Object.freeze({
    authority: "SEMANTIC" as const,
    prepareEnter: async () => Object.freeze({}),
    commitEnter: async () => Object.freeze({}),
    failEnter: async () => Object.freeze({}),
    prepareClose: async () => permit,
    commitClose: async () => Object.freeze({}),
    failClose: async () => Object.freeze({}),
    recoverDeadOwner: async () => {
      throw new Error("recovery_failed");
    },
    close: async () => {
      gameCloseCalls += 1;
    },
  }) as unknown as SemanticGameProductionAuthority;
  const facade = constructKnownUnmountedGameSemanticFacade(
    binding,
    authority,
    Object.freeze({}) as GameRuntimeMaterializer,
  );
  await assert.rejects(
    facade.recoverDeadOwner({ request: "recover_dead_owner", operationId: "operation_01" }),
    /recovery_failed/,
  );
  await facade.close();
  assert.equal(gameCloseCalls, 1);
  assert.equal(bindingCloseCalls, 1);
});

test("Game facade exposes launch ingress only after semantic enter commits", async () => {
  const calls: string[] = [];
  const binding = Object.freeze({
    executeWithBinding: async <T>(callback: (token: never) => Promise<T> | T): Promise<T> =>
      callback(mintBindingToken(execution()) as never),
    close: async () => undefined,
  }) as GameRuntimeBinding;
  const authority = Object.freeze({
    authority: "SEMANTIC" as const,
    prepareEnter: async () => Object.freeze({}),
    commitEnter: async () => {
      calls.push("commit");
      return Object.freeze({});
    },
    failEnter: async () => Object.freeze({}),
    close: async () => undefined,
  }) as unknown as SemanticGameProductionAuthority;
  const runtime = Object.freeze({
    receipt: Object.freeze({ gameSessionId: "game_session_01" }),
    piSessionId: "pi_session_01",
    connected: Object.freeze({
      host: Object.freeze({}),
      lifecycleSnapshot: () => Object.freeze({}),
      markClosing: () => undefined,
      activateIngress: () => calls.push("ingress"),
    }),
    teardownClose: async () => Object.freeze({}),
    close: async () => undefined,
  }) as unknown as MaterializedGameRuntime;
  const materializer = Object.freeze({
    materializeEnter: async (reservation: unknown) => {
      releaseReservedGameRuntimeMaterialization(reservation);
      return runtime;
    },
  }) as GameRuntimeMaterializer;
  const lease = await constructKnownUnmountedGameSemanticFacade(binding, authority, materializer).runEnter();
  assert.deepEqual(calls, ["commit"]);
  assert.equal(lease.gameSessionId, "game_session_01");
  lease.activateCommittedIngress();
  lease.activateCommittedIngress();
  assert.deepEqual(calls, ["commit", "ingress"]);
});

test("Game facade retries a failed close commit with its exact successful teardown checkpoint", async () => {
  let prepareCloseCalls = 0;
  let teardownCalls = 0;
  let commitCalls = 0;
  let gameCloseCalls = 0;
  let bindingCloseCalls = 0;
  const receivedPermits: unknown[] = [];
  const receivedReceipts: unknown[] = [];
  const durable = Object.freeze({});
  const binding = Object.freeze({
    executeWithBinding: async <T>(callback: (token: never) => Promise<T> | T): Promise<T> =>
      callback(mintBindingToken(execution()) as never),
    close: async (): Promise<void> => {
      bindingCloseCalls += 1;
    },
  }) as GameRuntimeBinding;
  const authority = Object.freeze({
    authority: "SEMANTIC" as const,
    prepareEnter: async () => Object.freeze({}),
    commitEnter: async () => durable,
    failEnter: async () => Object.freeze({}),
    prepareClose: async () => {
      prepareCloseCalls += 1;
      return permit;
    },
    commitClose: async (_durable: unknown, receivedPermit: unknown, receivedReceipt: unknown) => {
      commitCalls += 1;
      receivedPermits.push(receivedPermit);
      receivedReceipts.push(receivedReceipt);
      if (commitCalls === 1) throw new Error("transient_commit_failure");
      return Object.freeze({});
    },
    failClose: async () => Object.freeze({}),
    close: async () => {
      gameCloseCalls += 1;
    },
  }) as unknown as SemanticGameProductionAuthority;
  const runtime = Object.freeze({
    receipt: Object.freeze({}),
    connected: Object.freeze({
      host: Object.freeze({}),
      lifecycleSnapshot: () => Object.freeze({}),
      activateIngress: () => undefined,
      markClosing: () => undefined,
    }),
    piSessionId: "pi_session_fixture_01",
    teardownClose: async (receivedPermit: unknown) => {
      teardownCalls += 1;
      assert.strictEqual(receivedPermit, permit);
      return teardownReceipt;
    },
    close: async () => undefined,
  }) as MaterializedGameRuntime;
  const materializer = Object.freeze({
    materializeEnter: async (reservation: unknown) => {
      releaseReservedGameRuntimeMaterialization(reservation);
      return runtime;
    },
  }) as GameRuntimeMaterializer;
  const facade = constructKnownUnmountedGameSemanticFacade(binding, authority, materializer);

  await facade.runEnter();
  await assert.rejects(facade.close(), /transient_commit_failure/);
  await assert.rejects(facade.runEnter(), /semantic_game_facade_unavailable/);
  assert.equal(teardownCalls, 1);
  assert.equal(prepareCloseCalls, 1);
  assert.equal(gameCloseCalls, 0);
  assert.equal(bindingCloseCalls, 0);

  await facade.close();
  assert.equal(teardownCalls, 1);
  assert.equal(prepareCloseCalls, 1);
  assert.equal(commitCalls, 2);
  assert.strictEqual(receivedPermits[0], permit);
  assert.strictEqual(receivedPermits[1], permit);
  assert.strictEqual(receivedReceipts[0], teardownReceipt);
  assert.strictEqual(receivedReceipts[1], teardownReceipt);
  assert.equal(gameCloseCalls, 1);
  assert.equal(bindingCloseCalls, 1);
});
