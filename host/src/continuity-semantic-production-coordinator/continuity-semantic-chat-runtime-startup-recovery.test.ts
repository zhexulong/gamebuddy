/**
 * The Chat half of startup recovery, for the Chat RUNTIME cycle rather than the turn ledger.
 *
 * A Host that dies between `prepareChatRuntime` and `commitChatRuntime` (or between the teardown's two
 * writes) leaves a durable intent that `rejectChatRuntimeTransition` refuses every Chat runtime mount and
 * every Chat command for. The Game half has settled its own dead-owner obligation at startup since
 * `settleDurableGameRecoveryOnStartup`; this is the same shape for Chat, and the same decision rule: only a
 * `proven_dead` owner permits the settlement, `alive` is a single-instance conflict, unknown is not dead,
 * and a probe that could not run is deferred rather than fatal.
 *
 * The last case is the gate: every non-terminal status the two intent tables admit, taken from their own
 * durable `CHECK` declarations, is driven into that state on a real store and must reach `terminal` through
 * the production settlement. A state that cannot is the defect this file exists for.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { WindowsOwnerDeathOutcome } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.windows-owner-death.internal.js";
import { createTestWindowsOwnerDeathVerification } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.windows-owner-death.test-support.js";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import {
  openProductionContinuityStore,
  type ProductionBootstrapInput,
  type ProductionChatRuntimePermit,
  type ProductionChatRuntimeRecoveryTarget,
  type TavernExactContentReceipt,
} from "../continuity-semantic-store/continuity-semantic-production-store.js";
import {
  recoverChatRuntimeObligation,
  settleDurableChatRuntimeRecoveryOnStartup,
} from "./continuity-semantic-production-coordinator.internal.js";

const principal = Object.freeze({ continuityId: "continuity1", companionId: "companion1", playerId: "player1" });
const bootstrap: ProductionBootstrapInput = {
  principal,
  bootstrapOperationId: "bootstrap1",
  authorityGeneration: 1,
  authorityRootIdentity: "a".repeat(64),
};
const holderBindingDigest = "b".repeat(64);
/** A process this test is not: the intent's owner exited with the Host that prepared it. */
const deadOwner = Object.freeze({
  ownerToken: "owner-token-1",
  runtimeInstanceId: "runtime-instance-1",
  ownerPid: 4_242,
  ownerProcessStartIdentity: "start-identity-1",
});

type Store = ReturnType<ReturnType<typeof openProductionContinuityStore>["bindBootstrapContext"]>;

function receiptFor(chatThreadId: string, chatSurfaceSessionId: string): TavernExactContentReceipt {
  return Object.freeze({
    chatThreadId,
    chatSurfaceSessionId,
    continuityId: principal.continuityId,
    companionId: principal.companionId,
    digest: "c".repeat(64),
  });
}

/** One fresh root whose initial Chat is registered, verified and selected. */
function freshRoot() {
  const root = canonicalTestRootSync("production-chat-runtime-startup-recovery-");
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
    receiptFor(registered.chatThreadId!, registered.chatSurfaceSessionId!),
  );
  store.select({ holderBindingDigest, operationId: "select-1", expected: verified.vector });
  return { root, control, store };
}

function runtimeRequest(store: Store, suffix: string) {
  return {
    principal,
    operationId: `runtime-${suffix}`,
    requestId: `runtime-request-${suffix}`,
    chatThreadId: store.readChatCatalog().activeSelection!.chatThreadId,
    chatSurfaceSessionId: store.readChatCatalog().activeSelection!.chatSurfaceSessionId,
    runtimeBindingDigest: "d".repeat(64),
    owner: Object.freeze({ ...deadOwner }),
    deadlineAtMs: Date.now() + 60_000,
    expected: { ...store.readChatCatalog().vector },
  };
}

