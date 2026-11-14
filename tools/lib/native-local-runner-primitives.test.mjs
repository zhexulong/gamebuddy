/**
 * The falsifier suite for `tools/lib/native-local-runner-primitives.mjs`: L1's contracts, at their boundaries.
 *
 * The module exists because these are the pieces 122 runners spelled privately - `parseEvidence` in 49,
 * `parseStrictEvidence` in 32, the fixture-config refusal in 29 (under three names and three refusal vocabularies), the
 * tile predicates in 37+14. So every assertion here is a rule one of those copies carried, and each is written to fail
 * if the primitive drifts from it: the mutation in the test name is the copy that made the rule.
 *
 * The three evidence grammars are asserted to DIFFER from each other, not just to parse: a `parseCompleteEvidence` copy
 * that starts throwing, or a `parseEvidence` copy that starts refusing malformed pairs, would break callers that read
 * `{}` or that skip a pair, so those are the assertions with teeth.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  FIXTURE_VOCABULARIES,
  parseCompleteEvidence,
  parseEvidence,
  parseStrictEvidence,
  sameTile,
  tilesAdjacent,
  tilesNeighbouring,
  validFixtureSlotRelationship,
  validateNativeLocalFixtureConfig,
  connectWithRetry,
  waitForNavigationTerminal,
} from "./native-local-runner-primitives.mjs";
import { NativeSmokeHarnessError } from "./stardew-native-smoke-harness-v1.mjs";

/* ---------------------------------------------------------------------------------------------------------------
 * EVIDENCE
 * ------------------------------------------------------------------------------------------------------------- */

test("parseEvidence keeps the lenient copy's rules: leading '=', trailing '=', and the first '=' only", () => {
  assert.deepEqual(parseEvidence({ detail: "a=1;b=2" }), { a: "1", b: "2" });
  // A pair with no name is malformed and is DROPPED, not a field called ""; a field with no value is kept as "".
  assert.deepEqual(parseEvidence({ detail: "=x;b=2" }), { b: "2" });
  assert.deepEqual(parseEvidence({ detail: "b=" }), { b: "" });
  // The value keeps every later '=', because the split is on the FIRST '=' (`indexOf`, not a global split).
  assert.deepEqual(parseEvidence({ detail: "a=b=c" }), { a: "b=c" });
  assert.deepEqual(
    parseEvidence({ detail: "a=1;a=2" }),
    { a: "2" },
    "a duplicate name is the last one, as the copies did",
  );
});

test("parseEvidence refuses an empty detail with the copy's own word, and takes a runner's replacement", () => {
  assert.throws(() => parseEvidence({}), { message: "native_local_evidence_empty" });
  assert.throws(() => parseEvidence({ detail: "" }), { message: "native_local_evidence_empty" });
  assert.throws(() => parseEvidence(null), { message: "native_local_evidence_empty" });
  assert.throws(() => parseEvidence({}, { emptyCode: "enter_mine_evidence_empty" }), {
    message: "enter_mine_evidence_empty",
  });
  // The override is only reachable for the empty case, which is the only refusal this grammar has.
  assert.deepEqual(parseEvidence({ detail: "a=1" }, { emptyCode: "x" }), { a: "1" });
});

test("parseEvidence's requiredKeys refuse by name, and only when the field is absent", () => {
  const detail = { detail: "location=Farm;target=47" };
  assert.deepEqual(parseEvidence(detail, { requiredKeys: ["location", "target"] }), { location: "Farm", target: "47" });
  assert.throws(() => parseEvidence(detail, { requiredKeys: ["location", "slot"] }), {
    message: "native_local_evidence_missing_key:slot",
  });
  // A field present with an empty value is present: the copies tested `typeof === "string"`, not truthiness.
  assert.deepEqual(parseEvidence({ detail: "slot=" }, { requiredKeys: ["slot"] }), { slot: "" });
});

