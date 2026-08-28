import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVISORY_MINIMUM_SMAPI_VERSION,
  classifyStardewCompatibility,
  type StardewCompatibilityFacts,
  type StardewCompatibilityOutcome,
  STARDEW_COMPATIBILITY_REASONS,
  STARDEW_COMPATIBILITY_REASONS_BY_STATUS,
  STARDEW_COMPATIBILITY_STATUSES,
  validateStardewCompatibilityOutcome,
  VERIFIED_GAME_BUILD_NUMBER,
  VERIFIED_GAME_VERSION,
  VERIFIED_SMAPI_VERSION,
} from "./stardew-compatibility.js";

/** This is the exact verified environment: game 1.6.15, build 24356, SMAPI 4.5.2. */
function exactFacts(
  overrides: Partial<StardewCompatibilityFacts> = {},
): StardewCompatibilityFacts {
  return Object.freeze({
    gameVersion: VERIFIED_GAME_VERSION,
    gameBuildNumber: VERIFIED_GAME_BUILD_NUMBER,
    smapiVersion: VERIFIED_SMAPI_VERSION,
    runtime: "confirmed_ok",
    loader: "confirmed_ok",
    bridgeProtocolMajor: "confirmed_ok",
    nativeMultiplayerPeer: "confirmed_ok",
    ...overrides,
  });
}

const allowed = (outcome: StardewCompatibilityOutcome): boolean =>
  outcome.status !== "hard_incompatible";

test("exact verified tuple with all named checks confirmed classifies verified and attachable", () => {
  const result = classifyStardewCompatibility(exactFacts());
  assert.deepEqual(result, {
    status: "verified",
    reasonCode: "tuple_verified",
    attachmentAllowed: true,
  });
});

test("an absent native multiplayer session (peer not_applicable) still permits verified", () => {
  const result = classifyStardewCompatibility(
    exactFacts({ nativeMultiplayerPeer: "not_applicable" }),
  );
  assert.equal(result.status, "verified");
  assert.equal(result.reasonCode, "tuple_verified");
  assert.equal(result.attachmentAllowed, true);
});

test("a newer tuple downgrades to compatible_unverified but stays attachable", () => {
  const newerGame = classifyStardewCompatibility(
    exactFacts({ gameVersion: "1.6.16", gameBuildNumber: 24357 }),
  );
  assert.equal(newerGame.status, "compatible_unverified");
  assert.equal(newerGame.reasonCode, "tuple_not_verified");
  assert.equal(newerGame.attachmentAllowed, true);

  const newerSmapi = classifyStardewCompatibility(
    exactFacts({ smapiVersion: "4.6.0" }),
  );
  assert.equal(newerSmapi.status, "compatible_unverified");
  assert.equal(newerSmapi.reasonCode, "tuple_not_verified");
  assert.equal(newerSmapi.attachmentAllowed, true);
});

test("a valid parseable SMAPI below the advisory minimum is a warning, not a failure", () => {
  const result = classifyStardewCompatibility(
    exactFacts({ smapiVersion: "3.14.6" }),
  );
  assert.deepEqual(result, {
    status: "below_minimum_warning",
    reasonCode: "smapi_below_minimum",
    attachmentAllowed: true,
  });
});

test("a confirmed missing runtime is hard and not attachable", () => {
  const result = classifyStardewCompatibility(
    exactFacts({ runtime: "confirmed_failure" }),
  );
  assert.deepEqual(result, {
    status: "hard_incompatible",
    reasonCode: "runtime_missing",
    attachmentAllowed: false,
  });
});

test("a confirmed loader failure is hard and not attachable", () => {
  const result = classifyStardewCompatibility(
    exactFacts({ loader: "confirmed_failure" }),
  );
  assert.deepEqual(result, {
    status: "hard_incompatible",
    reasonCode: "loader_failure",
    attachmentAllowed: false,
  });
});

test("a confirmed bridge protocol-major mismatch is hard and not attachable", () => {
  const result = classifyStardewCompatibility(
    exactFacts({ bridgeProtocolMajor: "confirmed_mismatch" }),
  );
  assert.deepEqual(result, {
    status: "hard_incompatible",
    reasonCode: "bridge_protocol_major_mismatch",
    attachmentAllowed: false,
  });
});

test("a confirmed applicable native multiplayer peer mismatch is hard and not attachable", () => {
  const result = classifyStardewCompatibility(
    exactFacts({ nativeMultiplayerPeer: "confirmed_mismatch" }),
  );
  assert.deepEqual(result, {
    status: "hard_incompatible",
    reasonCode: "native_multiplayer_protocol_mismatch",
    attachmentAllowed: false,
  });
});

test("the exact tuple with a required check unknown is compatible_unverified, not verified", () => {
  for (const override of [
    { runtime: "unknown" as const },
    { loader: "unknown" as const },
    { bridgeProtocolMajor: "unknown" as const },
  ]) {
    const result = classifyStardewCompatibility(exactFacts(override));
    assert.equal(result.status, "compatible_unverified");
    assert.equal(result.reasonCode, "compatibility_evidence_incomplete");
    assert.equal(result.attachmentAllowed, true);
  }
});

