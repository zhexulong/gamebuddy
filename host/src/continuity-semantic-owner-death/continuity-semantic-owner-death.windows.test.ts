import assert from "node:assert/strict";
import test from "node:test";

import { readWindowsOwnerDeathVerification } from "./continuity-semantic-owner-death.internal.js";
import { createWindowsOwnerDeathVerifier } from "./continuity-semantic-owner-death.windows.js";

const owner = Object.freeze({
  ownerToken: "owner-token",
  runtimeInstanceId: "runtime-1",
  ownerPid: 1234,
  ownerProcessStartIdentity: "638400000000000000",
});

function verifier(result: () => Promise<{ stdout: string; stderr: string }>) {
  return createWindowsOwnerDeathVerifier({ platform: "win32", executeOwnerQuery: () => result() });
}

async function outcome(result: () => Promise<{ stdout: string; stderr: string }>) {
  return readWindowsOwnerDeathVerification(await verifier(result).verify(owner)).outcome;
}

test("Windows owner verifier accepts only the exact live PID and UTC CreationDate ticks tuple", async () => {
  assert.equal(await outcome(async () => ({ stdout: "1234|638400000000000000\r\n", stderr: "" })), "alive");
});

test("Windows owner verifier proves death only for the missing-process exit", async () => {
  assert.equal(
    await outcome(async () => {
      throw Object.assign(new Error("missing"), { code: 17 });
    }),
    "proven_dead",
  );
});

test("Windows owner verifier fails closed for malformed output, stderr, timeout, and command errors", async () => {
  assert.equal(await outcome(async () => ({ stdout: "1234|bad\n", stderr: "" })), "ambiguous");
  assert.equal(await outcome(async () => ({ stdout: "1234|638400000000000000\n", stderr: "warning" })), "ambiguous");
  assert.equal(
    await outcome(async () => {
      throw Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" });
    }),
    "unavailable",
  );
  assert.equal(
    await outcome(async () => {
      throw new Error("powershell failure");
    }),
    "unavailable",
  );
});

test("Windows owner verifier rejects PID and process-start mismatches", async () => {
  assert.equal(await outcome(async () => ({ stdout: "9999|638400000000000000\n", stderr: "" })), "mismatch");
  assert.equal(await outcome(async () => ({ stdout: "1234|638400000000000001\n", stderr: "" })), "mismatch");
});
