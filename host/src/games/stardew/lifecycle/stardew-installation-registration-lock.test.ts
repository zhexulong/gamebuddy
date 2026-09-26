import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  publishStardewInstallationRegistration,
  readStardewInstallationRegistration,
  withStardewLifecycleInstallationRegistrationOwner,
} from "../../../stardew-installation-registration.internal.js";
import { bindWindowsStaleLockReclaimer, reclaimStaleLock } from "../../../path-lock.js";
import { createTestWindowsStaleLockReclaimer } from "../../../windows-stale-lock-reclaimer/index.test-support.js";
import { createHarness } from "./stardew-private-bootstrap-composer.test-fixtures.js";

/**
 * Registration / Gate 6 — lock and session lifetime, across two real processes.
 *
 * The registration lock is an ordinary exclusive file create (`open(…, "wx")`)
 * with a PID-stamped owner record, so only a genuinely separate process can
 * prove the cross-process properties. A single-process test would have to fake
 * the lock bytes, which is the very thing under test.
 *
 * The fixture spawns a real child that acquires the lock through the production
 * seam and holds it, then asserts from the parent that:
 *  1. the stale-lock recovery path does NOT reclaim a live owner's lock, so
 *     recovery alone cannot hand the installation to a successor;
 *  2. every lock-taking registration operation stays blocked for as long as the
 *     foreign owner holds it, and leaves the record untouched;
 *  3. once the exact owner releases, the same operations succeed;
 *  4. a holder that dies without releasing leaves a barrier that only ages into
 *     reclaimability, and only then does a successor proceed.
 */

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const REGISTRATION_RELATIVE = join("stardew-installation-registration", "registration.json");
const STALE_LOCK_MS = 5 * 60_000;

const roots: string[] = [];

/**
 * Test reclaimer that actually reclaims. The shared composer fixture helper only
 * answers `release_owned_lock` (it returns `indeterminate` for reclaims), so it
 * cannot exercise the stale path; this one mirrors the frozen helper protocol:
 * it is handed the root/segments tuple plus the policy and answers with the
 * category the native helper would return, deleting the residue when the policy
 * says the owner is proven dead.
 */
function reclaimingLockHelper(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  child.stdin.on("data", (chunk: Buffer) => {
    void (async () => {
      let result = "indeterminate";
      try {
        const request = JSON.parse(chunk.toString("utf8")) as {
          operation: string;
          policy?: string;
          token?: string;
          root: string;
          segments: readonly string[];
        };
        const absolute = resolve(request.root, ...request.segments);
        if (request.operation === "reclaim_stale_lock") {
          // The real helper only reaches here when the Host already proved the
          // policy from fresh, identity-stable bytes; reproducing the delete is
          // the part the Host cannot do itself.
          const raw = await readFile(absolute, "utf8").catch(() => undefined);
          if (raw === undefined) result = "missing";
          else {
            await rm(absolute, { force: true });
            result = "reclaimed";
          }
        } else if (request.operation === "release_owned_lock") {
          const raw = await readFile(absolute, "utf8").catch(() => undefined);
          if (raw === undefined) result = "missing";
          else {
            const owner = JSON.parse(raw) as { token?: string };
            if (owner.token === request.token) { await rm(absolute, { force: true }); result = "released"; }
            else result = "kept_token_mismatch";
          }
        }
      } catch {
        result = "indeterminate";
      }
      child.stdout.end(`${JSON.stringify({ schemaVersion: 1, result })}\n`);
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    })();
  });
  return child as unknown as ChildProcess;
}

test.beforeEach(() => bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(reclaimingLockHelper)));
test.after(() => bindWindowsStaleLockReclaimer(undefined));
test.after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const readyRecord = (revision = 1) => ({
  schema: "gamebuddy-stardew-installation-registration/v1" as const,
  binding: { rootLayoutVersion: 1 as const },
  revision,
  state: "ready" as const,
  locator: "C:\\Games\\Stardew Valley",
  activeAttempt: null,
});

async function createRoot(): Promise<string> {
  const parent = process.env.LOCALAPPDATA ?? tmpdir();
  const root = await mkdtemp(join(await resolve(parent), "gamebuddy-registration-lock-"));
  roots.push(root);
  return root;
}

/**
 * Asserts that `operation` is still blocked after `windowMs`. Racing a short
 * timer is both faster and more precise than waiting out the lock module's
 * internal 10s timeout: it observes "still pending", which is exactly the
 * blocked state, and it fails loudly if the operation settles early.
 *
 * Returns the operation so the caller MUST settle it before releasing the
 * holder. A leaked in-flight lock attempt would otherwise acquire the lock the
 * instant it is released and mutate the record underneath the next assertion.
 */
/**
 * Asserts that `operation` is still blocked after `windowMs`. Racing a short
 * timer is both faster and more precise than waiting out the lock module's
 * internal 10s timeout: it observes "still pending", which is exactly the
 * blocked state, and it fails loudly if the operation settles early.
 *
 * The caller keeps its own reference to the operation and must drain it after
 * releasing the holder. A leaked in-flight lock attempt would otherwise acquire
 * the lock the instant it is released and mutate the record underneath the next
 * assertion.
 */
