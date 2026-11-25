/*
 * A RED PHASE NAMES ITS SCOPE, AND A ROUND KEEPS EVERY READING IT CAN AFFORD.
 *
 * What these assertions protect (measured 2026-11-25/26, `.tmp/lane-round33d.md` §5.3, §7): the shared capture came
 * back `DONE-CAPTURE failed=1 of 23` on driver `w-game-launch`, the round's runner threw on that one phase code, and
 * the three world invocations it had already scheduled - `x-game-death`, `y-game-endgame`, `z-game-disconnect`, each
 * with a `cleanup` + `launch` + `capture` of its own - were never attempted. One reading out of four, and the log
 * never named the three it owed.
 *
 * The population is the ROSTER (`phases/drivers.mjs` through `lib/world-invocations.mjs`), imported rather than
 * copied, so a state driver added tomorrow is covered here without editing this file. The phase codes are the
 * fixture: a phase exit is what `run.mjs` reads from a real phase, and the instrument under test is what the round
 * DOES with it - never "can a game launch".
 *
 * red-proof: inject  the old contract (a red phase ending the round - `if (reds.length > 0) break;` at the top of the
 *                   world loop): "a red shared capture still attempts the three world invocations…" fails on
 *                   `x-game-death was never attempted in \`cleanup\`: the round stopped at the first red, which is
 *                   the defect (ROUND33D: one reading out of four)`, exit 1 (measured 2026-11-27).
 * red-proof: inject  the round's exit code taken from nothing (`code: 0`): "…never turns a red shared capture into
 *                   failed=0…" fails on `ROUND: 1 red phase(s): shared/capture=3 - the round exits 0`, exit 1.
 * red-proof: inject  `skipBefore` returning `null` for every phase (a capture attempted on a Host that never
 *                   mounted): "a launch the quiet gate refused is not overruled by the round" fails on
 *                   `y-game-endgame's capture must not be attempted`, exit 1.
 * red-proof: inject  `borrowedRedRows` returning `[]` (the borrowed driver's red never named): "a world
 *                   invocation's borrowed prerequisite…" fails on the missing `borrowed prerequisite was red on
 *                   their mount` line, exit 1.
 * red-proof: inject  the mount line's own words (`gets a mount of its own` for `gets a mounted Host of its own`):
 *                   "a green round prints nothing of the round inside the shared invocation" fails on the diff of
 *                   the expected sequence, exit 1 - which is what holds today's green output byte for byte.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DRIVERS } from "../phases/drivers.mjs";
import { MACHINE_NOT_QUIET } from "./machine-quiet.mjs";
import {
  captureTotals,
  describeRound,
  PHASES,
  RED_SCOPE_INVOCATION,
  RED_SCOPE_ROUND,
  redScope,
  roundSchedule,
  runRound,
} from "./run-phases.mjs";
import { worldInvocations } from "./world-invocations.mjs";

const ROSTER = worldInvocations(DRIVERS);
const SCHEDULE = roundSchedule(ROSTER);
const SHARED_CAPTURE = `${SCHEDULE.shared.drivers.join(",")}/capture`;

/** What a fixture phase call is keyed by: the exact `--driver=` set it was given, then the phase. */
const callKey = (phase, options) => `${(options.drivers ?? ["-"]).join(",")}/${phase}`;

/** A green `DONE-CAPTURE` line for a capture invocation given N drivers. */
const greenCapture = (count) =>
  `DONE-CAPTURE failed=0 of ${count} ran=${count} skipped=0 not-selected=0 not-measured=0 blocked-by-product=0`;

/**
 * A round driven against a fixture of phase exits.
 *
 * `fail` maps a `callKey` to the exit code that phase returns; `captures` maps a capture `callKey` to the
 * `DONE-CAPTURE` line the phase prints; `refusals` maps a `callKey` to the refusal code its phase named (what
 * `phases/launch.mjs` writes into `launch.json` as `machine_not_quiet`, `cdp_port_held_by_pid`, …).
 *
 * The capture log is emulated the way `phases/capture.mjs` writes it - appended, one `DONE-CAPTURE` line per
 * invocation - and each call takes the entry IT appended, which is what `run.mjs` reads back out of the real file.
 */
