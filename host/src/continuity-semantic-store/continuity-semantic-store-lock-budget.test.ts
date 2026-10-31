import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import {
  openProductionContinuityStore,
  PRODUCTION_CONTINUITY_BUSY_TIMEOUT_MS,
  type ProductionBootstrapInput,
} from "./continuity-semantic-production-store.js";

const principal = { continuityId: "continuity1", companionId: "companion1", playerId: "player1" } as const;
const bootstrap: ProductionBootstrapInput = {
  principal,
  bootstrapOperationId: "bootstrap1",
  authorityGeneration: 1,
  authorityRootIdentity: "a".repeat(64),
};
const holderBindingDigest = "b".repeat(64);
const DATABASE = "gamebuddy-continuity-v1.sqlite";
const BEGINS_TRANSACTION = /^\s*BEGIN\b/iu;
/**
 * How much history the budget has to survive. Measured on this machine, one store write takes p50
 * 18 ms at 5 000 session rows, 55 ms at 20 000 and 108 ms at 40 000, because every command
 * transaction re-validates whole materialization; 40 000 is a size a Companion's Chat history
 * reaches, and it is the size at which a 250 ms budget stops being obviously safe.
 */
const HISTORY_ROWS = 40_000;
const TAKES_WRITE_LOCK = /^\s*BEGIN\s+IMMEDIATE\b/iu;

/**
 * The arguments each member needs to reach its transaction. A member that is handed nothing
 * refuses at its own argument validation and reports no statement at all, which would silently
 * shrink the population this gate classifies - so coverage of this table is asserted against the
 * members the store publishes, and a member added without arguments fails the gate instead of
 * being skipped.
 *
 * This table is the one hand-written thing here, and it deliberately carries ARGUMENTS only:
 * whether a member reads or writes, and which transaction mode it uses, is observed.
 */
