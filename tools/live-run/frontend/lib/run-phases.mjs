// THE PHASES A RUN HAS, WHAT A RED IN EACH ONE ENDS, AND THE READINGS A ROUND KEEPS.
//
// ROUND33D measured the defect this module exists for (`.tmp/lane-round33d.md` §5.3, §7): the shared capture came
// back `DONE-CAPTURE failed=1 of 23` (driver `w-game-launch`), the runner threw on that one phase code, and the
// three world invocations the round had already scheduled - `x-game-death`, `y-game-endgame`, `z-game-disconnect`,
// each with its own `cleanup` + `launch` + `capture` from `lib/world-invocations.mjs` - were never attempted. The
// round produced one reading out of four and its log said nothing about the three it owed.
//
// THE RULE: A RED PHASE NAMES ITS SCOPE, AND ONLY A ROUND-SCOPED RED ENDS THE ROUND.
//
//   round       `check`, `pin`, `build`. They produce the worktree and the artifact EVERY invocation launches
//               from, so a red here leaves nothing to mount. The round still runs to its own end: every scheduled
//               invocation is printed as NOT ATTEMPTED with that phase's name as its reason.
//   invocation  `launch`, `capture`, `cleanup`, `report`. They act on ONE mounted Host, or on the round's own
//               close, so a red here ends that invocation's reading and nothing else. The next world invocation is
//               a fresh mount of its own, and its reading belongs to nobody but itself.
//
// WHY NOTHING IS SKIPPED TO MAKE THE ROUND GREEN. `DONE-CAPTURE failed=1 of 23` is a fact about the shared
// invocation, not a debt the world invocations can pay: the round's exit code is the worst phase code it saw, and
// the summary quotes each invocation's own `DONE-CAPTURE` line beside the readings that followed it. A summary
// that only counted invocations would read `3 of 4 green` over a round whose one red driver is still red.
//
// THE QUIET GATE WINS OVER CONTINUING. `phases/launch.mjs` refuses a machine that already holds a game
// (`lib/machine-quiet.mjs`), and no round policy may overrule it: an invocation whose launch was refused does not
// attempt its capture (there is no mounted Host to read), it is named with the launch's own refusal, and the next
// invocation asks the gate again - which is the gate's answer for THAT mount, never a memory of the last one.
//
// THE DEPENDENCY A WORLD INVOCATION BORROWS. A state driver cannot bring up the world it ends or occupies: the
// cabin handoff in the launch-chain driver is the only path from a launched Player Host to an attachment
// (`lib/world-invocations.mjs`, measured 2026-11-22 lane YZOWN). So every world invocation BORROWS that chain
// driver, and a red borrow on its mount means the world's own driver never reaches its precondition - which the
// summary says in those words next to the driver's own name, instead of leaving a bare `not-measured`.

import { MACHINE_NOT_QUIET, MACHINE_NOT_QUIET_UNREADABLE } from "./machine-quiet.mjs";

/**
 * The phases a run has, in run order.
 *
 * One list, imported by the entry (`run.mjs`) for its own argv validation: a second copy is how a phase ends up
 * accepted by one half of the run and unscheduled by the other.
 */
export const PHASES = Object.freeze(["check", "pin", "build", "launch", "capture", "cleanup", "report"]);

/** The two scopes a red can have: the whole round, or only the invocation it happened in. */
export const RED_SCOPE_ROUND = "round";
export const RED_SCOPE_INVOCATION = "invocation";

/** Which scope each phase's red has, spelled once. `redScope` refuses a phase that is missing from here. */
const RED_SCOPE_OF_PHASE = Object.freeze({
  check: RED_SCOPE_ROUND,
  pin: RED_SCOPE_ROUND,
  build: RED_SCOPE_ROUND,
  launch: RED_SCOPE_INVOCATION,
  capture: RED_SCOPE_INVOCATION,
  cleanup: RED_SCOPE_INVOCATION,
  report: RED_SCOPE_INVOCATION,
});

