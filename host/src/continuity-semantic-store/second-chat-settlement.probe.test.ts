import { rmSync } from "node:fs";
import test from "node:test";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import {
  openProductionContinuityStore,
  type ProductionBootstrapInput,
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

function fixture(label: string) {
  const root = canonicalTestRootSync(`probe-${label}-`);
  const control = openProductionContinuityStore({ runtimeRoot: root });
  const metadata = control.bootstrapFresh(bootstrap);
  const store = control.bindBootstrapContext({ bootstrap, metadata });
  const claim = store.claim({
    holderBindingDigest,
    operationId: "claim_1",
    expected: { partitionRevision: 1, fenceEpoch: 1, selectionRevision: 0 },
  });
  const registered = store.register({ holderBindingDigest, operationId: "register_1", expected: claim.vector });
  const verified = store.verify(
    { holderBindingDigest, operationId: "verify_1", expected: registered.vector },
    {
      chatThreadId: registered.chatThreadId!,
      chatSurfaceSessionId: registered.chatSurfaceSessionId!,
      continuityId: principal.continuityId,
      companionId: principal.companionId,
      digest: "c".repeat(64),
    },
  );
  const selected = store.select({ holderBindingDigest, operationId: "select_1", expected: verified.vector });
  return {
    root,
    control,
    store,
    selected,
    close() {
      try {
        control.close();
      } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function bootRuntime(store: Store, selected: { chatThreadId: string | null; chatSurfaceSessionId: string | null }) {
  const prepared = store.prepareChatRuntime(
    Object.freeze({
      principal,
      operationId: "runtime_1",
      requestId: "runtime_request_1",
      chatThreadId: selected.chatThreadId!,
      chatSurfaceSessionId: selected.chatSurfaceSessionId!,
      runtimeBindingDigest,
      owner: runtimeOwner,
      deadlineAtMs: Date.now() + 60_000,
      expected: { ...store.readChatCatalog().vector },
    }),
  );
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

function tearDownRuntime(store: Store) {
  const permit0 = store.readChatCatalog();
  void permit0;
  return (store as any);
}

function tearDown(store: Store, bootstrapOperationId: string) {
  const teardown = store.prepareChatRuntimeTeardown({
    principal,
    operationId: "teardown_1",
    requestId: "teardown_request_1",
    bootstrapOperationId,
    chatThreadId: store.readChatCatalog().activeSelection!.chatThreadId,
    chatSurfaceSessionId: store.readChatCatalog().activeSelection!.chatSurfaceSessionId,
    runtimeBindingDigest,
    owner: runtimeOwner,
    deadlineAtMs: Date.now() + 60_000,
    expected: { ...store.readChatCatalog().vector },
  });
  const permit = teardown.permit!;
  return store.commitChatRuntimeTeardown({
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
}

function attempt(label: string, work: () => void): void {
  try {
    work();
    console.log(`PROBE ${label}: ACCEPTED`);
  } catch (error) {
    console.log(`PROBE ${label}: REJECTED ${(error as Error).message}`);
  }
}

test("probe: adr-0009 settlement shapes", () => {
  // S1: register_chat immediately after a terminal teardown.
  {
    const f = fixture("s1");
    try {
      bootRuntime(f.store, f.selected);
      const closed = tearDown(f.store, "runtime_1");
      console.log("PROBE s1 teardown vector", JSON.stringify(closed.vector));
      attempt("s1-register-after-teardown", () => {
        f.store.registerChat(
          Object.freeze({
            operationId: "register_new",
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            expected: { ...f.store.readChatCatalog().vector },
          }),
        );
      });
      attempt("s1-read-after-register", () => {
        console.log("PROBE s1 catalog", JSON.stringify(f.store.readChatCatalog().vector));
      });
    } finally {
      f.close();
    }
  }

  // S2: teardown, then register+verify+select the new chat, then the next mount.
  {
    const f = fixture("s2");
    try {
      bootRuntime(f.store, f.selected);
      const closed = tearDown(f.store, "runtime_1");
      const teardownVector = { ...closed.vector };
      attempt("s2-select-new-at-teardown-vector-without-registration", () => {
        f.store.selectChat(
          Object.freeze({
            operationId: "select_only",
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            expected: { ...teardownVector },
          }),
        );
      });
      attempt("s2-register", () => {
        f.store.registerChat(
          Object.freeze({
            operationId: "register_new",
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            expected: { ...teardownVector },
          }),
        );
      });
      attempt("s2-verify", () => {
        f.store.verifyChatContent(
          Object.freeze({
            operationId: "verify_new",
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            expected: { ...f.store.readChatCatalog().vector },
          }),
          Object.freeze({
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            continuityId: principal.continuityId,
            companionId: principal.companionId,
            digest: "e".repeat(64),
          }) as TavernExactContentReceipt,
        );
      });
      attempt("s2-select", () => {
        f.store.selectChat(
          Object.freeze({
            operationId: "select_new",
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            expected: { ...f.store.readChatCatalog().vector },
          }),
        );
      });
      attempt("s2-next-mount", () => {
        const prepared = f.store.prepareChatRuntime(
          Object.freeze({
            principal,
            operationId: "runtime_2",
            requestId: "runtime_request_2",
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            runtimeBindingDigest,
            owner: runtimeOwner,
            deadlineAtMs: Date.now() + 60_000,
            expected: { ...f.store.readChatCatalog().vector },
          }),
        );
        console.log("PROBE s2 mount outcome", prepared.outcome, prepared.readback.status);
      });
    } finally {
      f.close();
    }
  }

  // S3: teardown, same-selection bridge, then register+verify+select the new chat, then the next mount.
  {
    const f = fixture("s3");
    try {
      bootRuntime(f.store, f.selected);
      const closed = tearDown(f.store, "runtime_1");
      const teardownVector = { ...closed.vector };
      attempt("s3-same-selection-bridge", () => {
        f.store.selectChat(
          Object.freeze({
            operationId: "reselect_current",
            chatThreadId: f.selected.chatThreadId!,
            chatSurfaceSessionId: f.selected.chatSurfaceSessionId!,
            expected: { ...teardownVector },
          }),
        );
      });
      attempt("s3-register", () => {
        f.store.registerChat(
          Object.freeze({
            operationId: "register_new",
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            expected: { ...f.store.readChatCatalog().vector },
          }),
        );
      });
      attempt("s3-verify", () => {
        f.store.verifyChatContent(
          Object.freeze({
            operationId: "verify_new",
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            expected: { ...f.store.readChatCatalog().vector },
          }),
          Object.freeze({
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            continuityId: principal.continuityId,
            companionId: principal.companionId,
            digest: "e".repeat(64),
          }) as TavernExactContentReceipt,
        );
      });
      attempt("s3-select-new", () => {
        f.store.selectChat(
          Object.freeze({
            operationId: "select_new",
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            expected: { ...f.store.readChatCatalog().vector },
          }),
        );
      });
      attempt("s3-next-mount", () => {
        const prepared = f.store.prepareChatRuntime(
          Object.freeze({
            principal,
            operationId: "runtime_2",
            requestId: "runtime_request_2",
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            runtimeBindingDigest,
            owner: runtimeOwner,
            deadlineAtMs: Date.now() + 60_000,
            expected: { ...f.store.readChatCatalog().vector },
          }),
        );
        console.log("PROBE s3 mount outcome", prepared.outcome, prepared.readback.status);
      });
    } finally {
      f.close();
    }
  }

  // S5: a mounted runtime, then chat.create (register+verify), then the clean close.
  {
    const f = fixture("s5");
    try {
      bootRuntime(f.store, f.selected);
      attempt("s5-register-while-mounted", () => {
        f.store.registerChat(
          Object.freeze({
            operationId: "register_new",
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            expected: { ...f.store.readChatCatalog().vector },
          }),
        );
      });
      attempt("s5-verify-while-mounted", () => {
        f.store.verifyChatContent(
          Object.freeze({
            operationId: "verify_new",
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            expected: { ...f.store.readChatCatalog().vector },
          }),
          Object.freeze({
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            continuityId: principal.continuityId,
            companionId: principal.companionId,
            digest: "e".repeat(64),
          }) as TavernExactContentReceipt,
        );
      });
      attempt("s5-clean-close", () => {
        const teardown = f.store.prepareChatRuntimeTeardown({
          principal,
          operationId: "teardown_1",
          requestId: "teardown_request_1",
          bootstrapOperationId: "runtime_1",
          chatThreadId: f.selected.chatThreadId!,
          chatSurfaceSessionId: f.selected.chatSurfaceSessionId!,
          runtimeBindingDigest,
          owner: runtimeOwner,
          deadlineAtMs: Date.now() + 60_000,
          expected: { ...f.store.readChatCatalog().vector },
        });
        console.log("PROBE s5 teardown outcome", teardown.outcome);
      });
    } finally {
      f.close();
    }
  }

  // S4: no runtime ever mounted: switch the selection to a second chat, then mount it.
  {
    const f = fixture("s4");
    try {
      attempt("s4-register", () => {
        f.store.registerChat(
          Object.freeze({
            operationId: "register_new",
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            expected: { ...f.store.readChatCatalog().vector },
          }),
        );
      });
      attempt("s4-verify", () => {
        f.store.verifyChatContent(
          Object.freeze({
            operationId: "verify_new",
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            expected: { ...f.store.readChatCatalog().vector },
          }),
          Object.freeze({
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            continuityId: principal.continuityId,
            companionId: principal.companionId,
            digest: "e".repeat(64),
          }) as TavernExactContentReceipt,
        );
      });
      attempt("s4-select-new", () => {
        f.store.selectChat(
          Object.freeze({
            operationId: "select_new",
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            expected: { ...f.store.readChatCatalog().vector },
          }),
        );
      });
      attempt("s4-first-mount", () => {
        const prepared = f.store.prepareChatRuntime(
          Object.freeze({
            principal,
            operationId: "runtime_1",
            requestId: "runtime_request_1",
            chatThreadId: "chat-new",
            chatSurfaceSessionId: "surface-new",
            runtimeBindingDigest,
            owner: runtimeOwner,
            deadlineAtMs: Date.now() + 60_000,
            expected: { ...f.store.readChatCatalog().vector },
          }),
        );
        console.log("PROBE s4 mount outcome", prepared.outcome, prepared.readback.status);
      });
    } finally {
      f.close();
    }
  }
});

void tearDownRuntime;
