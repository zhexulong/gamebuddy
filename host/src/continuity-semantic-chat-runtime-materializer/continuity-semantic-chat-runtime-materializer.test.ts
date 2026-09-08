import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";

import {
  type ChatRuntimeBindingExecution,
  type ReservedChatRuntimeMaterialization,
  reserveChatRuntimeMaterialization,
  withConsumedChatRuntimeBinding,
} from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import type { ChatRuntimeBinding } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.js";
import { createTestChatRuntimeBinding } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.test-support.js";
import type { ProductionChatRuntimePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import {
  closeMaterializedChatRuntime,
} from "./continuity-semantic-chat-runtime-materializer.internal.js";
import {
  createTestChatRuntimeMaterializer,
} from "./continuity-semantic-chat-runtime-materializer.test-support.js";

const principal = Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" });

async function binding(): Promise<Readonly<{ root: string; binding: ChatRuntimeBinding }>> {
  const root = await canonicalTestRoot("chat-runtime-materializer-");
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot);
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot,
      principal,
      bootstrapOperationId: "bootstrap_01",
      authorityGeneration: 1,
    }),
  );
  return Object.freeze({
    root,
    binding: createTestChatRuntimeBinding({
      manifest: Object.freeze({
        schemaVersion: 2,
        topology: "independent_chat_and_game_surfaces",
        runtimeRoot,
        principal,
        bootstrapOperationId: "bootstrap_01",
        authorityGeneration: 1,
      }),
      ownerProof: Object.freeze({ processId: 42, creationTime100ns: "123456" }),
    }),
  });
}

function permit(
  execution: ChatRuntimeBindingExecution,
  overrides: Partial<ProductionChatRuntimePermit> = {},
): ProductionChatRuntimePermit {
  return Object.freeze({
    principal: execution.principal,
    operationId: "operation_01",
    requestId: "request_01",
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "chat_session_01",
    runtimeBindingDigest: execution.bindingFacts.runtimeBindingDigest,
    owner: execution.bindingFacts.owner,
    deadlineAtMs: Date.now() + 5_000,
    expected: Object.freeze({ partitionRevision: 1, fenceEpoch: 1, selectionRevision: 1 }),
    payloadDigest: "b".repeat(64),
    fenceToken: "fence_01",
    prepared: Object.freeze({ partitionRevision: 2, fenceEpoch: 2, selectionRevision: 1 }),
    ...overrides,
  });
}

async function inActiveBinding<T>(
  binding: ChatRuntimeBinding,
  callback: (execution: ChatRuntimeBindingExecution, reservation: ReservedChatRuntimeMaterialization) => Promise<T> | T,
): Promise<T> {
  return binding.executeWithBinding((token) =>
    withConsumedChatRuntimeBinding(token, (execution) =>
      callback(execution, reserveChatRuntimeMaterialization(execution)),
    ),
  );
}

test("Chat materializer source graph has the sole production Chat runtime owner and no caller factory seam", async () => {
  const folder = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../src/continuity-semantic-chat-runtime-materializer",
  );
  const publicSource = await (await import("node:fs/promises")).readFile(
    join(folder, "continuity-semantic-chat-runtime-materializer.ts"),
    "utf8",
  );
  const internalSource = await (await import("node:fs/promises")).readFile(
    join(folder, "continuity-semantic-chat-runtime-materializer.internal.ts"),
    "utf8",
  );
  assert.equal((publicSource.match(/createCompanionRuntime\s*\(/g) ?? []).length, 1);
  assert.equal(publicSource.includes("factory:") || publicSource.includes("factory("), false);
  assert.equal(internalSource.includes("createCompanionRuntime"), false);
  assert.equal(publicSource.includes("tavernStableContextSnapshot"), false);
  assert.equal(publicSource.includes("gameOperationalGateNonceSha256"), false);
  assert.equal(publicSource.includes("clearGameOperationalGateMarker"), false);
  assert.match(publicSource, /tavernNarrativeGateNonceSha256/);
  assert.equal(internalSource.includes("clearGameOperationalGateMarker"), false);
});