/** Why a scheduled invocation never produced a reading, as a code the summary can carry. */
export const SKIP_LAUNCH_NOT_MOUNTED = "launch_not_mounted";
export const SKIP_ROUND_PREREQUISITE_RED = "round_prerequisite_red";

/** A refusal code's own line, when the launch phase named one (`machine_not_quiet`, `cdp_port_held_by_pid`, …). */
const QUIET_REFUSALS = Object.freeze([MACHINE_NOT_QUIET, MACHINE_NOT_QUIET_UNREADABLE]);

/** The scope of a red in `phase`, or a refusal - an unscheduled phase is not silently invocation-scoped. */
export function redScope(phase) {
  if (!PHASES.includes(phase))
    throw new Error(
      `round_phase_unknown:${String(phase)} - a red phase must name its scope, and the run's phases are ${PHASES.join(", ")}`,
    );
  return RED_SCOPE_OF_PHASE[phase];
}

/**
 * The round's schedule, derived from the split `lib/world-invocations.mjs` took from the roster.
 *
 * The prerequisites are the three round-scoped phases; the shared invocation is the one mount every driver that
 * owns no world runs on; each world invocation is its own `cleanup` + `launch` + `capture` with `--force`, because
 * its drivers re-run the launch chain on a mount of its own (`run.mjs` paid for them by hand before this module).
 * The close is the round's own stop: one `cleanup` and the `report` that assembles the deliverable.
 */
export function roundSchedule({ shared, invocations, bringers }) {
  const rows = Array.isArray(invocations) ? invocations : [];
  const chain = Array.isArray(bringers) ? bringers : [];
  return Object.freeze({
    prerequisites: Object.freeze(PHASES.filter((phase) => redScope(phase) === RED_SCOPE_ROUND)),
    shared:
      shared === null || shared === undefined || shared.length === 0
        ? null
        : Object.freeze({
            kind: "shared",
            label: "shared",
            drivers: Object.freeze([...shared]),
            borrowed: Object.freeze([]),
            phases: Object.freeze(["launch", "capture"]),
            // `null`, not `false`: the shared invocation keeps whatever `--force` the operator passed.
            force: null,
          }),
    worlds: Object.freeze(
      rows.map((invocation) =>
        Object.freeze({
          kind: "world",
          label: invocation.driver,
          drivers: Object.freeze([...invocation.drivers]),
          borrowed: Object.freeze(chain.filter((key) => invocation.drivers.includes(key))),
          phases: Object.freeze(["cleanup", "launch", "capture"]),
          force: true,
        }),
      ),
    ),
    close: Object.freeze({
      kind: "close",
      label: "close",
      drivers: null,
      borrowed: Object.freeze([]),
      phases: Object.freeze(["cleanup", "report"]),
      force: null,
    }),
  });
}

// ------------------------------------------------------------------------------------------------ capture totals

const DONE_CAPTURE = /^DONE-CAPTURE failed=(\d+) of (\d+) /u;
const FAILED_DRIVERS = /failed-drivers=\[([^\]]*)\]/u;
const NOT_MEASURED_DRIVERS = /not-measured-drivers=\[([^\]]*)\]/u;

const bracketed = (line, pattern) => {
  const match = pattern.exec(line);
  if (match === null || match[1].trim().length === 0) return [];
  return match[1]
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

/**
 * Every `DONE-CAPTURE` line in a capture log, oldest first, parsed into the facts a round summary needs.
 *
 * The caller reads the log BEFORE a capture invocation and again after it and takes the entry the invocation
 * appended, so an append-only log spanning several invocations (and several runs of the same `--out`) never
 * lends one invocation another one's totals. Entries are `key:reason`, which the capture phase writes from the
 * driver's own verdict (`capture/game-states-verdict.mjs`, `capture/game-launch-verdict.mjs`).
 */
export function captureTotals(text) {
  const readings = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    const head = DONE_CAPTURE.exec(line);
    if (head === null) continue;
    readings.push(
      Object.freeze({
        line,
        failed: Number(head[1]),
        of: Number(head[2]),
        failedDrivers: Object.freeze(bracketed(line, FAILED_DRIVERS)),
        notMeasured: Object.freeze(
          bracketed(line, NOT_MEASURED_DRIVERS).map((entry) => {
            const colon = entry.indexOf(":");
            return colon < 0
              ? Object.freeze({ key: entry, reason: "unnamed" })
              : Object.freeze({ key: entry.slice(0, colon), reason: entry.slice(colon + 1) });
          }),
        ),
      }),
    );
  }
  return readings;
}

