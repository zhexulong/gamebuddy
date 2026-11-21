// The two chains, held against the kit that measures them.
//
// Every assertion here is about an agreement that has already broken once in this repository: a
// report that stopped at `r-card-export` while later drivers wrote into files nobody opened, a rung
// renamed to `cabin ready` that would otherwise have turned every fresh-world launch into 8/9, and a
// driver that reported `game_process_not_found` while the run's own attached game was alive. The
// failure each one shares: a vocabulary and the instrument that produces it drifted apart, and
// nothing named the drift.
//
// The population is derived from the authority: the roster in `phases/drivers.mjs` intersected with
// the field that roster already owns for the drivers that open a world (`requiresGame`), so a driver
// added tomorrow enters this gate by being declared as what it is, and an empty population is a
// failure rather than a pass.
//
// red-proof: inject  a third chain carrying a seat step -> `seats.map(id)` reads `+ 'weekly-cabin-seat'`, so the seat population reds by name
//   rather than by a count that a new member would leave satisfied.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DRIVERS } from "../phases/drivers.mjs";
import {
  auditChainAlignment,
  CHAIN_NAMES,
  CHAIN_STEPS,
  describeChainAlignment,
  ELSEWHERE_OWNERS,
  ELSEWHERE_PREFIX,
  driverForm,
  elsewhereSteps,
  measuredDrivers,
  namedGaps,
  STEP_KINDS,
  stepsOfChain,
} from "./chain-steps.mjs";

const require = createRequire(import.meta.url);
const turnAccount = require("../capture/turn-account.cjs");

const CAPTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "capture");

const readSource = (file) => {
  try {
    return readFileSync(join(CAPTURE, file), "utf8");
  } catch {
    return null;
  }
};

/** The capture modules that carry a chain verdict, discovered from the directory rather than listed. */
const CAPTURE_MODULES = Object.freeze(readdirSync(CAPTURE));

const audit = (over = {}) =>
  auditChainAlignment({
    entries: CHAIN_STEPS,
    drivers: DRIVERS,
    readSource,
    ...over,
  });

/** The verdicts a reading reported, one per line, so a failure prints what it found instead of a count. */
const describe = (problems) =>
  problems.map((problem) => `  ${problem.code}: ${problem.detail}`).join("\n") || "  (none)";

test("every chain step names a driver that exists, prints its fact, and the kit's own population is not empty", () => {
  assert.ok(CAPTURE_MODULES.length > 0, "the capture directory is empty");
  const reading = audit();
  assert.deepEqual(
    reading.problems,
    [],
    `the chain vocabulary and the kit disagree (examined ${String(reading.examined)} declaration(s) over ${String(reading.population.length)} chain driver(s): ${reading.population.join(", ")}):\n${describe(reading.problems)}`,
  );
  assert.notEqual(reading.examined, 0, "the vocabulary declares no step at all");
  assert.notEqual(reading.population.length, 0, "no roster driver declares requiresGame and can be read");
});

test("the alignment counts are the vocabulary's own, chain by chain", () => {
  const reading = audit();
  const lines = describeChainAlignment();
  assert.equal(
    lines[0],
    `CHAIN-ALIGNMENT examined ${String(CHAIN_STEPS.length)} declaration(s): ${String(reading.measured)} measured by a driver, ${String(reading.gaps)} named gap(s), ${String(reading.elsewhere)} owned elsewhere`,
  );
  for (const chain of CHAIN_NAMES) {
    const steps = stepsOfChain(chain);
    const where = (form) => steps.filter((entry) => driverForm(entry) === form).length;
    assert.ok(
      lines.includes(
        `CHAIN-ALIGNMENT ${chain}: ${String(steps.length)} declaration(s), ${String(where("measured"))} measured, ${String(where("gap"))} gap(s), ${String(where("elsewhere"))} elsewhere`,
      ),
      `${chain}'s count line is missing from the alignment block`,
    );
  }
  assert.equal(stepsOfChain("oobe").length + stepsOfChain("daily").length, CHAIN_STEPS.length);
  assert.deepEqual(
    namedGaps()
      .map((entry) => entry.gap)
      .filter((gap) => gap.length === 0),
    [],
    "a gap step names no reason",
  );
});

