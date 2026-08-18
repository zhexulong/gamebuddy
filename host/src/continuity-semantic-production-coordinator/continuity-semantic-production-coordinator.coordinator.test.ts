import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createTestChatRuntimeBinding } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.test-support.js";
import type { ChatRuntimeBinding } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import { createTestChatRuntimeMaterializer } from "../continuity-semantic-chat-runtime-materializer/continuity-semantic-chat-runtime-materializer.test-support.js";
import { createTestSemanticChatRuntimeCoordinator } from "./continuity-semantic-production-coordinator.test-support.js";
import type {
  ProductionChatRuntimePermit,
  ProductionChatRuntimeReadback,
  ProductionChatRuntimeTeardownPermit,
  ProductionChatRuntimeTeardownReadback,
} from "../continuity-semantic-store/continuity-semantic-production-store.js";
import type { RuntimeSession } from "../runtime.js";

const principal = Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" });
const vector = Object.freeze({ partitionRevision: 1, fenceEpoch: 1, selectionRevision: 1 });
const teardownReadback = (
  status: ProductionChatRuntimeTeardownReadback["status"],
  runtimeState: ProductionChatRuntimeTeardownReadback["runtimeState"],
): ProductionChatRuntimeTeardownReadback =>
  Object.freeze({
    operationId: "teardown_01",
    requestId: "teardown_request_01",
    bootstrapOperationId: "operation_01",
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    status,
    runtimeState,
    vector,
    receipt: null,
    recoveryReason: null,
  });
function binding(): { root: string; binding: ChatRuntimeBinding } {
  const root = mkdtempSync(join(tmpdir(), "chat-coordinator-"));
  return {
    root,
    binding: createTestChatRuntimeBinding({
      manifest: Object.freeze({
        schemaVersion: 2,
        topology: "independent_chat_and_game_surfaces",
        runtimeRoot: root,
        principal,
        bootstrapOperationId: "bootstrap_01",
        authorityGeneration: 1,
      }),
      ownerProof: Object.freeze({ processId: process.pid, creationTime100ns: "1" }),
    }),
  };
}
function readback(
  status: ProductionChatRuntimeReadback["status"],
  runtimeState: ProductionChatRuntimeReadback["runtimeState"],
): ProductionChatRuntimeReadback {
  return Object.freeze({
    operationId: "operation_01",
    requestId: "request_01",
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    status,
    runtimeState,
    vector,
    receipt: null,
    recoveryReason: null,
  });
}