// ---------------------------------------------------------------------------------------------------- the round

/**
 * Run the schedule one phase at a time and keep every reading, whichever way each phase ends.
 *
 * `runPhase(phase, options)` returns `{ code, refusal, failure, totals }` and prints the phase's own banner and
 * output; it never throws for a red phase, because the scope rule above is what decides whether a red continues.
 *
 * The returned round carries the readings in schedule order - `phases` (each with its exit code and its own
 * refusal), `skipped` (a phase this invocation did not attempt, with its reason code) - plus the red phases by
 * name and the round's exit code.
 */
export async function runRound({ schedule, runPhase, log = () => {} }) {
  const prerequisites = [];
  const invocations = [];
  const reds = [];
  let ended = null;

  const attempt = async (entry) => {
    const phases = [];
    const skipped = [];
    for (const phase of entry.phases) {
      const blocker = skipBefore({ phase, phases });
      if (blocker !== null) {
        skipped.push(Object.freeze({ phase, reason: blocker.reason }));
        log(`ROUND: ${entry.label} does not run ${phase} - ${blocker.reason}: ${blocker.detail}`);
        continue;
      }
      const reading = Object.freeze({
        phase,
        ...(await runPhase(phase, readingOptions(entry))),
      });
      phases.push(reading);
      if (reading.code === 0) continue;
      reds.push(Object.freeze({ label: entry.label, phase, code: reading.code }));
      log(describeRed({ label: entry.label, reading }));
    }
    return Object.freeze({
      kind: entry.kind,
      label: entry.label,
      drivers: entry.drivers,
      borrowed: entry.borrowed,
      phases: Object.freeze(phases),
      skipped: Object.freeze(skipped),
    });
  };

  for (const phase of schedule.prerequisites) {
    const reading = Object.freeze({ phase, ...(await runPhase(phase, {})) });
    prerequisites.push(reading);
    if (reading.code === 0) continue;
    ended = Object.freeze({ phase, code: reading.code });
    reds.push(Object.freeze({ label: "round", phase, code: reading.code }));
    log(describeRed({ label: "round", reading }));
    log(
      `ROUND: every invocation below is named not attempted - a red in ${schedule.prerequisites.join("/")} ends the round, because no invocation has a worktree or an artifact to mount`,
    );
    break;
  }

  if (ended === null) {
    if (schedule.shared !== null) invocations.push(await attempt(schedule.shared));
    for (const world of schedule.worlds) {
      log(describeMount(world));
      log(describeBorrow(world));
      invocations.push(await attempt(world));
    }
    invocations.push(await attempt(schedule.close));
  } else {
    // The round ended at a round-scoped red, so every scheduled mount is a reading of its own: NOT ATTEMPTED, with
    // the phase that ended the round as its reason. A silent absence is how the three world invocations went
    // unmeasured in ROUND33D (`.tmp/lane-round33d.md` §7: "not measured, and not attempted").
    for (const entry of [schedule.shared, ...schedule.worlds].filter((mount) => mount !== null))
      invocations.push(
        Object.freeze({
          kind: entry.kind,
          label: entry.label,
          drivers: entry.drivers,
          borrowed: entry.borrowed,
          phases: Object.freeze([]),
          skipped: Object.freeze([]),
          untried: `${SKIP_ROUND_PREREQUISITE_RED}:${ended.phase}`,
        }),
      );
  }

  return Object.freeze({
    schedule,
    prerequisites: Object.freeze(prerequisites),
    invocations: Object.freeze(invocations),
    reds: Object.freeze(reds),
    ended,
    // The worst code the round saw, never a code chosen to describe the round: a red phase's own exit code is the
    // one an operator has already been reading in that phase's log.
    code: reds.reduce((worst, red) => Math.max(worst, red.code), 0),
  });
}

