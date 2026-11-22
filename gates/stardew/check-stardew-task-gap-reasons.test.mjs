import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import test from "node:test";

import { gapReasonReading, gapReasonVerdict, readGapReasonInputs } from "./check-stardew-task-gap-reasons.mjs";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

/**
 * The falsifier suite for `tools/check-stardew-task-gap-reasons.mjs`.
 *
 * The gate's population is every `gap(...)` entry in `tools/lib/task-purpose.mjs`, and its property is that the
 * blocker each entry cites is still true. Every case below hands the pure reader a population and a catalog the
 * repository does not have, because the defect the gate exists for - a reason that outlived its blocker - cannot be
 * re-created in the real tree without reverting the fix.
 *
 * red-proof: history  the real tree on 2026-11-16, before the correction: `gapReasonReading` over the shipped table
 *                     printed `gaps examined 10 · expired 1` and
 *                     `EXPIRED gap_reason_no_longer_holds:mine_ladder_to_depth:action_use_mine_ladder_lifecycle
 *                     (lifecycle=live_verified)`, exit 1 - the entry cited `FarmhandActionLifecycle.Experimental` for an
 *                     action the surface had promoted, and the line it cited had moved on to another declaration
 * red-proof: inject  an entry whose `absent_evidence_field` claim names a field the action's receipt carries, and one
 *                     whose `action_lifecycle` claim names a lifecycle the catalog does not declare -> both
 *                     `gap_reason_no_longer_holds:<task>:<claim>`, naming the task and the measured value
 *                     (tools/check-stardew-task-gap-reasons.test.mjs)
 */

const REPO = repositoryRoot(import.meta.url);
const GATE = fileURLToPath(new URL("./check-stardew-task-gap-reasons.mjs", import.meta.url));

/** The Mod's surface as the reader takes it: an action id, its lifecycle, and the postcondition it declares. */
const catalogueOf = (rows) =>
  new Map(
    Object.entries(rows).map(([actionId, [lifecycle, postcondition]]) => [
      actionId,
      { actionId, lifecycle, postcondition },
    ]),
  );

/** The Host's completion contract as the reader takes it, in the parser's own shape. */
const contractsOf = (rows) => new Map(Object.entries(rows).map(([actionId, keys]) => [actionId, { actionId, keys }]));

/** A gap entry that says what `tools/lib/task-purpose.mjs` says, with the claims under test. */
const gapEntry = (missingFact, { reason, claims }) => ({
  purpose: "a purpose the tree cannot decide",
  missingFact,
  reason,
  claims,
});

const proseReason = (refutableBy) => ({ kind: "prose", refutableBy });

const LONG_ENOUGH = "an artifact that would refute this, named so a reader can check it without a run";

test("an entry citing a lifecycle the catalog has moved past is expired, and the finding names the task and the action", () => {
  const report = gapReasonReading({
    criteria: {
      mine_ladder_to_depth: gapEntry("the exit half is `use_mine_ladder`, registered Experimental", {
        reason: "mechanical",
        claims: [{ kind: "action_lifecycle", actionId: "use_mine_ladder", lifecycle: "experimental" }],
      }),
    },
    catalogue: catalogueOf({ use_mine_ladder: ["live_verified", "mine_left"] }),
    contracts: contractsOf({}),
  });
  assert.equal(report.examined, 1);
  assert.equal(report.mechanical, 1);
  assert.deepEqual(
    report.expired.map((entry) => entry.code),
    ["gap_reason_no_longer_holds:mine_ladder_to_depth:action_use_mine_ladder_lifecycle"],
  );
  assert.match(report.expired[0].measured, /live_verified/, "the finding has to say what the catalog says instead");
});