function argumentsFor(member: string, fixture: Fixture): readonly unknown[] {
  const absent = { principal, operationId: "gate-absent" };
  const table: Readonly<Record<string, readonly unknown[]>> = {
    // bootstrapped control
    bootstrapFresh: [bootstrap],
    validateBootstrap: [bootstrap],
    bindBootstrapContext: [{ bootstrap, metadata: fixture.metadata }],
    configuration: [],
    close: [],
    // bound store
    claim: [{ holderBindingDigest, operationId: "gate-probe-claim", expected: fixture.vector }],
    register: [{ holderBindingDigest, operationId: "gate-probe-register", expected: fixture.vector }],
    verify: [
      { holderBindingDigest, operationId: "gate-probe-verify", expected: fixture.vector },
      {
        chatThreadId: fixture.chatThreadId,
        chatSurfaceSessionId: fixture.chatSurfaceSessionId,
        continuityId: principal.continuityId,
        companionId: principal.companionId,
        digest: "c".repeat(64),
      },
    ],
    select: [{ holderBindingDigest, operationId: "gate-probe-select", expected: fixture.vector }],
    readChatCatalog: [],
    registerChat: [
      {
        operationId: "gate-probe-register-chat",
        chatThreadId: "gate-thread-2",
        chatSurfaceSessionId: "gate-surface-2",
        expected: fixture.vector,
        lifecycle: "active",
        managementRevision: 1,
      },
    ],
    verifyChatContent: [
      {
        operationId: "gate-probe-verify-chat",
        chatThreadId: "gate-thread-2",
        chatSurfaceSessionId: "gate-surface-2",
        expected: fixture.vector,
        lifecycle: "active",
        managementRevision: 1,
      },
      {
        chatThreadId: "gate-thread-2",
        chatSurfaceSessionId: "gate-surface-2",
        continuityId: principal.continuityId,
        companionId: principal.companionId,
        digest: "c".repeat(64),
      },
    ],
    selectChat: [
      {
        operationId: "gate-probe-select-chat",
        chatThreadId: fixture.chatThreadId,
        chatSurfaceSessionId: fixture.chatSurfaceSessionId,
        expected: fixture.vector,
        lifecycle: "active",
        managementRevision: 1,
      },
    ],
    transitionChatLifecycle: [
      {
        operationId: "gate-probe-lifecycle",
        chatThreadId: fixture.chatThreadId,
        chatSurfaceSessionId: fixture.chatSurfaceSessionId,
        expectedManagementRevision: 1,
        expected: fixture.vector,
        operation: "archive",
      },
    ],
    recordChatSelectionIntent: [
      {
        intent: {
          kind: "select",
          chatThreadId: fixture.chatThreadId,
          chatSurfaceSessionId: fixture.chatSurfaceSessionId,
        },
        expected: fixture.vector,
      },
    ],
    clearChatSelectionIntent: [{ expected: fixture.vector }],
    prepareChatRuntime: [
      {
        principal,
        operationId: "gate-probe-runtime",
        requestId: "gate-probe-runtime-request",
        chatThreadId: fixture.chatThreadId,
        chatSurfaceSessionId: fixture.chatSurfaceSessionId,
        runtimeBindingDigest: "d".repeat(64),
        owner: {
          ownerToken: "owner-token",
          runtimeInstanceId: "runtime-1",
          ownerPid: process.pid,
          ownerProcessStartIdentity: "start-1",
        },
        deadlineAtMs: Date.now() + 60_000,
        expected: fixture.vector,
      },
    ],
    commitChatRuntime: [{}],
    prepareChatRuntimeTeardown: [{}],
    commitChatRuntimeTeardown: [{}],
    failChatRuntimeTeardown: [{}],
    recoverChatRuntimeTeardown: [{}],
    failChatRuntime: [{}],
    recoverChatRuntime: [{}],
    resume: [holderBindingDigest],
    quarantineAfterAbandonedMutex: [],
    readQuarantine: [],
    prepareGame: [{}],
    commitGameTerminal: [{}],
    failGame: [{}],
    recoverGame: [{}],
    readGameRecoveryTarget: [absent],
    readGameAdmission: [],
    readGameOperation: [absent],
    createGameSessionMetadata: [
      {
        creationRequestId: "gate-probe-session",
        integrationId: "stardew",
        continuityIdentityId: principal.continuityId,
      },
    ],
    completeGameSessionBinding: [
      { creationRequestId: "gate-probe-session", gameSessionId: "gate-session", expectedRevision: 1 },
    ],
    failGameSessionCreation: [
      { creationRequestId: "gate-probe-session", gameSessionId: "gate-session", expectedRevision: 1 },
    ],
    readGameSessionMetadata: [{ gameSessionId: fixture.gameSessionId }],
    listResumableGameSessions: [],
    registerGameSessionWorldBinding: [
      {
        gameSessionId: fixture.gameSessionId,
        integrationId: "stardew",
        bindingRef: "gate-binding",
        operationId: "gate-probe-binding",
        holderHandle: "gate-holder",
      },
    ],
    readGameSessionWorldBinding: [{ gameSessionId: fixture.gameSessionId, integrationId: "stardew" }],
    markGameSessionWorldBindingTerminal: [
      {
        gameSessionId: fixture.gameSessionId,
        integrationId: "stardew",
        operationId: "gate-probe-binding",
        expectedRevision: 1,
      },
    ],
    readGameSessionWorldBindingSlotHolder: [{ integrationId: "stardew", bindingRef: "gate-binding" }],
    releaseGameSessionWorldBindingSlot: [
      {
        integrationId: "stardew",
        bindingRef: "gate-binding",
        holderHandle: "gate-holder",
        operationId: "gate-probe-release",
        proof: {},
      },
    ],
  };
  const found = table[member];
  if (found === undefined)
    throw new Error(
      `the store publishes a member this gate has no arguments for: ${member} - name the arguments it needs so it is classified instead of skipped`,
    );
  return found;
}

interface Fixture {
  readonly metadata: ReturnType<ReturnType<typeof openProductionContinuityStore>["validateBootstrap"]>;
  readonly vector: Readonly<{ partitionRevision: number; fenceEpoch: number; selectionRevision: number }>;
  readonly chatThreadId: string;
  readonly chatSurfaceSessionId: string;
  readonly gameSessionId: string;
}

/**
 * Which authority a member must be driven against for its writing branch to be live.
 *
 * `bootstrapFresh` is the one member whose write is conditional on the store being unbootstrapped:
 * on a bootstrapped authority it returns a validated read, which would otherwise be classified as
 * a read taking the writer's lock when it is in fact a write-if-empty command. Driving it against
 * its own branch keeps the classification honest without an exception list.
 */
