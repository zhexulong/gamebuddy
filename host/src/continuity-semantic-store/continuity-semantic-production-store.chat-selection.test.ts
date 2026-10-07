import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import {
  openProductionContinuityStore,
  type ProductionBootstrapInput,
  type ProductionChatCatalog,
  type TavernExactContentReceipt,
} from "./continuity-semantic-production-store.js";

const principal = { continuityId: "continuity1", companionId: "companion1", playerId: "player1" } as const;
const bootstrap: ProductionBootstrapInput = {
  principal,
  bootstrapOperationId: "bootstrap1",
  authorityGeneration: 1,
  authorityRootIdentity: "a".repeat(64),
};
const holderBindingDigest = "b".repeat(64);
const owner = {
  ownerToken: "owner-token",
  runtimeInstanceId: "runtime-1",
  ownerPid: process.pid,
  ownerProcessStartIdentity: "start-1",
} as const;
const runtimeOwner = Object.freeze({ ...owner });
const runtimeBindingDigest = "d".repeat(64);

type Store = ReturnType<ReturnType<typeof openProductionContinuityStore>["bindBootstrapContext"]>;
type Vector = ProductionChatCatalog["vector"];

/** One fresh root with the initial Chat saga already selected. */
function fixture(label: string) {
  const root = canonicalTestRootSync(`production-chat-selection-${label}-`);
  const control = openProductionContinuityStore({ runtimeRoot: root });
  const metadata = control.bootstrapFresh(bootstrap);
  const store = control.bindBootstrapContext({ bootstrap, metadata });
  const claim = store.claim({
    holderBindingDigest,
    operationId: "claim-1",
    expected: { partitionRevision: 1, fenceEpoch: 1, selectionRevision: 0 },
  });
  const registered = store.register({ holderBindingDigest, operationId: "register-1", expected: claim.vector });
  const verified = store.verify(
    { holderBindingDigest, operationId: "verify-1", expected: registered.vector },
    receiptFor(registered.chatThreadId!, registered.chatSurfaceSessionId!, "c"),
  );
  store.select({ holderBindingDigest, operationId: "select-1", expected: verified.vector });
  return {
    store,
    close() {
      try {
        control.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

function receiptFor(
  chatThreadId: string,
  chatSurfaceSessionId: string,
  fill: string,
): TavernExactContentReceipt {
  return Object.freeze({
    chatThreadId,
    chatSurfaceSessionId,
    continuityId: principal.continuityId,
    companionId: principal.companionId,
    digest: fill.repeat(64),
  });
}

/** Mounts and commits the currently selected Chat, leaving an active runtime. */
function mount(store: Store, selection: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }>) {
  const prepared = store.prepareChatRuntime(
    Object.freeze({
      principal,
      operationId: `runtime-${selection.chatThreadId}`,
      requestId: `runtime-request-${selection.chatThreadId}`,
      chatThreadId: selection.chatThreadId,
      chatSurfaceSessionId: selection.chatSurfaceSessionId,
      runtimeBindingDigest,
      owner: runtimeOwner,
      deadlineAtMs: Date.now() + 60_000,
      expected: { ...store.readChatCatalog().vector },
    }),
  );
  assert.equal(prepared.outcome, "effect_owned");
  const permit = prepared.permit!;
  return store.commitChatRuntime({
    principal,
    permit,
    receipt: Object.freeze({
      kind: "chat_runtime_bootstrapped" as const,
      operationId: permit.operationId,
      requestId: permit.requestId,
      chatThreadId: permit.chatThreadId,
      chatSurfaceSessionId: permit.chatSurfaceSessionId,
      runtimeBindingDigest: permit.runtimeBindingDigest,
      owner: Object.freeze({ ...permit.owner }),
      fenceToken: permit.fenceToken,
      occurredAtMs: Date.now(),
    }),
  });
}

/** The clean close of an active runtime, leaving a terminal teardown behind. */
function closeRuntime(
  store: Store,
  selection: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }>,
): Vector {
  const prepared = store.prepareChatRuntimeTeardown({
    principal,
    operationId: `teardown-${selection.chatThreadId}`,
    requestId: `teardown-request-${selection.chatThreadId}`,
    bootstrapOperationId: `runtime-${selection.chatThreadId}`,
    chatThreadId: selection.chatThreadId,
    chatSurfaceSessionId: selection.chatSurfaceSessionId,
    runtimeBindingDigest,
    owner: runtimeOwner,
    deadlineAtMs: Date.now() + 60_000,
    expected: { ...store.readChatCatalog().vector },
  });
  assert.equal(prepared.outcome, "effect_owned");
  const permit = prepared.permit!;
  const terminal = store.commitChatRuntimeTeardown({
    principal,
    permit,
    receipt: Object.freeze({
      kind: "chat_runtime_torn_down" as const,
      operationId: permit.operationId,
      requestId: permit.requestId,
      bootstrapOperationId: permit.bootstrapOperationId,
      chatThreadId: permit.chatThreadId,
      chatSurfaceSessionId: permit.chatSurfaceSessionId,
      runtimeBindingDigest: permit.runtimeBindingDigest,
      owner: Object.freeze({ ...permit.owner }),
      fenceToken: permit.fenceToken,
      occurredAtMs: Date.now(),
    }),
  });
  assert.equal(terminal.runtimeState, "closed");
  return terminal.vector;
}

/**
 * The pre-mount settlement exactly as the coordinator performs it: the recorded
 * expectation is registered (when new), verified against its Tavern content and
 * selected, then cleared. `chat.select` names Chat 2, which already exists.
 */
function settleCreate(store: Store, target: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }>): void {
  const catalog = store.readChatCatalog();
  store.registerChat(
    Object.freeze({
      operationId: "settle-register",
      chatThreadId: target.chatThreadId,
      chatSurfaceSessionId: target.chatSurfaceSessionId,
      expected: { ...catalog.vector },
    }),
  );
  const registered = store.readChatCatalog();
  assert.equal(
    registered.threads.find((thread) => thread.chatThreadId === target.chatThreadId)?.contentState,
    "registered",
  );
  store.verifyChatContent(
    Object.freeze({
      operationId: "settle-verify",
      chatThreadId: target.chatThreadId,
      chatSurfaceSessionId: target.chatSurfaceSessionId,
      expected: { ...registered.vector },
    }),
    receiptFor(target.chatThreadId, target.chatSurfaceSessionId, "e"),
  );
  const verified = store.readChatCatalog();
  store.selectChat(
    Object.freeze({
      operationId: "settle-select",
      chatThreadId: target.chatThreadId,
      chatSurfaceSessionId: target.chatSurfaceSessionId,
      expected: { ...verified.vector },
    }),
  );
  store.clearChatSelectionIntent(
    Object.freeze({ expected: { ...store.readChatCatalog().vector } }),
  );
}

test("a recorded expected selection is settled as the chain the successor admission accepts", () => {
  const fixtureUnderTest = fixture("settlement");
  try {
    const { store } = fixtureUnderTest;
    const opened = store.readChatCatalog();
    const initial = opened.activeSelection!;
    const initialRuntime = mount(store, initial);
    assert.equal(initialRuntime.runtimeState, "active");
    closeRuntime(store, initial);

    // ADR 0009: a created Chat is recorded as intent. The record advances no
    // vector, so the window after the teardown is legal store state.
    const beforeIntent = store.readChatCatalog();
    assert.equal(beforeIntent.expectedSelection, null);
    const target = Object.freeze({ chatThreadId: "chat-new", chatSurfaceSessionId: "surface-new" });
    const recorded = store.recordChatSelectionIntent(
      Object.freeze({
        intent: Object.freeze({ kind: "create" as const, ...target }),
        expected: { ...beforeIntent.vector },
      }),
    );
    assert.deepEqual(recorded.expectedSelection, Object.freeze({ kind: "create", ...target }));
    assert.deepEqual(recorded.vector, beforeIntent.vector);
    // Recording it is not itself a settlement: the runtime is still closed.
    assert.equal(recorded.activeSelection?.chatThreadId, initial.chatThreadId);

    settleCreate(store, target);
    const settled = store.readChatCatalog();
    assert.equal(settled.expectedSelection, null);
    assert.equal(settled.activeSelection?.chatThreadId, target.chatThreadId);
    assert.equal(settled.activeSelection?.chatSurfaceSessionId, target.chatSurfaceSessionId);

    // The next start mounts the Chat the player asked for.
    const nextRuntime = mount(store, target);
    assert.equal(nextRuntime.runtimeState, "active");
    assert.equal(nextRuntime.chatThreadId, target.chatThreadId);
    assert.equal(store.readChatCatalog().activeSelection?.chatThreadId, target.chatThreadId);
  } finally {
    fixtureUnderTest.close();
  }
});

test("a select expectation names an existing verified Chat and is settled by the same single bridge", () => {
  const fixtureUnderTest = fixture("select");
  try {
    const { store } = fixtureUnderTest;
    const opened = store.readChatCatalog();
    const initial = opened.activeSelection!;
    // A second Chat already exists and is verified, exactly like a Chat the
    // player created on an earlier run.
    const second = Object.freeze({ chatThreadId: "chat-second", chatSurfaceSessionId: "surface-second" });
    store.registerChat(
      Object.freeze({ operationId: "register-second", ...second, expected: { ...opened.vector } }),
    );
    const registered = store.readChatCatalog();
    store.verifyChatContent(
      Object.freeze({ operationId: "verify-second", ...second, expected: { ...registered.vector } }),
      receiptFor(second.chatThreadId, second.chatSurfaceSessionId, "f"),
    );
    const verified = store.readChatCatalog();
    const recorded = store.recordChatSelectionIntent(
      Object.freeze({
        intent: Object.freeze({ kind: "select" as const, ...second }),
        expected: { ...verified.vector },
      }),
    );
    assert.deepEqual(recorded.expectedSelection, Object.freeze({ kind: "select", ...second }));
    // Recording a select leaves the mounted selection where it is.
    assert.equal(recorded.activeSelection?.chatThreadId, initial.chatThreadId);

    mount(store, initial);
    closeRuntime(store, initial);
    const settleTarget = store.readChatCatalog();
    store.selectChat(
      Object.freeze({ operationId: "settle-select", ...second, expected: { ...settleTarget.vector } }),
    );
    store.clearChatSelectionIntent(Object.freeze({ expected: { ...store.readChatCatalog().vector } }));
    const settled = store.readChatCatalog();
    assert.equal(settled.expectedSelection, null);
    assert.equal(settled.activeSelection?.chatThreadId, second.chatThreadId);

    const nextRuntime = mount(store, second);
    assert.equal(nextRuntime.chatThreadId, second.chatThreadId);
  } finally {
    fixtureUnderTest.close();
  }
});

test("the successor admission still refuses an unverified Chat, a foreign target and a forged vector", () => {
  const fixtureUnderTest = fixture("refusals");
  try {
    const { store } = fixtureUnderTest;
    const opened = store.readChatCatalog();
    const initial = opened.activeSelection!;
    mount(store, initial);
    closeRuntime(store, initial);

    // An unverified Chat: registered but with no Tavern content behind it.
    const unverified = Object.freeze({ chatThreadId: "chat-unverified", chatSurfaceSessionId: "surface-unverified" });
    const afterTeardown = store.readChatCatalog();
    store.registerChat(
      Object.freeze({ operationId: "register-unverified", ...unverified, expected: { ...afterTeardown.vector } }),
    );
    const registeredCatalog = store.readChatCatalog();
    // A select of an unverified Chat is refused, and so is an expectation of it.
    assert.throws(
      () =>
        store.selectChat(
          Object.freeze({ operationId: "select-unverified", ...unverified, expected: { ...registeredCatalog.vector } }),
        ),
      /chat_transition_invalid/,
    );
    assert.throws(
      () =>
        store.recordChatSelectionIntent(
          Object.freeze({
            intent: Object.freeze({ kind: "select" as const, ...unverified }),
            expected: { ...registeredCatalog.vector },
          }),
        ),
      /chat_selection_conflict/,
    );
    // An out-of-order settlement: a select can never precede its registration.
    assert.throws(
      () =>
        store.selectChat(
          Object.freeze({
            operationId: "select-unregistered",
            chatThreadId: "chat-absent",
            chatSurfaceSessionId: "surface-absent",
            expected: { ...registeredCatalog.vector },
          }),
        ),
      /chat_exact_binding_conflict/,
    );

    // A settled chain to the player's Chat, then a mount that does not match it.
    const target = Object.freeze({ chatThreadId: "chat-settled", chatSurfaceSessionId: "surface-settled" });
    store.recordChatSelectionIntent(
      Object.freeze({
        intent: Object.freeze({ kind: "create" as const, ...target }),
        expected: { ...store.readChatCatalog().vector },
      }),
    );
    settleCreate(store, target);
    const settledCatalog = store.readChatCatalog();
    assert.equal(settledCatalog.activeSelection?.chatThreadId, target.chatThreadId);
    const forgedVector = {
      ...settledCatalog.vector,
      partitionRevision: settledCatalog.vector.partitionRevision + 1,
      fenceEpoch: settledCatalog.vector.fenceEpoch + 1,
    };
    // Another Chat: the chain's select bridge names the settled Chat only.
    assert.throws(
      () =>
        store.prepareChatRuntime(
          Object.freeze({
            principal,
            operationId: "runtime-foreign",
            requestId: "runtime-request-foreign",
            chatThreadId: unverified.chatThreadId,
            chatSurfaceSessionId: unverified.chatSurfaceSessionId,
            runtimeBindingDigest,
            owner: runtimeOwner,
            deadlineAtMs: Date.now() + 60_000,
            expected: { ...settledCatalog.vector },
          }),
        ),
      /chat_runtime_chain_invalid|chat_runtime_origin_conflict/,
    );
    // A vector the settled chain never produced.
    assert.throws(
      () =>
        store.prepareChatRuntime(
          Object.freeze({
            principal,
            operationId: "runtime-forged-vector",
            requestId: "runtime-request-forged-vector",
            chatThreadId: target.chatThreadId,
            chatSurfaceSessionId: target.chatSurfaceSessionId,
            runtimeBindingDigest,
            owner: runtimeOwner,
            deadlineAtMs: Date.now() + 60_000,
            expected: forgedVector,
          }),
        ),
      /chat_runtime_vector_conflict|chat_runtime_chain_invalid/,
    );
    // The exact settled Chat and vector is still admitted.
    assert.equal(mount(store, target).runtimeState, "active");
  } finally {
    fixtureUnderTest.close();
  }
});

test("a chain whose tip is no longer the settling select is refused", () => {
  const fixtureUnderTest = fixture("tip");
  try {
    const { store } = fixtureUnderTest;
    const opened = store.readChatCatalog();
    const initial = opened.activeSelection!;
    mount(store, initial);
    closeRuntime(store, initial);
    const target = Object.freeze({ chatThreadId: "chat-tip", chatSurfaceSessionId: "surface-tip" });
    store.recordChatSelectionIntent(
      Object.freeze({
        intent: Object.freeze({ kind: "create" as const, ...target }),
        expected: { ...store.readChatCatalog().vector },
      }),
    );
    settleCreate(store, target);
    // Any command recorded after the settling select becomes the chain tip, so
    // the admitted chain is no longer the settlement's.
    store.registerChat(
      Object.freeze({
        operationId: "register-after-settlement",
        chatThreadId: "chat-later",
        chatSurfaceSessionId: "surface-later",
        expected: { ...store.readChatCatalog().vector },
      }),
    );
    const tipped = store.readChatCatalog();
    assert.equal(tipped.activeSelection?.chatThreadId, target.chatThreadId);
    assert.throws(
      () =>
        store.prepareChatRuntime(
          Object.freeze({
            principal,
            operationId: "runtime-after-tip",
            requestId: "runtime-request-after-tip",
            chatThreadId: target.chatThreadId,
            chatSurfaceSessionId: target.chatSurfaceSessionId,
            runtimeBindingDigest,
            owner: runtimeOwner,
            deadlineAtMs: Date.now() + 60_000,
            expected: { ...tipped.vector },
          }),
        ),
      /chat_runtime_chain_invalid/,
    );
  } finally {
    fixtureUnderTest.close();
  }
});

test("recording an expectation fails closed while a runtime transition is in flight", () => {
  const fixtureUnderTest = fixture("in-flight");
  try {
    const { store } = fixtureUnderTest;
    const opened = store.readChatCatalog();
    const initial = opened.activeSelection!;
    const prepared = store.prepareChatRuntime(
      Object.freeze({
        principal,
        operationId: "runtime-in-flight",
        requestId: "runtime-request-in-flight",
        chatThreadId: initial.chatThreadId,
        chatSurfaceSessionId: initial.chatSurfaceSessionId,
        runtimeBindingDigest,
        owner: runtimeOwner,
        deadlineAtMs: Date.now() + 60_000,
        expected: { ...opened.vector },
      }),
    );
    assert.equal(prepared.outcome, "effect_owned");
    assert.throws(
      () =>
        store.recordChatSelectionIntent(
          Object.freeze({
            intent: Object.freeze({
              kind: "create" as const,
              chatThreadId: "chat-while-transitioning",
              chatSurfaceSessionId: "surface-while-transitioning",
            }),
            expected: { ...store.readChatCatalog().vector },
          }),
        ),
      /chat_selection_transition_in_flight/,
    );
    // Nothing was recorded and the runtime transition is untouched.
    assert.equal(store.readChatCatalog().expectedSelection, null);
    const permit = prepared.permit!;
    assert.equal(
      store.commitChatRuntime({
        principal,
        permit,
        receipt: Object.freeze({
          kind: "chat_runtime_bootstrapped" as const,
          operationId: permit.operationId,
          requestId: permit.requestId,
          chatThreadId: permit.chatThreadId,
          chatSurfaceSessionId: permit.chatSurfaceSessionId,
          runtimeBindingDigest: permit.runtimeBindingDigest,
          owner: Object.freeze({ ...permit.owner }),
          fenceToken: permit.fenceToken,
          occurredAtMs: Date.now(),
        }),
      }).runtimeState,
      "active",
    );
  } finally {
    fixtureUnderTest.close();
  }
});
