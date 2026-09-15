import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { canonicalTestRootSync } from "./test-support/canonical-test-root.test-support.js";
import {
  openProductionContinuityStore,
  type ProductionBootstrapInput,
  type ProductionContinuityStore,
} from "./continuity-semantic-store/continuity-semantic-production-store.js";
import {
  createStardewWorldBindingResolver,
  createStardewWorldBindingResolverFromGameAuthority,
  type WorldBindingReader,
} from "./stardew-owned-farmhand-game-world-binding-resolver.internal.js";

const principal = { continuityId: "continuity-resolver", companionId: "companion-resolver", playerId: "player-resolver" } as const;
const bootstrap: ProductionBootstrapInput = {
  principal,
  bootstrapOperationId: "bootstrap-resolver",
  authorityGeneration: 1,
  authorityRootIdentity: "b".repeat(64),
};

type StoreView = ReturnType<ProductionContinuityStore["bindBootstrapContext"]>;

function createStardewSession(
  root: string,
  creationRequestId: string,
  integrationId = "stardew",
  bindingRef = "opaque-world-ref",
  operationId = "bind-resolver-01",
) {
  const control = openProductionContinuityStore({ runtimeRoot: root });
  const metadata = control.bootstrapFresh(bootstrap);
  const store = control.bindBootstrapContext({ bootstrap, metadata });
  const session = store.createGameSessionMetadata({
    creationRequestId,
    integrationId,
    continuityIdentityId: principal.continuityId,
  });
  return { control, store, session };
}

function registerBinding(
  store: StoreView,
  session: { gameSessionId: string },
  bindingRef = "opaque-world-ref",
  operationId = "bind-resolver-01",
) {
  return store.registerGameSessionWorldBinding({
    gameSessionId: session.gameSessionId,
    integrationId: "stardew",
    bindingRef,
    operationId,
  });
}

/** The store's own close guard: a control that swallowed an assertion failure is still closed before rmSync. */
async function withControl(root: string, body: (control: ReturnType<typeof openProductionContinuityStore>) => Promise<void>): Promise<void> {
  const control = openProductionContinuityStore({ runtimeRoot: root });
  let controlClosed = false;
  try {
    await body(control);
    control.close();
    controlClosed = true;
  } finally {
    if (!controlClosed) control.close();
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* Windows SQLite cleanup is best effort */
    }
  }
}

test("resolver exposes only the frozen resolveWorldBinding operation", async () => {
  const resolverModule = await import("./stardew-owned-farmhand-game-world-binding-resolver.internal.js");
  assert.deepEqual(Object.keys(resolverModule).sort(), [
    "createStardewWorldBindingResolver",
    "createStardewWorldBindingResolverFromGameAuthority",
  ]);
  const readBinding: WorldBindingReader = async () => null;
  const resolver = createStardewWorldBindingResolver(readBinding);
  assert.deepEqual(Object.keys(resolver), ["resolveWorldBinding"]);
  assert.equal(Object.isFrozen(resolver), true);
  assert.equal(resolver.resolveWorldBinding.length, 1);
});

test("reader never receives a forged or extra field and only ever the Stardew integration", async () => {
  const observed: unknown[] = [];
  const resolver = createStardewWorldBindingResolver(async (input) => {
    observed.push(input);
    return null;
  });
  await resolver.resolveWorldBinding("session-abc");
  assert.equal(observed.length, 1);
  const call = observed[0] as Readonly<{ gameSessionId: string; integrationId: string }>;
  assert.deepEqual(Object.keys(call).sort(), ["gameSessionId", "integrationId"]);
  assert.equal(call.integrationId, "stardew");
  assert.equal(call.gameSessionId, "session-abc");
  // No PID/path/window/save/startup-time probe may reach the reader.
  assert.equal("pid" in call, false);
  assert.equal("saveId" in call, false);
  assert.equal("window" in call, false);
  assert.equal("bindingRef" in call, false);
});