/** The refusal a phase named, or `null`: a phase that names none is never printed as `[undefined]`. */
const refusalOf = (reading) =>
  typeof reading?.refusal === "string" && reading.refusal.length > 0 ? reading.refusal : null;

/** What a phase of this invocation is told: its own `--driver=` set, and `--force` only where the schedule says. */
function readingOptions(entry) {
  if (entry.drivers === null) return {};
  return entry.force === true ? { drivers: entry.drivers, force: true } : { drivers: entry.drivers };
}

/**
 * Why a phase cannot be attempted in THIS invocation: `{ reason, detail }`, or `null`.
 *
 * One dependency, and it is the invocation's own: `capture` reads a mounted Host, so a red `launch` in the same
 * invocation leaves it nothing to read. `cleanup` and `report` are not gated on anything here - a cleanup that
 * left a port held is refused by name at the next `launch`, which is that invocation's own reading.
 */
function skipBefore({ phase, phases }) {
  if (phase !== "capture") return null;
  const launch = phases.find((reading) => reading.phase === "launch");
  if (launch === undefined || launch.code === 0) return null;
  const refusal = refusalOf(launch);
  const exit = refusal === null ? `exit ${launch.code}` : `exit ${launch.code} ${refusal}`;
  const gate = QUIET_REFUSALS.includes(refusal)
    ? " - the machine-quiet gate is not overruled by this round (`lib/machine-quiet.mjs`): no game is launched on a machine it has refused"
    : "";
  return Object.freeze({
    reason: SKIP_LAUNCH_NOT_MOUNTED,
    detail: `its own launch did not mount a Host (launch ${exit}), and a capture with no mounted Host has nothing to read${gate}`,
  });
}

/** The one line a red phase prints as it happens, with the scope it ends and the refusal it named. */
function describeRed({ label, reading }) {
  const what = reading.totals?.line ?? reading.failure ?? `exit ${reading.code}`;
  const refusal = refusalOf(reading);
  const named = refusal === null ? what : `${what} [${refusal}]`;
  const ends =
    redScope(reading.phase) === RED_SCOPE_ROUND
      ? "ends the round"
      : "ends this invocation's reading only - the invocations after it are mounts of their own";
  return `ROUND: ${label} ${reading.phase} is red - ${named} - a red in ${reading.phase} ${ends}`;
}

/** Today's mount sentence, kept verbatim: it names the phases and the exact `--driver=` set this mount pays for. */
function describeMount(entry) {
  return `WORLDS: ${entry.label} gets a mounted Host of its own: ${entry.phases.join(", ")} --driver=${entry.drivers.join(",")}`;
}

/** Which roster driver an invocation borrowed, and what a red borrow means for the driver that borrowed it. */
function describeBorrow(entry) {
  const chain = entry.borrowed.join("+");
  return `WORLDS: ${entry.label} borrows ${chain} to bring its world to attachment=attached (the cabin handoff is the only path from a launched Player Host to an attachment); if ${chain} is red on this mount, ${entry.label} never reaches its precondition and what it reports is that fact, not a product verdict`;
}

// -------------------------------------------------------------------------------------------------- the summary

const scheduledCount = (schedule) => (schedule.shared === null ? 0 : 1) + schedule.worlds.length;

const labelOf = (entry) =>
  entry.drivers === null || entry.label === "shared" ? entry.label : `${entry.label}[${entry.drivers.join(",")}]`;

const entryCapture = (entry) => entry.phases.find((reading) => reading.phase === "capture") ?? null;

