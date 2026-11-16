// What a hard-killed harness left, and what it must never touch.
//
// The failure this file exists for: a harness force-killed mid-run runs no exit handler, so `lib/run-owner.mjs`
// never tears down the game that run opened - and the guardian keeps the player's world alive on purpose
// (product rule #3023), so the game is still on screen while nothing owns it. The next run of that stage is the
// only thing that can take it back, and the two ways it can be wrong are symmetrical: leaving the game there
// forever, or killing a pid the OS handed to somebody else. Every test below is one of those two.
//
// The fakes are the process table and the kill, i.e. the OS boundary. The ledger, the identities and the reading
// are the real modules, so a green suite says the real code classifies a real table correctly.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runPaths } from "./config.mjs";
import { processRow } from "./process-table.mjs";
import {
  closeRunInvocation,
  describeReaper,
  openRunInvocation,
  readRunInvocation,
  reapRunOrphans,
  writeReaperReading,
} from "./run-reaper.mjs";
import { registerRunProcess } from "./run-owner.mjs";

const STAGE = "E:\\projects\\ai-game-companion\\.tmp\\reaper.stage";
const OTHER_STAGE = "E:\\projects\\ai-game-companion\\.tmp\\other-lane.stage";
const START = "2026-11-16T16:27:17.1722400+08:00";
const REUSED = "2026-11-16T17:41:02.0000000+08:00";
const RUN_MODS = `${STAGE}\\root\\GameBuddy\\data\\stardew-private-bootstrap\\x\\player-host\\Mods`;

const invocation = (pid = 900, startTime = START) => ({ pid, startTime, phase: "capture", at: START });

/** A process table the test owns: rows keep their command line so `readStage` can filter exactly as the probe does. */
function world(rows) {
  const alive = new Map(rows.map((row) => [row.pid, row]));
  const kills = [];
  return {
    alive,
    kills,
    readTable: () => ({ examined: 361, rows: [...alive.values()] }),
    readStage: (text) => ({
      examined: 361,
      // The probe compares ordinally and case-insensitively; so does this, so a resolved stage root is the match.
      rows: [...alive.values()].filter((row) => row.commandLine.toLowerCase().includes(text.toLowerCase())),
    }),
    kill: (pid) => {
      kills.push(pid);
      alive.delete(pid);
      return "killed";
    },
  };
}

const row = (pid, parentPid, name, commandLine, startTime = START) => ({
  pid,
  parentPid,
  name,
  commandLine,
  startTime,
});

const launchDriver = (pid) => row(pid, 1, "node.exe", `node "run.mjs" "${STAGE}\\state\\run.json"`);
const loader = (pid, startTime = START) =>
  row(pid, 1, "StardewModdingAPI.exe", `"D:\\Steam\\StardewModdingAPI.exe" --mods-path "${RUN_MODS}"`, startTime);
// The client carries nothing of this run: its command line is its own image, which is why it is the row the
// pid-alone reaper would have to guess at and this one recognises through the loader it was born under.
const client = (pid, parentPid, startTime = START) =>
  row(pid, parentPid, "Stardew Valley.exe", `"D:\\Steam\\Stardew Valley.exe"`, startTime);