function teardownRequest(store: Store, runtime: ProductionChatRuntimePermit, suffix: string) {
  return {
    principal,
    operationId: `teardown-${suffix}`,
    requestId: `teardown-request-${suffix}`,
    bootstrapOperationId: runtime.operationId,
    chatThreadId: runtime.chatThreadId,
    chatSurfaceSessionId: runtime.chatSurfaceSessionId,
    runtimeBindingDigest: runtime.runtimeBindingDigest,
    owner: Object.freeze({ ...deadOwner }),
    deadlineAtMs: Date.now() + 60_000,
    expected: { ...store.readChatCatalog().vector },
  };
}

function bootstrapReceipt(permit: ProductionChatRuntimePermit) {
  return Object.freeze({
    kind: "chat_runtime_bootstrapped" as const,
    operationId: permit.operationId,
    requestId: permit.requestId,
    chatThreadId: permit.chatThreadId,
    chatSurfaceSessionId: permit.chatSurfaceSessionId,
    runtimeBindingDigest: permit.runtimeBindingDigest,
    owner: Object.freeze({ ...permit.owner }),
    fenceToken: permit.fenceToken,
    occurredAtMs: Date.now(),
  });
}

/** A committed Chat runtime: the terminal predecessor the teardown half requires. */
function committedRuntime(store: Store): ProductionChatRuntimePermit {
  const prepared = store.prepareChatRuntime(runtimeRequest(store, "committed"));
  const permit = prepared.permit!;
  assert.equal(
    store.commitChatRuntime({ principal, permit, receipt: bootstrapReceipt(permit) }).runtimeState,
    "active",
  );
  return permit;
}

/**
 * The production settlement, driven against this root's real store with the one OS reading a test may
 * choose: the same shape the receipt and the store call have in production, because both come from the
 * coordinator's own `recoverChatRuntimeObligation`.
 */
function settle(store: Store, outcome: WindowsOwnerDeathOutcome) {
  return settleDurableChatRuntimeRecoveryOnStartup(
    async () => store.readPendingChatRuntimeRecoveryTarget(),
    async (target: ProductionChatRuntimeRecoveryTarget, proof) =>
      recoverChatRuntimeObligation(store, principal, target, proof),
    Object.freeze({
      verify: async (exactOwner) => createTestWindowsOwnerDeathVerification(exactOwner, outcome),
    }),
  );
}

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

