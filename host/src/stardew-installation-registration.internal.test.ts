import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { bindWindowsStaleLockReclaimer, pathLockPath } from "./path-lock.js";
import {
  publishStardewInstallationRegistration,
  readStardewInstallationRegistration,
  withStardewLifecycleInstallationRegistrationOwner,
  type StardewInstallationRegistrationOwnerTransactionMarker,
  type StardewInstallationRegistrationRecordV1,
} from "./stardew-installation-registration.internal.js";
import { createTestWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.test-support.js";

const locator = "C:\\Games\\Stardew Valley";
const sentinelLocator = "Q:\\private-sentinel\\Stardew Valley";
const legacyActionDevelopmentProfileFields = [
  "profileIdentity",
  "targetVersion",
  "gameInstallPath",
  "modsPath",
  "releaseDir",
  "fixtureTransactionRoot",
  "nativeFixtureRoot",
  "saveIdentity",
  "templateIdentity",
  "gameVersion",
  "smapiVersion",
  "adapterVersion",
  "runtimeLeaseRoot",
  "runtimeLeaseIdentity",
  "timeoutMs",
  "nativeClientConfigFile",
] as const;

function record(
  overrides: Partial<StardewInstallationRegistrationRecordV1> = {},
): StardewInstallationRegistrationRecordV1 {
  return {
    schema: "gamebuddy-stardew-installation-registration/v1",
    binding: { rootLayoutVersion: 1 },
    revision: 1,
    state: "ready",
    locator,
    activeAttempt: null,
    ...overrides,
  } as StardewInstallationRegistrationRecordV1;
}

async function fixture(): Promise<{ root: string; path: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-stardew-registration-"));
  return {
    root,
    path: join(root, "stardew-installation-registration", "registration.json"),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/** The bound reclaimer answers the lock module's requests; `onRequest` counts them. */
function lockHelper(onRequest?: () => void) {
  return createTestWindowsStaleLockReclaimer(() => {
    onRequest?.();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    child.stdin.on("data", (input: Buffer) => {
      const request = JSON.parse(input.toString("utf8")) as {
        operation: "reclaim_stale_lock" | "release_owned_lock";
        root: string;
        segments: string[];
        token?: string;
      };
      void (async () => {
        let result = "indeterminate";
        if (request.operation === "release_owned_lock") {
          const path = resolve(request.root, ...request.segments);
          try {
            const owner = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
            if (owner.token === request.token) {
              await rm(path, { force: true });
              result = "released";
            } else result = "kept_token_mismatch";
          } catch (error) {
            result = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "kept_not_regular";
          }
        }
        child.stdout.end(`${JSON.stringify({ schemaVersion: 1, result })}\n`);
        child.stderr.end();
        queueMicrotask(() => child.emit("close", 0, null));
      })();
    });
    return child as unknown as ChildProcess;
  });
}

test.beforeEach(() => bindWindowsStaleLockReclaimer(lockHelper()));
test.after(() => bindWindowsStaleLockReclaimer(undefined));

/**
 * The assertions below are about the reclaimer being *consulted*, so they bind a helper that
 * counts its requests; a read that reaches it at all is reaching the exclusive lock path.
 */
function countingLock(checks: { requests: number }) {
  return lockHelper(() => {
    checks.requests += 1;
  });
}

/** A live foreign owner's lock record: fresh, well-formed, and its pid is not this process. */
async function writeForeignHeldLock(lockPath: string): Promise<void> {
  await writeFile(
    lockPath,
    JSON.stringify({ token: "4d2c7b1a-6f3e-4a5b-9c8d-0e7f6a5b4c3d", pid: 999_999_999, createdAtMs: Date.now() }),
    "utf8",
  );
}

test("a read never creates, waits on, or consults a lock file", async () => {
  const checks = { requests: 0 };
  bindWindowsStaleLockReclaimer(countingLock(checks));
  const subject = await fixture();
  try {
    assert.deepEqual(await publishStardewInstallationRegistration(subject.root, null, record()), record());
    // Publishing does take the exclusive lock, so its helper traffic is not the read's.
    const requestsAfterPublish = checks.requests;
    await assert.rejects(lstat(pathLockPath(subject.path)), { code: "ENOENT" });

    assert.deepEqual(await readStardewInstallationRegistration(subject.root), record());
    assert.equal(
      await readStardewInstallationRegistration(join(subject.root, "absent-runtime-root")),
      null,
      "an absent record is null, and reading it neither creates a root nor a lock",
    );
    await assert.rejects(lstat(join(subject.root, "absent-runtime-root")), { code: "ENOENT" });
    assert.equal(checks.requests, requestsAfterPublish, "no read reached the lock reclaimer");
    await assert.rejects(lstat(pathLockPath(subject.path)), { code: "ENOENT" });
  } finally {
    await subject.dispose();
  }
});

test("a read returns the record while another owner holds the lock, and still refuses what it refused", async () => {
  const subject = await fixture();
  try {
    const ready = record();
    await publishStardewInstallationRegistration(subject.root, null, ready);
    // A fresh, well-formed owner that is not this process: reclaim answers `valid_owner_fresh`
    // and the lock stays a barrier for every writer for the whole five-minute window.
    await writeForeignHeldLock(pathLockPath(subject.path));
    assert.deepEqual(await readStardewInstallationRegistration(subject.root), ready);

    // The marker check still governs the read while the lock is held by someone else.
    const markerPath = join(subject.root, "stardew-installation-registration", "owner-transaction.json");
    await writeFile(
      markerPath,
      JSON.stringify({
        schema: "gamebuddy-stardew-installation-owner-transaction/v1",
        operation: "prepare_bind",
        bootstrapCorrelation: "bootstrap_01",
        registrationRevision: 2,
        ownerRecordRevision: 1,
      }),
      "utf8",
    );
    await assert.rejects(readStardewInstallationRegistration(subject.root), {
      message: "stardew_installation_registration_unavailable",
    });
    await rm(markerPath);

    // The byte re-verification still governs it: a non-canonical spelling of a valid record is
    // refused rather than returned, and the foreign lock neither hides nor manufactures that.
    await writeFile(subject.path, JSON.stringify({ ...ready, revision: 2 }, null, 2), "utf8");
    await assert.rejects(readStardewInstallationRegistration(subject.root), {
      message: "stardew_installation_registration_unavailable",
    });
  } finally {
    await subject.dispose();
  }
});

test("publish and the owner transaction still take the exclusive lock", async () => {
  const checks = { requests: 0 };
  bindWindowsStaleLockReclaimer(countingLock(checks));
  const subject = await fixture();
  try {
    // Each writer's release goes through the reclaimer, so the count moves exactly when a
    // writer holds and releases the lock; a read never moves it at all.
    assert.deepEqual(await publishStardewInstallationRegistration(subject.root, null, record()), record());
    assert.ok(checks.requests > 0, "publishing releases its lock through the reclaimer");
    const requestsAfterPublish = checks.requests;
    await readStardewInstallationRegistration(subject.root);
    await readStardewInstallationRegistration(subject.root);
    assert.equal(checks.requests, requestsAfterPublish);
    await withStardewLifecycleInstallationRegistrationOwner(subject.root, async () => "done");
    assert.ok(checks.requests > requestsAfterPublish, "the owner transaction releases its lock through the reclaimer");
  } finally {
    await subject.dispose();
  }
});

test("a read still refuses a registration directory that is a link, record or no record", async (t) => {
  const real = await fixture();
  const linked = await fixture();
  const linkLeaf = join(linked.root, "stardew-installation-registration");
  try {
    await publishStardewInstallationRegistration(real.root, null, record());
    try {
      await symlink(
        join(real.root, "stardew-installation-registration"),
        linkLeaf,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
        t.skip("symbolic links are not permitted in this environment");
        return;
      }
      throw error;
    }
    // The same bytes are returned through the real directory and refused through the link, so
    // the boundary re-verification the lock used to cover is still covered by the read itself.
    assert.deepEqual(await readStardewInstallationRegistration(real.root), record());
    await assert.rejects(readStardewInstallationRegistration(linked.root), {
      message: "stardew_installation_registration_unavailable",
    });
    // And with no record behind the link at all, the answer is still `unavailable`, never the
    // `null` that means "no registration": a path that resolves elsewhere is not evidence about
    // this runtime root. The lock's own chain verification was what covered this case.
    await rm(join(real.root, "stardew-installation-registration", "registration.json"));
    assert.equal(await readStardewInstallationRegistration(real.root), null);
    await assert.rejects(readStardewInstallationRegistration(linked.root), {
      message: "stardew_installation_registration_unavailable",
    });
  } finally {
    await real.dispose();
    await linked.dispose();
  }
});

test("publishes and strict-reads canonical ready and invalid records only at the root-bound path", async () => {
  const subject = await fixture();
  try {
    const ready = record();
    assert.deepEqual(await publishStardewInstallationRegistration(subject.root, null, ready), ready);
    assert.equal(await readFile(subject.path, "utf8"), JSON.stringify(ready));
    assert.deepEqual(await readStardewInstallationRegistration(subject.root), ready);

    const invalid = record({ revision: 2, state: "invalid", locator: null });
    assert.deepEqual(await publishStardewInstallationRegistration(subject.root, 1, invalid), invalid);
    assert.deepEqual(await readStardewInstallationRegistration(subject.root), invalid);
    assert.equal(await readStardewInstallationRegistration(join(subject.root, "independent-runtime-root")), null);
    await assert.rejects(readStardewInstallationRegistration("relative-runtime-root"), {
      message: "stardew_installation_registration_unavailable",
    });
  } finally {
    await subject.dispose();
  }
});

test("strict parser rejects malformed schemas, unsafe structures, unowned productInstallationId, and invalid field grammar without locator leakage", async () => {
  const subject = await fixture();
  try {
    await mkdir(join(subject.root, "stardew-installation-registration"));
    const badValues: unknown[] = [
      [],
      null,
      { ...record(), unknown: true },
      { schema: record().schema },
      { ...record(), revision: 0 },
      { ...record(), revision: 1.5 },
      { ...record(), revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...record(), binding: { rootLayoutVersion: 2 } },
      { ...record(), binding: { rootLayoutVersion: 1, productInstallationId: "desktop_installation_01" } },
      { ...record(), state: "invalid" },
      { ...record(), locator: "C:/Games/Stardew Valley" },
      { ...record(), locator: "C:\\Games\\..\\Stardew Valley" },
      { ...record(), locator: "C:\\Games\\NUL" },
      { ...record(), activeAttempt: { bootstrapCorrelation: "attempt_01", pid: 123 } },
      { ...record(), activeAttempt: { bootstrapCorrelation: "not valid" } },
      { ...record(), activeAttempt: [] },
    ];
    for (const value of badValues) {
      await writeFile(subject.path, JSON.stringify(value), "utf8");
      await rejectsRedacted(() => readStardewInstallationRegistration(subject.root), sentinelLocator);
    }
    await writeFile(
      subject.path,
      `{"schema":"gamebuddy-stardew-installation-registration/v1","schema":"wrong"}`,
      "utf8",
    );
    await rejectsRedacted(() => readStardewInstallationRegistration(subject.root), sentinelLocator);
    await writeFile(subject.path, `${JSON.stringify({ ...record(), locator: sentinelLocator })}\n`, "utf8");
    await rejectsRedacted(() => readStardewInstallationRegistration(subject.root), sentinelLocator);
    await writeFile(subject.path, "x".repeat(64 * 1024 + 1), "utf8");
    await rejectsRedacted(() => readStardewInstallationRegistration(subject.root), sentinelLocator);
  } finally {
    await subject.dispose();
  }
});

test("strict parser rejects every legacy action-development profile field as unknown without locator leakage", async () => {
  const subject = await fixture();
  try {
    await mkdir(join(subject.root, "stardew-installation-registration"));
    for (const field of legacyActionDevelopmentProfileFields) {
      await writeFile(subject.path, JSON.stringify({ ...record(), [field]: sentinelLocator }), "utf8");
      await rejectsRedacted(() => readStardewInstallationRegistration(subject.root), sentinelLocator);
    }
  } finally {
    await subject.dispose();
  }
});

test("publish requires the exact predecessor and refuses active pointer records without an independent pointer CAS", async () => {
  const subject = await fixture();
  try {
    await publishStardewInstallationRegistration(subject.root, null, record());
    await assert.rejects(publishStardewInstallationRegistration(subject.root, null, record({ revision: 1 })), {
      message: "stardew_installation_registration_conflict",
    });
    await assert.rejects(publishStardewInstallationRegistration(subject.root, 2, record({ revision: 3 })), {
      message: "stardew_installation_registration_conflict",
    });
    await assert.rejects(publishStardewInstallationRegistration(subject.root, 1, record({ revision: 3 })), {
      message: "invalid_stardew_installation_registration_publish",
    });
    await assert.rejects(
      publishStardewInstallationRegistration(
        subject.root,
        1,
        record({ revision: 2, activeAttempt: { bootstrapCorrelation: "attempt_01" } }),
      ),
      { message: "invalid_stardew_installation_registration_publish" },
    );
    const symbolBearing = record({ revision: 2 });
    Object.defineProperty(symbolBearing, Symbol("unexpected"), { value: true, enumerable: true });
    await assert.rejects(publishStardewInstallationRegistration(subject.root, 1, symbolBearing), {
      message: "stardew_installation_registration_unavailable",
    });
    const prototypeBearing = Object.assign(Object.create({ inherited: true }), record({ revision: 2 }));
    await assert.rejects(publishStardewInstallationRegistration(subject.root, 1, prototypeBearing), {
      message: "stardew_installation_registration_unavailable",
    });

    await writeFile(
      subject.path,
      JSON.stringify(record({ activeAttempt: { bootstrapCorrelation: "attempt_01" } })),
      "utf8",
    );
    await assert.rejects(publishStardewInstallationRegistration(subject.root, 1, record({ revision: 2 })), {
      message: "stardew_installation_registration_busy",
    });
  } finally {
    await subject.dispose();
  }
});

test("safe-boundary failures are fail-closed", async (t) => {
  const subject = await fixture();
  const link = join(subject.root, "stardew-installation-registration");
  try {
    try {
      await mkdir(join(subject.root, "outside"));
      await symlink(join(subject.root, "outside"), link, "dir");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
        t.skip("symbolic links are not permitted in this environment");
        return;
      }
      throw error;
    }
    await rejectsRedacted(
      () => publishStardewInstallationRegistration(subject.root, null, record({ locator: sentinelLocator })),
      sentinelLocator,
    );
    await assert.rejects(readFile(pathLockPath(subject.path), "utf8"), { code: "ENOENT" });
  } finally {
    await subject.dispose();
  }
});

test("sole owner locked transaction binds and releases only a matching pointer with bounded marker persistence", async () => {
  const subject = await fixture();
  const prepareMarker: StardewInstallationRegistrationOwnerTransactionMarker = {
    schema: "gamebuddy-stardew-installation-owner-transaction/v1",
    operation: "prepare_bind",
    bootstrapCorrelation: "bootstrap_01",
    registrationRevision: 2,
    ownerRecordRevision: 1,
  };
  const settlementMarker: StardewInstallationRegistrationOwnerTransactionMarker = {
    ...prepareMarker,
    operation: "settlement_release",
    registrationRevision: 3,
    ownerRecordRevision: 8,
  };
  try {
    await publishStardewInstallationRegistration(subject.root, null, record());
    await withStardewLifecycleInstallationRegistrationOwner(subject.root, async (storage) => {
      assert.equal((await storage.readRegistration())?.activeAttempt, null);
      await storage.writeMarker(prepareMarker);
      const paired = await storage.bindPreparedPointer(1, prepareMarker);
      assert.deepEqual(paired.activeAttempt, { bootstrapCorrelation: "bootstrap_01" });
      assert.equal(paired.revision, 2);
      await storage.clearMarker(prepareMarker);
    });
    assert.deepEqual((await readStardewInstallationRegistration(subject.root))?.activeAttempt, {
      bootstrapCorrelation: "bootstrap_01",
    });
    await assert.rejects(publishStardewInstallationRegistration(subject.root, 2, record({ revision: 3 })), {
      message: "stardew_installation_registration_busy",
    });
    await withStardewLifecycleInstallationRegistrationOwner(subject.root, async (storage) => {
      await storage.writeMarker(settlementMarker);
      const released = await storage.releaseSettledPointer(2, settlementMarker);
      assert.equal(released.activeAttempt, null);
      assert.equal(released.revision, 3);
      await storage.clearMarker(settlementMarker);
    });
    assert.equal((await readStardewInstallationRegistration(subject.root))?.activeAttempt, null);
  } finally {
    await subject.dispose();
  }
});

test("owner transaction rejects stale and mismatched settlement markers without rewriting their revision", async () => {
  const subject = await fixture();
  const prepareMarker: StardewInstallationRegistrationOwnerTransactionMarker = {
    schema: "gamebuddy-stardew-installation-owner-transaction/v1",
    operation: "prepare_bind",
    bootstrapCorrelation: "bootstrap_01",
    registrationRevision: 2,
    ownerRecordRevision: 1,
  };
  const settlementMarker: StardewInstallationRegistrationOwnerTransactionMarker = {
    ...prepareMarker,
    operation: "settlement_release",
    registrationRevision: 3,
    ownerRecordRevision: 8,
  };
  const markerPath = join(subject.root, "stardew-installation-registration", "owner-transaction.json");
  try {
    await publishStardewInstallationRegistration(subject.root, null, record());
    await withStardewLifecycleInstallationRegistrationOwner(subject.root, async (storage) => {
      await storage.writeMarker(prepareMarker);
      await storage.bindPreparedPointer(1, prepareMarker);
      await storage.clearMarker(prepareMarker);
    });
    await writeFile(markerPath, JSON.stringify({ ...settlementMarker, registrationRevision: 2 }), "utf8");
    await assert.rejects(
      withStardewLifecycleInstallationRegistrationOwner(subject.root, async (storage) => {
        await storage.releaseSettledPointer(2, settlementMarker);
      }),
      { message: "stardew_installation_registration_unavailable" },
    );
    // The intentionally mismatched settlement marker stays on disk and the
    // record revision is never rewritten. Public read is unavailable while a
    // marker exists, so the revision is asserted inside the owner lock.
    await withStardewLifecycleInstallationRegistrationOwner(subject.root, async (storage) => {
      assert.equal((await storage.readRegistration())?.revision, 2);
      assert.equal((await storage.readRegistration())?.activeAttempt?.bootstrapCorrelation, "bootstrap_01");
    });
    assert.notEqual(await readFile(markerPath, "utf8"), "");
  } finally {
    await subject.dispose();
  }
});

test("owner transaction rejects a mismatched bind marker and leaves the durable marker unavailable", async () => {
  const subject = await fixture();
  const marker: StardewInstallationRegistrationOwnerTransactionMarker = {
    schema: "gamebuddy-stardew-installation-owner-transaction/v1",
    operation: "prepare_bind",
    bootstrapCorrelation: "bootstrap_01",
    registrationRevision: 2,
    ownerRecordRevision: 1,
  };
  try {
    await publishStardewInstallationRegistration(subject.root, null, record());
    await assert.rejects(
      withStardewLifecycleInstallationRegistrationOwner(subject.root, async (storage) => {
        await storage.writeMarker(marker);
        await storage.bindPreparedPointer(1, { ...marker, bootstrapCorrelation: "other" });
      }),
      { message: "stardew_installation_registration_unavailable" },
    );
    await assert.rejects(publishStardewInstallationRegistration(subject.root, 1, record({ revision: 2 })), {
      message: "stardew_installation_registration_unavailable",
    });
  } finally {
    await subject.dispose();
  }
});

test("owner transaction locator replacement preserves the pointer and rejects stale or foreign writers", async () => {
  const subject = await fixture();
  const prepareMarker: StardewInstallationRegistrationOwnerTransactionMarker = {
    schema: "gamebuddy-stardew-installation-owner-transaction/v1",
    operation: "prepare_bind",
    bootstrapCorrelation: "bootstrap_01",
    registrationRevision: 2,
    ownerRecordRevision: 1,
  };
  try {
    await publishStardewInstallationRegistration(subject.root, null, record());
    await withStardewLifecycleInstallationRegistrationOwner(subject.root, async (storage) => {
      await storage.writeMarker(prepareMarker);
      await storage.bindPreparedPointer(1, prepareMarker);
      await storage.clearMarker(prepareMarker);
    });
    await withStardewLifecycleInstallationRegistrationOwner(subject.root, async (storage) => {
      const replaced = await storage.replaceActiveAttemptLocator(2, "bootstrap_01", "D:\\Games\\Stardew Valley");
      assert.deepEqual(
        replaced,
        record({
          revision: 3,
          locator: "D:\\Games\\Stardew Valley",
          activeAttempt: { bootstrapCorrelation: "bootstrap_01" },
        }),
      );
      await assert.rejects(storage.replaceActiveAttemptLocator(2, "bootstrap_01", "E:\\Games\\Stardew Valley"), {
        message: "stardew_installation_registration_conflict",
      });
      await assert.rejects(storage.replaceActiveAttemptLocator(3, "foreign_attempt", "E:\\Games\\Stardew Valley"), {
        message: "stardew_installation_registration_conflict",
      });
    });
  } finally {
    await subject.dispose();
  }
});

test("public read and publish are unavailable when owner-transaction marker is present, and marker bytes are not cleaned up", async () => {
  const subject = await fixture();
  const marker: StardewInstallationRegistrationOwnerTransactionMarker = {
    schema: "gamebuddy-stardew-installation-owner-transaction/v1",
    operation: "prepare_bind",
    bootstrapCorrelation: "bootstrap_01",
    registrationRevision: 2,
    ownerRecordRevision: 1,
  };
  const markerPath = join(subject.root, "stardew-installation-registration", "owner-transaction.json");
  try {
    await publishStardewInstallationRegistration(subject.root, null, record());
    await writeFile(markerPath, JSON.stringify(marker), "utf8");
    await assert.rejects(readStardewInstallationRegistration(subject.root), {
      message: "stardew_installation_registration_unavailable",
    });
    await assert.rejects(publishStardewInstallationRegistration(subject.root, 1, record({ revision: 2 })), {
      message: "stardew_installation_registration_unavailable",
    });
    const markerBytes = await readFile(markerPath, "utf8");
    assert.equal(markerBytes, JSON.stringify(marker));
  } finally {
    await subject.dispose();
  }
});

test("source exposes no browser, action-development, recovery, or independent fence seam", async () => {
  const source = await readFile(new URL("./stardew-installation-registration.internal.js", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /browser\/|action-development|readView|recovery|fence|AdmittedStardewInstallation|consumeAdmitted/,
  );
  assert.doesNotMatch(source, /export (?:async )?function (?:prepare|settle|recover|clear|bind|replace).*Attempt/);
  assert.match(source, /export async function withStardewLifecycleInstallationRegistrationOwner/);
  assert.doesNotMatch(source, /export async function withStardewInstallationRegistrationOwnerTransaction/);
  assert.doesNotMatch(source, /export (?:async )?function replaceStardewInstallationRegistrationLocator/);
});

test("product registration and lifecycle composition do not accept legacy action-development profile authority", async () => {
  const sources = await Promise.all([
    readFile(new URL("./stardew-installation-registration.internal.js", import.meta.url), "utf8"),
    readFile(new URL("./stardew-production-lifecycle-coordinator.internal.js", import.meta.url), "utf8"),
  ]);
  const legacyProfileAuthority =
    /gamebuddy-action-target-profile\/v1|action-development(?:[\\/]|\b)|profileFile|gameInstallPath|modsPath|releaseDir|fixtureTransactionRoot|nativeFixtureRoot|runtimeLeaseRoot|runtimeLeaseIdentity|nativeClientConfigFile|--profile/;
  for (const source of sources) assert.doesNotMatch(source, legacyProfileAuthority);
  // `bootstrapId` is the current bootstrap owner record's own identity, read by
  // the crashed-world-slot recovery path (`bootstrapFacts: { bootstrapId:
  // holder.holderHandle }`, 0c798cb8/d78c142d); it is not legacy profile
  // authority. The removed locator-replacement seam stays forbidden.
  assert.doesNotMatch(sources[1], /replaceStardewInstallationRegistrationLocator/);
});

async function rejectsRedacted(work: () => Promise<unknown>, secret: string): Promise<void> {
  try {
    await work();
    assert.fail("expected rejection");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "stardew_installation_registration_unavailable");
    assert.equal(error.message.includes(secret), false);
  }
}