test("every declaration sits in exactly one of the three forms, and each population is printed", () => {
  // THE PRINTING IS THE GATE. `elsewhere:` exists so a fact another lane owns is not called a gap and not
  // called unmeasured - and a bucket that only ever grows is where a real gap goes to hide. So both buckets
  // print their members, the three counts have to add up to the vocabulary, and every owner is a known lane.
  const byForm = { measured: [], gap: [], elsewhere: [], unknown: [] };
  for (const entry of CHAIN_STEPS) byForm[driverForm(entry)].push(entry.id);
  assert.equal(
    byForm.measured.length + byForm.gap.length + byForm.elsewhere.length + byForm.unknown.length,
    CHAIN_STEPS.length,
    `the three forms have to account for every declaration: measured ${JSON.stringify(byForm.measured)}, gap ${JSON.stringify(byForm.gap)}, elsewhere ${JSON.stringify(byForm.elsewhere)}, unknown ${JSON.stringify(byForm.unknown)}`,
  );
  assert.deepEqual(byForm.unknown, [], "a driver value that is neither a roster driver, gap: nor elsewhere:");
  assert.ok(
    byForm.elsewhere.length > 0,
    "no step is owned elsewhere, so the third form has no member and nothing holds it",
  );
  const printed = describeChainAlignment().find((line) => line.startsWith("CHAIN-ALIGNMENT owned elsewhere:"));
  assert.ok(printed !== undefined, "the alignment block has to print the elsewhere population, not only its size");
  for (const member of byForm.elsewhere)
    assert.ok(printed.includes(member), `${member} is missing from the printed population`);
  // The gap bucket prints its population too, and an EMPTY bucket prints `none`: four reading gaps were closed
  // by `capture/run-records.cjs`, and a bucket that emptied silently would let the next real gap hide behind a
  // count nobody re-read.
  const printedGaps = describeChainAlignment().find((line) => line.startsWith("CHAIN-ALIGNMENT named gaps:"));
  assert.ok(printedGaps !== undefined, "the alignment block has to print the gap population, not only its size");
  for (const member of byForm.gap)
    assert.ok(printedGaps.includes(member), `${member} is missing from the printed gap population`);
  if (byForm.gap.length === 0)
    assert.equal(
      printedGaps,
      "CHAIN-ALIGNMENT named gaps: none",
      "an empty gap bucket has to read `none`, not an empty list",
    );
  for (const owned of elsewhereSteps()) {
    assert.ok(
      ELSEWHERE_OWNERS.includes(owned.owner),
      `${owned.id} is owned by ${JSON.stringify(owned.owner)}, which is not one of ${ELSEWHERE_OWNERS.join(", ")}`,
    );
    const entry = CHAIN_STEPS.find((candidate) => candidate.id === owned.id);
    assert.ok(
      typeof entry.reason === "string" && entry.reason.trim().length > 0,
      `${owned.id} steps out of this kit without a reason, so the next reader cannot tell a boundary from an oversight`,
    );
  }
});