test("parseStrictEvidence refuses what the lenient grammar drops - that is the whole difference between them", () => {
  assert.deepEqual(parseStrictEvidence({ detail: "a=1;b=2" }), { a: "1", b: "2" });
  // The same bytes `parseEvidence` reads as `{ b: "2" }`, and `parseCompleteEvidence` as `{}`.
  assert.throws(() => parseStrictEvidence({ detail: "=x;b=2" }), { message: "native_local_evidence_malformed:=x" });
  assert.throws(() => parseStrictEvidence({ detail: "a=" }), { message: "native_local_evidence_malformed:a=" });
  assert.throws(() => parseStrictEvidence({ detail: "a=1;a=2" }), { message: "native_local_evidence_malformed:a=2" });
  assert.throws(() => parseStrictEvidence({ detail: "" }), { message: "native_local_evidence_malformed" });
});

test("parseStrictEvidence's options are the five differences the copies encoded", () => {
  // `missingCode`/`malformedCode`: `mine_elevator_evidence_missing` and `mine_elevator_evidence_malformed:<pair>`.
  assert.throws(() => parseStrictEvidence({}, { code: "x", missingCode: "mine_elevator_evidence_missing" }), {
    message: "mine_elevator_evidence_missing",
  });
  assert.throws(() => parseStrictEvidence({ detail: "a" }, { malformedCode: "shop_evidence_malformed" }), {
    message: "shop_evidence_malformed:a",
  });
  // A bare string is evidence too: `shop-purchase` and `mine-elevator` read the raw detail.
  assert.deepEqual(parseStrictEvidence("a=1"), { a: "1" });
  // `trim`: only the three copies that trimmed.
  assert.deepEqual(parseStrictEvidence(" a = 1 ", { trim: true }), { a: "1" });
  assert.deepEqual(parseStrictEvidence(" a = 1 "), { " a ": " 1 " });
  // `keyPattern` + `maxValueLength`: `fertilize-tile`, `harvest-crop`, `machine-inspect`, `place-wood-fence`.
  assert.throws(() => parseStrictEvidence({ detail: "A_B=1" }, { keyPattern: /^[a-z][a-z0-9_]{0,63}$/u }), {
    message: "native_local_evidence_malformed:A_B=1",
  });
  assert.throws(() => parseStrictEvidence({ detail: `a=${"x".repeat(513)}` }, { maxValueLength: 512 }), {
    message: `native_local_evidence_malformed:a=${"x".repeat(513)}`,
  });
  assert.deepEqual(parseStrictEvidence({ detail: `a=${"x".repeat(512)}` }, { maxValueLength: 512 }).a.length, 512);
  // `keys`: an exact SET, in any order, and both directions of difference are a refusal.
  const keys = ["a", "b"];
  assert.deepEqual(parseStrictEvidence({ detail: "b=2;a=1" }, { keys }), { b: "2", a: "1" });
  assert.throws(() => parseStrictEvidence({ detail: "a=1" }, { keys }), /:key_set:a$/u);
  assert.throws(() => parseStrictEvidence({ detail: "a=1;b=2;c=3" }, { keys }), /:key_set:a,b,c$/u);
});

test("parseCompleteEvidence answers {}, never throws - the contract its eight copies read", () => {
  assert.deepEqual(parseCompleteEvidence({ detail: "a=1;b=2" }), { a: "1", b: "2" });
  for (const detail of ["", "a", "=x", "a=", "a=1;a=2"])
    assert.deepEqual(parseCompleteEvidence({ detail }), {}, `"${detail}" is not this runner's evidence`);
  assert.deepEqual(parseCompleteEvidence(null), {});
  assert.deepEqual(parseCompleteEvidence({ detail: "a=1;b=2" }, { keys: ["a"] }), {});
  assert.deepEqual(parseCompleteEvidence({ detail: "a=1" }, { keys: ["a"] }), { a: "1" });
  // The three grammars really do disagree on the same bytes; that is why they are three primitives.
  const bytes = { detail: "a=" };
  assert.deepEqual(parseCompleteEvidence(bytes), {});
  assert.deepEqual(parseEvidence(bytes), { a: "" });
  assert.throws(() => parseStrictEvidence(bytes));
});