test("exact registered binding resolves and reopen reads the same record", async () => {
  const root = canonicalTestRootSync("resolver-exact-");
  await withControl(root, async (control) => {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const session = store.createGameSessionMetadata({
      creationRequestId: "create-resolver-exact",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    const registered = registerBinding(store, session, "opaque-world-ref", "bind-resolver-exact");
    const resolver = createStardewWorldBindingResolver((input) =>
      Promise.resolve(store.readGameSessionWorldBinding(input)),
    );
    const outcome = await resolver.resolveWorldBinding(session.gameSessionId);
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.deepEqual(outcome.binding, registered);

    // Reopen consistency: the exact registered binding survives reopen.
    const reopenedControl = openProductionContinuityStore({ runtimeRoot: root });
    let reopenedClosed = false;
    try {
      const reopenedStore = reopenedControl.bindBootstrapContext({
        bootstrap,
        metadata: reopenedControl.validateBootstrap(bootstrap),
      });
      const reopenedResolver = createStardewWorldBindingResolver((input) =>
        Promise.resolve(reopenedStore.readGameSessionWorldBinding(input)),
      );
      const reopenedOutcome = await reopenedResolver.resolveWorldBinding(session.gameSessionId);
      assert.equal(reopenedOutcome.ok, true);
      if (reopenedOutcome.ok) assert.deepEqual(reopenedOutcome.binding, registered);
    } finally {
      reopenedControl.close();
      reopenedClosed = true;
    }
  });
});

test("missing session or missing binding fails closed as unavailable", async () => {
  const readBinding: WorldBindingReader = async (input) => {
    assert.equal(input.integrationId, "stardew");
    return Promise.resolve(null);
  };
  const resolver = createStardewWorldBindingResolver(readBinding);
  const missing = await resolver.resolveWorldBinding("session-absent");
  assert.deepEqual(missing, { ok: false, reason: "missing_or_foreign" });
});

test("foreign integration binding is unavailable without interpreting its ref", async () => {
  const root = canonicalTestRootSync("resolver-foreign-");
  await withControl(root, async (control) => {
    // A session bound to another integration must never resolve as Stardew.
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const session = store.createGameSessionMetadata({
      creationRequestId: "create-resolver-foreign",
      integrationId: "other-integration",
      continuityIdentityId: principal.continuityId,
    });
    store.registerGameSessionWorldBinding({
      gameSessionId: session.gameSessionId,
      integrationId: "other-integration",
      bindingRef: "other-opaque-ref",
      operationId: "bind-resolver-foreign",
    });
    const resolver = createStardewWorldBindingResolver((input) =>
      Promise.resolve(store.readGameSessionWorldBinding(input)),
    );
    const outcome = await resolver.resolveWorldBinding(session.gameSessionId);
    assert.deepEqual(outcome, { ok: false, reason: "missing_or_foreign" });
  });
});

test("terminal binding is unavailable and remains unavailable after reopen", async () => {
  const root = canonicalTestRootSync("resolver-terminal-");
  await withControl(root, async (control) => {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const session = store.createGameSessionMetadata({
      creationRequestId: "create-resolver-terminal",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    registerBinding(store, session, "opaque-terminal-ref", "bind-resolver-terminal");
    // The store's terminal transition requires the session to be resumable first.
    store.completeGameSessionBinding({
      creationRequestId: "create-resolver-terminal",
      gameSessionId: session.gameSessionId,
      expectedRevision: 1,
    });
    const terminal = store.markGameSessionWorldBindingTerminal({
      gameSessionId: session.gameSessionId,
      integrationId: "stardew",
      expectedRevision: 1,
      operationId: "bind-resolver-terminal",
    });
    assert.equal(terminal.status, "terminal");

    const resolver = createStardewWorldBindingResolver((input) =>
      Promise.resolve(store.readGameSessionWorldBinding(input)),
    );
    const terminalOutcome = await resolver.resolveWorldBinding(session.gameSessionId);
    assert.deepEqual(terminalOutcome, { ok: false, reason: "terminal" });

    // Reopen consistency: terminal is sticky across reopen.
    const reopenedControl = openProductionContinuityStore({ runtimeRoot: root });
    let reopenedClosed = false;
    try {
      const reopenedStore = reopenedControl.bindBootstrapContext({
        bootstrap,
        metadata: reopenedControl.validateBootstrap(bootstrap),
      });
      const reopenedResolver = createStardewWorldBindingResolver((input) =>
        Promise.resolve(reopenedStore.readGameSessionWorldBinding(input)),
      );
      const reopenedOutcome = await reopenedResolver.resolveWorldBinding(session.gameSessionId);
      assert.deepEqual(reopenedOutcome, { ok: false, reason: "terminal" });
    } finally {
      reopenedControl.close();
      reopenedClosed = true;
    }
  });
});

test("invalid or unsafe session identity fails closed without calling the reader", async () => {
  let readerCalls = 0;
  const resolver = createStardewWorldBindingResolver(async () => {
    readerCalls += 1;
    return null;
  });
  for (const bad of ["", "has space", "quote'", "semi;colon", "slash/path", "🦆", "a".repeat(129)]) {
    const outcome = await resolver.resolveWorldBinding(bad);
    assert.deepEqual(outcome, { ok: false, reason: "missing_or_foreign" });
  }
  assert.equal(readerCalls, 0);
});

test("construction wrapper rejects a non-authority shape and forwards through the exact authority method", async () => {
  assert.throws(
    () => createStardewWorldBindingResolverFromGameAuthority(undefined as never),
    /invalid_stardew_world_binding_resolver_authority/,
  );
  assert.throws(
    () => createStardewWorldBindingResolverFromGameAuthority({} as never),
    /invalid_stardew_world_binding_resolver_authority/,
  );
  const calls: string[] = [];
  const fakeAuthority = {
    async readGameSessionWorldBinding(input: Readonly<{ gameSessionId: string; integrationId: string }>) {
      calls.push(`${input.integrationId}:${input.gameSessionId}`);
      return null;
    },
  };
  const resolver = createStardewWorldBindingResolverFromGameAuthority(fakeAuthority as never);
  const outcome = await resolver.resolveWorldBinding("session-wrapper");
  assert.deepEqual(outcome, { ok: false, reason: "missing_or_foreign" });
  assert.deepEqual(calls, ["stardew:session-wrapper"]);
});