/** One line per invocation: what it ran, what it did not, and its own capture totals when it printed any. */
function describeInvocation(entry) {
  if (entry.untried !== undefined)
    return `ROUND: ${labelOf(entry)} not attempted: ${entry.untried} - the round ended before this invocation could mount anything`;
  const ran = entry.phases.map((reading) => `${reading.phase}=${reading.code}`);
  const skipped = entry.skipped.map((skip) => `${skip.phase}=not-attempted(${skip.reason})`);
  const outcome = entry.phases.length === 0 ? "not attempted" : "attempted";
  const red = entry.phases.find((reading) => reading.code !== 0) ?? null;
  const quote =
    red === null
      ? (entryCapture(entry)?.totals ?? null)
      : (red.totals ?? (typeof red.failure === "string" ? { line: red.failure } : null));
  return `ROUND: ${labelOf(entry)} ${outcome}: ${[...ran, ...skipped].join(" ")}${quote === null ? "" : ` -- ${quote.line}`}`;
}

/**
 * The world drivers that measured nothing because the driver their mount borrowed was red.
 *
 * Only rows the invocation's OWN totals support: the borrowed driver is in `failed-drivers`, and the owner is in
 * `not-measured-drivers`. A mount whose capture never ran has no totals to make that claim from, and a world driver
 * that measured its state on a mount whose borrowed chain went red elsewhere is not claimed either.
 */
function borrowedRedRows(invocations) {
  const rows = [];
  for (const entry of invocations) {
    if (entry.borrowed.length === 0) continue;
    const capture = entryCapture(entry);
    const totals = capture?.totals ?? null;
    if (totals === null) continue;
    const redBorrow = entry.borrowed.filter((key) => totals.failedDrivers.includes(key));
    if (redBorrow.length === 0) continue;
    const own = totals.notMeasured.find((row) => row.key === entry.label) ?? null;
    if (own === null) continue;
    rows.push({ entry, redBorrow, own });
  }
  return rows;
}

/**
 * The round's summary: the scheduled population, a reading per invocation, the borrowed prerequisites that went
 * red, and the exit code with the phases that produced it.
 *
 * Printed before `DONE-FULL-RUN` on every round, green or red, so the two are compared line for line instead of a
 * red round being told apart by the absence of a line.
 */
export function describeRound(round) {
  const { schedule, invocations, reds } = round;
  const scheduled = scheduledCount(schedule);
  // The close is the round's own stop (`cleanup` + `report`), not a mount: it gets its own line, and it is not
  // counted as an invocation that could be "attempted" or skipped.
  const mounts = invocations.filter((entry) => entry.kind !== "close");
  const attempted = mounts.filter((entry) => entry.phases.length > 0);
  const untried = mounts.filter((entry) => entry.phases.length === 0);
  const names = [...(schedule.shared === null ? [] : ["shared"]), ...schedule.worlds.map((world) => world.label)];
  const lines = [
    `ROUND: ${scheduled} invocation(s) scheduled (${schedule.shared === null ? "no" : "1"} shared + ${schedule.worlds.length} world: ${names.join(", ")}), ${attempted.length} attempted, ${untried.length} not attempted`,
  ];
  if (untried.length > 0)
    lines.push(
      `ROUND: ${untried.length} of those invocation(s) are not attempted (${SKIP_ROUND_PREREQUISITE_RED}:${round.ended?.phase ?? "unknown"}): ${untried.map((entry) => labelOf(entry)).join(", ")}`,
    );
  for (const entry of invocations) lines.push(describeInvocation(entry));
  const starved = borrowedRedRows(invocations);
  for (const { entry, redBorrow, own } of starved)
    lines.push(
      `ROUND: ${entry.label}'s borrowed prerequisite ${redBorrow.join("+")} was red on its mount, so ${entry.label} could not reach its precondition - its own reading is not-measured:${own.reason}`,
    );
  if (starved.length > 0)
    lines.push(
      `ROUND: ${starved.length} world-owning driver(s) measured nothing because their borrowed prerequisite was red on their mount: ${starved.map(({ entry }) => entry.label).join(", ")} - not a silent count, and not a product verdict`,
    );
  if (reds.length === 0) lines.push("ROUND: no phase is red, and the round exits 0");
  else
    lines.push(
      `ROUND: ${reds.length} red phase(s): ${reds.map((red) => `${red.label}/${red.phase}=${red.code}`).join(" ")} - the round exits ${round.code}; every scheduled invocation produced its own reading or its own named skip, and none was dropped to make the round green`,
    );
  return lines;
}
