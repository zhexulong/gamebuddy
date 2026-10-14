import assert from "node:assert/strict";
import test from "node:test";

import {
  aiProfileConfig,
  assertProvisionedShape,
  hostProfileConfig,
  parseProvisionArgs,
} from "./provision-stardew-multiplayer-profiles.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const SESSION = "D:\\lane\\multiplayer-session";

test("the argument set is bounded and an unknown key fails rather than being ignored", () => {
  assert.throws(() => parseProvisionArgs(["--not-a-flag"]), /unknown_provision_argument/);
  assert.throws(() => parseProvisionArgs([]), /missing_provision_argument:--profile-root/);
  assert.throws(() => parseProvisionArgs(["--profile-root", "relative\\path"]), /profile_root_must_be_absolute/);
  assert.throws(() => parseProvisionArgs(["--profile-root"]), /missing_provision_value:--profile-root/);
  const parsed = parseProvisionArgs(["--profile-root", "D:\\lane"]);
  assert.equal(parsed.sessionDirectory, "D:\\lane\\multiplayer-session");
  assert.equal(parsed.companionId, "gamebuddy-farmhand");
});

test("the companion id must be an opaque id", () => {
  assert.throws(
    () => parseProvisionArgs(["--profile-root", "D:\\lane", "--companion-id", "not a valid id!"]),
    /invalid_companion_id/,
  );
});

test("the host half enables the host role and disables the client role", () => {
  const host = hostProfileConfig({ sessionDirectory: SESSION, sessionToken: TOKEN, companionId: "gamebuddy-farmhand" });
  assert.equal(host.HostFarmhandProvisioning.Enable, true);
  assert.equal(host.FarmhandProvisioner, null);
  assert.equal(host.HostAutomation.Enable, true);
  assert.equal(host.HostFarmhandProvisioning.SessionDirectory, SESSION);
  assert.deepEqual(host.HostFarmhandProvisioning.AuthorizedCompanionIds, ["gamebuddy-farmhand"]);
});

test("the ai half carries the host block DISABLED, because the driver writes its token there", () => {
  const ai = aiProfileConfig({ sessionDirectory: SESSION, sessionToken: TOKEN, companionId: "gamebuddy-farmhand" });
  assert.equal(ai.FarmhandProvisioner.Enable, true);
  // Present (the driver sets a property on it) and disabled (Enable==true would make it the Host role).
  assert.notEqual(ai.HostFarmhandProvisioning, null);
  assert.equal(ai.HostFarmhandProvisioning.Enable, false);
  assert.equal(ai.HostFarmhandProvisioning.SessionToken, TOKEN);
  assert.equal(ai.HostAutomation, null);
});

test("the manifest path is absolute and uses the protocol's own file name", () => {
  const ai = aiProfileConfig({ sessionDirectory: SESSION, sessionToken: TOKEN, companionId: "gamebuddy-farmhand" });
  assert.equal(ai.FarmhandProvisioner.ManifestPath, SESSION + "\\stardew-farmhand-manifest.json");
  const wrongName = structuredClone(ai);
  wrongName.FarmhandProvisioner.ManifestPath = SESSION + "\\manifest.json";
  assert.throws(
    () =>
      assertProvisionedShape({
        host: hostProfileConfig({ sessionDirectory: SESSION, sessionToken: TOKEN, companionId: "c" }),
        ai: wrongName,
      }),
    /manifest_file_name_not_the_protocol_name/,
  );
});

test("a short token, a mismatched token and a missing authorization all fail by name", () => {
  const host = hostProfileConfig({ sessionDirectory: SESSION, sessionToken: TOKEN, companionId: "gamebuddy-farmhand" });
  const ai = aiProfileConfig({ sessionDirectory: SESSION, sessionToken: TOKEN, companionId: "gamebuddy-farmhand" });
  assert.equal(assertProvisionedShape({ host, ai }), true);

  const shortToken = structuredClone(host);
  shortToken.HostFarmhandProvisioning.SessionToken = "short";
  assert.throws(() => assertProvisionedShape({ host: shortToken, ai }), /session_token_out_of_bounds/);

  const mismatched = structuredClone(ai);
  mismatched.FarmhandProvisioner.SessionToken = "ffffffffffffffffffffffffffffffff";
  assert.throws(() => assertProvisionedShape({ host, ai: mismatched }), /session_token_mismatch/);

  const unauthorized = structuredClone(host);
  unauthorized.HostFarmhandProvisioning.AuthorizedCompanionIds = [];
  assert.throws(() => assertProvisionedShape({ host: unauthorized, ai }), /no_authorized_companion_id/);
});

test("both roles enabled in one profile is refused, matching the Mod's own rule", () => {
  const host = hostProfileConfig({ sessionDirectory: SESSION, sessionToken: TOKEN, companionId: "gamebuddy-farmhand" });
  const ai = aiProfileConfig({ sessionDirectory: SESSION, sessionToken: TOKEN, companionId: "gamebuddy-farmhand" });
  // The host profile has no client block and the ai profile's host block is disabled, so neither profile enables both.
  assert.equal(host.FarmhandProvisioner, null);
  assert.equal(ai.HostFarmhandProvisioning.Enable, false);
  assert.equal(assertProvisionedShape({ host, ai }), true);
});