function authorityFor(member: string): "bootstrap" | "bound" {
  return member === "bootstrapFresh" ? "bootstrap" : "bound";
}

/**
 * Runs one member with writes forbidden for the duration of its own transaction.
 *
 * Every statement the member issues is recorded, and immediately after it opens a transaction the
 * connection is switched to `PRAGMA query_only=ON`. That makes the classification sound in the
 * one direction this gate needs: a member that COMPLETES this way provably issued no write, so it
 * is a pure read and has no business taking the writer's lock. A member that reaches a write fails
 * with `attempt to write a readonly database` and is provably a writer.
 *
 * Deciding from the statements alone would not do: a writer that refuses at its own precondition
 * before its first write leaves a trace indistinguishable from a read, and the members that do
 * that are most of this store's command surface.
 */
function driveReadOnly(body: () => void): {
  statements: readonly string[];
  completed: boolean;
  readonlyRefusal: boolean;
  error: unknown;
} {
  const statements: string[] = [];
  let injecting = false;
  const originalExec = DatabaseSync.prototype.exec;
  const originalPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.exec = function recordedExec(sql: string, ...rest: unknown[]) {
    statements.push(String(sql));
    const result = (originalExec as unknown as (...args: unknown[]) => unknown).call(this, sql, ...rest);
    if (!injecting && BEGINS_TRANSACTION.test(String(sql))) {
      injecting = true;
      try {
        (originalExec as unknown as (sql: string) => void).call(this, "PRAGMA query_only=ON");
      } finally {
        injecting = false;
      }
    }
    return result;
  };
  DatabaseSync.prototype.prepare = function recordedPrepare(sql: string, ...rest: unknown[]) {
    statements.push(String(sql));
    return (originalPrepare as unknown as (...args: unknown[]) => StatementSync).call(this, sql, ...rest);
  };
  let completed = false;
  let error: unknown;
  try {
    body();
    completed = true;
  } catch (caught) {
    error = caught;
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    DatabaseSync.prototype.prepare = originalPrepare;
  }
  return {
    statements,
    completed,
    readonlyRefusal: /readonly database/iu.test(String((error as Error | undefined)?.message ?? "")),
    error,
  };
}

function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
}

/**
 * A control whose authority is created but not yet bootstrapped, so the members whose write is
 * conditional on an empty store reach their writing branch instead of their early read-only return.
 */
function unbootstrappedRoot(): { root: string; control: ReturnType<typeof openProductionContinuityStore> } {
  const root = canonicalTestRootSync("store-lock-gate-empty-");
  return { root, control: openProductionContinuityStore({ runtimeRoot: root }) };
}

/**
 * A fresh, fully bootstrapped authority, holding a bound Chat and one Game session so the
 * members that need existing rows have them.
 */
function fixtureRoot(): {
  root: string;
  metadata: Fixture["metadata"];
  store: any;
  control: ReturnType<typeof openProductionContinuityStore>;
  shape: Fixture;
} {
  const root = canonicalTestRootSync("store-lock-gate-");
  const control = openProductionContinuityStore({ runtimeRoot: root });
  const metadata = control.bootstrapFresh(bootstrap);
  const store = control.bindBootstrapContext({ bootstrap, metadata });
  const claimed = store.claim({
    holderBindingDigest,
    operationId: "gate-claim",
    expected: { partitionRevision: 1, fenceEpoch: 1, selectionRevision: 0 },
  });
  const registered = store.register({
    holderBindingDigest,
    operationId: "gate-register",
    expected: { ...claimed.vector },
  });
  const verified = store.verify(
    { holderBindingDigest, operationId: "gate-verify", expected: { ...registered.vector } },
    {
      chatThreadId: registered.chatThreadId!,
      chatSurfaceSessionId: registered.chatSurfaceSessionId!,
      continuityId: principal.continuityId,
      companionId: principal.companionId,
      digest: "c".repeat(64),
    },
  );
  const selected = store.select({ holderBindingDigest, operationId: "gate-select", expected: { ...verified.vector } });
  const gameSession = store.createGameSessionMetadata({
    creationRequestId: "gate-session",
    integrationId: "stardew",
    continuityIdentityId: principal.continuityId,
  });
  store.registerGameSessionWorldBinding({
    gameSessionId: gameSession.gameSessionId,
    integrationId: "stardew",
    bindingRef: "gate-binding",
    operationId: "gate-binding",
    holderHandle: "gate-holder",
  });
  const shape: Fixture = {
    metadata,
    vector: { ...selected.vector },
    chatThreadId: selected.chatThreadId!,
    chatSurfaceSessionId: selected.chatSurfaceSessionId!,
    gameSessionId: gameSession.gameSessionId,
  };
  return { root, metadata, store, control, shape };
}

