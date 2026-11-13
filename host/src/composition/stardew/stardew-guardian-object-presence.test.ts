import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyGuardianObjectWin32Error,
  probeWindowsStardewGuardianObjects,
} from "./stardew-guardian-object-presence.js";

/**
 * The native Guardian fixture already owns the objects a real Guardian creates:
 * `--hold-job` creates the named Job and joins the holder to it, `--hold-mutex`
 * holds the named lease. It is built by
 * `node scripts/build-windows-bootstrap-guardian.mjs`.
 */
const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "native",
  "windows-bootstrap-guardian",
  ".dist",
  "fixtures",
  "RoleRootFixture.exe",
);

const FIXTURE_START_TIMEOUT_MS = 30_000;

test("only ERROR_FILE_NOT_FOUND is absence; a denied or mismatched object is unclassified", () => {
  assert.equal(classifyGuardianObjectWin32Error(0), "opened");
  assert.equal(classifyGuardianObjectWin32Error(2), "not_found");
  // ERROR_ACCESS_DENIED: the object exists with a DACL this user cannot open.
  assert.equal(classifyGuardianObjectWin32Error(5), "unclassified");
  // ERROR_INVALID_HANDLE: the name resolves to a different object kind.
  assert.equal(classifyGuardianObjectWin32Error(6), "unclassified");
  assert.equal(classifyGuardianObjectWin32Error(87), "unclassified");
});

test("a name outside the Guardian's own grammar is never probed and is unclassified", async () => {
  const verdict = await probeWindowsStardewGuardianObjects({
    playerJobName: "Global\\NotAGuardianName",
    leaseName: "Local\\GameBuddy-Lease-Probe",
  });
  assert.deepEqual(verdict, { playerJob: "unclassified", lease: "unclassified" });
});

test("the probe reports the objects the fixture holds as opened, and gone after it exits", async (t) => {
  if (!requireFixture(t)) return;
  const names = freshNames("Held");
  const fixture = await startFixture(["--hold-job", names.playerJobName, "--hold-mutex", names.leaseName]);
  try {
    assert.deepEqual(await probeWindowsStardewGuardianObjects(names), { playerJob: "opened", lease: "opened" });
  } finally {
    await stopFixture(fixture);
  }
  assert.deepEqual(await probeWindowsStardewGuardianObjects(names), { playerJob: "not_found", lease: "not_found" });
});

test("a Job that exists but denies this user reads unclassified, never absent", async (t) => {
  if (!requireFixture(t)) return;
  const names = freshNames("Denied");
  // `deny-current` creates the Job with a protected empty DACL: it exists, and no
  // principal is granted access to it through that descriptor.
  const fixture = await startFixture(["--recovery-job", names.playerJobName, "deny-current"]);
  try {
    assert.deepEqual(await probeWindowsStardewGuardianObjects(names), {
      playerJob: "unclassified",
      lease: "not_found",
    });
  } finally {
    await stopFixture(fixture);
  }
});

type FixtureNames = Readonly<{ playerJobName: string; leaseName: string }>;

function freshNames(label: string): FixtureNames {
  const unique = `${process.pid}-${Date.now()}-${Math.trunc(Math.random() * 1_000_000)}`;
  return Object.freeze({
    playerJobName: `Local\\GameBuddy-Probe-${label}-Job-${unique}`,
    leaseName: `Local\\GameBuddy-Probe-${label}-Lease-${unique}`,
  });
}

/** A missing fixture is `not_measured`, never a silent pass. */
function requireFixture(t: { skip(reason: string): void }): boolean {
  if (existsSync(FIXTURE)) return true;
  t.skip(`not measured: ${FIXTURE} is absent - build it with \`node scripts/build-windows-bootstrap-guardian.mjs\``);
  return false;
}

/** Starts the fixture and waits for the readiness report it writes after creating its objects. */
async function startFixture(args: readonly string[]): Promise<ChildProcess> {
  const report = join(
    tmpdir(),
    `gamebuddy-guardian-object-probe-${process.pid}-${Math.trunc(Math.random() * 1_000_000)}.txt`,
  );
  const child = spawn(FIXTURE, [...args, "--signal", report], { shell: false, windowsHide: true, stdio: "ignore" });
  const deadline = Date.now() + FIXTURE_START_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("windows_guardian_object_probe_fixture_exited_before_report");
      try {
        await readFile(report, "utf8");
        return child;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
    }
    throw new Error("windows_guardian_object_probe_fixture_report_timeout");
  } finally {
    await rm(report, { force: true });
  }
}

/**
 * Ends exactly the process this test started, and waits for the OS to report the
 * exit: the probe's own premise is that the named Job dies with its last handle,
 * so the absence reading means nothing before that exit is observed.
 */
async function stopFixture(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
  child.kill();
  await exited;
}