test("the audit refuses an owner it does not know, a missing reason, and a driver value in no form at all", () => {
  // Injected violations rather than a manual red run: the bucket has to stay guarded by the suite.
  const play = CHAIN_STEPS.find((entry) => entry.id === "daily-play");
  const stranger = audit({
    entries: CHAIN_STEPS.map((entry) =>
      entry.id === "daily-play" ? Object.freeze({ ...entry, driver: `${ELSEWHERE_PREFIX}some-lane` }) : entry,
    ),
  });
  assert.ok(
    stranger.problems.some(
      (problem) => problem.code === "unknown_elsewhere_owner" && problem.detail.includes("some-lane"),
    ),
    `an owner outside the closed list must be refused by name:\n${describe(stranger.problems)}`,
  );
  const silent = audit({
    entries: CHAIN_STEPS.map((entry) => (entry.id === "daily-play" ? Object.freeze({ ...entry, reason: "" }) : entry)),
  });
  assert.ok(
    silent.problems.some((problem) => problem.code === "elsewhere_without_reason" && problem.detail.includes(play.id)),
    `stepping out without a reason must be refused by name:\n${describe(silent.problems)}`,
  );
  const formless = audit({
    entries: CHAIN_STEPS.map((entry) =>
      entry.id === "daily-play" ? Object.freeze({ ...entry, driver: "  " }) : entry,
    ),
  });
  assert.ok(
    formless.problems.some((problem) => problem.code === "unknown_driver_form" && problem.detail.includes(play.id)),
    `a driver value in none of the three forms must be refused by name:\n${describe(formless.problems)}`,
  );
});

test("every driver the vocabulary measures opens a world, and every world-opening driver is in the vocabulary", () => {
  const reading = audit();
  assert.deepEqual(
    [...reading.population].sort(),
    [...measuredDrivers()],
    "the drivers the vocabulary calls measured and the drivers the roster says open a world are not the same set: a step claims a reading, or a driver opens a world, that the other side does not know about",
  );
});

test("a driver that opens a world and names no step is refused, by name", () => {
  const ghost = { key: "aa-ghost", file: "aa-ghost.cjs", out: "aa-ghost.txt", requiresGame: true };
  const reading = audit({
    drivers: [...DRIVERS, ghost],
    readSource: (file) => (file === ghost.file ? readSource("w-game-launch.cjs") : readSource(file)),
  });
  assert.ok(
    reading.problems.some((problem) => problem.code === "driver_without_step" && problem.detail.includes("aa-ghost")),
    `a world-opening driver with no step must be refused and named:\n${describe(reading.problems)}`,
  );
});

test("deleting a step names the driver that lost its home", () => {
  const withoutDeath = CHAIN_STEPS.filter((entry) => entry.id !== "daily-game-dies");
  const reading = audit({ entries: withoutDeath });
  assert.ok(
    reading.problems.some(
      (problem) => problem.code === "driver_without_step" && problem.detail.includes("x-game-death"),
    ),
    `removing daily-game-dies must name x-game-death as the driver left with no step:\n${describe(reading.problems)}`,
  );
});

test("a step that names a driver the roster lost is refused, with both names", () => {
  const reading = audit({ drivers: DRIVERS.filter((driver) => driver.key !== "w-game-launch") });
  assert.ok(
    reading.problems.some(
      (problem) =>
        problem.code === "step_driver_not_in_roster" &&
        problem.detail.includes("w-game-launch") &&
        problem.detail.includes("oobe-cabin-seat"),
    ),
    `a step whose driver left the roster must name the step and the driver:\n${describe(reading.problems)}`,
  );
});

test("a step whose fact no driver prints is refused", () => {
  const renamed = CHAIN_STEPS.map((entry) =>
    entry.id === "oobe-attach" ? Object.freeze({ ...entry, fact: "attachment=attached-to-nothing" }) : entry,
  );
  const reading = audit({ entries: renamed });
  assert.ok(
    reading.problems.some((problem) => problem.code === "step_fact_absent" && problem.detail.includes("oobe-attach")),
    `a fact no driver prints must be refused:\n${describe(reading.problems)}`,
  );
});

test("an empty population is blocked and named, never green", () => {
  const reading = audit({ drivers: [] });
  assert.ok(reading.problems.some((problem) => problem.code === "empty_roster"));
  const nobodyOpensAGame = audit({ drivers: DRIVERS.map((driver) => ({ ...driver, requiresGame: false })) });
  assert.ok(
    nobodyOpensAGame.problems.some(
      (problem) => problem.code === "empty_population" && problem.detail.includes("declares requiresGame"),
    ),
    `a kit that cannot answer which driver opens a world must say so:\n${describe(nobodyOpensAGame.problems)}`,
  );
});