async function assertStillBlocked(operation: Promise<unknown>, windowMs = 500): Promise<void> {
  const marker = Symbol("pending");
  const raced = await Promise.race([
    operation.then(() => "settled" as const, (error: unknown) => `rejected:${String((error as Error)?.message ?? error)}`),
    new Promise<typeof marker>((resolveTimer) => { setTimeout(() => resolveTimer(marker), windowMs); }),
  ]);
  assert.equal(raced, marker, `expected the operation to stay blocked while a live foreign owner holds the lock, got ${String(raced)}`);
  // Its eventual rejection is expected (lock timeout); swallow it so it does not
  // surface as an unhandled rejection during the wait.
  void operation.catch(() => undefined);
}

/**
 * Ages a lock past the stale window by rewriting its owner record as a
 * locally-dead pid and back-dating the file. Both the file mtime and the owner
 * record's `createdAtMs` feed the stale decision, and the window is five
 * minutes, so the fixture rewrites them instead of waiting. The owner token
 * shape is preserved, so the selector still parses a real owner record.
 */
async function ageLockPastStaleWindow(
  lockPath: string,
  pid: number,
  offsetMs = STALE_LOCK_MS + 5_000,
): Promise<void> {
  const owner = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
  await writeFile(lockPath, JSON.stringify({ ...owner, pid, createdAtMs: Date.now() - offsetMs }), "utf8");
  const staleAt = new Date(Date.now() - offsetMs);
  await utimes(lockPath, staleAt, staleAt);
}

/** A pid that is not alive on this host, so the dead-owner rule is exercised. */
const DEAD_PID = 999_999_999;

type LockHolder = Readonly<{
  pid: number;
  release(): Promise<void>;
  exited: Promise<void>;
  stderr(): string;
}>;

/** Spawns a real second process that holds the registration lock until released. */
async function spawnLockHolder(root: string): Promise<LockHolder> {
  const lockModuleUrl = pathToFileURL(join(moduleDirectory, "..", "..", "..", "path-lock.js")).href;
  const registrationPath = join(root, REGISTRATION_RELATIVE);
  const workerPath = join(root, "lock-holder-worker.mjs");
  // The worker takes the lock through the production seam and holds it for as
  // long as its stdin stays open. It never touches the record bytes, so the
  // parent is blocked purely by the lock.
  await writeFile(workerPath, [
    `import { withPathLock, bindWindowsStaleLockReclaimer } from ${JSON.stringify(lockModuleUrl)};`,
    `bindWindowsStaleLockReclaimer(undefined);`,
    `const release = new Promise((resolveRelease) => {`,
    `  process.stdin.on("data", (chunk) => { if (chunk.toString("utf8").includes("release")) resolveRelease(); });`,
    `  process.stdin.on("end", resolveRelease);`,
    `});`,
    `await withPathLock(${JSON.stringify(registrationPath)}, async () => {`,
    `  process.stdout.write("LOCKED\\n");`,
    `  await release;`,
    `});`,
    `process.stdout.write("RELEASED\\n");`,
  ].join("\n"), "utf8");

  const child = spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
  const exited = new Promise<void>((resolveExit) => { child.once("exit", () => resolveExit()); });
  await new Promise<void>((resolveLocked, rejectLocked) => {
    const timer = setTimeout(() => rejectLocked(new Error(`lock holder never acquired; stderr=${stderr || "<empty>"}`)), 10_000);
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("LOCKED")) { clearTimeout(timer); resolveLocked(); }
    });
    child.once("error", (error) => { clearTimeout(timer); rejectLocked(error); });
  });
  return Object.freeze({
    pid: child.pid!,
    async release() {
      child.stdin.end("release\n");
      await exited;
    },
    exited,
    stderr: () => stderr,
  });
}

