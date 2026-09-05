import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { bindWindowsStaleLockReclaimer, pathLockPath } from "./path-lock.js";
import {
  publishStardewInstallationRegistration,
  readStardewInstallationRegistration,
  withStardewInstallationRegistrationOwnerTransaction,
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

function record(overrides: Partial<StardewInstallationRegistrationRecordV1> = {}): StardewInstallationRegistrationRecordV1 {
  return {
    schema: "gamebuddy-stardew-installation-registration/v1",
    binding: { rootLayoutVersion: 1, productInstallationId: "desktop_installation_01" },
    revision: 1,
    state: "ready",
    locator,
    activeAttempt: null,
    ...overrides,
  } as StardewInstallationRegistrationRecordV1;
}

async function fixture(): Promise<{ root: string; path: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-registration-"));
  return {
    root,
    path: join(root, "stardew-installation-registration", "registration.json"),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

function lockHelper() {
  return createTestWindowsStaleLockReclaimer(() => {
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

test("publishes and strict-reads canonical ready and invalid records only at the root-bound path", async () => {
  const subject = await fixture();
  try {
    const ready = record();
    assert.deepEqual(await publishStardewInstallationRegistration(subject.root, null, ready), ready);
    assert.equal(
      await readFile(subject.path, "utf8"),
      JSON.stringify(ready),
    );
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

test("strict parser rejects malformed schemas, unsafe structures, and invalid field grammar without locator leakage", async () => {
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
      { ...record(), binding: { rootLayoutVersion: 2, productInstallationId: "desktop_installation_01" } },
      { ...record(), binding: { rootLayoutVersion: 1, productInstallationId: "not valid" } },
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
    await writeFile(subject.path, `{"schema":"gamebuddy-stardew-installation-registration/v1","schema":"wrong"}`, "utf8");
    await rejectsRedacted(() => readStardewInstallationRegistration(subject.root), sentinelLocator);
    await writeFile(subject.path, JSON.stringify({ ...record(), locator: sentinelLocator }) + "\n", "utf8");
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
    await assert.rejects(
      publishStardewInstallationRegistration(subject.root, null, record({ revision: 1 })),
      { message: "stardew_installation_registration_conflict" },
    );
    await assert.rejects(
      publishStardewInstallationRegistration(subject.root, 2, record({ revision: 3 })),
      { message: "stardew_installation_registration_conflict" },
    );
    await assert.rejects(
      publishStardewInstallationRegistration(subject.root, 1, record({ revision: 3 })),
      { message: "invalid_stardew_installation_registration_publish" },
    );
    await assert.rejects(
      publishStardewInstallationRegistration(subject.root, 1, record({ revision: 2, activeAttempt: { bootstrapCorrelation: "attempt_01" } })),
      { message: "invalid_stardew_installation_registration_publish" },
    );
    const symbolBearing = record({ revision: 2 });
    Object.defineProperty(symbolBearing, Symbol("unexpected"), { value: true, enumerable: true });
    await assert.rejects(
      publishStardewInstallationRegistration(subject.root, 1, symbolBearing),
      { message: "stardew_installation_registration_unavailable" },
    );
    const prototypeBearing = Object.assign(Object.create({ inherited: true }), record({ revision: 2 }));
    await assert.rejects(
      publishStardewInstallationRegistration(subject.root, 1, prototypeBearing),
      { message: "stardew_installation_registration_unavailable" },
    );

    await writeFile(subject.path, JSON.stringify(record({ activeAttempt: { bootstrapCorrelation: "attempt_01" } })), "utf8");
    await assert.rejects(
      publishStardewInstallationRegistration(subject.root, 1, record({ revision: 2 })),
      { message: "stardew_installation_registration_busy" },
    );
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
    await rejectsRedacted(() => publishStardewInstallationRegistration(subject.root, null, record({ locator: sentinelLocator })), sentinelLocator);
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
    await withStardewInstallationRegistrationOwnerTransaction(subject.root, async (storage) => {
      assert.equal((await storage.readRegistration())?.activeAttempt, null);
      await storage.writeMarker(prepareMarker);
      const paired = await storage.bindPreparedPointer(1, prepareMarker);
      assert.deepEqual(paired.activeAttempt, { bootstrapCorrelation: "bootstrap_01" });
      assert.equal(paired.revision, 2);
      await storage.clearMarker(prepareMarker);
    });
    assert.deepEqual((await readStardewInstallationRegistration(subject.root))?.activeAttempt, { bootstrapCorrelation: "bootstrap_01" });
    await assert.rejects(
      publishStardewInstallationRegistration(subject.root, 2, record({ revision: 3 })),
      { message: "stardew_installation_registration_busy" },
    );
    await withStardewInstallationRegistrationOwnerTransaction(subject.root, async (storage) => {
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

test("owner transaction rejects a mismatched marker and leaves the durable marker unavailable", async () => {
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
    await assert.rejects(withStardewInstallationRegistrationOwnerTransaction(subject.root, async (storage) => {
      await storage.writeMarker(marker);
      await storage.bindPreparedPointer(1, { ...marker, bootstrapCorrelation: "other" });
    }), { message: "stardew_installation_registration_unavailable" });
    await assert.rejects(publishStardewInstallationRegistration(subject.root, 1, record({ revision: 2 })), {
      message: "stardew_installation_registration_unavailable",
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
    await assert.rejects(
      readStardewInstallationRegistration(subject.root),
      { message: "stardew_installation_registration_unavailable" },
    );
    await assert.rejects(
      publishStardewInstallationRegistration(subject.root, 1, record({ revision: 2 })),
      { message: "stardew_installation_registration_unavailable" },
    );
    const markerBytes = await readFile(markerPath, "utf8");
    assert.equal(markerBytes, JSON.stringify(marker));
  } finally {
    await subject.dispose();
  }
});

test("source exposes no browser, action-development, recovery, or independent fence seam", async () => {
  const source = await readFile(new URL("./stardew-installation-registration.internal.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /browser\/|action-development|readView|recovery|fence|AdmittedStardewInstallation|consumeAdmitted/);
  assert.doesNotMatch(source, /export (?:async )?function (?:prepare|settle|recover|clear|bind).*Attempt/);
});

test("product registration and lifecycle composition do not accept legacy action-development profile authority", async () => {
  const sources = await Promise.all([
    readFile(new URL("./stardew-installation-registration.internal.js", import.meta.url), "utf8"),
    readFile(new URL("./stardew-production-lifecycle-coordinator.internal.js", import.meta.url), "utf8"),
  ]);
  const legacyProfileAuthority = /gamebuddy-action-target-profile\/v1|action-development(?:[\\/]|\b)|profileFile|gameInstallPath|modsPath|releaseDir|fixtureTransactionRoot|nativeFixtureRoot|runtimeLeaseRoot|runtimeLeaseIdentity|nativeClientConfigFile|--profile/;
  for (const source of sources) assert.doesNotMatch(source, legacyProfileAuthority);
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