/** The state the two intent tables admit, read from their own durable declarations. */
function durableStatuses(sql: string): readonly string[] {
  const declaration = /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/u.exec(sql);
  if (declaration === null) throw new Error(`the intent table no longer declares its statuses: ${sql}`);
  return Object.freeze([...declaration[1]!.matchAll(/'([^']+)'/gu)].map((match) => match[1]!));
}

function intentStatuses(root: string): Readonly<Record<string, readonly string[]>> {
  const db = new DatabaseSync(join(root, "gamebuddy-continuity-v1.sqlite"), { readOnly: true });
  try {
    const tables = ["production_chat_runtime_intent", "production_chat_runtime_teardown_intent"] as const;
    return Object.freeze(
      Object.fromEntries(
        tables.map((table) => {
          const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as
            | { sql: string }
            | undefined;
          if (row === undefined) throw new Error(`the store no longer declares ${table}`);
          return [table, durableStatuses(row.sql)];
        }),
      ),
    );
  } finally {
    db.close();
  }
}

test("a Chat runtime intent a dead Host left is settled at startup and the Chat becomes usable again", async () => {
  const { root, control, store } = freshRoot();
  try {
    const prepared = store.prepareChatRuntime(runtimeRequest(store, "abandoned"));
    const permit = prepared.permit!;
    // The defect, measured before the settlement: the mount and the Chat ledger both refuse by name.
    assert.throws(() => store.prepareChatRuntime(runtimeRequest(store, "blocked")), /chat_runtime_transition_pending/);

    const { result, diagnostics } = await captureDiagnostics(() => settle(store, "proven_dead"));

    // The settlement's own answer: the intent it settled is terminal, and it is the one the dead Host left.
    assert.equal(result?.status, "terminal");
    assert.equal(result?.operationId, permit.operationId);
    // The one line an unattributed recovery leaves: the Chat, the half, the owner and the verdict.
    assert.match(diagnostics, /^\[chat-runtime-recovery\] startup /u);
    assert.match(diagnostics, /recovered the Chat runtime obligation/u);
    assert.match(diagnostics, new RegExp(`operation=${permit.operationId}`, "u"));
    assert.match(diagnostics, /half=bootstrap/u);
    assert.match(diagnostics, new RegExp(`owner_pid=${deadOwner.ownerPid}`, "u"));
    assert.match(diagnostics, /owner=proven_dead/u);

    // What the player gets back: the obligation is gone, the successor bridge can be written, and the
    // runtime mounts. Neither of the last two was reachable while the intent was live.
    assert.equal(store.readPendingChatRuntimeRecoveryTarget(), null);
    store.selectChat({
      operationId: "select-successor",
      chatThreadId: permit.chatThreadId,
      chatSurfaceSessionId: permit.chatSurfaceSessionId,
      expected: { ...store.readChatCatalog().vector },
    });
    assert.equal(store.prepareChatRuntime(runtimeRequest(store, "admitted")).outcome, "effect_owned");
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a living owner is refused as a single-instance conflict and the obligation is left exactly as it was", async () => {
  const { root, control, store } = freshRoot();
  try {
    store.prepareChatRuntime(runtimeRequest(store, "alive"));
    const before = store.readPendingChatRuntimeRecoveryTarget();
    const { diagnostics } = await captureDiagnostics(async () => {
      await assert.rejects(settle(store, "alive"), /chat_runtime_recovery_blocked_owner_alive/u);
    });
    assert.match(diagnostics, /another GameBuddy is already running/u);
    assert.doesNotMatch(diagnostics, /could not be proven/u);
    assert.deepEqual(store.readPendingChatRuntimeRecoveryTarget(), before);
    assert.throws(() => store.prepareChatRuntime(runtimeRequest(store, "blocked")), /chat_runtime_transition_pending/);
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const outcome of ["mismatch", "ambiguous"] as const)
  test(`an ${outcome} owner verdict is unknown, so nothing is settled and the refusal names the condition`, async () => {
    const { root, control, store } = freshRoot();
    try {
      store.prepareChatRuntime(runtimeRequest(store, outcome));
      const before = store.readPendingChatRuntimeRecoveryTarget();
      const { diagnostics } = await captureDiagnostics(async () => {
        await assert.rejects(settle(store, outcome), /chat_runtime_recovery_blocked_owner_unknown/u);
      });
      assert.match(diagnostics, new RegExp(`owner=${outcome}`, "u"));
      assert.match(diagnostics, /could not be proven/u);
      assert.deepEqual(store.readPendingChatRuntimeRecoveryTarget(), before);
      assert.throws(
        () => store.prepareChatRuntime(runtimeRequest(store, "blocked")),
        /chat_runtime_transition_pending/,
      );
    } finally {
      control.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

test("a probe that could not run is deferred rather than fatal, and the obligation stays durable for the next start", async () => {
  const { root, control, store } = freshRoot();
  try {
    store.prepareChatRuntime(runtimeRequest(store, "unavailable"));
    const before = store.readPendingChatRuntimeRecoveryTarget();
    const { result, diagnostics } = await captureDiagnostics(() => settle(store, "unavailable"));
    assert.equal(result, null);
    assert.match(diagnostics, /deferred/u);
    assert.match(diagnostics, /owner=unavailable/u);
    assert.match(diagnostics, /the next start asks again/u);
    assert.deepEqual(store.readPendingChatRuntimeRecoveryTarget(), before);
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second start finds nothing to settle and says nothing", async () => {
  const { root, control, store } = freshRoot();
  try {
    store.prepareChatRuntime(runtimeRequest(store, "once"));
    assert.equal((await settle(store, "proven_dead"))?.status, "terminal");
    const { result, diagnostics } = await captureDiagnostics(() => settle(store, "proven_dead"));
    assert.equal(result, null);
    assert.equal(diagnostics, "");
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a root that owes no Chat runtime recovery says nothing and settles nothing", async () => {
  const { root, control, store } = freshRoot();
  try {
    const { result, diagnostics } = await captureDiagnostics(() => settle(store, "proven_dead"));
    assert.equal(result, null);
    assert.equal(diagnostics, "");
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The two tables' non-terminal statuses are the population, and the production settlement is the forward
 * path. Each member is driven into its own state on a real root and must come out `terminal` with the next
 * Chat operation admitted; the drivers are keyed by `table:status`, so a status the schema admits but
 * nothing here can produce fails loudly by name instead of being skipped.
 */
const obligationDrivers: Readonly<Record<string, (store: Store) => void>> = Object.freeze({
  "production_chat_runtime_intent:pending": (store) => {
    store.prepareChatRuntime(runtimeRequest(store, "gate-pending"));
  },
  "production_chat_runtime_intent:recovery_required": (store) => {
    const prepared = store.prepareChatRuntime(runtimeRequest(store, "gate-failed"));
    store.failChatRuntime({ principal, permit: prepared.permit!, reason: "effect_failed" });
  },
  "production_chat_runtime_teardown_intent:pending": (store) => {
    store.prepareChatRuntimeTeardown(teardownRequest(store, committedRuntime(store), "gate-pending"));
  },
  "production_chat_runtime_teardown_intent:recovery_required": (store) => {
    const prepared = store.prepareChatRuntimeTeardown(teardownRequest(store, committedRuntime(store), "gate-failed"));
    store.failChatRuntimeTeardown({ principal, permit: prepared.permit!, reason: "effect_failed" });
  },
});

test("every non-terminal Chat runtime intent status has a production forward path", async () => {
  const probe = freshRoot();
  const declared = intentStatuses(probe.root);
  probe.control.close();
  rmSync(probe.root, { recursive: true, force: true });

  const population = Object.entries(declared)
    .flatMap(([table, statuses]) =>
      statuses.filter((status) => status !== "terminal").map((status) => `${table}:${status}`),
    )
    .sort();
  const settled: string[] = [];
  const missing: string[] = [];
  for (const member of population) {
    const driver = obligationDrivers[member];
    if (driver === undefined) {
      missing.push(`${member} (no driver: the schema admits a state this gate cannot reach)`);
      continue;
    }
    const { root, control, store } = freshRoot();
    try {
      driver(store);
      const target = store.readPendingChatRuntimeRecoveryTarget();
      if (target === null || target.readback.status !== member.slice(member.indexOf(":") + 1)) {
        missing.push(`${member} (driving the state did not produce it)`);
        continue;
      }
      const result = await settle(store, "proven_dead");
      if (result?.status !== "terminal" || store.readPendingChatRuntimeRecoveryTarget() !== null) {
        missing.push(`${member} (the settlement did not terminalize it)`);
        continue;
      }
      // A settlement that only moved the row is not a forward path: the next Chat operation must run.
      store.selectChat({
        operationId: `select-successor-${member.replaceAll(":", "-")}`,
        chatThreadId: target.readback.chatThreadId,
        chatSurfaceSessionId: target.readback.chatSurfaceSessionId,
        expected: { ...store.readChatCatalog().vector },
      });
      store.prepareChatRuntime(runtimeRequest(store, `after-${member.replaceAll(":", "-")}`));
      settled.push(member);
    } catch (error) {
      missing.push(`${member} (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      control.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
  console.log(
    `chat runtime intent forward path: states ${population.length} · with a production forward path ${settled.length} · missing ${missing.length ? JSON.stringify(missing) : "none"} · population ${JSON.stringify(population)}`,
  );
  assert.ok(
    population.length > 0,
    "the gate examined no non-terminal Chat runtime intent state, so it agreed with itself",
  );
  assert.deepEqual(missing, []);
  assert.equal(settled.length, population.length);
});