test("the same entry is green while its cited lifecycle is the one the catalog declares", () => {
  // The inverse of the case above, so the guard is a comparison and not a constant: the SAME entry is clean against a
  // catalog that still registers the action Experimental.
  const report = gapReasonReading({
    criteria: {
      mine_ladder_to_depth: gapEntry("the exit half is `use_mine_ladder`, registered Experimental", {
        reason: "mechanical",
        claims: [{ kind: "action_lifecycle", actionId: "use_mine_ladder", lifecycle: "experimental" }],
      }),
    },
    catalogue: catalogueOf({ use_mine_ladder: ["experimental", "mine_left"] }),
    contracts: contractsOf({}),
  });
  assert.deepEqual(report.expired, []);
  assert.deepEqual(report.violations, []);
});

test("a receipt that gained the field its entry said it cannot carry is expired", () => {
  const report = gapReasonReading({
    criteria: {
      town_market: gapEntry("`shop_purchase` carries no `location`", {
        reason: "mechanical",
        claims: [{ kind: "absent_evidence_field", actionId: "shop_purchase", field: "location" }],
      }),
    },
    catalogue: catalogueOf({ shop_purchase: ["live_verified", "item_purchased"] }),
    contracts: contractsOf({ shop_purchase: ["location", "shop", "item"] }),
  });
  assert.deepEqual(
    report.expired.map((entry) => entry.code),
    ["gap_reason_no_longer_holds:town_market:receipt_for_shop_purchase_carries_no_location"],
  );
});

test("a field the entry says IS published, and is not, is expired too", () => {
  // The other direction matters as much: `town_visit` and `home_and_hearth` now rest on "this fact IS published", and
  // deleting the field from the producer refutes them just as hard as adding one refutes `town_market`.
  const report = gapReasonReading({
    criteria: {
      town_visit: gapEntry("`talk_to_npc` does publish `location`", {
        reason: "mechanical",
        claims: [{ kind: "present_evidence_field", actionId: "talk_to_npc", field: "location" }],
      }),
    },
    catalogue: catalogueOf({ talk_to_npc: ["live_verified", "npc_talked"] }),
    contracts: contractsOf({ talk_to_npc: ["target", "tile"] }),
  });
  assert.deepEqual(
    report.expired.map((entry) => entry.code),
    ["gap_reason_no_longer_holds:town_visit:receipt_for_talk_to_npc_carries_location"],
  );
});

test("an entry that says an action does not exist is expired the day the catalog declares it", () => {
  const report = gapReasonReading({
    criteria: {
      a_gap: gapEntry("there is no action that cleans a room", {
        reason: "mechanical",
        claims: [{ kind: "absent_action", actionId: "tidy_room" }],
      }),
    },
    catalogue: catalogueOf({ tidy_room: ["published", "room_tidied"] }),
    contracts: contractsOf({}),
  });
  assert.deepEqual(
    report.expired.map((entry) => entry.code),
    ["gap_reason_no_longer_holds:a_gap:action_tidy_room_absent_from_the_catalog"],
  );
});

test("an evidence contract whose keys could not be read is blocked, never green", () => {
  // `readHostCompletionContracts` returns an empty list for a contract written as `"key" in evidence` rather than an
  // array literal. Reading that as "carries no field" would pass every absent-field claim about such an action, so the
  // claim is refused by name and the run is blocked instead of counting the claim as still true.
  const report = gapReasonReading({
    criteria: {
      a_gap: gapEntry("`use_mine_ladder` carries no `location`", {
        reason: "mechanical",
        claims: [{ kind: "absent_evidence_field", actionId: "use_mine_ladder", field: "location" }],
      }),
    },
    catalogue: catalogueOf({ use_mine_ladder: ["live_verified", "mine_left"] }),
    contracts: contractsOf({ use_mine_ladder: [] }),
  });
  assert.deepEqual(report.expired, [], "an unmeasured claim must not be reported as expired");
  assert.equal(report.blocked.length, 1);
  assert.match(report.blocked[0].code, /^gap_reason_not_measured:a_gap:/);

  const absentContract = gapReasonReading({
    criteria: {
      a_gap: gapEntry("`no_such_action` carries no `location`", {
        reason: "mechanical",
        claims: [{ kind: "absent_evidence_field", actionId: "no_such_action", field: "location" }],
      }),
    },
    catalogue: catalogueOf({}),
    contracts: contractsOf({}),
  });
  assert.equal(absentContract.blocked.length, 1, "an action the Host has no contract for cannot be measured either");
});

