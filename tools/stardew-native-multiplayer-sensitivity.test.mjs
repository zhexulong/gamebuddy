import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  collectContextTokens,
  collectDecisiveTokens,
  deriveNativeSeamEvidence,
  extractMethodBody,
  validateMultiplayerSensitivityRegister,
} from "./lib/stardew-native-multiplayer-sensitivity.mjs";

const SOURCE = Object.freeze({
  "StardewValley/Fake.cs": {
    text: [
      "public virtual bool Act(Farmer who)",
      "{",
      "    if (who.IsLocalPlayer) PlaySound();",
      "    if (Game1.player.team.SpecialOrderActive(\"X\")) Stamp();",
      "    return Mutate();",
      "}",
      "public virtual bool Clean(Farmer who)",
      "{",
      "    return Mutate();",
      "}",
      "public virtual bool TeamOnly(Farmer who)",
      "{",
      "    if (Game1.player.team.SpecialOrderActive(\"X\")) Stamp();",
      "    return Mutate();",
      "}",
    ].join("\n"),
  },
});

function seam(overrides = {}) {
  return { kind: "native", file: "StardewValley/Fake.cs", signature: "public virtual bool Act(Farmer who)", sensitivity: "mp-semantic", semanticEffect: "changes the target", ...overrides };
}

function register(actions, extra = {}) {
  return {
    schemaVersion: 1,
    artifactKind: "stardew_native_multiplayer_sensitivity",
    declaredActionIds: actions.map((action) => action.actionId),
    actions,
    ...extra,
  };
}

function action(overrides = {}) {
  return {
    actionId: "act",
    lifecycle: "published",
    seams: [seam()],
    admission: { verdict: "admits_multiplayer" },
    requiredLiveTopology: "shared_world_multiplayer",
    ...overrides,
  };
}

test("separates decisive multiplayer signals from mode-neutral context tokens", () => {
  const body = extractMethodBody(SOURCE["StardewValley/Fake.cs"].text, "public virtual bool Act(");
  assert.deepEqual(collectDecisiveTokens(body), ["IsLocalPlayer"]);
  assert.deepEqual(collectContextTokens(body), ["team"]);
});

test("derives seam evidence by brace-balanced method extraction", () => {
  const [evidence] = deriveNativeSeamEvidence([seam()], SOURCE);
  assert.deepEqual(evidence.decisiveTokens, ["IsLocalPlayer"]);
  assert.deepEqual(evidence.contextTokens, ["team"]);
});

test("accepts a mod-owned seam and refuses to give it a native sensitivity", () => {
  const ok = validateMultiplayerSensitivityRegister(
    register([
      action({
        seams: [{ kind: "mod_owned", authority: "BodyController", sensitivity: "mp-insensitive" }],
        admission: { verdict: "admits_multiplayer" },
        requiredLiveTopology: "single_player_native_companion",
      }),
    ]),
    SOURCE,
  );
  assert.equal(ok.defects.length, 0);

  assert.throws(
    () =>
      validateMultiplayerSensitivityRegister(
        register([
          action({
            seams: [{ kind: "mod_owned", authority: "BodyController", sensitivity: "mp-semantic", semanticEffect: "x" }],
            requiredLiveTopology: "shared_world_multiplayer",
          }),
        ]),
        SOURCE,
      ),
    /mod_owned seam/,
  );
});

test("rejects claiming mp-insensitive for a seam that reads a decisive token", () => {
  assert.throws(
    () =>
      validateMultiplayerSensitivityRegister(
        register([action({ seams: [seam({ sensitivity: "mp-insensitive", semanticEffect: undefined })] })]),
        SOURCE,
      ),
    /decisive token/,
  );
});

test("requires a mode-neutral reason when only context tokens are present", () => {
  const teamOnly = () => seam({ signature: "public virtual bool TeamOnly(Farmer who)", sensitivity: "mp-insensitive", semanticEffect: undefined });
  // Undeclared mode-neutral justification is refused.
  assert.throws(
    () =>
      validateMultiplayerSensitivityRegister(
        register([action({ seams: [teamOnly()], requiredLiveTopology: "single_player_native_companion" })]),
        SOURCE,
      ),
    /modeNeutralReason/,
  );
  // Declaring it is enough to pass, and such a seam stays single-player scope.
  const ok = validateMultiplayerSensitivityRegister(
    register([
      action({
        seams: [{ ...teamOnly(), modeNeutralReason: "FarmerTeam is populated in single-player too" }],
        requiredLiveTopology: "single_player_native_companion",
      }),
    ]),
    SOURCE,
  );
  assert.equal(ok.defects.length, 0);
});

test("requires an observed-effect justification for an mp-observational native seam", () => {
  // An observational seam that does read a decisive token must explain why that
  // read cannot change the transaction outcome; otherwise a reviewer cannot tell
  // a genuine collateral effect from a swallowed real one.
  assert.throws(
    () =>
      validateMultiplayerSensitivityRegister(
        register([
          action({
            seams: [{ ...seam({ sensitivity: "mp-observational" }), semanticEffect: undefined }],
            requiredLiveTopology: "single_player_native_companion",
          }),
        ]),
        SOURCE,
      ),
    /observedEffect/,
  );
});