test("a hard-killed invocation's processes are taken back, and a pid the machine reused is only named", () => {
  const fake = world([
    launchDriver(100),
    loader(200),
    client(300, 200),
    // The pid the ledger recorded now belongs to something else: same number, different creation time.
    row(400, 1, "msedge.exe", `msedge --user-data-dir=${OTHER_STAGE}\\browser-profile`, REUSED),
    // Alive, no recorded start time, and nothing in its command line or parent chain names this stage.
    row(600, 1, "node.exe", "node -e setInterval(()=>{},1000)", START),
  ]);
  const reading = reapRunOrphans({
    paths: { stageRoot: STAGE },
    stageRoot: STAGE,
    previous: invocation(),
    records: [
      { pid: 100, role: "launch-driver", startTime: null },
      { pid: 200, role: "game-smapi", startTime: START },
      { pid: 300, role: "game-client", startTime: START },
      { pid: 400, role: "capture:w-game-launch", startTime: START },
      { pid: 500, role: "launch-driver", startTime: START },
      { pid: 600, role: "unrecorded", startTime: null },
    ],
    readTable: fake.readTable,
    readStage: fake.readStage,
    kill: fake.kill,
    attempts: 2,
  });

  assert.ok(
    fake.kills.indexOf(300) < fake.kills.indexOf(200),
    "the client dies before the loader whose tree would take it",
  );
  assert.deepEqual([...fake.kills].sort(), [100, 200, 300], "and every recorded orphan is taken, exactly once");
  assert.deepEqual(
    reading.terminated.map((entry) => entry.pid),
    [300, 100, 200],
    "a record with no start time is believed through its command line, and a client through its recorded loader",
  );
  assert.deepEqual(
    reading.alreadyGone.map((entry) => entry.pid),
    [500],
    "a registered pid the table no longer has is gone, and that is an answer rather than a gap",
  );
  assert.deepEqual(
    reading.identityMismatch.map((entry) => entry.pid),
    [400],
    "the same number with another creation time is another process",
  );
  assert.deepEqual(
    reading.skipped.map((entry) => entry.pid),
    [600],
    "nothing can be shown about an untimed pid with no path and no recorded loader in its chain",
  );
  assert.ok(fake.alive.has(400), "the process the pid was recycled into is untouched");
  assert.ok(fake.alive.has(600), "and so is the one that could not be identified");

  const lines = describeReaper(reading);
  assert.deepEqual(lines.slice(0, 6), [
    "reaper_terminated: 300(game-client)",
    "reaper_terminated: 100(launch-driver)",
    "reaper_terminated: 200(game-smapi)",
    "reaper_already_gone: 500",
    "reaper_identity_mismatch: 400",
    "reaper_skipped: 600: recorded without a start time, and neither its command line nor its parent chain names this stage root",
  ]);
  assert.match(lines.at(-2), /^REAPER: 400\(capture:w-game-launch\) recorded a pid whose start time/u);
  assert.match(
    lines.at(-1),
    /^REAPER: examined 6 recorded for .*terminated 3, already-gone 1, could-not-terminate 0, identity-mismatch 1, skipped 1 \(the previous invocation, pid 900, never closed\)$/u,
  );
});

test("the game client is recognised after its loader has exited, by the parent it was born under", () => {
  // The measured shape of the orphan: the loader is gone, the client is still on screen, and Windows still
  // reports the parent pid the client was created with. A reaper that needed the loader alive would never
  // take this process back, which is precisely the game the operator saw.
  const fake = world([client(300, 200)]);
  const reading = reapRunOrphans({
    paths: { stageRoot: STAGE },
    stageRoot: STAGE,
    previous: invocation(),
    records: [
      { pid: 200, role: "game-smapi", startTime: START },
      { pid: 300, role: "game-client", startTime: START },
    ],
    readTable: fake.readTable,
    readStage: fake.readStage,
    kill: fake.kill,
    attempts: 2,
  });
  assert.deepEqual(fake.kills, [300]);
  assert.equal(reading.terminated[0].identity, "child_of_recorded_game_loader:200");
  assert.deepEqual(
    reading.alreadyGone.map((entry) => entry.pid),
    [200],
    "the loader is recorded as gone, not as a process this run killed",
  );
});

test("a pid that outlived its process under a reused number does not block the reaper, and is not killed", () => {
  // The marker names a pid the machine has since handed to another process. Reading that as "the invocation is
  // still running" would make the reaper refuse forever and leave the game on screen; reading it as "reap" and
  // killing it would be the game-killer. It is neither: the marker is dead, and its pid is not in the records.
  const fake = world([row(900, 1, "notepad.exe", "notepad.exe", REUSED), launchDriver(100)]);
  const reading = reapRunOrphans({
    paths: { stageRoot: STAGE },
    stageRoot: STAGE,
    previous: invocation(900),
    records: [{ pid: 100, role: "launch-driver", startTime: null }],
    readTable: fake.readTable,
    readStage: fake.readStage,
    kill: fake.kill,
    attempts: 2,
  });
  assert.equal(reading.evidence, "reaped");
  assert.deepEqual(fake.kills, [100], "the recorded orphan is taken; the marker's recycled pid is not");
  assert.ok(fake.alive.has(900));
});