test("no member that issues no writing statement takes the writer's lock", () => {
  // Each member is classified against its own freshly bootstrapped authority: a shared fixture
  // would let an earlier member consume the state a later one needs, so the later one would
  // refuse at its own precondition and its transaction would never be observed at all.
  const published = (() => {
    const probe = fixtureRoot();
    try {
      return [...Object.keys(probe.store), ...Object.keys(probe.control)];
    } finally {
      probe.control.close();
      removeRoot(probe.root);
    }
  })();
  const misrouted: string[] = [];
  const pureReads: string[] = [];
  const writers: string[] = [];
  for (const member of published) {
    const empty = authorityFor(member) === "bootstrap" ? unbootstrappedRoot() : undefined;
    const subject = empty === undefined ? fixtureRoot() : undefined;
    try {
      const control = empty?.control ?? subject!.control;
      const store = subject?.store;
      const fromStore = store !== undefined && Object.hasOwn(store, member);
      const target = fromStore ? store : control;
      const call = target[member];
      if (typeof call !== "function") continue;
      const args = argumentsFor(member, subject?.shape ?? ({} as Fixture));
      const label = `${fromStore ? "store" : "control"}.${member}`;
      const driven = driveReadOnly(() => (call as (...a: unknown[]) => unknown).apply(target, [...args]));
      if (!driven.statements.some((statement) => BEGINS_TRANSACTION.test(statement))) continue;
      if (driven.readonlyRefusal) {
        writers.push(label);
        continue;
      }
      if (!driven.completed) continue;
      pureReads.push(label);
      if (driven.statements.some((statement) => TAKES_WRITE_LOCK.test(statement))) misrouted.push(label);
    } finally {
      (empty?.control ?? subject!.control).close();
      removeRoot(empty?.root ?? subject!.root);
    }
  }
  assert.ok(
    pureReads.length >= 10,
    `only ${String(pureReads.length)} members completed with writes forbidden (${pureReads.join(", ")}); the probe stopped observing the store's transactions`,
  );
  assert.ok(
    writers.length >= 3,
    `only ${String(writers.length)} members were proven to write (${writers.join(", ")}); the probe no longer separates reads from writes`,
  );
  assert.deepEqual(
    misrouted,
    [],
    `these members completed while issuing no write, so they are pure reads, yet they take the writer's lock - each must run through readTransaction: ${misrouted.join(", ")}`,
  );
});

/**
 * A pure read does not take the writer's lock, but this journal mode still excludes it from a
 * writer that holds EXCLUSIVE - and that wait is bounded by the WRITE budget, then fails.
 *
 * Two different locks, and only one of them was fixed by `4bb4cd0e`. A writer in RESERVED
 * (`BEGIN IMMEDIATE`) leaves readers free, and the sibling test above proves this store's reads use
 * that freedom. A writer in EXCLUSIVE excludes readers structurally: under `journal_mode=DELETE` a
 * read takes SHARED for its own duration, and SHARED is what EXCLUSIVE is exclusive against. That is
 * not a routing defect in the store, and no `readTransaction` change can remove it.
 *
 * MEASURED here on 2026-10-31 against another PROCESS holding `BEGIN EXCLUSIVE` plus one UPDATE on
 * this store's DELETE-mode file, with the store's 5 000ms budget in force on the reader:
 *
 *   store.readChatCatalog()            6 930ms  database is locked
 *   raw prepare().get(), no BEGIN      7 923ms  database is locked
 *   raw BEGIN then SELECT              7 274ms  database is locked
 *   PRAGMA query_only=ON/OFF               0ms  ok (a pragma touches no page)
 *   the same reads against RESERVED        3-5ms ok
 *
 * So the wait outlasts the 5 000ms budget and the read then fails rather than proceeding - which is
 * the shape a live run produced as a 10 s `/state` wait ending in a 409. The overshoot past the budget
 * is SQLite's busy handler, which sleeps between retries and re-checks the clock only at a retry
 * boundary. What the assertion below pins is the part that must stay true whatever the journal mode:
 * the wait is BOUNDED, so a reader can never hang the shell indefinitely, and the failure names
 * itself. A budget that silently stopped bounding this - a connection opened without it, a retry loop
 * added around it - would make a wedged writer hang every reader forever, so that is the failure this
 * test exists to catch.
 */