test("forces mp-semantic actions onto shared-world live evidence", () => {
  assert.throws(
    () =>
      validateMultiplayerSensitivityRegister(
        register([action({ requiredLiveTopology: "single_player_native_companion" })]),
        SOURCE,
      ),
    /topology_understated|mp-semantic native seam/,
  );
});

test("derives over_restriction when admission rejects a shared world without native cause", () => {
  const report = validateMultiplayerSensitivityRegister(
    register([
      action({
        seams: [seam({ signature: "public virtual bool Clean(Farmer who)", sensitivity: "mp-insensitive" })],
        admission: { verdict: "rejects_multiplayer", reasonCode: "native_local_player_required" },
        requiredLiveTopology: "single_player_native_companion",
      }),
    ]),
    SOURCE,
  );
  assert.equal(report.overRestricted.length, 1);
  assert.equal(report.overRestricted[0].actionId, "act");
});

test("derives unverified_scope when admission admits a shared world with an mp-semantic seam", () => {
  const report = validateMultiplayerSensitivityRegister(register([action()]), SOURCE);
  assert.equal(report.unverifiedScope.length, 1);
});

test("treats a read-only action as having no admission to be restrictive", () => {
  const report = validateMultiplayerSensitivityRegister(
    register([
      action({
        seams: [seam({ signature: "public virtual bool Clean(Farmer who)", sensitivity: "mp-insensitive" })],
        admission: { verdict: "read_only" },
        requiredLiveTopology: "single_player_native_companion",
      }),
    ]),
    SOURCE,
  );
  assert.equal(report.defects.length, 0);
});

test("a per-action acknowledgement suppresses its defect and is rejected once stale", () => {
  const pinned = action({
    seams: [seam({ signature: "public virtual bool Clean(Farmer who)", sensitivity: "mp-insensitive" })],
    admission: { verdict: "rejects_multiplayer", reasonCode: "native_local_player_required" },
    requiredLiveTopology: "single_player_native_companion",
    acknowledgedDefect: { defect: "over_restriction", reason: "known gap", owner: "stardew-integration" },
  });
  const report = validateMultiplayerSensitivityRegister(register([pinned]), SOURCE);
  assert.equal(report.defects.length, 0);
  assert.equal(report.acknowledged.length, 1);

  assert.throws(
    () =>
      validateMultiplayerSensitivityRegister(
        register([action({ acknowledgedDefect: { defect: "over_restriction", reason: "r", owner: "o" } })]),
        SOURCE,
      ),
    /stale acknowledgement/,
  );
});

test("a scope acknowledgement covers many actions and cannot outlive the gap", () => {
  const overRestricted = action({
    actionId: "a1",
    seams: [seam({ signature: "public virtual bool Clean(Farmer who)", sensitivity: "mp-insensitive" })],
    admission: { verdict: "rejects_multiplayer", reasonCode: "native_local_player_required" },
    requiredLiveTopology: "single_player_native_companion",
  });
  const clean = action({
    actionId: "a2",
    seams: [seam({ signature: "public virtual bool Clean(Farmer who)", sensitivity: "mp-insensitive" })],
    requiredLiveTopology: "single_player_native_companion",
  });
  const scope = [{ defect: "over_restriction", actions: ["a1"], reason: "systemic", owner: "stardew-integration" }];

  const report = validateMultiplayerSensitivityRegister(register([overRestricted, clean], { scopeAcknowledgements: scope }), SOURCE);
  assert.equal(report.defects.length, 0);
  assert.equal(report.acknowledged.length, 1);

  assert.throws(
    () => validateMultiplayerSensitivityRegister(register([clean], { scopeAcknowledgements: scope }), SOURCE),
    /stale/,
  );
});

test("the committed register derives cleanly against the exact decompiled source", async () => {
  const registerText = await readFile(
    "integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json",
    "utf8",
  );
  const sources = {};
  const { readdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = "ref/external/StardewValleyDecompiled/Stardew Valley";
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name.endsWith(".cs"))
        sources[path.relative(root, absolute).split(path.sep).join("/")] = { text: await readFile(absolute, "utf8") };
    }
  }
  const report = validateMultiplayerSensitivityRegister(JSON.parse(registerText), sources);
  assert.equal(report.actionCount, 45);
  assert.deepEqual(report.defects, []);
  // Every pin must be a real, still-derived defect carrying a reason and an owner:
  // a pin is an acknowledged gap, never a silent suppression. The list is asserted
  // exactly rather than by count, so neither a stale pin nor a hand-typed one can
  // hide here. Update this list deliberately when a shared-world action lands.
  assert.deepEqual(
    report.acknowledged.map((ack) => `${ack.defect}:${ack.actionId}`).sort(),
    ["unverified_scope:chest_retrieve", "unverified_scope:pet_animal", "unverified_scope:ship_item"],
  );
  for (const ack of report.acknowledged) {
    assert.ok(ack.reason && ack.reason.length > 0, `${ack.actionId} pin must carry a reason`);
    assert.ok(ack.owner && ack.owner.length > 0, `${ack.actionId} pin must carry an owner`);
  }
  // The pins must be doing real work, not masking an empty register: the scope-bound
  // actor resolver landed, so no action may still derive the retired over-restriction
  // defect (the 16 single-player guards are gone).
  assert.equal(report.actions.filter((a) => a.rawDefects.some((d) => d.defect === "over_restriction")).length, 0);
});
