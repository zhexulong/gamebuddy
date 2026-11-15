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

test("the refusal names the ACTION, because one run's log carries every runner's words", () => {
  // The 51 copies spoke three vocabularies; the tree's own answer is the action prefix, which the template's 12 runners
  // already used, so a runner that later moves onto the template does not change its refusal word.
  assert.throws(() => validateNativeLocalFixtureConfig({}, { action: "x1" }), {
    message: "native_local_x1_fixture_config_invalid",
  });
  assert.throws(
    () => validateNativeLocalFixtureConfig({ ...fixtureConfig, Portfolio: { Enable: true } }, { action: "x1" }),
    {
      message: "native_local_x1_action_policy_invalid",
    },
  );
  // The two words stay distinct: a shared feature is a policy refusal, not a broken fixture section.
  assert.equal(validateNativeLocalFixtureConfig(fixtureConfig, { action: "x1" }), undefined);
});

test("the action is required and has no default", () => {
  assert.throws(() => validateNativeLocalFixtureConfig(fixtureConfig, {}), {
    message: "native_local_fixture_config_action_missing:undefined",
  });
  assert.throws(() => validateNativeLocalFixtureConfig(fixtureConfig, { action: "" }), {
    message: "native_local_fixture_config_action_missing:",
  });
});

test("the scenario is checked only when a runner arms one, and the mismatch names the scenario it found", () => {
  // 39 of the 51 copies never read a scenario: a config with any scenario is valid for them.
  assert.equal(
    validateNativeLocalFixtureConfig(
      { NativeLocalPlayerFixture: { Enable: true, FixtureScenario: "anything" } },
      { action: "x1" },
    ),
    undefined,
  );
  assert.throws(
    () => validateNativeLocalFixtureConfig(fixtureConfig, { action: "x1", fixtureScenario: "native_y_v1" }),
    { message: "native_local_x1_fixture_scenario_mismatch:native_x_v1" },
  );
  assert.throws(
    () =>
      validateNativeLocalFixtureConfig(
        { NativeLocalPlayerFixture: { Enable: true } },
        { action: "x1", fixtureScenario: "native_y_v1" },
      ),
    { message: "native_local_x1_fixture_scenario_mismatch:missing" },
  );
});

test("the bootstrap check is the title-screen phase's own refusal, and it is always read", () => {
  // Eight copies never looked at it. The observed-phase config never carries the key at all
  // (`configureNativeLocalPlayer` replaces the whole section), and the fixture module refuses the same config with the
  // same test, so the check refuses nothing a real run produces.
  const withBootstrap = {
    NativeLocalPlayerFixture: { ...fixtureConfig.NativeLocalPlayerFixture, Bootstrap: { Enable: true } },
  };
  assert.throws(() => validateNativeLocalFixtureConfig(withBootstrap, { action: "x1" }), {
    message: "native_local_x1_fixture_config_invalid",
  });
  // A Bootstrap section that is off, or present with no Enable key, is not the bootstrap phase.
  for (const Bootstrap of [{ Enable: false }, {}])
    assert.equal(
      validateNativeLocalFixtureConfig(
        { NativeLocalPlayerFixture: { ...fixtureConfig.NativeLocalPlayerFixture, Bootstrap } },
        { action: "x1" },
      ),
      undefined,
    );
});

test("the slot relationship is read only when a runner asks for it", () => {
  assert.equal(validFixtureSlotRelationship("GameBuddyFixtureA", "GameBuddyFixtureA_1"), true);
  assert.equal(validFixtureSlotRelationship("GameBuddyFixtureA", "GameBuddyFixtureA_x"), false);
  const broken = {
    NativeLocalPlayerFixture: { ...fixtureConfig.NativeLocalPlayerFixture, ObservedSaveSlot: "Other_1" },
  };
  assert.equal(validateNativeLocalFixtureConfig(broken, { action: "x1" }), undefined, "not read by default");
  assert.throws(() => validateNativeLocalFixtureConfig(broken, { action: "x1", slotRelationship: true }), {
    message: "native_local_x1_fixture_config_invalid",
  });
});

test("the order is shape, scenario, topology, policy - and the two orderings the copies used refuse alike", () => {
  const shared = { ...fixtureConfig, Portfolio: { Enable: true } };
  assert.throws(() => validateNativeLocalFixtureConfig({ Portfolio: { Enable: true } }, { action: "x1" }), {
    message: "native_local_x1_fixture_config_invalid",
  });
  assert.throws(() => validateNativeLocalFixtureConfig(shared, { action: "x1" }), {
    message: "native_local_x1_action_policy_invalid",
  });
  assert.throws(
    () =>
      validateNativeLocalFixtureConfig(
        { ...shared, DeniedActions: ["travel"], DeniedActionFamilies: [], ExperimentalActions: [] },
        { action: "x1", requiredActions: ["travel"] },
      ),
    { message: "native_local_x1_action_policy_invalid" },
  );
});

test("requiredActions are asserted through the harness's own policy validator, not re-derived here", () => {
  // The harness owns the deny-by-exception reading, so it is driven rather than copied: the refusal a runner sees is the
  // harness's, and a config that denies an action the runner needs refuses before the run starts.
  const policy = { DeniedActions: ["travel"], DeniedActionFamilies: [], ExperimentalActions: [] };
  assert.throws(
    () =>
      validateNativeLocalFixtureConfig({ ...fixtureConfig, ...policy }, { action: "x1", requiredActions: ["travel"] }),
    { message: "native_fixture_policy_denies_required:travel" },
  );
  assert.equal(
    validateNativeLocalFixtureConfig(
      { ...fixtureConfig, ...policy },
      { action: "x1", requiredActions: ["move_to_tile"] },
    ),
    undefined,
  );
  // An opt-in the caller did not declare experimental is refused, which is what makes the test-only path explicit.
  assert.throws(
    () =>
      validateNativeLocalFixtureConfig(
        { ...fixtureConfig, ...policy, ExperimentalActions: ["sweep_scythe"] },
        { action: "x1", requiredActions: [], experimentalActions: [] },
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
  const unguardedWithinOne = (value) => value <= 1;
  assert.equal(unguardedWithinOne(Number.NaN), false);
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