test("a pure read waits on a writer that holds EXCLUSIVE, and the store's budget bounds that wait", (t) => {
  const subject = fixtureRoot();
  const holderPath = join(subject.root, "exclusive-holder.mjs");
  writeFileSync(
    holderPath,
    [
      'import { DatabaseSync } from "node:sqlite";',
      "const [dbPath] = process.argv.slice(2);",
      "const db = new DatabaseSync(dbPath);",
      'db.exec("PRAGMA busy_timeout=10000");',
      'db.exec("BEGIN EXCLUSIVE");',
      'db.prepare("UPDATE production_partition SET partition_revision=partition_revision WHERE singleton=1").run();',
      'process.stdout.write("held");',
      // Held until this test kills it: the point is a writer that does NOT release inside the budget,
      // which is what a crash-in-progress or a committed transaction whose flush is stuck looks like.
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const holder = spawn(process.execPath, [holderPath, join(subject.root, DATABASE)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise<void>((resolve, reject) => {
    holder.stdout.once("data", () => {
      const budget = subject.control.configuration().busyTimeoutMs;
      const started = performance.now();
      let failure: unknown;
      let answered = false;
      try {
        subject.store.readChatCatalog();
        answered = true;
      } catch (caught) {
        failure = caught;
      }
      const elapsedMs = performance.now() - started;
      holder.kill();
      subject.control.close();
      removeRoot(subject.root);
      try {
        // The bound, not the outcome: a reader that answers or fails within a small multiple of the
        // budget is a reader a caller can act on. A reader still waiting after that is one that will
        // hang the shell, which is the defect this class is about.
        assert.ok(
          elapsedMs < budget * 2,
          `a pure read against a writer holding EXCLUSIVE was still waiting after ${elapsedMs.toFixed(0)}ms against a ${String(budget)}ms budget (answered=${String(answered)}): nothing is bounding it, so a wedged writer hangs every reader for as long as it lives`,
        );
        if (!answered) {
          const message = String((failure as Error | undefined)?.message ?? "");
          assert.match(
            message,
            /database is locked/u,
            `the read gave up after ${elapsedMs.toFixed(0)}ms but not with a lock failure (${message}): a read that fails for another reason cannot be told apart from a read that succeeded`,
          );
        }
        // Recorded rather than asserted, because WHICH of the two happens is the journal mode's
        // property, not this store's: under DELETE a writer in EXCLUSIVE always wins against a
        // reader. Reporting it keeps the reading attached to the run that produced it.
        t.diagnostic(
          `readChatCatalog against a held EXCLUSIVE lock: ${elapsedMs.toFixed(0)}ms, answered=${String(answered)}, budget=${String(budget)}ms`,
        );
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
});

test("every pure read answers while another connection holds the writer's lock", () => {
  const subject = fixtureRoot();
  try {
    const reads: ReadonlyArray<readonly [string, () => unknown]> = [
      ["readChatCatalog", () => subject.store.readChatCatalog()],
      ["resume", () => subject.store.resume(holderBindingDigest)],
      ["readQuarantine", () => subject.store.readQuarantine()],
      ["readGameAdmission", () => subject.store.readGameAdmission()],
      ["readGameOperation", () => subject.store.readGameOperation({ principal, operationId: "gate-absent" })],
      ["readGameRecoveryTarget", () => subject.store.readGameRecoveryTarget({ principal, operationId: "gate-absent" })],
      [
        "readGameSessionMetadata",
        () => subject.store.readGameSessionMetadata({ gameSessionId: subject.shape.gameSessionId }),
      ],
      ["listResumableGameSessions", () => subject.store.listResumableGameSessions()],
      [
        "readGameSessionWorldBinding",
        () =>
          subject.store.readGameSessionWorldBinding({
            gameSessionId: subject.shape.gameSessionId,
            integrationId: "stardew",
          }),
      ],
      [
        "readGameSessionWorldBindingSlotHolder",
        () =>
          subject.store.readGameSessionWorldBindingSlotHolder({ integrationId: "stardew", bindingRef: "gate-binding" }),
      ],
    ];
    const held = new DatabaseSync(join(subject.root, DATABASE));
    held.exec(`PRAGMA busy_timeout=${PRODUCTION_CONTINUITY_BUSY_TIMEOUT_MS}`);
    try {
      held.exec("BEGIN IMMEDIATE");
      held.prepare("UPDATE production_partition SET partition_revision=partition_revision WHERE singleton=1").run();
      const slow: string[] = [];
      for (const [name, read] of reads) {
        const started = performance.now();
        read();
        const elapsedMs = performance.now() - started;
        // A read still waits behind a writer that holds EXCLUSIVE, which is correct; what must
        // never happen is a read needing the write lock while the lock is merely RESERVED, and a
        // read that completes proves it never asked for it.
        if (elapsedMs >= 250) slow.push(`${name} (${elapsedMs.toFixed(1)}ms)`);
      }
      assert.deepEqual(
        slow,
        [],
        `these reads waited on the writer's lock instead of reading past it: ${slow.join(", ")}`,
      );
    } finally {
      held.exec("ROLLBACK");
      held.close();
    }
  } finally {
    subject.control.close();
    removeRoot(subject.root);
  }
});

/**
 * Seeds `rows` game-session rows with SQL and returns the time each of `samples` real commits took,
 * sorted. SQL seeding keeps the reading about the store's write path rather than about how long the
 * fixture takes to build through its own API.
 */
function measureCommits(subject: { root: string; store: any }, rows: number, samples: number): number[] {
  if (rows > 0) {
    const seeder = new DatabaseSync(join(subject.root, DATABASE));
    seeder.exec(`PRAGMA busy_timeout=${PRODUCTION_CONTINUITY_BUSY_TIMEOUT_MS}`);
    try {
      seeder.exec("BEGIN IMMEDIATE");
      const insert = seeder.prepare("INSERT OR IGNORE INTO production_game_session_metadata VALUES(?,?,?,?,?,?)");
      for (let index = 0; index < rows; index += 1) {
        insert.run(`history-${index}`, `history-create-${index}`, "stardew", principal.continuityId, "failed", 2);
      }
      seeder.exec("COMMIT");
    } finally {
      seeder.close();
    }
  }
  const times: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    subject.store.createGameSessionMetadata({
      creationRequestId: `budget-${rows}-${index}`,
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    times.push(performance.now() - started);
  }
  return times.sort((left, right) => left - right);
}

/** The quantile of a sorted sample set, nearest-rank so it is always a time that was actually measured. */
function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
}

/**
 * The row counts the sweep walks: a freshly bootstrapped store, then histories far past what the
 * product carries today (a live run's semantic store is 288 KB). Each size gets its own authority
 * because the commit cost is what grows with the history, and seeding one file at every size would
 * measure the sum rather than the curve.
 */
const SWEEP_ROWS = [0, 20_000, 40_000, 60_000, 80_000] as const;
/**
 * Samples per size. Eleven makes p95 the second-largest reading rather than the largest, so the tail
 * is not one outlier's arithmetic, and keeps the whole sweep inside a test-file budget.
 */
const SWEEP_SAMPLES = 11;

/**
 * What one real commit costs as the store's history grows, with the crossing into the busy budget
 * named rather than assumed.
 *
 * Measured on this machine on 2026-10-31, seeding rows with SQL so each reading is the store's own
 * write path rather than how long the fixture takes to build through its API, at 9-15 samples per
 * size:
 *
 *   rows        0: p50    4.2ms  max     6.4ms
 *   rows   20 000: p50   55.8ms  max    70.4ms
 *   rows   40 000: p50  152.7ms  max   315.7ms
 *   rows   80 000: p50  302.9ms  max   428.9ms
 *   rows  160 000: p50  960.1ms  max 1 222.4ms
 *   rows  320 000: p50 1 403.6ms max 1 618.1ms
 *   rows  640 000: p50 3 055.2ms max 3 837.3ms
 *   rows  960 000: p50 5 363.2ms max 8 377.2ms
 *
 * The crossing into `PRODUCTION_CONTINUITY_BUSY_TIMEOUT_MS` (5 000ms) is between 640 000 and 960 000
 * rows: at 960 000 the MEDIAN commit alone outlasts the budget, so a legitimate commit is a race
 * against its own budget by construction. At roughly 150 MB - some hundreds of times today's 288 KB
 * store - that is not a reachable size for the product's current shape, which is what makes the
 * existing 5 s budget a measurement rather than a guess. What the curve does say is that the growth
 * is linear in re-validated rows, so a column added to `production_game_session_metadata` is a shift
 * in the slope, and that is the drift the gate beside this test watches.
 *
 * The sweep itself stops at 80 000: walking to the crossing spends minutes seeding rows to confirm
 * arithmetic the per-row cost already carries. The larger sizes were measured out of band and are
 * recorded above; the per-row cost this test DERIVES from its own readings is what turns them into a
 * prediction instead of a second hand-written copy of the same fact. Those derived crossings land
 * between 1.3 and 1.6 million rows depending on what else the machine is doing, which is the honest
 * width of this measurement: re-validation cost is linear, the constant around it is not.
 */
test("the commit curve grows with the store's history and names where it would cross the budget", (t) => {
  const measured: { rows: number; bytes: number; p50: number; p95: number; max: number }[] = [];
  for (const rows of SWEEP_ROWS) {
    const subject = fixtureRoot();
    try {
      const times = measureCommits(subject, rows, SWEEP_SAMPLES);
      const bytes = statSync(join(subject.root, DATABASE)).size;
      measured.push({ rows, bytes, p50: quantile(times, 0.5), p95: quantile(times, 0.95), max: quantile(times, 1) });
    } finally {
      subject.control.close();
      removeRoot(subject.root);
    }
  }
  for (const reading of measured) {
    t.diagnostic(
      `rows ${String(reading.rows).padStart(7)}  p50 ${reading.p50.toFixed(1).padStart(8)}ms  p95 ${reading.p95.toFixed(1).padStart(8)}ms  max ${reading.max.toFixed(1).padStart(8)}ms  file ${(reading.bytes / 1024).toFixed(0).padStart(8)} KB`,
    );
  }
  const fresh = measured[0]!;
  const largest = measured[measured.length - 1]!;
  // The sweep has to prove its own readings are worth something: a commit grows with the history it
  // re-validates. Flat numbers would mean it was timing fixture setup rather than the write path,
  // and every conclusion drawn from the curve would be wrong.
  assert.ok(
    largest.max > fresh.max * 3,
    `a commit at ${String(largest.rows)} rows (max ${largest.max.toFixed(1)}ms) is not materially slower than one on a fresh authority (max ${fresh.max.toFixed(1)}ms): this sweep is no longer measuring what grows with history, so its readings cannot say anything about the budget`,
  );
  // The per-row cost the curve carries, so the crossing is derived from this run's readings rather
  // than restated as a constant that drifts when a column is added.
  const perRowMs = (largest.p50 - fresh.p50) / largest.rows;
  assert.ok(
    perRowMs > 0,
    `the sweep measured a non-positive per-row cost (${String(perRowMs)}ms) between ${String(fresh.rows)} and ${String(largest.rows)} rows: a commit that gets cheaper as history grows means the readings are noise`,
  );
  t.diagnostic(
    `one row of history costs ${(perRowMs * 1000).toFixed(2)}us of commit re-validation, so the ${String(PRODUCTION_CONTINUITY_BUSY_TIMEOUT_MS)}ms budget is crossed at about ${(Math.round(PRODUCTION_CONTINUITY_BUSY_TIMEOUT_MS / perRowMs / 10_000) * 10_000).toLocaleString("en-US")} rows`,
  );
});

test("the busy budget clears the longest commit this store makes at a history it will reach", () => {
  const subject = fixtureRoot();
  try {
    // A fresh authority commits in single-digit milliseconds and would pass any budget at all,
    // which is exactly why the defect survived: the budget has to clear the store's commit at the
    // size the store actually grows to. Rows are seeded with SQL so this measures the write path
    // rather than how long it takes to build the fixture through the API.
    const databasePath = join(subject.root, DATABASE);
    const seeder = new DatabaseSync(databasePath);
    seeder.exec(`PRAGMA busy_timeout=${PRODUCTION_CONTINUITY_BUSY_TIMEOUT_MS}`);
    try {
      seeder.exec("BEGIN IMMEDIATE");
      const insert = seeder.prepare("INSERT OR IGNORE INTO production_game_session_metadata VALUES(?,?,?,?,?,?)");
      for (let index = 0; index < HISTORY_ROWS; index += 1) {
        insert.run(`history-${index}`, `history-create-${index}`, "stardew", principal.continuityId, "failed", 2);
      }
      seeder.exec("COMMIT");
    } finally {
      seeder.close();
    }

    const commits: number[] = [];
    for (let index = 0; index < 9; index += 1) {
      const started = performance.now();
      subject.store.createGameSessionMetadata({
        creationRequestId: `budget-${index}`,
        integrationId: "stardew",
        continuityIdentityId: principal.continuityId,
      });
      commits.push(performance.now() - started);
    }
    const longestMs = Math.max(...commits);
    // Both sides of the comparison come from the store: the budget from its live connection and
    // the commit from its real write path. A literal on either side would be a second copy of a
    // fact the store already owns, and the copies would drift exactly when a commit grows.
    const budget = subject.control.configuration().busyTimeoutMs;
    assert.equal(
      budget,
      PRODUCTION_CONTINUITY_BUSY_TIMEOUT_MS,
      "the live connection's budget and the store's published budget are two readings of one fact",
    );
    assert.ok(
      budget > longestMs * 10,
      `the store allows ${String(budget)}ms but its longest commit over ${String(HISTORY_ROWS)} rows took ${longestMs.toFixed(1)}ms; a budget shorter than a legitimate commit is a race by construction, not a tuning choice`,
    );
  } finally {
    subject.control.close();
    removeRoot(subject.root);
  }
});
/**
 * The configured budget is worth nothing if it is set after the statements that need it.
 *
 * `PRAGMA journal_mode=DELETE` takes the write lock itself, and the open path used to run the
 * pragmas last - so against a held writer the open failed at 22.3 ms while a 5 s budget was
 * configured. This drives the real open path against a writer held by a SEPARATE PROCESS: a timer
 * in this thread cannot release anything, because the thread is blocked inside SQLite.
 */
test("the configured budget is in force before every statement of the open path", () => {
  const subject = fixtureRoot();
  const holderPath = join(subject.root, "lock-holder.mjs");
  writeFileSync(
    holderPath,
    [
      'import { DatabaseSync } from "node:sqlite";',
      "const [dbPath, holdMs] = process.argv.slice(2);",
      "const db = new DatabaseSync(dbPath);",
      'db.exec("PRAGMA busy_timeout=10000");',
      'db.exec("BEGIN EXCLUSIVE");',
      'db.prepare("UPDATE production_partition SET partition_revision=partition_revision WHERE singleton=1").run();',
      'process.stdout.write("held");',
      'setTimeout(() => { try { db.exec("ROLLBACK"); } catch {} db.close(); process.exit(0); }, Number(holdMs));',
    ].join("\n"),
  );
  const holdMs = 1200;
  const holder = spawn(process.execPath, [holderPath, join(subject.root, DATABASE), String(holdMs)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise<void>((resolve, reject) => {
    holder.stdout.once("data", () => {
      const started = performance.now();
      let opened = false;
      let error: unknown;
      try {
        const control = openProductionContinuityStore({ runtimeRoot: subject.root });
        opened = true;
        control.close();
      } catch (caught) {
        error = caught;
      }
      const elapsedMs = performance.now() - started;
      void setTimeout(() => {
        holder.kill();
        subject.control.close();
        removeRoot(subject.root);
        try {
          assert.ok(
            opened,
            `opening the authority against a writer held by another process failed after ${elapsedMs.toFixed(1)}ms (${String((error as Error | undefined)?.message ?? "")}) although the store configures a ${String(PRODUCTION_CONTINUITY_BUSY_TIMEOUT_MS)}ms budget: the budget is being set after the statements that need it`,
          );
          resolve();
        } catch (failure) {
          reject(failure);
        }
      }, holdMs + 400);
    });
  });
});