test("a prose reason has to name the artifact that would refute it", () => {
  const report = gapReasonReading({
    criteria: {
      a_gap: gapEntry("no module declares which maps are Town", { reason: "prose", claims: [proseReason("none")] }),
    },
    catalogue: catalogueOf({}),
    contracts: contractsOf({}),
  });
  assert.deepEqual(
    report.violations.map((entry) => entry.code),
    ["gap_reason_prose_names_no_artifact:a_gap"],
  );
  assert.equal(report.prose, 1);
  assert.equal(report.claimsProse, 1);
});

test("an entry's declared reason class has to agree with the claims it carries, in both directions", () => {
  const declaresMechanicalWithProse = gapReasonReading({
    criteria: {
      a_gap: gapEntry("no module declares which maps are Town", {
        reason: "mechanical",
        claims: [proseReason(LONG_ENOUGH)],
      }),
    },
    catalogue: catalogueOf({}),
    contracts: contractsOf({}),
  });
  assert.deepEqual(
    declaresMechanicalWithProse.violations.map((entry) => entry.code),
    ["gap_reason_class_disagrees_with_its_claims:a_gap:mechanical:prose"],
  );

  const declaresProseWithNone = gapReasonReading({
    criteria: {
      a_gap: gapEntry("`cut_weeds` carries no `location`", {
        reason: "prose",
        claims: [{ kind: "absent_evidence_field", actionId: "cut_weeds", field: "location" }],
      }),
    },
    catalogue: catalogueOf({ cut_weeds: ["live_verified", "native_action_postcondition"] }),
    contracts: contractsOf({ cut_weeds: ["target", "tool"] }),
  });
  assert.deepEqual(
    declaresProseWithNone.violations.map((entry) => entry.code),
    ["gap_reason_class_disagrees_with_its_claims:a_gap:prose:mechanical"],
  );
});

test("an entry that declares no claim at all is a finding rather than a silently unchecked reason", () => {
  for (const claims of [undefined, []]) {
    const report = gapReasonReading({
      criteria: {
        a_gap: {
          purpose: "a purpose",
          missingFact: "no fact says anything about the farm at all",
          reason: "prose",
          claims,
        },
      },
      catalogue: catalogueOf({}),
      contracts: contractsOf({}),
    });
    assert.deepEqual(
      report.violations.map((entry) => entry.code),
      ["gap_reason_declares_no_claim:a_gap"],
      "a reason nothing checks is the defect this gate exists for",
    );
  }
});

test("a reason may not cite a source line, because the line is what outlived the blocker", () => {
  const report = gapReasonReading({
    criteria: {
      a_gap: gapEntry("`use_mine_ladder` is Experimental (FarmhandActionDefinitions.cs:270)", {
        reason: "prose",
        claims: [proseReason(LONG_ENOUGH)],
      }),
    },
    catalogue: catalogueOf({}),
    contracts: contractsOf({}),
  });
  assert.deepEqual(
    report.violations.map((entry) => entry.code),
    ["gap_reason_cites_a_line:a_gap"],
  );
});

test("a claim the reason never names is a finding: one fact, two spellings", () => {
  const report = gapReasonReading({
    criteria: {
      a_gap: gapEntry("some receipt has no map on it", {
        reason: "prose",
        claims: [
          proseReason(LONG_ENOUGH),
          { kind: "absent_evidence_field", actionId: "shop_purchase", field: "location" },
        ],
      }),
    },
    catalogue: catalogueOf({ shop_purchase: ["live_verified", "item_purchased"] }),
    contracts: contractsOf({ shop_purchase: ["shop", "item"] }),
  });
  assert.deepEqual(
    report.violations.map((entry) => entry.code),
    ["gap_reason_does_not_name_its_claim:a_gap:shop_purchase"],
    "a claim the sentence does not mention can neither be checked by a reader nor guarded by this gate",
  );
});