async function driveRound(schedule, { fail = {}, captures = {}, refusals = {} } = {}) {
  const log = [];
  const calls = [];
  let captureLog = "";
  const runPhase = async (phase, options) => {
    log.push(`== phase ${phase} ==`);
    const key = callKey(phase, options);
    calls.push(key);
    const before = captureTotals(captureLog).length;
    if (phase === "capture") captureLog += `${captures[key] ?? greenCapture((options.drivers ?? []).length)}\n`;
    const code = fail[key] ?? 0;
    return {
      code,
      refusal: refusals[key] ?? null,
      failure: code === 0 ? null : `phase ${phase} failed (exit ${code})`,
      totals: phase === "capture" ? (captureTotals(captureLog)[before] ?? null) : null,
    };
  };
  const round = await runRound({ schedule, runPhase, log: (line) => log.push(line) });
  return { round, log, calls, summary: describeRound(round) };
}

const worldKeys = (schedule) => schedule.worlds.map((world) => world.label);
const worldCall = (schedule, driver, phase) =>
  callKey(phase, { drivers: schedule.worlds.find((w) => w.label === driver).drivers });

test("a red phase names its scope: the three phases every mount needs end the round, the rest end their invocation", () => {
  assert.deepEqual(
    PHASES.filter((phase) => redScope(phase) === RED_SCOPE_ROUND),
    ["check", "pin", "build"],
    "a red in a phase that produces the worktree or the artifact every invocation mounts has to end the round: nothing below has anything to mount",
  );
  assert.deepEqual(
    PHASES.filter((phase) => redScope(phase) === RED_SCOPE_INVOCATION),
    ["launch", "capture", "cleanup", "report"],
    "a phase that acts on one mounted Host (or on the round's own close) ends its own invocation's reading and nobody else's",
  );
  assert.deepEqual(roundSchedule(ROSTER).prerequisites, ["check", "pin", "build"]);
  assert.throws(
    () => redScope("publish"),
    /round_phase_unknown:publish/u,
    "a phase added without a scope must be refused, never silently treated as invocation-scoped",
  );
});

test("a red shared capture still attempts the three world invocations, each with its own reading", async () => {
  const { round, calls, summary } = await driveRound(SCHEDULE, {
    fail: { [SHARED_CAPTURE]: 3 },
    captures: {
      [SHARED_CAPTURE]:
        "DONE-CAPTURE failed=1 of 23 ran=23 skipped=0 not-selected=3 not-measured=0 blocked-by-product=0 failed-drivers=[w-game-launch]",
    },
  });

  for (const driver of worldKeys(SCHEDULE))
    for (const phase of ["cleanup", "launch", "capture"])
      assert.equal(
        calls.includes(worldCall(SCHEDULE, driver, phase)),
        true,
        `${driver} was never attempted in \`${phase}\`: the round stopped at the first red, which is the defect (ROUND33D: one reading out of four)\n${calls.join("\n")}`,
      );
  assert.ok(calls.length > 3 * worldKeys(SCHEDULE).length, "the round ran nothing after the shared invocation");

  assert.equal(round.code, 3, "the round exits with the red phase's own code, not a code chosen to describe it");
  assert.deepEqual(
    round.reds.map((red) => `${red.label}/${red.phase}=${red.code}`),
    ["shared/capture=3"],
    "exactly one phase is red, and it is the shared capture",
  );

  // Every invocation's own line, in schedule order, with the shared one first and the close last.
  const perInvocation = summary.filter(
    (line) => line.startsWith("ROUND: ") && / (attempted|not attempted): /u.test(line),
  );
  assert.equal(
    perInvocation.length,
    SCHEDULE.worlds.length + 2,
    `the summary names every scheduled invocation once (shared + ${SCHEDULE.worlds.length} world + close), got:\n${summary.join("\n")}`,
  );
  assert.match(perInvocation.at(-1), /^ROUND: close attempted: cleanup=0 report=0/u);
  for (const driver of worldKeys(SCHEDULE))
    assert.match(
      perInvocation.find((line) => line.startsWith(`ROUND: ${driver}[`)),
      /capture=0 -- DONE-CAPTURE failed=0 of 2 /u,
      `${driver} ran on its own mount after the shared red and its own totals are in the summary`,
    );
  assert.match(
    summary[0],
    new RegExp(
      `ROUND: 4 invocation\\(s\\) scheduled \\(1 shared \\+ 3 world: shared, ${worldKeys(SCHEDULE).join(", ")}\\), 4 attempted, 0 not attempted`,
      "u",
    ),
  );
});