test("a live second process holding the registration lock blocks every registration operation", async () => {
  const root = await createRoot();
  await publishStardewInstallationRegistration(root, null, readyRecord());
  const lockPath = join(root, `${REGISTRATION_RELATIVE}.lock`);

  const holder = await spawnLockHolder(root);
  const pending: Array<Promise<unknown>> = [];
  try {
    // The owner is genuinely alive in another process: recovery must keep the
    // lock rather than reclaim it. This is the property a same-process test
    // cannot demonstrate, because it would have to forge the owner pid.
    const observedOwner = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    assert.equal(observedOwner.pid, holder.pid, "the lock records the real foreign owner pid");

    // Age the lock past the stale window while the owner is still alive. The
    // liveness rule must still win: an old-but-live owner is never reclaimed,
    // which is what makes time passage alone unable to displace a running game.
    // The pid inside the record stays the real foreign owner's, so liveness — not
    // the record's age — is the deciding input.
    await ageLockPastStaleWindow(lockPath, holder.pid);
    const recovery = await reclaimStaleLock(lockPath);
    assert.equal(recovery.outcome, "kept");
    assert.equal(recovery.reason, "valid_owner_live");

    // Publish and the owner transaction both take the same lock, so both must
    // stay blocked for as long as the foreign owner holds it. A blocked publish
    // must not have touched the record.
    const publishPending = publishStardewInstallationRegistration(root, 1, readyRecord(2));
    pending.push(publishPending.catch(() => undefined));
    await assertStillBlocked(publishPending);
    const ownerPending = withStardewLifecycleInstallationRegistrationOwner(root, async () => "unreachable");
    pending.push(ownerPending.catch(() => undefined));
    await assertStillBlocked(ownerPending);
    // Reading also takes the lock, so a blocked read is redacted as unavailable
    // rather than observing a half-owned registration.
    const readPending = readStardewInstallationRegistration(root);
    pending.push(readPending.catch(() => undefined));
    await assertStillBlocked(readPending);
    assert.equal(JSON.parse(await readFile(join(root, REGISTRATION_RELATIVE), "utf8")).revision, 1);

    // Release, then drain every blocked attempt before asserting on the record:
    // a still-running lock wait would otherwise succeed the moment the lock is
    // free and mutate the record underneath the next assertion. Exactly which
    // drained attempt wins is not the point of this test, so the final publish
    // derives its expected predecessor from the record's actual revision.
    await holder.release();
    await Promise.all(pending);
  } finally {
    await holder.exited.catch(() => undefined);
  }

  // Once the exact owner released, a successor is admitted again: the block was
  // ownership, not a poisoned lock.
  const current = await readStardewInstallationRegistration(root);
  assert.notEqual(current, null);
  await publishStardewInstallationRegistration(root, current!.revision, readyRecord(current!.revision + 1));
  assert.equal((await readStardewInstallationRegistration(root))?.revision, current!.revision + 1);
});

/**
 * The registration lock is a short preparation scope, not a session lock. This
 * test pins the distinction: once the owner attempt is bound, a competing
 * operation is refused because of the ACTIVE POINTER (`busy`), not because the
 * lock is still held (`durable_path_lock_timeout`). If the lock leaked into the
 * session, every assertion here would time out instead.
 */
test("the registration lock is released once the attempt is bound, so the refusal is the pointer", async () => {
  const root = await createRoot();
  await publishStardewInstallationRegistration(root, null, readyRecord());
  const lockPath = join(root, `${REGISTRATION_RELATIVE}.lock`);

  // Binding the attempt takes the lock for the preparation scope only.
  const harness = createHarness();
  const browserSessionId = "browser-lock-scope";
  const confirmed = harness.composition.broker.confirm({
    playerId: "player-1", companionId: "companion-1", browserSessionId, expiresAtMs: 5_000,
  }).consume(browserSessionId);
  await harness.testCore.reserveOwnedPlayerHostBootstrapForActivation(root, confirmed);

  assert.deepEqual(
    (await readStardewInstallationRegistration(root))?.activeAttempt,
    { bootstrapCorrelation: "bootstrap-1" },
  );
  // The preparation scope is closed: no lock residue is left behind.
  await assert.rejects(readFile(lockPath, "utf8"), /ENOENT/);
  // And a competing rewrite is refused by the pointer rule, which is only
  // reachable when the lock is free. A held lock would time out instead.
  await assert.rejects(
    publishStardewInstallationRegistration(root, 1, readyRecord(2)),
    /stardew_installation_registration_busy/,
  );
});

test("a holder that died without releasing still blocks a successor while its lock is fresh", async () => {
  const root = await createRoot();
  await publishStardewInstallationRegistration(root, null, readyRecord());
  const lockPath = join(root, `${REGISTRATION_RELATIVE}.lock`);

  const holder = await spawnLockHolder(root);
  // Kill the owner without a clean release while the lock is still fresh. A
  // fresh lock whose owner died is deliberately still a barrier: recovery must
  // not infer a dead owner from an unaged record, or a slow-but-alive process
  // could lose its installation to a successor.
  process.kill(holder.pid, "SIGKILL");
  await holder.exited.catch(() => undefined);

  const freshRecovery = await reclaimStaleLock(lockPath);
  assert.equal(freshRecovery.outcome, "kept", "a fresh owner-died lock is not yet reclaimable");
  assert.equal(freshRecovery.reason, "valid_owner_fresh");

  // The successor stays unavailable for as long as the residue is fresh, so a
  // crash alone cannot let a second launch take the installation.
  const pending = publishStardewInstallationRegistration(root, 1, readyRecord(2));
  await assertStillBlocked(pending);
  assert.equal(JSON.parse(await readFile(join(root, REGISTRATION_RELATIVE), "utf8")).revision, 1);

  // Aging the residue into staleness is the only thing that frees it: the real
  // dead child pid is still in the record, so once the bytes are old both the
  // age rule and the liveness rule agree, and only then does a successor run.
  await pending.catch(() => undefined);
  await ageLockPastStaleWindow(lockPath, holder.pid);
  const staleRecovery = await reclaimStaleLock(lockPath);
  assert.equal(staleRecovery.outcome, "reclaimed");
  assert.equal(staleRecovery.reason, "valid_owner_stale_and_dead");

  await publishStardewInstallationRegistration(root, 1, readyRecord(2));
  assert.equal((await readStardewInstallationRegistration(root))?.revision, 2);
});