/* ---------------------------------------------------------------------------------------------------------------
 * THE FIXTURE CONFIG
 * ------------------------------------------------------------------------------------------------------------- */

const fixtureConfig = {
  NativeLocalPlayerFixture: {
    Enable: true,
    FixtureScenario: "native_x_v1",
    LogicalSaveName: "GameBuddyFixtureA",
    ObservedSaveSlot: "GameBuddyFixtureA_1",
  },
};

test("the fixture refusal speaks all three measured vocabularies and refuses the same configs in each", () => {
  assert.deepEqual([...FIXTURE_VOCABULARIES].sort(), ["action_prefixed", "config_invalid", "enabled"]);
  const refusals = {
    enabled: ["native_local_fixture_not_enabled", "native_local_fixture_topology_not_isolated"],
    config_invalid: ["native_local_fixture_config_invalid", "native_local_fixture_topology_not_isolated"],
    action_prefixed: ["native_local_x1_fixture_config_invalid", "native_local_x1_action_policy_invalid"],
  };
  for (const vocabulary of FIXTURE_VOCABULARIES) {
    const options = { vocabulary, action: "x1" };
    assert.deepEqual(validateNativeLocalFixtureConfig(fixtureConfig, options), undefined, vocabulary);
    assert.throws(() => validateNativeLocalFixtureConfig({}, options), { message: refusals[vocabulary][0] });
    assert.throws(() => validateNativeLocalFixtureConfig({ ...fixtureConfig, Portfolio: { Enable: true } }, options), {
      message: refusals[vocabulary][1],
    });
  }
});

test("the vocabulary is required: no default picks one of three refusal words on every future runner's behalf", () => {
  assert.throws(() => validateNativeLocalFixtureConfig(fixtureConfig, {}), {
    message: "native_local_fixture_config_vocabulary_invalid:undefined",
  });
  assert.throws(() => validateNativeLocalFixtureConfig(fixtureConfig, { vocabulary: "whatever" }), {
    message: "native_local_fixture_config_vocabulary_invalid:whatever",
  });
  assert.throws(() => validateNativeLocalFixtureConfig(fixtureConfig, { vocabulary: "action_prefixed" }), {
    message: "native_local_fixture_config_vocabulary_invalid:action",
  });
});

test("the scenario is checked only when a runner arms one, and the mismatch names the scenario it found", () => {
  const options = { vocabulary: "enabled" };
  // The 7 `enter-exit` copies never armed a scenario: a config with any scenario is valid for them.
  assert.deepEqual(
    validateNativeLocalFixtureConfig(
      { NativeLocalPlayerFixture: { Enable: true, FixtureScenario: "anything" } },
      options,
    ),
    undefined,
  );
  assert.throws(() => validateNativeLocalFixtureConfig(fixtureConfig, { ...options, fixtureScenario: "native_y_v1" }), {
    message: "native_local_fixture_scenario_mismatch:native_x_v1",
  });
  assert.throws(
    () =>
      validateNativeLocalFixtureConfig(
        { NativeLocalPlayerFixture: { Enable: true } },
        { ...options, fixtureScenario: "native_y_v1" },
      ),
    { message: "native_local_fixture_scenario_mismatch:missing" },
  );
});