test("v38 Chat coordinator orders callback reserve, prepare, unlocked materialize, commit and retains runtime until close", async () => {
  const fixture = binding();
  const events: string[] = [];
  let disposed = 0;
  try {
    let permit!: ProductionChatRuntimePermit;
    const coordinator = createTestSemanticChatRuntimeCoordinator({
      binding: fixture.binding,
      locked(work) {
        events.push("lock");
        try {
          const result = work();
          return Promise.resolve(result);
        } finally {
          events.push("unlock");
        }
      },
      store: {
        prepare(facts) {
          events.push("prepare");
          permit = Object.freeze({
            principal,
            operationId: "operation_01",
            requestId: "request_01",
            chatThreadId: "thread_01",
            chatSurfaceSessionId: "surface_01",
            runtimeBindingDigest: facts.runtimeBindingDigest,
            owner: facts.owner,
            deadlineAtMs: Date.now() + 30_000,
            expected: vector,
            payloadDigest: "a".repeat(64),
            fenceToken: "fence_01",
            prepared: vector,
          });
          return Object.freeze({ outcome: "effect_owned" as const, permit, readback: readback("pending", "pending") });
        },
        commit(_permit, receipt) {
          events.push("commit");
          assert.equal(receipt.kind, "chat_runtime_bootstrapped");
          return readback("terminal", "active");
        },
        fail() {
          throw new Error("unexpected_fail");
        },
      },
      materializer: createTestChatRuntimeMaterializer(async ({ permit: materializationPermit }) => {
        events.push("materialize");
        return Object.freeze({
          operationId: materializationPermit.operationId,
          session: Object.freeze({
            dispose: () => {
              disposed++;
              events.push("dispose");
            },
          }),
        });
      }),
    });
    const result = await coordinator.start();
    assert.equal(result.runtimeState, "active");
    assert.deepEqual(events, ["lock", "prepare", "unlock", "materialize", "lock", "commit", "unlock"]);
    assert.equal(disposed, 0);
    await coordinator.close();
    assert.equal(disposed, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("mounted Chat lease exposes only the committed session and exact IDs, then delegates close", async () => {
  const fixture = binding();
  let disposed = 0;
  let teardownCommitted = 0;
  const runtimeSession = Object.freeze({}) as RuntimeSession;
  try {
    const coordinator = createTestSemanticChatRuntimeCoordinator({
      binding: fixture.binding,
      locked(work) {
        return Promise.resolve(work());
      },
      store: {
        prepare(facts) {
          const permit = Object.freeze({
            principal,
            operationId: "operation_01",
            requestId: "request_01",
            chatThreadId: "thread_01",
            chatSurfaceSessionId: "surface_01",
            runtimeBindingDigest: facts.runtimeBindingDigest,
            owner: facts.owner,
            deadlineAtMs: Date.now() + 30_000,
            expected: vector,
            payloadDigest: "a".repeat(64),
            fenceToken: "fence_01",
            prepared: vector,
          });
          return Object.freeze({ outcome: "effect_owned" as const, permit, readback: readback("pending", "pending") });
        },
        commit(_permit, receipt) {
          assert.equal(receipt.operationId, "operation_01");
          return Object.freeze({ ...readback("terminal", "active"), receipt });
        },
        fail() {
          throw new Error("unexpected_fail");
        },
        prepareTeardown(request) {
          return Object.freeze({
            outcome: "effect_owned" as const,
            permit: Object.freeze({
              ...request,
              payloadDigest: "b".repeat(64),
              fenceToken: "teardown_fence",
              prepared: vector,
            }),
            readback: teardownReadback("pending", "pending"),
          });
        },
        commitTeardown() {
          teardownCommitted += 1;
          return teardownReadback("terminal", "closed");
        },
      },
      materializer: createTestChatRuntimeMaterializer(async () =>
        Object.freeze({
          runtimeSession,
          session: Object.freeze({
            dispose: () => {
              disposed += 1;
            },
          }),
        }),
      ),
    });
    const lease = await coordinator.startMounted();
    assert.strictEqual(lease.runtimeSession, runtimeSession);
    assert.deepEqual(Object.keys(lease).sort(), ["chatSurfaceSessionId", "chatThreadId", "close", "runtimeSession"]);
    assert.equal(lease.chatThreadId, "thread_01");
    assert.equal(lease.chatSurfaceSessionId, "surface_01");
    await assert.rejects(lease.close.call(Object.freeze({})), /semantic_chat_runtime_lease_rejected/);
    const replayed = Object.freeze({ ...lease });
    await assert.rejects(replayed.close(), /semantic_chat_runtime_lease_rejected/);
    await lease.close();
    await lease.close();
    assert.equal(disposed, 1);
    assert.equal(teardownCommitted, 1);
  } finally {
    await fixture.binding.close().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("v38 Chat coordinator commit throw closes runtime, durably fails, and preserves primary", async () => {
  const fixture = binding();
  const events: string[] = [];
  try {
    const coordinator = createTestSemanticChatRuntimeCoordinator({
      binding: fixture.binding,
      locked(work) {
        events.push("lock");
        try {
          const result = work();
          return Promise.resolve(result);
        } finally {
          events.push("unlock");
        }
      },
      store: {
        prepare(facts) {
          return Object.freeze({
            outcome: "effect_owned" as const,
            permit: Object.freeze({
              principal,
              operationId: "operation_01",
              requestId: "request_01",
              chatThreadId: "thread_01",
              chatSurfaceSessionId: "surface_01",
              runtimeBindingDigest: facts.runtimeBindingDigest,
              owner: facts.owner,
              deadlineAtMs: Date.now() + 30_000,
              expected: vector,
              payloadDigest: "a".repeat(64),
              fenceToken: "fence_01",
              prepared: vector,
            }),
            readback: readback("pending", "pending"),
          });
        },
        commit() {
          events.push("commit");
          throw new Error("commit_primary");
        },
        fail() {
          events.push("fail");
          return readback("recovery_required", "recovery_required");
        },
      },
      materializer: createTestChatRuntimeMaterializer(async () =>
        Object.freeze({
          session: Object.freeze({
            dispose: () => {
              events.push("dispose");
            },
          }),
        }),
      ),
    });
    await assert.rejects(coordinator.start(), /commit_primary/);
    assert.deepEqual(events, ["lock", "unlock", "lock", "commit", "unlock", "dispose", "lock", "fail", "unlock"]);
    await coordinator.close();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("v38 Chat coordinator commit recovery/nonactive closes runtime, fails, and exposes no recovery API", async () => {
  const fixture = binding();
  let disposed = 0;
  let failed = 0;
  try {
    const coordinator = createTestSemanticChatRuntimeCoordinator({
      binding: fixture.binding,
      locked(work) {
        return Promise.resolve(work());
      },
      store: {
        prepare(facts) {
          return Object.freeze({
            outcome: "effect_owned" as const,
            permit: Object.freeze({
              principal,
              operationId: "operation_01",
              requestId: "request_01",
              chatThreadId: "thread_01",
              chatSurfaceSessionId: "surface_01",
              runtimeBindingDigest: facts.runtimeBindingDigest,
              owner: facts.owner,
              deadlineAtMs: Date.now() + 30_000,
              expected: vector,
              payloadDigest: "a".repeat(64),
              fenceToken: "fence_01",
              prepared: vector,
            }),
            readback: readback("pending", "pending"),
          });
        },
        commit() {
          return readback("recovery_required", "recovery_required");
        },
        fail() {
          failed++;
          return readback("recovery_required", "recovery_required");
        },
      },
      materializer: createTestChatRuntimeMaterializer(async () =>
        Object.freeze({
          session: Object.freeze({
            dispose: () => {
              disposed++;
            },
          }),
        }),
      ),
    });
    await assert.rejects(coordinator.start(), /semantic_chat_runtime_recovery_required/);
    assert.equal(disposed, 1);
    assert.equal(failed, 1);
    assert.deepEqual(Object.keys(coordinator).sort(), ["close", "start", "startMounted"]);
    await coordinator.close();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("v38 Chat coordinator aggregates primary commit, close, and fail errors", async () => {
  const fixture = binding();
  try {
    const coordinator = createTestSemanticChatRuntimeCoordinator({
      binding: fixture.binding,
      locked(work) {
        return Promise.resolve(work());
      },
      store: {
        prepare(facts) {
          return Object.freeze({
            outcome: "effect_owned" as const,
            permit: Object.freeze({
              principal,
              operationId: "operation_01",
              requestId: "request_01",
              chatThreadId: "thread_01",
              chatSurfaceSessionId: "surface_01",
              runtimeBindingDigest: facts.runtimeBindingDigest,
              owner: facts.owner,
              deadlineAtMs: Date.now() + 30_000,
              expected: vector,
              payloadDigest: "a".repeat(64),
              fenceToken: "fence_01",
              prepared: vector,
            }),
            readback: readback("pending", "pending"),
          });
        },
        commit() {
          throw new Error("commit_primary");
        },
        fail() {
          throw new Error("fail_secondary");
        },
      },
      materializer: createTestChatRuntimeMaterializer(async () =>
        Object.freeze({
          session: Object.freeze({
            dispose: () => {
              throw new Error("close_secondary");
            },
          }),
        }),
      ),
    });
    await assert.rejects(coordinator.start(), (error: unknown) => {
      assert(error instanceof AggregateError);
      assert.equal((error as AggregateError).errors[0]?.message, "commit_primary");
      const closeFailure = (error as AggregateError).errors[1];
      assert(closeFailure instanceof AggregateError);
      assert.equal(closeFailure.errors[0]?.message, "close_secondary");
      assert.equal((error as AggregateError).errors[2]?.message, "fail_secondary");
      return true;
    });
    await coordinator.close();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("v40 teardown retries the same permit after runtime close rejection", async () => {
  const fixture = binding();
  let closeCalls = 0;
  let prepareCalls = 0;
  let commitCalls = 0;
  let dependencyCalls = 0;
  let retry = true;
  let teardownPermit!: ProductionChatRuntimeTeardownPermit;
  const teardownReadback = (
    status: ProductionChatRuntimeTeardownReadback["status"],
    runtimeState: ProductionChatRuntimeTeardownReadback["runtimeState"],
  ): ProductionChatRuntimeTeardownReadback =>
    Object.freeze({
      operationId: "teardown_01",
      requestId: "teardown_request_01",
      bootstrapOperationId: "operation_01",
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      status,
      runtimeState,
      vector,
      receipt: null,
      recoveryReason: null,
    });
  try {
    const coordinator = createTestSemanticChatRuntimeCoordinator({
      binding: fixture.binding,
      locked(work) {
        return Promise.resolve(work());
      },
      store: {
        prepare(facts) {
          const permit = Object.freeze({
            principal,
            operationId: "operation_01",
            requestId: "request_01",
            chatThreadId: "thread_01",
            chatSurfaceSessionId: "surface_01",
            runtimeBindingDigest: facts.runtimeBindingDigest,
            owner: facts.owner,
            deadlineAtMs: Date.now() + 30_000,
            expected: vector,
            payloadDigest: "a".repeat(64),
            fenceToken: "fence_01",
            prepared: vector,
          });
          return Object.freeze({ outcome: "effect_owned" as const, permit, readback: readback("pending", "pending") });
        },
        commit() {
          return readback("terminal", "active");
        },
        fail() {
          throw new Error("unexpected_fail");
        },
        prepareTeardown(request) {
          prepareCalls += 1;
          teardownPermit = Object.freeze({
            ...request,
            payloadDigest: "b".repeat(64),
            fenceToken: "teardown_fence",
            prepared: vector,
          });
          return Object.freeze({
            outcome: "effect_owned" as const,
            permit: teardownPermit,
            readback: teardownReadback("pending", "pending"),
          });
        },
        commitTeardown(permit) {
          commitCalls += 1;
          assert.strictEqual(permit, teardownPermit);
          return teardownReadback("terminal", "closed");
        },
      },
      materializer: createTestChatRuntimeMaterializer(async () =>
        Object.freeze({
          runtimeSession: Object.freeze({}) as RuntimeSession,
          session: Object.freeze({
            dispose: () => {
              closeCalls += 1;
              if (retry) {
                retry = false;
                throw new Error("close_transient");
              }
            },
          }),
        }),
      ),
      closeDependencies: async () => {
        dependencyCalls += 1;
      },
    });
    const lease = await coordinator.startMounted();
    const first = lease.close();
    assert.strictEqual(first, lease.close());
    await assert.rejects(first, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(String(error.errors[0]), /close_transient/);
      return true;
    });
    assert.equal(prepareCalls, 1);
    assert.equal(commitCalls, 0);
    assert.equal(dependencyCalls, 0);
    await lease.close();
    assert.equal(closeCalls, 2);
    assert.equal(prepareCalls, 1);
    assert.equal(commitCalls, 1);
    assert.equal(dependencyCalls, 1);
  } finally {
    await fixture.binding.close().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Chat dependency close retries only the remaining dependency stage", async () => {
  const fixture = binding();
  let bindingCloseCalls = 0;
  let dependencyCloseCalls = 0;
  let retry = true;
  const bindingWithCount = Object.freeze({
    ...fixture.binding,
    close: async () => {
      bindingCloseCalls += 1;
      await fixture.binding.close();
    },
  });
  try {
    const coordinator = createTestSemanticChatRuntimeCoordinator({
      binding: bindingWithCount,
      locked(work) {
        return Promise.resolve(work());
      },
      store: {
        prepare(facts) {
          const permit = Object.freeze({
            principal,
            operationId: "operation_01",
            requestId: "request_01",
            chatThreadId: "thread_01",
            chatSurfaceSessionId: "surface_01",
            runtimeBindingDigest: facts.runtimeBindingDigest,
            owner: facts.owner,
            deadlineAtMs: Date.now() + 30_000,
            expected: vector,
            payloadDigest: "a".repeat(64),
            fenceToken: "fence_01",
            prepared: vector,
          });
          return Object.freeze({ outcome: "effect_owned" as const, permit, readback: readback("pending", "pending") });
        },
        commit() {
          return readback("terminal", "active");
        },
        fail() {
          throw new Error("unexpected_fail");
        },
      },
      materializer: createTestChatRuntimeMaterializer(async () =>
        Object.freeze({ session: Object.freeze({ dispose: () => undefined }) }),
      ),
      closeDependencies: async () => {
        dependencyCloseCalls += 1;
        if (retry) {
          retry = false;
          throw new Error("dependency_close_transient");
        }
      },
    });
    await coordinator.start();
    await assert.rejects(coordinator.close(), /dependency_close_transient/);
    assert.equal(bindingCloseCalls, 1);
    assert.equal(dependencyCloseCalls, 1);
    await coordinator.close();
    assert.equal(bindingCloseCalls, 1);
    assert.equal(dependencyCloseCalls, 2);
  } finally {
    await fixture.binding.close().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Chat teardown commit failure retains the physical-close checkpoint", async () => {
  const fixture = binding();
  let physicalCloseCalls = 0;
  let commitCalls = 0;
  let retry = true;
  try {
    const coordinator = createTestSemanticChatRuntimeCoordinator({
      binding: fixture.binding,
      locked(work) {
        return Promise.resolve(work());
      },
      store: {
        prepare(facts) {
          const permit = Object.freeze({
            principal,
            operationId: "operation_01",
            requestId: "request_01",
            chatThreadId: "thread_01",
            chatSurfaceSessionId: "surface_01",
            runtimeBindingDigest: facts.runtimeBindingDigest,
            owner: facts.owner,
            deadlineAtMs: Date.now() + 30_000,
            expected: vector,
            payloadDigest: "a".repeat(64),
            fenceToken: "fence_01",
            prepared: vector,
          });
          return Object.freeze({ outcome: "effect_owned" as const, permit, readback: readback("pending", "pending") });
        },
        commit() {
          return readback("terminal", "active");
        },
        fail() {
          throw new Error("unexpected_fail");
        },
        prepareTeardown(request) {
          return Object.freeze({
            outcome: "effect_owned" as const,
            permit: Object.freeze({
              ...request,
              payloadDigest: "b".repeat(64),
              fenceToken: "teardown_fence",
              prepared: vector,
            }),
            readback: teardownReadback("pending", "pending"),
          });
        },
        commitTeardown() {
          commitCalls += 1;
          if (retry) {
            retry = false;
            throw new Error("teardown_commit_transient");
          }
          return teardownReadback("terminal", "closed");
        },
      },
      materializer: createTestChatRuntimeMaterializer(async () =>
        Object.freeze({
          session: Object.freeze({
            dispose: () => {
              physicalCloseCalls += 1;
            },
          }),
        }),
      ),
    });
    await coordinator.start();
    await assert.rejects(coordinator.close(), /teardown_commit_transient/);
    await coordinator.close();
    assert.equal(physicalCloseCalls, 1);
    assert.equal(commitCalls, 2);
  } finally {
    await fixture.binding.close().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("v38 Chat coordinator fails durable effect and does not retain a live runtime", async () => {
  const fixture = binding();
  let failed = 0;
  try {
    const coordinator = createTestSemanticChatRuntimeCoordinator({
      binding: fixture.binding,
      locked(work) {
        return Promise.resolve(work());
      },
      store: {
        prepare(facts) {
          return Object.freeze({
            outcome: "effect_owned" as const,
            permit: Object.freeze({
              principal,
              operationId: "operation_01",
              requestId: "request_01",
              chatThreadId: "thread_01",
              chatSurfaceSessionId: "surface_01",
              runtimeBindingDigest: facts.runtimeBindingDigest,
              owner: facts.owner,
              deadlineAtMs: Date.now() + 30_000,
              expected: vector,
              payloadDigest: "a".repeat(64),
              fenceToken: "fence_01",
              prepared: vector,
            }),
            readback: readback("pending", "pending"),
          });
        },
        commit() {
          throw new Error("unexpected_commit");
        },
        fail() {
          failed++;
          return readback("recovery_required", "recovery_required");
        },
      },
      materializer: createTestChatRuntimeMaterializer(async () => {
        throw new Error("factory_failed");
      }),
    });
    await assert.rejects(coordinator.start(), /factory_failed/);
    assert.equal(failed, 1);
    await coordinator.close();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