test("no marker means the previous invocation closed, so a stepwise session is left alone", () => {
  // `node run.mjs capture` after a clean `node run.mjs launch`: the mounted session IS the next phase's input.
  const fake = world([launchDriver(100), loader(200), client(300, 200)]);
  const reading = reapRunOrphans({
    paths: { stageRoot: STAGE },
    stageRoot: STAGE,
    previous: null,
    records: [
      { pid: 100, role: "launch-driver", startTime: null },
      { pid: 200, role: "game-smapi", startTime: START },
      { pid: 300, role: "game-client", startTime: START },
    ],
    readTable: fake.readTable,
    readStage: fake.readStage,
    kill: fake.kill,
  });
  assert.deepEqual(fake.kills, [], "a run that closed on purpose did not leave an orphan");
  assert.equal(reading.evidence, "no_orphaned_invocation");
  assert.deepEqual(describeReaper(reading), [
    `REAPER: nothing to reap - no earlier invocation of ${STAGE} died without closing (examined 3 recorded identities; a stepwise session it left behind is the next phase's input, not an orphan)`,
  ]);
});

test("an earlier invocation that is still running is named and not reaped", () => {
  const fake = world([
    { ...row(900, 1, "node.exe", `node "run.mjs" "${STAGE}\\state\\run.json"`, START) },
    loader(200),
  ]);
  const reading = reapRunOrphans({
    paths: { stageRoot: STAGE },
    stageRoot: STAGE,
    previous: invocation(900),
    records: [
      { pid: 900, role: "launch-driver", startTime: null },
      { pid: 200, role: "game-smapi", startTime: START },
    ],
    readTable: fake.readTable,
    readStage: fake.readStage,
    kill: fake.kill,
  });
  assert.deepEqual(fake.kills, []);
  assert.equal(reading.evidence, "previous_invocation_alive");
  assert.match(
    describeReaper(reading)[0],
    /^reaper_skipped: 900: an earlier invocation of this stage is still running/u,
  );
  assert.match(describeReaper(reading).at(-1), /^REAPER: nothing was touched \(examined 2 recorded/u);
});

test("a machine that cannot be asked is unverifiable, never a machine with nothing left", () => {
  const reading = reapRunOrphans({
    paths: { stageRoot: STAGE },
    stageRoot: STAGE,
    previous: invocation(),
    records: [{ pid: 100, role: "launch-driver", startTime: null }],
    readTable: () => null,
    readStage: () => null,
  });
  assert.equal(reading.evidence, "process_table_unavailable");
  assert.deepEqual(reading.terminated, []);
  assert.match(describeReaper(reading)[0], /^REAPER: unverifiable:process_table_unavailable - /u);
});

test("a terminated pid that is still there after the bound is a different answer from one that went away", () => {
  const stubborn = world([launchDriver(100)]);
  const reading = reapRunOrphans({
    paths: { stageRoot: STAGE },
    stageRoot: STAGE,
    previous: invocation(),
    records: [{ pid: 100, role: "launch-driver", startTime: null }],
    readTable: stubborn.readTable,
    readStage: stubborn.readStage,
    // A kill that reports success and does nothing: the assertion has to catch it from the table, not the report.
    kill: () => "killed",
    attempts: 2,
  });
  assert.deepEqual(reading.terminated, []);
  assert.deepEqual(reading.couldNotTerminate, [
    { pid: 100, role: "launch-driver", identity: "stage_root_in_command_line", reason: "still_alive_after_kill" },
  ]);
  const lines = describeReaper(reading);
  assert.ok(lines.includes("reaper_could_not_terminate: 100"));
  assert.match(lines.at(-2), /^REAPER: COULD NOT TERMINATE 100\(launch-driver\)/u);
});

test("the marker is the invocation's, and is read before it is replaced", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-run-reaper-marker-"));
  try {
    const paths = runPaths({ outRoot: join(root, "run"), stageRoot: join(root, "run.stage") });
    const first = openRunInvocation({ paths, phase: "launch", readRow: () => ({ startTime: START }) });
    assert.equal(first, null, "the first invocation of a stage has no predecessor");
    assert.deepEqual(readRunInvocation(paths), {
      pid: process.pid,
      startTime: START,
      phase: "launch",
      at: readRunInvocation(paths).at,
    });
    const second = openRunInvocation({ paths, phase: "capture", readRow: () => ({ startTime: START }) });
    assert.equal(second.pid, process.pid, "the successor is handed its predecessor's marker");
    assert.equal(second.phase, "launch");
    closeRunInvocation(paths);
    assert.equal(readRunInvocation(paths), null, "a run that closes leaves the next invocation nothing to reap");
    closeRunInvocation(paths);
    assert.equal(readRunInvocation(paths), null, "closing twice is not an error, and is not a marker either");
    writeReaperReading(paths, { evidence: "no_orphaned_invocation", examined: 0, terminated: [] });
    assert.match(
      JSON.parse(readFileSync(paths.reaperFile, "utf8")).evidence,
      /^no_orphaned_invocation$/u,
      "the reading is written beside the run",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The half the fakes cannot prove: REAL processes, REAL kills, and a real skip of a process this stage never
// caused. The ledger, the marker, the identity checks and the termination are the production modules; only the
// game itself is a stand-in (this lane does not launch one - the machine's other lane is using it).
const IDLE = "setInterval(() => {}, 1000);";

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitForGone(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test(
  "real orphans of a hard-killed invocation are terminated, and an unrelated process is not",
  { timeout: 120_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "gb-run-reaper-live-"));
    const paths = runPaths({ outRoot: join(root, "run"), stageRoot: join(root, "run.stage") });
    mkdirSync(paths.stateDir, { recursive: true });
    // A stand-in Mod loader carrying this stage's mods root in its command line, which spawns its own game under
    // it: the same two-hop relation a real launch produces, without launching Stardew.
    const loaderScript = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}, "--", "D:\\\\Steam\\\\Stardew Valley.exe"], {
      stdio: "ignore", windowsHide: true,
    });
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `;
    const loaderChild = spawn(
      process.execPath,
      ["-e", loaderScript, "--", "--mods-path", `${paths.stageRoot}\\root\\player-host\\Mods`],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const unrelated = spawn(process.execPath, ["-e", IDLE, "--", "not-this-stage"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const clientPid = await new Promise((resolve, reject) => {
      let output = "";
      loaderChild.stdout.on("data", (chunk) => {
        output += String(chunk);
        const pid = Number(output.trim().split("\n")[0]);
        if (Number.isSafeInteger(pid) && pid > 0) resolve(pid);
      });
      loaderChild.on("error", reject);
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      // What a capture boundary would have written, from the table's own creation times.
      registerRunProcess(paths, {
        pid: loaderChild.pid,
        role: "game-smapi",
        startTime: processRow(loaderChild.pid)?.startTime,
      });
      registerRunProcess(paths, { pid: clientPid, role: "game-client", startTime: processRow(clientPid)?.startTime });
      // The control: registered in this stage's ledger, alive, but its recorded time is not the one the OS has (and
      // its command line names nothing of this stage). A reaper that acted on pids rather than identities would end it.
      registerRunProcess(paths, {
        pid: unrelated.pid,
        role: "unrecorded",
        startTime: "2020-01-01T00:00:00.0000000+08:00",
      });
      // The marker of an invocation that was force-killed: its pid is one the machine cannot have reused here.
      writeFileSync(
        paths.inflightFile,
        `${JSON.stringify({ pid: 999_999, startTime: null, phase: "capture", at: new Date().toISOString() }, null, 1)}\n`,
        "utf8",
      );

      const reading = reapRunOrphans({ paths });
      const lines = describeReaper(reading);
      assert.equal(reading.evidence, "reaped", lines.join("\n"));
      assert.deepEqual(
        reading.terminated.map((entry) => [entry.pid, entry.role, entry.identity]),
        [
          [clientPid, "game-client", `child_of_recorded_game_loader:${String(loaderChild.pid)}`],
          [loaderChild.pid, "game-smapi", "stage_root_in_command_line"],
        ],
        lines.join("\n"),
      );
      assert.deepEqual(
        reading.identityMismatch.map((entry) => entry.pid),
        [unrelated.pid],
        "the control is named, not killed",
      );
      assert.ok(
        await waitForGone(loaderChild.pid),
        `the stand-in loader (pid ${String(loaderChild.pid)}) must be gone`,
      );
      assert.ok(await waitForGone(clientPid), `the stand-in game (pid ${String(clientPid)}) must be gone`);
      assert.ok(isAlive(unrelated.pid), "a process this stage never caused is still running");
    } finally {
      loaderChild.kill("SIGKILL");
      unrelated.kill("SIGKILL");
      await waitForGone(loaderChild.pid);
      await waitForGone(unrelated.pid);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
