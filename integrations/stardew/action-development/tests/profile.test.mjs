import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseTargetProfileText, validateTargetProfile } from "../src/profile.mjs";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const example = JSON.parse(await readFile(path.join(projectDirectory, "profiles", "example.json"), "utf8"));

test("validates the non-secret example target profile", () => {
  const profile = validateTargetProfile(example);
  assert.deepEqual(profile, example);
  assert.ok(Object.isFrozen(profile));
  assert.deepEqual(parseTargetProfileText(JSON.stringify(example)), example);
  assert.throws(() => parseTargetProfileText('{"schema":"gamebuddy-action-target-profile/v1","schema":"wrong"}'), /duplicate_key/);
});

test("rejects malformed, unknown, missing, and action-bearing profile fields", () => {
  assert.throws(() => validateTargetProfile(null), /invalid_shape/);
  assert.throws(() => validateTargetProfile({ ...example, endpoint: "pipe" }), /invalid_shape/);
  assert.throws(() => validateTargetProfile({ schema: example.schema, profileIdentity: example.profileIdentity }), /invalid_shape/);
  assert.throws(() => validateTargetProfile({ ...example, schema: "wrong/v1" }), /invalid_schema/);
  assert.throws(() => validateTargetProfile({ ...example, profileIdentity: "../unsafe" }), /invalid_identity/);
  assert.throws(() => validateTargetProfile({ ...example, targetVersion: "" }), /invalid_target_version/);
});

test("rejects accessors and hidden fields", () => {
  const accessor = { ...example };
  Object.defineProperty(accessor, "targetVersion", { enumerable: true, get: () => example.targetVersion });
  assert.throws(() => validateTargetProfile(accessor), /invalid_shape/);
  const hidden = { ...example };
  Object.defineProperty(hidden, "secret", { value: "no", enumerable: false });
  assert.throws(() => validateTargetProfile(hidden), /invalid_shape/);
  assert.throws(() => validateTargetProfile(new Proxy(example, {})), /invalid_shape/);
  const { proxy, revoke } = Proxy.revocable({ ...example }, {});
  revoke();
  assert.throws(() => validateTargetProfile(proxy), /invalid_shape/);
});
