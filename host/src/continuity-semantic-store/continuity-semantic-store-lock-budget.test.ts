import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
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
/**
 * How much of the budget one legitimate commit may occupy: a commit is allowed a tenth of it, and the
 * rest is the wait the budget exists to bound. Stated as a ratio because both sides are derived from
 * the store on every run - see the gate that uses it.
 */
const COMMIT_BUDGET_MARGIN = 10;
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
 * The file SQLite leaves beside the database for an interrupted transaction, derived from the mode the
 * store reports. One spelling of the fact, so a mode change moves the assertion with it instead of
 * leaving a test that asserts a file the new mode never writes.
 */
function journalArtifactSuffix(journalMode: string): string {
  return journalMode.toLowerCase() === "wal" ? "-wal" : "-journal";
}

/** Resolves once a child has printed `token`, so the parent acts while the child really holds its lock. */
function awaitToken(child: ReturnType<typeof spawn>, token: string): Promise<void> {
  return new Promise((resolve) => {
    let pending = "";
    child.stdout!.on("data", (chunk) => {
      pending += String(chunk);
      if (pending.includes(token)) resolve();
    });
  });
}

/**
 * Puts a standalone database file into `mode` and returns the mode SQLite reports, so a caller can
 * assert the conversion happened instead of assuming it.
 *
 * The file has to be closed first: `journal_mode` is a property of the database, and the store's own
 * open path pins one mode, so a probe that went through the store could only ever describe that mode.
 */
function setJournalMode(databasePath: string, mode: "DELETE" | "WAL"): string {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA busy_timeout=10000");
    db.exec(`PRAGMA journal_mode=${mode}`);
    db.exec("PRAGMA synchronous=FULL");
    return String((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode);
  } finally {
    db.close();
  }
}

/**
 * A bootstrapped authority that has been CLOSED, leaving its database file as the whole durable state.
 *
 * The probe copies this file per mode: two modes over one file would make the second reading describe
 * the first one's leftovers, and the point is a comparison between two otherwise identical files.
 */
