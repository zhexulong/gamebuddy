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
  GAP_PREFIX,
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

test("daily-play names the account member the turn reader reads, and says it has no driver", () => {
  // TWO FAILURES THIS HOLDS APART. A fact spelled by hand is a second spelling of the producer's vocabulary -
  // the step would keep reading as declared after `capture/turn-account.cjs` stopped printing or parsing that
  // member. And a `driver:` here would claim a reading no driver in this kit can produce: every capture driver
  // types into a browser, and the only producer of a `player_input` turn needs a keystroke in the game window.
  const play = CHAIN_STEPS.filter((entry) => entry.id === "daily-play");
  assert.equal(play.length, 1, "the daily chain has exactly one step for the player speaking to her");
  const [entry] = play;
  assert.ok(
    entry.driver.startsWith(GAP_PREFIX),
    `${entry.id} names the driver "${entry.driver}": no driver in this kit puts keystrokes into the player host's window, so a driver here claims a reading nobody produces`,
  );
  assert.equal(
    entry.fact,
    `${turnAccount.TURN_ACCOUNT_FACT} ${turnAccount.PLAYER_INPUT}`,
    `${entry.id}'s fact must be the account member \`capture/turn-account.cjs\` reads (${turnAccount.TURN_ACCOUNT_FACT} + ${turnAccount.PLAYER_INPUT}), not a sentence about her trace`,
  );
});

test("the player speaking to her has two rungs, and each names its own missing thing", () => {
  // The interaction is declared twice because its two halves fail independently: the ADMISSION (the Host
  // producing a `player_input` turn at all) and the ENGINE SEAM (a keystroke in the game's own chat box).
  // Collapsing them into one `gap:` reason is how the difference between "nothing listens on either route this
  // stage can speak to" and "OS input injection was removed on purpose" disappears from the map - and a reader
  // who has only the second sentence goes looking for a driver to write instead of a boundary to reopen.
  const [admission, engineChat] = ["daily-play", "daily-play-in-engine-chat"].map((id) =>
    CHAIN_STEPS.filter((entry) => entry.id === id),
  );
  assert.equal(admission.length, 1, "rung 1: the words admitted while attached is one step");
  assert.equal(engineChat.length, 1, "rung 2: the words typed through the engine's own chat box is its own step");
  const [rung1] = admission;
  const [rung2] = engineChat;
  assert.ok(
    rung1.driver.startsWith(GAP_PREFIX) && rung2.driver.startsWith(GAP_PREFIX),
    "both rungs are gaps: no driver in this kit produces either reading",
  );
  assert.notEqual(
    rung1.driver,
    rung2.driver,
    "one reason cannot name both: rung 1 has no route this stage can drive, rung 2 has an OS-input boundary in the way",
  );
  assert.equal(
    rung2.driver,
    `${GAP_PREFIX}no_os_input_injection`,
    "rung 2's missing capability is the one `tools/README.md` removed by name: window focus and OS input injection",
  );
  assert.match(
    rung2.fact,
    /textBoxEnter/u,
    `${rung2.id}'s fact has to name the engine seam it would be read from (\`ChatBox.textBoxEnter\`), not her trace`,
  );
  assert.match(
    rung1.owner,
    /acceptPlayerInput/u,
    `${rung1.id}'s owner is the admission: the seam that mints the \`player_input\` turn and refuses it by name`,
  );
});
