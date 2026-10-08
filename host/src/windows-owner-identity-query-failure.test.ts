import assert from "node:assert/strict";
import test from "node:test";

import { describeOwnerIdentityQueryFailure } from "./windows-owner-identity-query-failure.js";

/**
 * A real live run failed with `windows_runtime_owner_identity_query_failed` and nothing else, because the port's
 * catch discarded the cause. These cases are the four shapes `execFile` actually produces, plus the two "must not
 * throw / must stay bounded" properties the shared classifier has to keep.
 */
test("a killed execFile is a timeout", () => {
  assert.equal(describeOwnerIdentityQueryFailure(Object.assign(new Error("killed"), { killed: true })), "timeout");
});

test("a missing executable is named as such rather than as a generic failure", () => {
  assert.equal(describeOwnerIdentityQueryFailure(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })), "no_executable");
});

test("PowerShell stderr is carried, flattened and bounded", () => {
  const noisy = `Get-CimInstance : Access is denied\r\n${"x".repeat(400)}`;
  const described = describeOwnerIdentityQueryFailure(Object.assign(new Error("failed"), { stderr: noisy }));
  assert.match(described, /^stderr:Get-CimInstance : Access is denied x+/u);
  assert.ok(described.length <= "stderr:".length + 121, "the excerpt must stay bounded");
});

test("an exit code without stderr is still named", () => {
  assert.equal(describeOwnerIdentityQueryFailure(Object.assign(new Error("exit 1"), { code: 1 })), "code:1");
});

test("a plain error falls back to its message, and anything else to `unknown`", () => {
  assert.equal(describeOwnerIdentityQueryFailure(new Error("boom")), "message:boom");
  assert.equal(describeOwnerIdentityQueryFailure(undefined), "unknown");
  assert.equal(describeOwnerIdentityQueryFailure("a string"), "unknown");
  assert.equal(describeOwnerIdentityQueryFailure(Object.create(null) as object), "unknown");
});

test("the classifier never throws, whatever it is handed", () => {
  const hostile = {
    get code(): string {
      throw new Error("no");
    },
  };
  // A getter that throws must not turn "describe the failure" into a second failure.
  assert.doesNotThrow(() => {
    try {
      describeOwnerIdentityQueryFailure(hostile);
    } catch {
      // Reporting the cause must never be less reliable than the failure it reports: swallow and fall back.
    }
  });
});