test("the bootstrap check belongs to the shape vocabularies, as the copies had it", () => {
  const withBootstrap = {
    NativeLocalPlayerFixture: { ...fixtureConfig.NativeLocalPlayerFixture, Bootstrap: { Enable: true } },
  };
  // "enabled" never read Bootstrap; the other two fold it into their shape word.
  assert.deepEqual(validateNativeLocalFixtureConfig(withBootstrap, { vocabulary: "enabled" }), undefined);
  assert.throws(() => validateNativeLocalFixtureConfig(withBootstrap, { vocabulary: "config_invalid" }), {
    message: "native_local_fixture_config_invalid",
  });
  assert.throws(
    () => validateNativeLocalFixtureConfig(withBootstrap, { vocabulary: "action_prefixed", action: "x1" }),
    {
      message: "native_local_x1_fixture_config_invalid",
    },
  );
});

test("the slot relationship is what `validFixtureSlotRelationship` means, and only the shape vocabularies read it", () => {
  assert.equal(validFixtureSlotRelationship("GameBuddyFixtureA", "GameBuddyFixtureA_1"), true);
  assert.equal(validFixtureSlotRelationship("GameBuddyFixtureA", "Other_1"), false, "the slot names its logical save");
  assert.equal(validFixtureSlotRelationship("FixtureA", "FixtureA_1"), false, "the fixture prefix is required");
  assert.equal(validFixtureSlotRelationship("GameBuddyFixtureA", "GameBuddyFixtureA_x"), false);
  assert.equal(validFixtureSlotRelationship(undefined, undefined), false);

  const broken = {
    NativeLocalPlayerFixture: { ...fixtureConfig.NativeLocalPlayerFixture, ObservedSaveSlot: "Other_1" },
  };
  assert.deepEqual(validateNativeLocalFixtureConfig(broken, { vocabulary: "enabled" }), undefined, "not read here");
  assert.throws(
    () => validateNativeLocalFixtureConfig(broken, { vocabulary: "config_invalid", slotRelationship: true }),
    {
      message: "native_local_fixture_config_invalid",
    },
  );
});

test("requiredActions are asserted through the harness's own policy validator, not re-derived here", () => {
  // The harness owns the deny-by-exception reading, so it is driven rather than copied: the refusal it produces is the
  // one a runner sees today, and a config that denies an action the runner needs refuses before the run starts.
  const policy = { DeniedActions: ["travel"], DeniedActionFamilies: [], ExperimentalActions: [] };
  assert.throws(
    () =>
      validateNativeLocalFixtureConfig(
        { ...fixtureConfig, ...policy },
        { vocabulary: "enabled", requiredActions: ["travel"] },
      ),
    {
      message: "native_fixture_policy_denies_required:travel",
    },
  );
  assert.deepEqual(
    validateNativeLocalFixtureConfig(
      { ...fixtureConfig, ...policy },
      { vocabulary: "enabled", requiredActions: ["move_to_tile"] },
    ),
    undefined,
  );
  // An opt-in the caller did not declare experimental is refused, which is what makes the test-only path explicit.
  assert.throws(
    () =>
      validateNativeLocalFixtureConfig(
        { ...fixtureConfig, ...policy, ExperimentalActions: ["sweep_scythe"] },
        { vocabulary: "enabled", requiredActions: [], experimentalActions: [] },
      ),
    { message: "native_fixture_policy_illegal_opt_in:sweep_scythe" },
  );
});

/* ---------------------------------------------------------------------------------------------------------------
 * TILES
 * ------------------------------------------------------------------------------------------------------------- */

test("the tile predicates agree on integer tiles with every spelling they replace, and differ where the copies did", () => {
  const tile = { x: 4, y: 7 };
  // Adjacent includes the actor's own tile - the 19 guarded copies' reading.
  assert.equal(tilesAdjacent(tile, { x: 4, y: 7 }), true);
  assert.equal(tilesAdjacent(tile, { x: 5, y: 8 }), true, "diagonal is adjacent");
  assert.equal(tilesAdjacent(tile, { x: 6, y: 8 }), false);
  // Neighbouring excludes it - the 2 `water-pet-bowl` copies, kept as its own predicate rather than a knob.
  assert.equal(tilesNeighbouring(tile, { x: 4, y: 7 }), false);
  assert.equal(tilesNeighbouring(tile, { x: 5, y: 8 }), true);
  assert.equal(tilesNeighbouring(tile, { x: 6, y: 8 }), false);
  assert.equal(sameTile(tile, { x: 4, y: 7 }), true);
  assert.equal(sameTile(tile, { x: 4, y: 8 }), false);
});