test("a duplicated step id and an unknown kind are refused", () => {
  const doubled = [...CHAIN_STEPS, CHAIN_STEPS[0]];
  const reading = audit({ entries: doubled });
  assert.ok(reading.problems.some((problem) => problem.code === "duplicate_step_id"));
  const oddKind = CHAIN_STEPS.map((entry) =>
    entry.id === "daily-stop" ? Object.freeze({ ...entry, kind: "epilogue" }) : entry,
  );
  const other = audit({ entries: oddKind });
  assert.ok(
    other.problems.some((problem) => problem.code === "unknown_kind" && problem.detail.includes("daily-stop")),
    `a kind outside ${STEP_KINDS.join("/")} must be refused:\n${describe(other.problems)}`,
  );
});

test("a cabin-seat step names the rung the driver records, not one of the two branches it accepts", () => {
  // `capture/w-game-launch.cjs` records ONE rung (`cabin ready`) for two different worlds: the engine
  // releasing its unclaimed native Farmhand slot, or the Mod building a cabin on a free pad
  // (`CHAIN_LOG_PATTERNS`). The declaration first named the released-slot sentence for the OOBE step, which
  // reads a run on a built-cabin world - `frontend--r23` measured that sentence's sibling - as a step that
  // never happened. One rung, one fact, both chains.
  const seats = CHAIN_STEPS.filter((entry) => entry.id === "oobe-cabin-seat" || entry.id === "daily-cabin-seat");
  assert.deepEqual(
    seats.map((entry) => entry.id),
    ["oobe-cabin-seat", "daily-cabin-seat"],
    "both chains have a seat step, and both are held here",
  );
  for (const entry of seats)
    assert.equal(
      entry.fact,
      "cabin ready",
      `${entry.id} must name the rung the driver records: a branch sentence reports the other branch's seat as unmeasured`,
    );
});

test("daily-play names the account member the turn reader reads, and names the lane that owns it", () => {
  // TWO FAILURES THIS HOLDS APART. A fact spelled by hand is a second spelling of the producer's vocabulary -
  // the step would keep reading as declared after `capture/turn-account.cjs` stopped printing or parsing that
  // member. And this step must not be declared as something this kit produces: the words enter through the
  // engine's own chat box, and the lane that speaks through that admission is the game lane.
  const play = CHAIN_STEPS.filter((entry) => entry.id === "daily-play");
  assert.equal(play.length, 1, "the daily chain has exactly one step for the player speaking to her");
  const [entry] = play;
  assert.equal(
    entry.driver,
    `${ELSEWHERE_PREFIX}game-lane`,
    `${entry.id} names \`${entry.driver}\`: sending a message inside the game is not the frontend's job, and a \`gap:\` here would read as work this kit owes`,
  );
  assert.ok(
    !elsewhereSteps().some((owned) => owned.id === "daily-play-in-engine-chat") &&
      CHAIN_STEPS.every((candidate) => candidate.id !== "daily-play-in-engine-chat"),
    "the engine seam is part of the same step, not a second one: one rung, one owner, one fact",
  );
  assert.match(
    entry.owner,
    /run-stardew-native-local-agent-ab-live\.mjs/u,
    `${entry.id}'s owner has to name the lane that speaks through the admission (the game lane's A/B run), not a module the frontend drives`,
  );
  assert.equal(
    entry.fact,
    `${turnAccount.TURN_ACCOUNT_FACT} ${turnAccount.PLAYER_INPUT}`,
    `${entry.id}'s fact must be the account member \`capture/turn-account.cjs\` reads (${turnAccount.TURN_ACCOUNT_FACT} + ${turnAccount.PLAYER_INPUT}), not a sentence about her trace`,
  );
});
