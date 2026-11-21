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
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DRIVERS } from "../phases/drivers.mjs";
import {
  auditChainAlignment,
  CHAIN_NAMES,
  CHAIN_STEPS,
  describeChainAlignment,
  measuredDrivers,
  namedGaps,
  STEP_KINDS,
  stepsOfChain,
} from "./chain-steps.mjs";

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
    `CHAIN-ALIGNMENT examined ${String(CHAIN_STEPS.length)} declaration(s): ${String(reading.measured)} measured by a driver, ${String(reading.gaps)} named gap(s)`,
  );
  for (const chain of CHAIN_NAMES) {
    const steps = stepsOfChain(chain);
    const gaps = steps.filter((entry) => entry.driver.startsWith("gap:")).length;
    assert.ok(
      lines.includes(
        `CHAIN-ALIGNMENT ${chain}: ${String(steps.length)} declaration(s), ${String(steps.length - gaps)} measured, ${String(gaps)} gap(s)`,
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
  assert.equal(seats.length, 2, "both chains have a seat step, and both are held here");
  for (const entry of seats)
    assert.equal(
      entry.fact,
      "cabin ready",
      `${entry.id} must name the rung the driver records: a branch sentence reports the other branch's seat as unmeasured`,
    );
});