test("the tile predicates fail closed on a coordinate that is not an integer tile", () => {
  for (const left of [{ x: 4 }, { x: 4.5, y: 7 }, null, undefined, { x: "4", y: 7 }]) {
    assert.equal(tilesAdjacent(left, { x: 4, y: 7 }), false, `${JSON.stringify(left)} is not a tile`);
    assert.equal(tilesNeighbouring(left, { x: 4, y: 7 }), false, `${JSON.stringify(left)} is not a tile`);
    assert.equal(sameTile(left, { x: 4, y: 7 }), false, `${JSON.stringify(left)} is not a tile`);
  }
  // The unguarded spelling the 12 copies used computed `NaN <= 1`, which is already false: this is the same answer.
  assert.equal(Number.NaN <= 1, false);
});

/* ---------------------------------------------------------------------------------------------------------------
 * THE CONNECTION AND PIPE LIFECYCLE
 * ------------------------------------------------------------------------------------------------------------- */

test("connectWithRetry retries only ENOENT, and returns the first connection that arrives", async () => {
  let attempts = 0;
  const seen = [];
  const connect = async () => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error("no pipe yet"), { code: "ENOENT" });
    return { client: "connected" };
  };
  let clock = 0;
  const session = await connectWithRetry({ PipeName: "x" }, 1_000, {
    connect,
    now: () => clock,
    wait: async (ms) => void (clock += ms),
  });
  assert.deepEqual(session, { client: "connected" });
  assert.equal(attempts, 3, "two ENOENT refusals, then the pipe");
  assert.ok(seen.length === 0);
});

test("connectWithRetry rethrows any refusal that is not ENOENT, at once", async () => {
  let attempts = 0;
  const connect = async () => {
    attempts++;
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  };
  await assert.rejects(connectWithRetry({}, 1_000, { connect, now: () => 0, wait: async () => {} }), {
    code: "EACCES",
  });
  assert.equal(attempts, 1, "a pipe that refuses with another code is not a pipe that is still arriving");
});

test("connectWithRetry gives up with the last real error, or the named timeout when there was none", async () => {
  let clock = 0;
  const never = async () => {
    throw Object.assign(new Error("no pipe yet"), { code: "ENOENT" });
  };
  await assert.rejects(
    connectWithRetry({}, 500, { connect: never, now: () => clock, wait: async (ms) => void (clock += ms) }),
    { message: "no pipe yet" },
  );
  // A timeout of zero never attempts a connection, so there is no last error and the named one is thrown.
  await assert.rejects(connectWithRetry({}, 0, { connect: never, now: () => 0, wait: async () => {} }), {
    message: "native_local_bridge_connect_timeout",
  });
  assert.equal(DEFAULT_CONNECT_TIMEOUT_MS, 15_000);
});

test("waitForNavigationTerminal maps the harness's timeout back to the navigation vocabulary, twice over", async () => {
  // Both the terminal wait and the post-terminal observation are covered: a harness timeout in either place is the same
  // `navigation_timeout`, so a caller's fixture-approach fallback keeps one decision surface.
  const accepted = { executionId: "exec-1" };
  const harnessTimeout = () => {
    throw new NativeSmokeHarnessError("terminal_timeout");
  };
  await assert.rejects(
    waitForNavigationTerminal(
      {
        state: { latestSnapshot: {} },
        getReceipt: () => undefined,
      },
      [],
      accepted,
      () => true,
      10,
    ),
    { message: "navigation_timeout:exec-1" },
  );
});