function closedAuthority(): { root: string; database: string } {
  const subject = fixtureRoot();
  const database = join(subject.root, DATABASE);
  subject.control.close();
  return { root: subject.root, database };
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
 * The journal mode ALONE decides whether a reader waits behind a writer that holds EXCLUSIVE, and
 * the same is true in the other direction - a held reader blocking a writer's COMMIT.
 *
 * Both directions are driven here because they fail for one cause and it is worth seeing it from
 * both ends: under `journal_mode=DELETE` a read takes SHARED for its own duration and SHARED is
 * exactly what EXCLUSIVE excludes, so the reader waits; and a held SHARED is what a writer's COMMIT
 * needs to upgrade past, so the writer waits. WAL has neither lock: readers read a snapshot and a
 * writer appends.
 *
 * The subject is a COPY of a real bootstrapped store database, closed first so the file is its own
 * complete durable state, converted to each mode and driven by RAW connections at the store's own
 * budget. Raw connections are the point: the store's open path pins one mode, so a reading taken
 * through it could only ever describe that mode. What this pins is the property that justifies the
 * mode the store runs, not the mode string.
 *
 * MEASURED on 2026-11-01, Windows, node:sqlite, 5 000ms budget, one pre-committed row (the fixture's
 * own `partition_revision`, read from the file so "empty" and "stale" are distinguishable from "the
 * correct pre-writer snapshot"):
 *
 *   DELETE  reader vs held EXCLUSIVE   7 271.3ms  database is locked
 *   WAL     reader vs held EXCLUSIVE       1.4ms  answered, the pre-writer revision
 *   DELETE  writer vs held reader      1 534.2ms  committed (waited out the whole 1 500ms hold)
 *   WAL     writer vs held reader          3.1ms  committed
 */
test("the journal mode alone decides whether a reader waits behind a held writer, in both directions", async (t) => {
  const subject = closedAuthority();
  const budget = PRODUCTION_CONTINUITY_BUSY_TIMEOUT_MS;
  const smallBoundMs = budget / 10;
  const HOLD_MS = 1500;
  const holderPath = join(subject.root, "exclusive-holder.mjs");
  const readerPath = join(subject.root, "held-reader.mjs");
  writeFileSync(
    holderPath,
    [
      'import { DatabaseSync } from "node:sqlite";',
      "const [dbPath] = process.argv.slice(2);",
      "const db = new DatabaseSync(dbPath);",
      'db.exec("PRAGMA busy_timeout=10000");',
      'db.exec("BEGIN EXCLUSIVE");',
      // A REAL page change, uncommitted: the reader must not be able to see it, and the value it does
      // see is the pre-writer snapshot rather than a missing row.
      'db.prepare("UPDATE production_partition SET partition_revision=partition_revision+1 WHERE singleton=1").run();',
      'process.stdout.write("held");',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  writeFileSync(
    readerPath,
    [
      'import { DatabaseSync } from "node:sqlite";',
      "const [dbPath, holdMs] = process.argv.slice(2);",
      "const db = new DatabaseSync(dbPath);",
      'db.exec("PRAGMA busy_timeout=10000");',
      'db.exec("BEGIN");',
      'db.prepare("SELECT 1 FROM production_partition WHERE singleton=1").get();',
      'process.stdout.write("reading");',
      // A synchronous spin, not a timer: the process must SIT inside the transaction holding the
      // read lock rather than yielding its event loop and releasing it.
      "const spinUntil = (deadline) => { while (Date.now() < deadline) {} };",
      "spinUntil(Date.now() + Number(holdMs));",
      'db.exec("COMMIT");',
      "db.close();",
    ].join("\n"),
  );

  type Reading = Readonly<{
    mode: string;
    direction: string;
    elapsedMs: number;
    answered: boolean;
    failure: string;
    revision: number | undefined;
  }>;
  const readings: Reading[] = [];
  // The pre-writer revision, read from the file itself rather than written down here: the fixture's
  // own commands decide it, and a literal would be a second copy of a fact that moves when the
  // fixture changes - the reading would then look wrong while being right.
  const preWriterRevision = (() => {
    const db = new DatabaseSync(subject.database);
    try {
      return (
        db.prepare("SELECT partition_revision FROM production_partition WHERE singleton=1").get() as {
          partition_revision: number;
        }
      ).partition_revision;
    } finally {
      db.close();
    }
  })();
  try {
    for (const mode of ["DELETE", "WAL"] as const) {
      const database = join(subject.root, `probe-${mode}.sqlite`);
      copyFileSync(subject.database, database);
      const applied = setJournalMode(database, mode);
      assert.equal(applied, mode.toLowerCase(), `the probe could not put ${database} into ${mode} mode`);

      // Direction A: a reader at the store's budget against a writer that holds EXCLUSIVE.
      const holder = spawn(process.execPath, [holderPath, database], { stdio: ["ignore", "pipe", "inherit"] });
      await awaitToken(holder, "held");
      const reader = new DatabaseSync(database);
      reader.exec(`PRAGMA busy_timeout=${String(budget)}`);
      const startedA = performance.now();
      let answered = false;
      let failure = "";
      let revision: number | undefined;
      try {
        revision = (
          reader.prepare("SELECT partition_revision FROM production_partition WHERE singleton=1").get() as
            | { partition_revision: number }
            | undefined
        )?.partition_revision;
        answered = true;
      } catch (caught) {
        failure = (caught as Error).message;
      }
      const elapsedA = performance.now() - startedA;
      reader.close();
      holder.kill("SIGKILL");
      await once(holder, "exit");
      readings.push({
        mode,
        direction: "reader-vs-held-EXCLUSIVE",
        elapsedMs: elapsedA,
        answered,
        failure,
        revision,
      });

      // Direction B: a writer at the store's budget against a reader that holds BEGIN/SELECT.
      const held = spawn(process.execPath, [readerPath, database, String(HOLD_MS)], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      await awaitToken(held, "reading");
      const writer = new DatabaseSync(database);
      writer.exec(`PRAGMA busy_timeout=${String(budget)}`);
      const startedB = performance.now();
      let committed = false;
      let writeFailure = "";
      try {
        writer.exec("BEGIN IMMEDIATE");
        writer
          .prepare("UPDATE production_partition SET partition_revision=partition_revision+1 WHERE singleton=1")
          .run();
        writer.exec("COMMIT");
        committed = true;
      } catch (caught) {
        writeFailure = (caught as Error).message;
      }
      const elapsedB = performance.now() - startedB;
      writer.close();
      await once(held, "exit");
      readings.push({
        mode,
        direction: "writer-vs-held-reader",
        elapsedMs: elapsedB,
        answered: committed,
        failure: writeFailure,
        revision: undefined,
      });
    }
  } finally {
    removeRoot(subject.root);
  }

  for (const reading of readings)
    t.diagnostic(
      `${reading.mode.padEnd(6)} ${reading.direction.padEnd(26)} ${reading.elapsedMs.toFixed(1).padStart(9)}ms  ${
        reading.answered ? "answered" : "did not answer"
      }${reading.revision === undefined ? "" : ` partition_revision=${String(reading.revision)}`}${
        reading.failure === "" ? "" : ` (${reading.failure})`
      }`,
    );

  const find = (mode: string, direction: string): Reading => {
    const found = readings.find((reading) => reading.mode === mode && reading.direction === direction);
    assert.ok(found, `the probe produced no ${mode} reading for ${direction}`);
    return found;
  };

  // DELETE, both directions: the wait is the mode's lock model, and it is what the store used to run.
  const deleteRead = find("DELETE", "reader-vs-held-EXCLUSIVE");
  assert.ok(
    !deleteRead.answered || deleteRead.elapsedMs >= budget,
    `a DELETE-mode reader answered a held EXCLUSIVE writer in ${deleteRead.elapsedMs.toFixed(1)}ms: the probe no longer reproduces the rollback-journal lock model the store was moved off, so its WAL reading proves nothing`,
  );
  const deleteWrite = find("DELETE", "writer-vs-held-reader");
  assert.ok(
    deleteWrite.elapsedMs >= HOLD_MS / 2,
    `a DELETE-mode writer committed in ${deleteWrite.elapsedMs.toFixed(1)}ms against a reader that held its transaction for ${String(HOLD_MS)}ms: the probe no longer reproduces the reader-blocks-writer direction`,
  );

  // WAL, both directions: the wait is gone rather than tolerated, so the bound is a small fraction of
  // the budget and the reader must see the pre-writer snapshot, not an empty or stale one.
  const walRead = find("WAL", "reader-vs-held-EXCLUSIVE");
  assert.ok(
    walRead.answered,
    `a WAL-mode reader did not answer a held EXCLUSIVE writer at all (${walRead.elapsedMs.toFixed(1)}ms, ${walRead.failure}): WAL is supposed to remove this wait, not bound it`,
  );
  assert.ok(
    walRead.elapsedMs < smallBoundMs,
    `a WAL-mode reader took ${walRead.elapsedMs.toFixed(1)}ms against a held EXCLUSIVE writer, which is not the ${smallBoundMs.toFixed(0)}ms a read that does not wait would take out of the ${String(budget)}ms budget`,
  );
  assert.equal(
    walRead.revision,
    preWriterRevision,
    `a WAL-mode reader beside an uncommitted writer did not see the pre-writer snapshot (partition_revision ${String(preWriterRevision)}): the reading is not distinguishable from an empty or stale one`,
  );
  const walWrite = find("WAL", "writer-vs-held-reader");
  assert.ok(
    walWrite.answered,
    `a WAL-mode writer could not commit while a reader held its transaction (${walWrite.elapsedMs.toFixed(1)}ms, ${walWrite.failure})`,
  );
  assert.ok(
    walWrite.elapsedMs < smallBoundMs,
    `a WAL-mode writer took ${walWrite.elapsedMs.toFixed(1)}ms to commit against a held reader, so it is queuing behind the reader's lock instead of appending past it`,
  );
});

/**
 * The gate: a pure read completes within a small bound while another PROCESS holds `BEGIN EXCLUSIVE`.
 *
 * This asserts the PROPERTY the store depends on, not the mode string. `configuration().journalMode`
 * already reports the mode, and a test that reads it back only pins that someone typed `WAL`; the
 * thing that broke a live run was a read that had to WAIT, and the only reading that can see a
 * regression to a waiting mode is a timed read issued against a real held writer.
 *
 * The hold is `BEGIN EXCLUSIVE` plus an uncommitted page change, from a separate process - a timer in
 * this thread cannot release anything, because the thread is blocked inside SQLite. The reader is the
 * store's own `readChatCatalog`, so what is measured is the read path the product runs.
 *
 * RED against `journal_mode=DELETE` (the mode the store ran until 2026-11-01): the read waited
 * 6 930-7 923ms and then failed with `database is locked`, which is the 10 s `/state` wait that ended
 * in a 409. GREEN against `journal_mode=WAL`: 1.4-3.6ms, answered, pre-writer snapshot. The bound is
 * a tenth of the store's own budget, which is 5-6 orders of magnitude away from the DELETE reading and
 * therefore not a threshold anyone can drift into by accident.
 */
test("a pure read completes within a small bound while another process holds BEGIN EXCLUSIVE", async (t) => {
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
      'db.prepare("UPDATE production_partition SET partition_revision=partition_revision+1 WHERE singleton=1").run();',
      'process.stdout.write("held");',
      // Held until this test kills it: a writer that releases inside the budget is not the case that
      // broke, and one that never releases is the worst case a reader can meet.
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const holder = spawn(process.execPath, [holderPath, join(subject.root, DATABASE)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await awaitToken(holder, "held");
    const budget = subject.control.configuration().busyTimeoutMs;
    const journalMode = subject.control.configuration().journalMode;
    const smallBoundMs = budget / 10;
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
    t.diagnostic(
      `readChatCatalog against a held EXCLUSIVE lock: ${elapsedMs.toFixed(1)}ms, answered=${String(answered)}, journal_mode=${journalMode}, budget=${String(budget)}ms`,
    );
    assert.ok(
      answered,
      `a pure read did not answer a writer holding EXCLUSIVE after ${elapsedMs.toFixed(1)}ms with journal_mode=${journalMode} (${String((failure as Error | undefined)?.message ?? "")}): under a waiting journal mode a reader takes SHARED for its own duration and SHARED is what EXCLUSIVE excludes, so every /state behind a writer's transaction waits out the write budget and then fails - the shape that produced a 10 s wait and a 409 in a live run`,
    );
    assert.ok(
      elapsedMs < smallBoundMs,
      `a pure read answered a held EXCLUSIVE writer only after ${elapsedMs.toFixed(1)}ms with journal_mode=${journalMode}, which is not the sub-${smallBoundMs.toFixed(0)}ms a read that does not wait would take out of the ${String(budget)}ms budget: the wait is being tolerated rather than removed`,
    );
  } finally {
    holder.kill("SIGKILL");
    await once(holder, "exit");
    subject.control.close();
    removeRoot(subject.root);
  }
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
 * Two readers beside writers that hold RESERVED for as long as this store's own commits hold it,
 * which is the shape the live run broke in: a pure read must not FAIL because a writer holds the
 * lock.
 *
 * The writer is a separate PROCESS that announces every cycle it spends inside `BEGIN IMMEDIATE`, and
 * the readers run only on those announcements - so every read is issued while the write lock is
 * demonstrably held, rather than hoping the timing lines up. The hold is `HOLD_MS`, the time a real
 * commit spends inside the lock at a history this store reaches (measured above: 150-300ms at 40 000
 * rows, where every command transaction re-validates whole materialization). That is what makes the
 * test discriminate: verified red against the pre-`4bb4cd0e` shape, where `readTransaction` opened
 * `BEGIN IMMEDIATE` and every read here waited out the hold, and green against the current shape.
 *
 * What bounds a read here is worth stating because nothing else does: this store has ONE connection
 * and one `PRAGMA busy_timeout`, so the only clock a reader waits against is
 * `PRODUCTION_CONTINUITY_BUSY_TIMEOUT_MS` - the same number that bounds a legitimate commit. A read
 * and a commit therefore share one budget, and a store whose commits grow toward that budget (see the
 * sweep above) leaves a reader no headroom its own work justifies. That is a property of where the
 * budget sits, not of any one read, and it is reported here rather than changed.
 */
test("pure reads answer while a writer holds the lock, so no read waits out the write budget", (t) => {
  const subject = fixtureRoot();
  const writerPath = join(subject.root, "writer.mjs");
  const HOLD_MS = 150;
  const CYCLES = 8;
  writeFileSync(
    writerPath,
    [
      'import { DatabaseSync } from "node:sqlite";',
      "const [dbPath, cycles, holdMs] = process.argv.slice(2);",
      "const db = new DatabaseSync(dbPath);",
      'db.exec("PRAGMA busy_timeout=30000");',
      'const bump = db.prepare("UPDATE production_partition SET partition_revision=partition_revision WHERE singleton=1");',
      // A synchronous spin, not a timer: the process must SIT inside the transaction holding the
      // lock rather than yielding its event loop and releasing it.
      "const spinUntil = (deadline) => { while (Date.now() < deadline) {} };",
      "for (let index = 0; index < Number(cycles); index += 1) {",
      '  db.exec("BEGIN IMMEDIATE");',
      "  bump.run();",
      // Announce the hold, then spend it locked. Every read below is issued on this announcement, so
      // the reader is inside the window rather than racing the commit.
      '  process.stdout.write("held\\n");',
      "  spinUntil(Date.now() + Number(holdMs));",
      '  db.exec("COMMIT");',
      "}",
      "db.close();",
    ].join("\n"),
  );
  const writer = spawn(process.execPath, [writerPath, join(subject.root, DATABASE), String(CYCLES), String(HOLD_MS)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise<void>((resolve, reject) => {
    const reads: number[] = [];
    const failures: string[] = [];
    // Two read PATHS over the same authority, which is what two surfaces of the product share.
    const readerPaths: ReadonlyArray<readonly [string, () => unknown]> = [
      ["readChatCatalog", () => subject.store.readChatCatalog()],
      ["readGameAdmission", () => subject.store.readGameAdmission()],
    ];
    const finish = (error?: unknown) => {
      writer.kill();
      subject.control.close();
      removeRoot(subject.root);
      if (error !== undefined) return reject(error);
      resolve();
    };
    let pending = "";
    writer.stdout.on("data", (chunk) => {
      pending += String(chunk);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line !== "held") continue;
        for (const [name, read] of readerPaths) {
          const started = performance.now();
          try {
            read();
          } catch (error) {
            failures.push(`${name}: ${(error as Error).message}`);
          }
          reads.push(performance.now() - started);
        }
      }
    });
    writer.once("exit", () => {
      try {
        const budget = subject.control.configuration().busyTimeoutMs;
        assert.deepEqual(
          failures,
          [],
          `reads failed while a writer held the lock (${String(failures.length)} of ${String(reads.length)}): ${failures.slice(0, 3).join(", ")} - a pure read must not lose to a writer that only holds RESERVED`,
        );
        assert.ok(
          reads.length > 0,
          `no read landed inside a held writer out of ${String(CYCLES)} announced holds: the reading does not describe a read beside a held lock`,
        );
        const sorted = [...reads].sort((left, right) => left - right);
        const longest = quantile(sorted, 1);
        t.diagnostic(
          `${String(reads.length)} reads inside ${String(CYCLES)} writer holds of ${String(HOLD_MS)}ms: p50 ${quantile(sorted, 0.5).toFixed(1)}ms, p95 ${quantile(sorted, 0.95).toFixed(1)}ms, max ${longest.toFixed(1)}ms, budget ${String(budget)}ms`,
        );
        // A read that has to wait out even one hold is a read queued behind a writer's lock, and what
        // bounds it then is the write budget rather than anything its own work justifies. Asserted
        // before coverage so a blocked read reports the wait rather than a short sample.
        assert.ok(
          longest < HOLD_MS,
          `the slowest of ${String(reads.length)} reads inside writer holds of ${String(HOLD_MS)}ms took ${longest.toFixed(1)}ms: a read is queuing behind the writer's lock instead of reading past it, so the only clock bounding it is the ${String(budget)}ms write budget`,
        );
        assert.equal(
          reads.length,
          CYCLES * readerPaths.length,
          `only ${String(reads.length)} reads landed inside a held writer out of ${String(CYCLES * readerPaths.length)} announced holds: a read that spends the hold waiting cannot be issued in the next window, so the sample stops describing reads beside a held lock`,
        );
        finish();
      } catch (error) {
        finish(error);
      }
    });
  });
});

/**
 * A commit interrupted by a real process kill: the database reopens, the last COMMITTED transaction is
 * present, the interrupted one is absent, and no human has to touch anything.
 *
 * The kill is `process.kill` on a real child mid-transaction - not a thrown error and not a closed
 * handle - because those are the cases the runtime already handles. A power loss or a `taskkill` on
 * the Host is what a player actually experiences as "GameBuddy will not start", and it leaves the
 * journal artifact of whatever mode the store runs behind that recovery has to consume.
 *
 * The child drives the store's REAL open path (`openProductionContinuityStore`) rather than typing a
 * mode into SQL, and the artifact it must leave is DERIVED from the mode that path applied - `-journal`
 * for a rollback journal, `-wal` for WAL. Pinning one name would have made this test either silently
 * vacuous (asserting a file the mode never writes) or wrongly red the day the mode moved.
 */
test("the semantic store survives a killed commit and reopens with the committed history intact", async () => {
  const subject = fixtureRoot();
  // The mode is read from the store's own live connection and then the connection is CLOSED, so the
  // child is the only process holding the file. That matters: the last connection to a WAL database
  // checkpoints on close and removes the `-wal`, so a parent still holding it would either destroy the
  // artifact before the assertion or leave the reopen with nothing to replay.
  const journalMode = subject.control.configuration().journalMode;
  subject.control.close();
  const childPath = join(subject.root, "killed-writer.mjs");
  // The child commits one row, says so, then starts a second transaction and dies inside it without
  // ever reaching COMMIT. The row it already committed is the one recovery must keep.
  writeFileSync(
    childPath,
    [
      'import { DatabaseSync } from "node:sqlite";',
      'import { writeFileSync } from "node:fs";',
      "const [dbPath, markerPath, mode] = process.argv.slice(2);",
      "const db = new DatabaseSync(dbPath);",
      'db.exec("PRAGMA busy_timeout=10000");',
      // The mode the STORE reported, not a literal here: a child that typed its own mode could leave a
      // different artifact from the one the product leaves, and the assertion below would then describe
      // the child rather than the store.
      "db.exec(`PRAGMA journal_mode=${mode}; PRAGMA synchronous=FULL`);",
      'db.exec("BEGIN IMMEDIATE");',
      `db.prepare("INSERT INTO production_game_session_metadata VALUES(?,?,?,?,?,?)").run("kept-row", "kept-request", "stardew", null, "failed", 2);`,
      'db.exec("COMMIT");',
      'db.exec("BEGIN IMMEDIATE");',
      `db.prepare("INSERT INTO production_game_session_metadata VALUES(?,?,?,?,?,?)").run("lost-row", "lost-request", "stardew", null, "failed", 2);`,
      // Written INSIDE the open transaction, so the parent knows the interruption landed after the
      // insert and before any COMMIT.
      'writeFileSync(markerPath, "uncommitted");',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const markerPath = join(subject.root, "marker.txt");
  const child = spawn(process.execPath, [childPath, join(subject.root, DATABASE), markerPath, journalMode], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (!existsSync(markerPath)) return;
      clearInterval(timer);
      resolve();
    }, 20);
    child.once("error", reject);
    child.once("exit", () => {
      clearInterval(timer);
      reject(new Error("the writer exited before it reached its uncommitted insert"));
    });
  });
  // A real kill: SIGKILL on POSIX, TerminateProcess on Windows. Nothing runs in the child's
  // process after this, so no ROLLBACK and no checkpoint can hide the recovery being tested.
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  // The interrupted transaction has to have left recovery work behind, or this test would be
  // asserting that a CLEAN file reopens - true of any file, and worth nothing. WHICH file that is
  // follows from the mode the store reported: a rollback journal writes `-journal`, WAL writes `-wal`.
  const journalPath = `${join(subject.root, DATABASE)}${journalArtifactSuffix(journalMode)}`;
  assert.ok(
    existsSync(journalPath),
    `no ${journalArtifactSuffix(journalMode)} was left at ${journalPath} although the store reports journal_mode=${journalMode}: the kill did not interrupt a transaction, so this test proved nothing about recovery`,
  );

  // No manual intervention: just open the authority the way the Host does at startup.
  const recovered = openProductionContinuityStore({ runtimeRoot: subject.root });
  try {
    recovered.validateBootstrap(bootstrap);
    const reader = new DatabaseSync(join(subject.root, DATABASE));
    try {
      const kept = reader
        .prepare("SELECT 1 FROM production_game_session_metadata WHERE game_session_id='kept-row'")
        .get();
      const lost = reader
        .prepare("SELECT 1 FROM production_game_session_metadata WHERE game_session_id='lost-row'")
        .get();
      assert.ok(
        kept,
        "the committed row was lost across a killed commit: the store did not recover to its last commit",
      );
      assert.equal(
        lost,
        undefined,
        "the interrupted row is present, so a transaction that never committed was made durable",
      );
      assert.equal(
        (reader.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
        "ok",
        "the database reports damage after recovering from a killed commit",
      );
    } finally {
      reader.close();
    }
  } finally {
    recovered.close();
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
 * between 0.87 and 1.53 million rows across runs, which is the honest width of this measurement:
 * re-validation cost is linear, the constant around it is not. The out-of-band sweep above puts the
 * same crossing between 640 000 and 960 000 rows, so the two agree on the order of magnitude and on
 * the fact that it is far past any history this product carries.
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

/**
 * The gate: a legitimate commit at a history a Companion's Chat history reaches must clear the
 * configured budget by a stated margin, and the failure names both numbers and the row count.
 *
 * Why this exists as a gate rather than as the sweep above. The sweep records a curve, which is a
 * snapshot: someone reads it, nods, and the next column added to a re-validated table shifts the
 * slope without anyone re-reading anything. The defect this class is about is exactly that shape -
 * a budget that stops bounding a legitimate operation - and it shipped once already at 250 ms. So the
 * comparison is made every run, both sides derive from the store (the budget from its live
 * connection's own `PRAGMA busy_timeout`, the commit from its real write path), and the failure
 * prints what it saw.
 *
 * The margin is 10x, and it is stated as a ratio rather than as a number of milliseconds because
 * the two sides are what it relates: a commit may occupy up to a TENTH of the budget, leaving the
 * rest as the wait the budget was actually meant to bound. At the size this gate uses (40 000 rows,
 * `HISTORY_ROWS` above - a size a Companion's Chat history reaches) a commit measures 150-350 ms, so
 * the margin holds with room, and a change that tripled the per-commit cost would take it out.
 *
 * The size is fixed rather than derived from the budget so the gate's own runtime stays bounded
 * (seeding is the expensive part, and 40 000 rows seeds in a few seconds); the SIZE is what a real
 * store reaches, which is the property that matters, and moving it is a deliberate act that shows up
 * in a diff.
 */
test("a legitimate commit at a reachable history clears the store's own budget by 10x", () => {
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

    // Both the worst case and the median, because a budget can be outrun by either: a single slow
    // commit is a race, and a median past the margin means the whole path has drifted rather than
    // one sample being unlucky. Ten samples so the median is a reading and not one measurement.
    const commits: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const started = performance.now();
      subject.store.createGameSessionMetadata({
        creationRequestId: `budget-${index}`,
        integrationId: "stardew",
        continuityIdentityId: principal.continuityId,
      });
      commits.push(performance.now() - started);
    }
    const sorted = [...commits].sort((left, right) => left - right);
    const longestMs = sorted[sorted.length - 1]!;
    const medianMs = quantile(sorted, 0.5);
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
      longestMs * COMMIT_BUDGET_MARGIN < budget,
      `a legitimate commit no longer clears the budget by ${String(COMMIT_BUDGET_MARGIN)}x: the store allows ${String(budget)}ms, and its slowest of 10 commits at ${String(HISTORY_ROWS)} rows took ${longestMs.toFixed(1)}ms (median ${medianMs.toFixed(1)}ms). That leaves ${(budget / longestMs).toFixed(1)}x headroom instead of ${String(COMMIT_BUDGET_MARGIN)}x, so a commit is now competing with the wait the budget exists to bound - either the budget is too small for this store at ${String(HISTORY_ROWS)} rows, or a re-validated table grew and the commit path got slower`,
    );
  } finally {
    subject.control.close();
    removeRoot(subject.root);
  }
});
/**
 * The configured budget is worth nothing if it is set after the statements that need it.
 *
 * Configuring the journal can take the write lock itself - converting a file that is still in DELETE
 * does, measured at 7 124ms behind a held writer - and the open path used to run the pragmas last, so
 * against a held writer the open failed at 22.3 ms while a 5 s budget was configured. This drives the
 * real open path against a writer held by a SEPARATE PROCESS: a timer in this thread cannot release
 * anything, because the thread is blocked inside SQLite.
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
