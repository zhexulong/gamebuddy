/*
 * The one thing no fake can settle: does the real Windows query answer `proven_dead` for a process this
 * machine actually killed?
 *
 * `createWindowsOwnerDeathVerifier()` reads the OS process table through PowerShell and returns
 * `proven_dead` only for PowerShell's explicit missing-process exit (code 17); every other error is
 * `unavailable`, a differing start identity is `mismatch`, and a matching one is `alive`. The coordinator's
 * startup settlement is covered by tests with a fake verifier, so the link those tests cannot reach is
 * this one: what the OS says when a real owner has been force-killed.
 *
 * Three questions, each answered here on the machine that runs it:
 *   1. a live child  -> `alive`          (the identity it reports is the one we hold)
 *   2. after taskkill /F of that child -> `proven_dead`, with the identity we recorded while it lived
 *   3. a live child, but an identity that is not its own -> `mismatch`  (a reused PID is not a death)
 *
 * Run: node tools/live-run/game/owner-death-probe.mjs     (Windows only; exits 0 only if all three hold)
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HOST_DIST = join(process.cwd(), "host", "dist-test");
const VERIFIER = join(
  HOST_DIST,
  "continuity-semantic-game-runtime-binding",
  "continuity-semantic-game-runtime-binding.windows-owner-death.js",
);
const VERIFIER_INTERNAL = join(
  HOST_DIST,
  "continuity-semantic-game-runtime-binding",
  "continuity-semantic-game-runtime-binding.windows-owner-death.internal.js",
);

/** The same query the verifier makes, so the identity we hold is the one it will compare. */
async function readStartIdentity(pid) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$processRecord = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + ${pid})`,
    "if ($null -eq $processRecord) { exit 17 }",
    "[Console]::Out.WriteLine([string]([datetime]$processRecord.CreationDate).ToUniversalTime().Ticks)",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
  return stdout.trim();
}

async function kill(pid) {
  await execFileAsync("taskkill", ["/F", "/PID", String(pid)]).catch(() => {});
  // The OS reaps asynchronously; the verifier's question is only meaningful once the row is gone.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await readStartIdentity(pid);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

if (process.platform !== "win32") {
  console.log("owner_death_probe_skipped: not Windows, and the verifier answers `unavailable` there by design");
  process.exit(0);
}
if (!existsSync(VERIFIER)) {
  console.error(`owner_death_probe_blocked: ${VERIFIER} is not built; run: pnpm --dir host build:test`);
  process.exit(1);
}

const { createWindowsOwnerDeathVerifier } = await import(`file://${VERIFIER.replace(/\\/gu, "/")}`);
const { readWindowsOwnerDeathVerification } = await import(`file://${VERIFIER_INTERNAL.replace(/\\/gu, "/")}`);
const verifier = createWindowsOwnerDeathVerifier();

/** The verification is an opaque frozen token; the outcome is only readable through its own reader. */
async function outcomeFor(owner) {
  return readWindowsOwnerDeathVerification(await verifier.verify(owner)).outcome;
}

const findings = [];
function record(question, expected, actual) {
  const ok = actual === expected;
  findings.push({ question, expected, actual, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${question}: expected ${expected}, got ${actual}`);
}

// A child that stays alive until we kill it, so the PID and its start identity are both real.
const child = execFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true });
await new Promise((resolve) => child.once("spawn", resolve));

const ownerPid = child.pid;
const startIdentity = await readStartIdentity(ownerPid);
const owner = Object.freeze({ ownerPid, ownerProcessStartIdentity: startIdentity, ownerStartedAtUnixMs: 0 });

record("a live owner is `alive`", "alive", await outcomeFor(owner));

const reaped = await kill(ownerPid);
if (!reaped) {
  console.error("owner_death_probe_blocked: taskkill did not remove the child, so question 2 was never asked");
  process.exit(1);
}

record("the same owner, force-killed, is `proven_dead`", "proven_dead", await outcomeFor(owner));

const second = execFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true });
await new Promise((resolve) => second.once("spawn", resolve));
const secondIdentity = await readStartIdentity(second.pid);
record(
  "a live PID under someone else's identity is `mismatch`",
  "mismatch",
  await outcomeFor({ ...owner, ownerPid: second.pid, ownerProcessStartIdentity: `${secondIdentity}0` }),
);
await kill(second.pid);

const failed = findings.filter((finding) => !finding.ok);
console.log(
  `owner_death_probe: examined ${String(findings.length)} question(s) on real Windows, ${String(failed.length)} disagreement(s)`,
);
process.exit(failed.length === 0 ? 0 : 1);