test("the summary never turns a red shared capture into failed=0, and the round still exits non-zero", async () => {
  const { round, summary } = await driveRound(SCHEDULE, {
    fail: { [SHARED_CAPTURE]: 3 },
    captures: {
      [SHARED_CAPTURE]:
        "DONE-CAPTURE failed=1 of 23 ran=23 skipped=0 not-selected=3 not-measured=0 blocked-by-product=0 failed-drivers=[w-game-launch]",
    },
  });

  assert.match(
    summary.find((line) => line.startsWith("ROUND: shared attempted:")),
    /DONE-CAPTURE failed=1 of 23 /u,
    "the shared invocation's own totals are quoted, so the runs after it cannot stand in for its red",
  );
  assert.equal(
    summary.some((line) => /failed=0/u.test(line) && line.startsWith("ROUND: shared")),
    false,
    "the shared invocation is red and no line must present it as failed=0",
  );
  assert.match(summary.at(-1), /^ROUND: 1 red phase\(s\): shared\/capture=3 - the round exits 3;/u);
  assert.equal(round.code, 3);
});

test("a round-scoped red names every invocation not attempted instead of running it against halves", async () => {
  const { round, calls, summary } = await driveRound(SCHEDULE, { fail: { "-/build": 1 } });

  assert.deepEqual(calls, ["-/check", "-/pin", "-/build"], "nothing may mount after the build went red");
  assert.equal(round.code, 1);
  assert.equal(round.ended.phase, "build");
  assert.match(
    summary[0],
    /ROUND: 4 invocation\(s\) scheduled \(1 shared \+ 3 world: shared, x-game-death, y-game-endgame, z-game-disconnect\), 0 attempted, 4 not attempted/u,
  );
  assert.match(
    summary[1],
    /^ROUND: 4 of those invocation\(s\) are not attempted \(round_prerequisite_red:build\): shared, x-game-death\[w-game-launch,x-game-death\], y-game-endgame/u,
  );
  assert.equal(
    summary.filter((line) => / not attempted: round_prerequisite_red:build /u.test(line)).length,
    4,
    `every scheduled mount says WHY it produced no reading, got:\n${summary.join("\n")}`,
  );
  assert.match(summary.at(-1), /^ROUND: 1 red phase\(s\): round\/build=1 - the round exits 1;/u);
});

test("a launch the quiet gate refused is not overruled by the round, and the next mount asks again", async () => {
  const refused = worldCall(SCHEDULE, "y-game-endgame", "launch");
  const { round, calls, log, summary } = await driveRound(SCHEDULE, {
    fail: { [refused]: 2 },
    refusals: { [refused]: MACHINE_NOT_QUIET },
  });

  assert.equal(
    calls.includes(worldCall(SCHEDULE, "y-game-endgame", "capture")),
    false,
    "y-game-endgame's capture must not be attempted: there is no mounted Host to read, and a capture without one refuses by name rather than producing a reading",
  );
  assert.match(
    log.find((line) => line.startsWith("ROUND: y-game-endgame does not run capture")),
    /launch_not_mounted/u,
  );
  assert.match(
    log.find((line) => line.startsWith("ROUND: y-game-endgame launch is red")),
    new RegExp(`${MACHINE_NOT_QUIET}`, "u"),
    "the round quotes the gate's own refusal rather than an unnamed exit code",
  );
  for (const later of ["z-game-disconnect"])
    assert.equal(
      calls.includes(worldCall(SCHEDULE, later, "capture")),
      true,
      `${later} is a mount of its own: the gate's answer for y's mount is not a memory about ${later}'s`,
    );
  assert.match(
    summary.find((line) => line.startsWith("ROUND: y-game-endgame[")),
    /launch=2 capture=not-attempted\(launch_not_mounted\)/u,
  );
  assert.equal(round.code, 2);
});

