// The SDK lock's semantics: accept what `global.json` asks the SDK to accept, refuse everything else.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSdkLock, sdkVersionSatisfiesLock, UNSUPPORTED_ROLL_FORWARD } from "./dotnet-sdk-lock.mjs";

const lockOf = (sdk) => parseSdkLock(JSON.stringify({ sdk }));

test("a patch update is accepted, which is what latestPatch means", () => {
  // The case that blocked this repository: the machine was patched 8.0.424 -> 8.0.425.
  const lock = lockOf({ version: "8.0.424", rollForward: "latestPatch", allowPrerelease: false });
  assert.equal(sdkVersionSatisfiesLock({ actual: "8.0.425", lock }), true);
  assert.equal(sdkVersionSatisfiesLock({ actual: "8.0.424", lock }), true);
});

test("a different feature band, a lower patch and a prerelease are all refused", () => {
  const lock = lockOf({ version: "8.0.424", rollForward: "latestPatch", allowPrerelease: false });
  assert.equal(sdkVersionSatisfiesLock({ actual: "8.1.0", lock }), false);
  assert.equal(sdkVersionSatisfiesLock({ actual: "9.0.0", lock }), false);
  assert.equal(sdkVersionSatisfiesLock({ actual: "8.0.423", lock }), false);
  assert.equal(sdkVersionSatisfiesLock({ actual: "8.0.425-preview.1", lock }), false);
  assert.equal(sdkVersionSatisfiesLock({ actual: "not-a-version", lock }), false);
});

test("allowPrerelease honors the SDK's own opt-in", () => {
  const lock = lockOf({ version: "8.0.424", rollForward: "latestPatch", allowPrerelease: true });
  assert.equal(sdkVersionSatisfiesLock({ actual: "8.0.425-preview.1", lock }), true);
});

test("disable still means exact, and the default policy is latestPatch", () => {
  const exact = lockOf({ version: "8.0.424", rollForward: "disable" });
  assert.equal(sdkVersionSatisfiesLock({ actual: "8.0.424", lock: exact }), true);
  assert.equal(sdkVersionSatisfiesLock({ actual: "8.0.425", lock: exact }), false);
  const bare = lockOf({ version: "8.0.424" });
  assert.equal(bare.rollForward, "latestPatch");
  assert.equal(sdkVersionSatisfiesLock({ actual: "8.0.425", lock: bare }), true);
});

test("an unimplemented policy fails loudly instead of weakening the gate", () => {
  const wider = lockOf({ version: "8.0.424", rollForward: "latestMinor" });
  assert.throws(
    () => sdkVersionSatisfiesLock({ actual: "8.9.0", lock: wider }),
    (error) => error instanceof Error && error.message === `${UNSUPPORTED_ROLL_FORWARD}:latestMinor`,
  );
});

test("a global.json without a usable lock is rejected", () => {
  assert.throws(() => parseSdkLock("{}"), /sdk_lock_invalid/u);
  assert.throws(() => parseSdkLock("{ not json"), /sdk_lock_invalid/u);
  assert.throws(() => parseSdkLock(JSON.stringify({ sdk: { version: "eight" } })), /sdk_lock_invalid/u);
});