test("materializes only an exact Chat permit and mints permit-exact Host lifecycle evidence", async () => {
  let factoryCalls = 0;
  let disposed = 0;
  const materializer = createTestChatRuntimeMaterializer(async () => {
    factoryCalls += 1;
    return Object.freeze({
      session: Object.freeze({
        dispose: () => {
          disposed += 1;
        },
      }),
    });
  });
  const fixture = await binding();
  try {
    const result = await inActiveBinding(fixture.binding, (execution, reservation) =>
      materializer.materialize(reservation, permit(execution)),
    );
    assert.equal(factoryCalls, 1);
    assert.equal(result.receipt.kind, "chat_runtime_bootstrapped");
    assert.equal(result.receipt.operationId, "operation_01");
    assert.equal(result.receipt.chatThreadId, "thread_01");
    assert.ok(result.receipt.occurredAtMs <= Date.now());
    await result.close();
    await result.close();
    assert.equal(disposed, 1);
  } finally {
    await fixture.binding.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("reverse disposal clears the authored-context capability before disposing Pi", async () => {
  const events: string[] = [];
  const capability = Object.freeze({
    prepare: () => Object.freeze({ sourceRefs: Object.freeze([]), stableTokenCount: 0 }),
    assertInstall: () => undefined,
    clear: async () => {
      events.push("clear");
    },
  });
  const runtime = Object.freeze({
    authoredContextCapability: capability,
    session: Object.freeze({
      dispose: () => {
        events.push("dispose");
      },
    }),
  });
  await closeMaterializedChatRuntime(runtime);
  assert.deepEqual(events, ["clear", "dispose"]);
});

test("reverse disposal aggregates authored capability clear and Pi disposal failures", async () => {
  const events: string[] = [];
  const clearError = new Error("clear_failed");
  const disposeError = new Error("dispose_failed");
  await assert.rejects(
    closeMaterializedChatRuntime(Object.freeze({
      authoredContextCapability: Object.freeze({
        prepare: () => Object.freeze({ sourceRefs: Object.freeze([]), stableTokenCount: 0 }),
        assertInstall: () => undefined,
        clear: async () => {
          events.push("clear");
          throw clearError;
        },
      }),
      session: Object.freeze({
        dispose: () => {
          events.push("dispose");
          throw disposeError;
        },
      }),
    })),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [clearError, disposeError]);
      return true;
    },
  );
  assert.deepEqual(events, ["clear", "dispose"]);
});

test("materialized Chat close caches fulfillment but retries captured disposal after rejection", async () => {
  let disposeCalls = 0;
  let first = true;
  const materializer = createTestChatRuntimeMaterializer(async () =>
    Object.freeze({
      session: Object.freeze({
        dispose: () => {
          disposeCalls += 1;
          if (first) {
            first = false;
            throw new Error("dispose_transient");
          }
        },
      }),
    }),
  );
  const fixture = await binding();
  try {
    const result = await inActiveBinding(fixture.binding, (execution, reservation) =>
      materializer.materialize(reservation, permit(execution)),
    );
    await assert.rejects(result.close(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], error.errors[0] as Error);
      assert.match(String(error.errors[0]), /dispose_transient/);
      return true;
    });
    await result.close();
    await result.close();
    assert.equal(disposeCalls, 2);
  } finally {
    await fixture.binding.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("reverse disposal disposes and aggregates when authored capability clear fails", async () => {
  const events: string[] = [];
  const clearError = new Error("clear_failed");
  const disposeError = new Error("dispose_failed");
  await assert.rejects(
    closeMaterializedChatRuntime(
      Object.freeze({
        authoredContextCapability: Object.freeze({
          prepare: () => Object.freeze({ sourceRefs: Object.freeze([]), stableTokenCount: 0 }),
          assertInstall: () => undefined,
          clear: async () => {
            events.push("clear");
            throw clearError;
          },
        }),
        session: Object.freeze({
          dispose: () => {
            events.push("dispose");
            throw disposeError;
          },
        }),
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [clearError, disposeError]);
      return true;
    },
  );
  assert.deepEqual(events, ["clear", "dispose"]);
});

test("rejects binding digest drift before factory invocation and releases its admitted reservation", async () => {
  let calls = 0;
  const materializer = createTestChatRuntimeMaterializer(async () => {
    calls += 1;
    return Object.freeze({ session: Object.freeze({ dispose: () => undefined }) });
  });
  const fixture = await binding();
  try {
    await assert.rejects(
      inActiveBinding(fixture.binding, (execution, reservation) =>
        materializer.materialize(reservation, permit(execution, { runtimeBindingDigest: "c".repeat(64) })),
      ),
      /chat_runtime_materialization_permit_rejected/,
    );
    assert.equal(calls, 0);
    await fixture.binding.close();
  } finally {
    await fixture.binding.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("expired exact permit rejects before factory invocation and releases its admitted reservation", async () => {
  let calls = 0;
  const materializer = createTestChatRuntimeMaterializer(async () => {
    calls += 1;
    return Object.freeze({ session: Object.freeze({ dispose: () => undefined }) });
  });
  const fixture = await binding();
  try {
    await assert.rejects(
      inActiveBinding(fixture.binding, (execution, reservation) =>
        materializer.materialize(reservation, permit(execution, { deadlineAtMs: 0 })),
      ),
      /chat_runtime_materialization_permit_rejected/,
    );
    assert.equal(calls, 0);
    await fixture.binding.close();
  } finally {
    await fixture.binding.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("deadline expiry after factory reverse-disposes the runtime and emits no receipt", async () => {
  let disposed = 0;
  const materializer = createTestChatRuntimeMaterializer(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Object.freeze({
      session: Object.freeze({
        dispose: () => {
          disposed += 1;
        },
      }),
    });
  });
  const fixture = await binding();
  try {
    await assert.rejects(
      inActiveBinding(fixture.binding, (execution, reservation) =>
        materializer.materialize(reservation, permit(execution, { deadlineAtMs: Date.now() + 1 })),
      ),
      /chat_runtime_materialization_permit_rejected/,
    );
    assert.equal(disposed, 1);
    await fixture.binding.close();
  } finally {
    await fixture.binding.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("post-factory permit failure preserves primary and reverse cleanup failures", async () => {
  const clearError = new Error("clear_failed_after_permit_rejection");
  const disposeError = new Error("dispose_failed_after_permit_rejection");
  const materializer = createTestChatRuntimeMaterializer(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Object.freeze({
      authoredContextCapability: Object.freeze({
        prepare: () => Object.freeze({ sourceRefs: Object.freeze([]), stableTokenCount: 0 }),
        assertInstall: () => undefined,
        clear: async () => {
          throw clearError;
        },
      }),
      session: Object.freeze({
        dispose: () => {
          throw disposeError;
        },
      }),
    });
  });
  const fixture = await binding();
  try {
    await assert.rejects(
      inActiveBinding(fixture.binding, (execution, reservation) =>
        materializer.materialize(reservation, permit(execution, { deadlineAtMs: Date.now() + 1 })),
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(String(error.errors[0]), /chat_runtime_materialization_permit_rejected/);
        assert.deepEqual(error.errors.slice(1), [clearError, disposeError]);
        return true;
      },
    );
    // The reservation release is in the unconditional finally path above;
    // binding teardown therefore remains clean even when reverse cleanup fails.
  } finally {
    await fixture.binding.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