test("the three zeroes stay apart: empty population and unreadable contract are blocked, a finding is red", () => {
  const clean = gapReasonReading({
    criteria: {
      a_gap: gapEntry("`cut_weeds` carries no `location`", {
        reason: "mechanical",
        claims: [{ kind: "absent_evidence_field", actionId: "cut_weeds", field: "location" }],
      }),
    },
    catalogue: catalogueOf({ cut_weeds: ["live_verified", "native_action_postcondition"] }),
    contracts: contractsOf({ cut_weeds: ["target", "tool"] }),
  });
  assert.equal(gapReasonVerdict(clean).exitCode, 0, "a measured reading with nothing expired is the only green");

  const empty = gapReasonReading({ criteria: {}, catalogue: catalogueOf({}), contracts: contractsOf({}) });
  assert.equal(empty.examined, 0);
  assert.deepEqual(
    { exitCode: gapReasonVerdict(empty).exitCode, code: gapReasonVerdict(empty).code },
    { exitCode: 2, code: "gap_reason_population_empty" },
    "a gate over no gap agrees with itself, so zero population is blocked rather than passed",
  );

  const unreadable = gapReasonReading({
    criteria: {
      a_gap: gapEntry("`use_mine_ladder` carries no `location`", {
        reason: "mechanical",
        claims: [{ kind: "absent_evidence_field", actionId: "use_mine_ladder", field: "location" }],
      }),
    },
    catalogue: catalogueOf({ use_mine_ladder: ["live_verified", "mine_left"] }),
    contracts: contractsOf({ use_mine_ladder: [] }),
  });
  assert.equal(gapReasonVerdict(unreadable).exitCode, 2, "not measured is not a pass and is not an expiry either");

  const unclaimed = gapReasonReading({
    criteria: {
      a_gap: { purpose: "a purpose", missingFact: "no fact says anything about the farm at all", reason: "prose" },
    },
    catalogue: catalogueOf({}),
    contracts: contractsOf({}),
  });
  assert.equal(gapReasonVerdict(unclaimed).exitCode, 1, "a reason nothing checks is red, not blocked");
});

test("the real tree answers green, over a population that is not empty", () => {
  // Driven by the real artifacts - the generated surface and the Host completion contract - so this case fails if
  // either reader stops finding them. The counts are asserted as relations, not as today's numbers.
  const inputs = readGapReasonInputs();
  const report = gapReasonReading(inputs);
  assert.ok(report.examined > 0, "the rotation declares gaps, and a gate over none of them agrees with itself");
  assert.equal(report.examined, report.mechanical + report.prose, "every examined gap is classified exactly once");
  assert.ok(report.claimsChecked > 0, "the reasons quote receipt shapes, and those claims are what this gate reads");
  assert.deepEqual(report.expired, []);
  assert.deepEqual(report.blocked, []);
  assert.deepEqual(report.violations, []);
});

test("the gate's own command prints its population and exits 0 on the real tree", () => {
  const run = spawnSync(process.execPath, [GATE], { cwd: REPO, encoding: "utf8" });
  assert.equal(run.status, 0, `the gate is red on the tree it guards: ${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /gaps examined \d+ · mechanical \d+ · prose \d+ · expired 0/u);
  assert.match(run.stdout, /claims checked [1-9]\d*/u, "a claim count of zero would mean nothing was read");
  assert.equal(
    /EXPIRED|BLOCKED|VIOLATION/u.test(run.stdout),
    false,
    `the gate reported a finding while exiting 0: ${run.stdout}`,
  );
});