test("a world invocation's borrowed prerequisite is printed with what a red borrow means, and named in the summary", async () => {
  const starved = (driver) =>
    `DONE-CAPTURE failed=1 of 2 ran=2 skipped=0 not-selected=0 not-measured=1 blocked-by-product=0 failed-drivers=[w-game-launch] not-measured-drivers=[${driver}:world_not_owned_by_this_driver]`;
  const captures = Object.fromEntries(
    SCHEDULE.worlds.map((world) => [callKey("capture", { drivers: world.drivers }), starved(world.label)]),
  );
  const { log, summary, round } = await driveRound(SCHEDULE, {
    fail: Object.fromEntries(SCHEDULE.worlds.map((world) => [callKey("capture", { drivers: world.drivers }), 3])),
    captures,
  });

  for (const world of SCHEDULE.worlds) {
    const borrow = log.find((line) => line.startsWith(`WORLDS: ${world.label} borrows`));
    assert.match(
      borrow,
      new RegExp(
        `borrows ${world.borrowed.join("\\+")} .* if ${world.borrowed.join("\\+")} is red on this mount, ${world.label} never reaches its precondition`,
        "u",
      ),
      `${world.label}'s mount has to name the roster driver it borrowed and what a red borrow means for its own driver`,
    );
    assert.equal(
      log[log.indexOf(borrow) + 1],
      "== phase cleanup ==",
      `${world.label}'s borrowed prerequisite is named before its own mount is paid for`,
    );
  }

  assert.equal(round.code, 3);
  assert.match(
    summary.find((line) => line.startsWith("ROUND: 3 world-owning driver(s) measured nothing")),
    /borrowed prerequisite was red on their mount: x-game-death, y-game-endgame, z-game-disconnect - not a silent count, and not a product verdict/u,
  );
  for (const driver of worldKeys(SCHEDULE))
    assert.ok(
      summary.some((line) =>
        line.startsWith(
          `ROUND: ${driver}'s borrowed prerequisite w-game-launch was red on its mount, so ${driver} could not reach its precondition - its own reading is not-measured:world_not_owned_by_this_driver`,
        ),
      ),
      `${driver}'s summary has to say WHY it measured nothing: it borrowed the driver that went red`,
    );
});

test("a green round prints nothing of the round inside the shared invocation", async () => {
  // The schedule today's full round drives, spelled out so the expected sequence is a reading and not a derivation
  // of the code under test: one shared mount, one world mount, the round's own close.
  const schedule = roundSchedule({
    shared: ["a-surfaces", "w-game-launch"],
    invocations: [{ driver: "x-game-death", drivers: ["w-game-launch", "x-game-death"] }],
    bringers: ["w-game-launch"],
  });
  const { log, round, summary } = await driveRound(schedule);

  assert.deepEqual(
    log.filter((line) => !(line.startsWith("ROUND:") || line.includes(" borrows "))),
    [
      "== phase check ==",
      "== phase pin ==",
      "== phase build ==",
      "== phase launch ==",
      "== phase capture ==",
      "WORLDS: x-game-death gets a mounted Host of its own: cleanup, launch, capture --driver=w-game-launch,x-game-death",
      "== phase cleanup ==",
      "== phase launch ==",
      "== phase capture ==",
      "== phase cleanup ==",
      "== phase report ==",
    ],
    "a green round's own output is the round it always ran; the scope rule adds the borrow line to a world mount and the summary at the end, and nothing else",
  );
  assert.equal(round.code, 0);
  assert.deepEqual(round.reds, []);
  assert.match(summary.at(-1), /^ROUND: no phase is red, and the round exits 0$/u);
});

test("the capture totals are read per invocation, never inherited from the line above", () => {
  const text = [
    "===== capture invocation 2026-11-25T20:02:44.183Z drivers=[a-surfaces] force=false =====",
    "  | some driver output",
    "DONE-CAPTURE failed=1 of 23 ran=23 skipped=0 not-selected=3 not-measured=0 blocked-by-product=0 failed-drivers=[w-game-launch]",
    "===== capture invocation 2026-11-26T04:02:44.183Z drivers=[w-game-launch,x-game-death] force=true =====",
    "DONE-CAPTURE failed=1 of 2 ran=2 skipped=0 not-selected=24 not-measured=1 blocked-by-product=0 failed-drivers=[w-game-launch] not-measured-drivers=[x-game-death:world_not_owned_by_this_driver]",
  ].join("\n");
  const readings = captureTotals(text);
  assert.equal(readings.length, 2);
  assert.equal(readings[0].failed, 1);
  assert.equal(readings[0].of, 23);
  assert.deepEqual(readings[0].notMeasured, []);
  assert.equal(readings[1].failed, 1);
  assert.equal(readings[1].of, 2);
  assert.deepEqual(readings[1].notMeasured, [{ key: "x-game-death", reason: "world_not_owned_by_this_driver" }]);
  assert.deepEqual(readings[1].failedDrivers, ["w-game-launch"]);
});