test("an unknown native multiplayer peer on the exact tuple is compatible_unverified", () => {
  const result = classifyStardewCompatibility(
    exactFacts({ nativeMultiplayerPeer: "unknown" }),
  );
  assert.equal(result.status, "compatible_unverified");
  assert.equal(result.reasonCode, "compatibility_evidence_incomplete");
  assert.equal(result.attachmentAllowed, true);
});

test("a peer-check failure is unverified; only a confirmed peer protocol mismatch is hard", () => {
  const result = classifyStardewCompatibility(
    exactFacts({ nativeMultiplayerPeer: "confirmed_failure" }),
  );
  assert.equal(result.status, "compatible_unverified");
  assert.equal(result.reasonCode, "compatibility_evidence_incomplete");
  assert.equal(result.attachmentAllowed, true);
});

test("malformed and null SMAPI produce compatible_unverified, never warning or hard", () => {
  for (const smapiVersion of [
    "4",
    "bogus",
    null,
  ] as (string | null)[]) {
    const result = classifyStardewCompatibility(
      exactFacts({ smapiVersion }),
    );
    assert.equal(result.status, "compatible_unverified");
    assert.notEqual(result.status, "below_minimum_warning");
    assert.notEqual(result.status, "hard_incompatible");
    assert.equal(result.attachmentAllowed, true);
  }
});

test("malformed SMAPI keeps the missing identity facts reason only when an identity fact is absent", () => {
  const malformed = classifyStardewCompatibility(
    exactFacts({ smapiVersion: "bogus" }),
  );
  assert.equal(malformed.reasonCode, "tuple_not_verified");

  const nulled = classifyStardewCompatibility(exactFacts({ smapiVersion: null }));
  assert.equal(nulled.reasonCode, "compatibility_evidence_incomplete");
});

test("the validator accepts an exact valid outcome", () => {
  const result = validateStardewCompatibilityOutcome({
    status: "verified",
    reasonCode: "tuple_verified",
    attachmentAllowed: true,
  });
  assert.notEqual(result, null);
  assert.deepEqual(result, {
    status: "verified",
    reasonCode: "tuple_verified",
    attachmentAllowed: true,
  });

  const warning = validateStardewCompatibilityOutcome({
    status: "below_minimum_warning",
    reasonCode: "smapi_below_minimum",
    attachmentAllowed: true,
  });
  assert.deepEqual(warning, {
    status: "below_minimum_warning",
    reasonCode: "smapi_below_minimum",
    attachmentAllowed: true,
  });
});

test("the validator rejects wrong keys, wrong reasons, and broken attachmentAllowed coupling", () => {
  assert.equal(
    validateStardewCompatibilityOutcome({
      status: "verified",
      reasonCode: "tuple_verified",
      attachmentAllowed: true,
      extra: true,
    }),
    null,
  );
  assert.equal(
    validateStardewCompatibilityOutcome({
      status: "verified",
      reasonCode: "tuple_verified",
    }),
    null,
  );
  assert.equal(
    validateStardewCompatibilityOutcome({
      status: "verified",
      reasonCode: "runtime_missing",
      attachmentAllowed: true,
    }),
    null,
  );
  assert.equal(
    validateStardewCompatibilityOutcome({
      status: "hard_incompatible",
      reasonCode: "runtime_missing",
      attachmentAllowed: true,
    }),
    null,
  );
  assert.equal(
    validateStardewCompatibilityOutcome({
      status: "verified",
      reasonCode: "tuple_verified",
      attachmentAllowed: false,
    }),
    null,
  );
  assert.equal(validateStardewCompatibilityOutcome(null), null);
  assert.equal(
    validateStardewCompatibilityOutcome({ status: "verified" }),
    null,
  );
});

test("every status and reason documented in the frozen contract resolves through the classifier", () => {
  assert.deepEqual(
    STARDEW_COMPATIBILITY_STATUSES,
    [
      "verified",
      "compatible_unverified",
      "below_minimum_warning",
      "hard_incompatible",
    ],
  );
  assert.deepEqual(
    STARDEW_COMPATIBILITY_REASONS,
    [
      "runtime_missing",
      "loader_failure",
      "bridge_protocol_major_mismatch",
      "native_multiplayer_protocol_mismatch",
      "smapi_below_minimum",
      "tuple_not_verified",
      "compatibility_evidence_incomplete",
      "tuple_verified",
    ],
  );
  assert.deepEqual(Array.from(STARDEW_COMPATIBILITY_REASONS_BY_STATUS.verified), [
    "tuple_verified",
  ]);
  assert.deepEqual(
    Array.from(STARDEW_COMPATIBILITY_REASONS_BY_STATUS.compatible_unverified),
    ["tuple_not_verified", "compatibility_evidence_incomplete"],
  );
  assert.deepEqual(
    Array.from(STARDEW_COMPATIBILITY_REASONS_BY_STATUS.below_minimum_warning),
    ["smapi_below_minimum"],
  );
  assert.deepEqual(
    Array.from(STARDEW_COMPATIBILITY_REASONS_BY_STATUS.hard_incompatible),
    [
      "runtime_missing",
      "loader_failure",
      "bridge_protocol_major_mismatch",
      "native_multiplayer_protocol_mismatch",
    ],
  );
});
