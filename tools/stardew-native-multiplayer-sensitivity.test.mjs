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
    // Every register must carry the mechanism axis; a default fixture entry keeps
    // the action-focused tests focused on the action axis.
    mechanisms: extra.mechanisms ?? [mechanism()],
    declaredActionIds: actions.map((action) => action.actionId),
    actions,
    ...extra,
  };
}

function mechanism(overrides = {}) {
  return {
    id: "m",
    summary: "a mechanism that forks per world mode",
    forks: [
      {
        file: "StardewValley/Fake.cs",
        signature: "public virtual bool Act(Farmer who)",
        predicate: "if (who.IsLocalPlayer)",
        forkClass: "outcome_fork",
        reason: "the branch decides the result",
      },
    ],
    ...overrides,
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
  // The expected count is derived from the Mod catalog, never hardcoded: a
  // hardcoded number is what let three actions (`water_pet_bowl`,
  // `water_slime_hutch_trough`, `advance_day`) sit outside the register while the
  // suite stayed green. The comparison is set equality, so a registered action the
  // catalog does not declare fails too.
  const catalogText = await readFile(
    "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs",
    "utf8",
  );
  const catalogBody = catalogText.match(/Registrations\s*=\s*Array\.AsReadOnly\(new\[\]\s*\{([\s\S]*?)\}\);/)[1];
  const catalogIds = [...catalogBody.matchAll(/\b(E|R)\(\s*"([a-z0-9_]+)"/g)].map((m) => m[2]).sort();
  const registeredIds = JSON.parse(registerText).actions.map((a) => a.actionId).sort();
  assert.deepEqual(
    registeredIds,
    catalogIds,
    "the sensitivity register must cover exactly the Mod catalog: a missing entry means the action was never scope-classified",
  );
  assert.deepEqual(report.defects, []);
  // Every pin must be a real, still-derived defect carrying a reason and an owner:
  // a pin is an acknowledged gap, never a silent suppression. The list is asserted
  // exactly rather than by count, so neither a stale pin nor a hand-typed one can
  // hide here. Update this list deliberately when a shared-world action lands.
  assert.deepEqual(
    report.acknowledged.map((ack) => `${ack.defect}:${ack.actionId}`).sort(),
    [
      "unverified_scope:advance_day",
      "unverified_scope:chest_retrieve",
      "unverified_scope:pet_animal",
      "unverified_scope:ship_item",
    ],
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

test("the mechanism axis requires a real fork citation and never understates the set", async () => {
  const { validateMultiplayerMechanisms, deriveRequiredSharedWorldMechanisms } = await import(
    "./lib/stardew-native-multiplayer-sensitivity.mjs"
  );
  // A fork whose predicate is absent from the cited body is drift, not a citation.
  assert.throws(
    () => validateMultiplayerMechanisms([mechanism({ forks: [{ ...mechanism().forks[0], predicate: "if (Game1.IsMultiplayer)" }] })], SOURCE),
    (error) => error.code === "mp_sensitivity_mechanism_fork_drift",
  );
  // An uncited fork class is rejected rather than silently treated as collateral.
  assert.throws(
    () => validateMultiplayerMechanisms([mechanism({ forks: [{ ...mechanism().forks[0], forkClass: "maybe" }] })], SOURCE),
    (error) => error.code === "mp_sensitivity_register_invalid",
  );
  // The shared-world set is derived from the forks: adding an outcome fork must grow
  // it without anyone editing a hardcoded list, and a collateral-only fork must not.
  const collateral = mechanism({ id: "c", forks: [{ ...mechanism().forks[0], forkClass: "collateral_fork" }] });
  const validated = validateMultiplayerMechanisms([mechanism({ id: "a" }), collateral], SOURCE);
  assert.deepEqual(deriveRequiredSharedWorldMechanisms(validated), ["a"]);
});

test("the committed register pins the sleep mechanism as shared-world evidence", async () => {
  const registerText = await readFile(
    "integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json",
    "utf8",
  );
  const committed = JSON.parse(registerText);
  // Sleeping is not a Mod action, so an action-only register could never see it.
  // Its forks must be cited against the real source and must include the outcome
  // fork that makes single-player sleep evidence non-transferable.
  const sleep = committed.mechanisms.find((m) => m.id === "sleep");
  assert.ok(sleep, "sleep must be registered as a first-class mechanism");
  const files = new Set(sleep.forks.map((fork) => fork.file));
  assert.ok(files.has("StardewValley/GameLocation.cs"), "must cite the startSleep fork");
  assert.ok(files.has("StardewValley/Game1.cs"), "must cite the cross-day forks");
  assert.ok(sleep.forks.every((fork) => fork.forkClass === "outcome_fork"));
});

test("a mechanism pin suppresses its blocking finding and is rejected once stale", async () => {
  const { validateMultiplayerSensitivityRegister } = await import(
    "./lib/stardew-native-multiplayer-sensitivity.mjs"
  );
  const pin = {
    defect: "unverified_mechanism_scope",
    mechanisms: ["m"],
    reason: "the claimed capability is single-player only and makes no shared-world claim",
    owner: "stardew-integration",
  };
  const act = action();
  // A mechanism that derives an outcome fork must require shared-world evidence.
  const unpinned = validateMultiplayerSensitivityRegister(register([act], { scopeAcknowledgements: [] }), SOURCE);
  assert.deepEqual(unpinned.requiredSharedWorldMechanisms, ["m"]);
  // Pinned, the acknowledgement is preserved and the mechanism stays visible.
  const pinned = validateMultiplayerSensitivityRegister(register([act], { scopeAcknowledgements: [pin] }), SOURCE);
  assert.equal(pinned.scopeAcknowledgements.filter((s) => s.defect === "unverified_mechanism_scope").length, 1);
  assert.deepEqual(pinned.requiredSharedWorldMechanisms, ["m"]);
  // A pin naming a mechanism that derives no outcome fork cannot outlive its gap.
  assert.throws(
    () =>
      validateMultiplayerSensitivityRegister(
        register([act], { scopeAcknowledgements: [{ ...pin, mechanisms: ["not_a_mechanism"] }] }),
        SOURCE,
      ),
    (error) => error.code === "mp_sensitivity_stale_acknowledgement",
  );
  // A mechanism pin must name mechanisms, not actions.
  assert.throws(
    () => validateMultiplayerSensitivityRegister(register([act], { scopeAcknowledgements: [{ ...pin, mechanisms: [] }] }), SOURCE),
    (error) => error.code === "mp_sensitivity_register_invalid",
  );
});
