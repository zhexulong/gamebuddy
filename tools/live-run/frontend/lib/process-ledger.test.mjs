/*
 * red-proof: inject  with the `createdOnly` filter dropped in `collectProcessLedger`'s `claim()`, this suite
 * fails on
 *
 *   "a game process that existed before the run opened is not claimed"
 *     the player's own session is recorded as this run's process
 *
 * and with the `endedByRunUnowned` split removed (counting every ended pid as owned) it fails on
 *
 *   "a process this run ended without owning is collateral damage, and the line says so"
 *
 * Both mutations are the ones the ledger exists to prevent: a record that claims the player's game, and a
 * window in which the run kills something outside its own set. No browser and no OS process table is needed
 * here - the table reads are injected, which is the boundary this module does not own.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closeProcessLedger,
  collectProcessLedger,
  deliberatelyKept,
  describeProcessLedger,
  openProcessLedger,
  ownershipMarkers,
} from "./process-ledger.mjs";

const STAGE = "E:\\tmp\\run.stage";
const GAME_DIR = "D:\\Steam\\steamapps\\common\\Stardew Valley";

/** A table read: `rows` are `{ pid, parentPid, name, startTime }`, exactly what the probe answers. */
const tableOf = (rows) => () => ({ examined: rows.length, rows });

/** A command-line query: `{ text -> rows }`, and `null` for a text nobody claims. */
const queriesOf = (byMarker) => (text) => {
  const rows = byMarker[text];
  return rows === undefined ? { examined: 385, rows: [] } : { examined: 385, rows };
};

const row = (pid, parentPid, name, extra = {}) => ({
  pid,
  parentPid,
  name,
  startTime: "2026-11-15T06:00:00.0000000+08:00",
  commandLine: "",
  ...extra,
});

test("the marker population names its reasons, and the game markers are created-only", () => {
  const markers = ownershipMarkers({ stageRoot: STAGE, gameDir: GAME_DIR, hostPid: 8080, guardianPid: 7070 });
  assert.deepEqual(
    markers.map((marker) => marker.id),
    ["stage", "game-smapi", "game-client", "host", "guardian-tree"],
  );
  for (const marker of markers) assert.ok(marker.reason.length > 20, `${marker.id} must state why it is this run's`);
  assert.equal(markers.find((marker) => marker.id === "stage").createdOnly, false);
  assert.equal(markers.find((marker) => marker.id === "game-smapi").createdOnly, true);
  assert.equal(markers.find((marker) => marker.id === "game-client").createdOnly, true);
  assert.equal(markers.find((marker) => marker.id === "guardian-tree").createdOnly, true);
  // The executable markers are derived from the configured installation, not spelled here.
  assert.equal(markers.find((marker) => marker.id === "game-smapi").text, `${GAME_DIR}\\StardewModdingAPI.exe`);
  assert.equal(markers.find((marker) => marker.id === "game-smapi").text, `${GAME_DIR}` + "\\StardewModdingAPI.exe");
});

test("a process this run never claimed is not recorded", () => {
  const ledger = openProcessLedger({ stageRoot: STAGE, readTable: tableOf([row(4, 0, "System")]) });
  const collected = collectProcessLedger(ledger, {
    query: queriesOf({}),
    readTable: tableOf([row(4, 0, "System"), row(900, 4, "svchost.exe")]),
  });
  assert.deepEqual(collected.entries, []);
});

test("the stage root claims the browser and the phase processes, with their start times", () => {
  const browser = row(900, 4, "msedge.exe", { commandLine: `msedge.exe --user-data-dir=${STAGE}\\browser-profile` });
  const capture = row(901, 900, "node.exe", { commandLine: `node.exe phases/capture.mjs ${STAGE}\\state\\run.json` });
  const ledger = openProcessLedger({ stageRoot: STAGE, readTable: tableOf([row(4, 0, "System")]) });
  const collected = collectProcessLedger(ledger, {
    query: queriesOf({ [STAGE]: [browser, capture] }),
    readTable: tableOf([row(4, 0, "System"), row(900, 4, browser.name), row(901, 900, capture.name)]),
  });
  assert.deepEqual(
    collected.entries.map((entry) => [entry.pid, entry.name, entry.commandLineMarker]),
    [
      [900, "msedge.exe", "stage"],
      [901, "node.exe", "stage"],
    ],
  );
  for (const entry of collected.entries) assert.match(entry.startTime, /^2026-11-15T06:00/u);
});

test("a game process that existed before the run opened is not claimed, and one that appeared after is", () => {
  const playerGame = row(500, 4, "StardewModdingAPI.exe");
  const ourGame = row(501, 7070, "StardewModdingAPI.exe");
  const sql = [`${GAME_DIR}\\StardewModdingAPI.exe`];
  const ledger = openProcessLedger({
    stageRoot: STAGE,
    gameDir: GAME_DIR,
    readTable: tableOf([row(4, 0, "System"), row(500, 4, "StardewModdingAPI.exe")]),
  });
  const collected = collectProcessLedger(ledger, {
    query: queriesOf({ [sql[0]]: [playerGame, ourGame] }),
    readTable: tableOf([row(4, 0, "System"), row(500, 4, playerGame.name), row(501, 7070, ourGame.name)]),
  });
  assert.deepEqual(
    collected.entries.map((entry) => entry.pid),
    [501],
    "the player's own game was running before this run opened, so it is not this run's",
  );
});

test("the guardian tree claims what the supervisor started for us, and never the supervisor itself", () => {
  const table = [
    row(4, 0, "System"),
    row(7070, 4, "GameBuddy.Desktop.exe"),
    row(8080, 7070, "GameBuddy.Host.exe"),
    row(9090, 7070, "StardewModdingAPI.exe"),
  ];
  const ledger = openProcessLedger({ stageRoot: STAGE, hostPid: 8080, readTable: tableOf([row(4, 0, "System")]) });
  const collected = collectProcessLedger(ledger, { query: queriesOf({}), readTable: tableOf(table) });
  assert.deepEqual(
    collected.entries.map((entry) => [entry.pid, entry.commandLineMarker]),
    [
      [8080, "host"],
      [9090, "guardian-tree"],
    ],
    "the supervisor launched the Host and the game; the supervisor itself is not a process this run created",
  );
});

test("a run-owned parent is not read as the supervisor, so its tree stays this run's to stop", () => {
  // The gate launcher (`tools/desktop-composition-launch.mjs`) spawns the Host itself, and its tree also holds
  // the run's own browser. Calling that tree "not this run's to end" would hide a real leftover behind a reason.
  const table = [
    row(4, 0, "System"),
    row(8000, 4, "node.exe"),
    row(8080, 8000, "GameBuddy.Host.exe"),
    row(9100, 8000, "msedge.exe"),
  ];
  const ledger = openProcessLedger({ stageRoot: STAGE, hostPid: 8080, readTable: tableOf([row(4, 0, "System")]) });
  const collected = collectProcessLedger(ledger, {
    query: queriesOf({ [STAGE]: [row(8000, 4, "node.exe"), row(9100, 4, "msedge.exe")] }),
    readTable: tableOf(table),
  });
  assert.deepEqual(
    collected.entries.map((entry) => [entry.pid, entry.commandLineMarker]),
    [
      [8000, "stage"],
      [8080, "host"],
      [9100, "stage"],
    ],
  );
  assert.deepEqual(
    deliberatelyKept(collected.entries).map((entry) => entry.pid),
    [],
    "nothing in this run's own tree may be exempted from the leftover reading",
  );
});

test("a registered pid that already exited keeps its role, and says it has no start time to give", () => {
  const ledger = openProcessLedger({ stageRoot: STAGE, readTable: tableOf([row(4, 0, "System")]) });
  const collected = collectProcessLedger(ledger, {
    registry: [{ pid: 4242, role: "launch-driver" }],
    query: queriesOf({}),
    readTable: tableOf([row(4, 0, "System")]),
  });
  assert.deepEqual(collected.entries, [
    {
      name: null,
      pid: 4242,
      startTime: null,
      commandLineMarker: "registry",
      markerReason: "this run registered the pid when it spawned it",
      role: "launch-driver",
    },
  ]);
});

test("leftovers are what survived teardown; what the caller kept on purpose is named with its reason", () => {
  const ledger = openProcessLedger({ stageRoot: STAGE, readTable: tableOf([row(4, 0, "System")]) });
  const collected = collectProcessLedger(ledger, {
    query: queriesOf({ [STAGE]: [row(900, 4, "msedge.exe"), row(901, 900, "node.exe")] }),
    readTable: tableOf([row(4, 0, "System"), row(900, 4, "msedge.exe"), row(901, 900, "node.exe")]),
  });
  const reading = closeProcessLedger(ledger, collected, {
    readTable: tableOf([row(4, 0, "System"), row(900, 4, "msedge.exe")]),
    keptAlive: [{ pid: 900, reason: "stepwise run leaves this for the next phase" }],
  });
  assert.deepEqual(
    reading.entries.map((entry) => [entry.pid, entry.stillAliveAfter, entry.leftDeliberately]),
    [
      [900, true, "stepwise run leaves this for the next phase"],
      [901, false, null],
    ],
  );
  assert.deepEqual(reading.leftovers, [], "a deliberately kept process is not a leftover");
  assert.equal(reading.deliberatelyLeft.length, 1);
  const lines = describeProcessLedger(reading);
  assert.match(lines[0], /examined 2 run-owned, leftovers 0/u);
  assert.match(lines.join("\n"), /deliberately left 900\(stepwise run leaves this for the next phase\)/u);
});

test("a process this run ended without owning is collateral damage, and the line says so", () => {
  const ledger = openProcessLedger({ stageRoot: STAGE, readTable: tableOf([row(4, 0, "System")]) });
  const collected = collectProcessLedger(ledger, {
    query: queriesOf({ [STAGE]: [row(900, 4, "msedge.exe")] }),
    readTable: tableOf([row(4, 0, "System"), row(900, 4, "msedge.exe")]),
  });
  const reading = closeProcessLedger(ledger, collected, {
    readTable: tableOf([row(4, 0, "System")]),
    endedByRun: [900, 999],
  });
  assert.equal(reading.collateral.endedByRun, 2);
  assert.equal(reading.collateral.endedByRunUnowned, 1);
  assert.match(describeProcessLedger(reading).join("\n"), /COLLATERAL .* 2 pid\(s\) and 1 of them are not run-owned/u);
});

test("every ended pid being run-owned is printed as the reading it is, with the count", () => {
  const ledger = openProcessLedger({ stageRoot: STAGE, readTable: tableOf([row(4, 0, "System")]) });
  const collected = collectProcessLedger(ledger, {
    query: queriesOf({ [STAGE]: [row(900, 4, "msedge.exe")] }),
    readTable: tableOf([row(4, 0, "System"), row(900, 4, "msedge.exe")]),
  });
  const reading = closeProcessLedger(ledger, collected, {
    readTable: tableOf([row(4, 0, "System")]),
    endedByRun: [900],
  });
  assert.deepEqual(reading.collateral, {
    before: 1,
    after: 1,
    vanished: 0,
    vanishedOwned: 0,
    vanishedUnowned: 0,
    endedByRun: 1,
    endedByRunUnowned: 0,
  });
  const text = describeProcessLedger(reading).join("\n");
  assert.match(text, /full process table before=1 after=1; vanished=0 \(run-owned 0, not this run's 0\)/u);
  assert.match(text, /this run ended 1 pid\(s\), all of them run-owned; unowned-ended=0/u);
});

test("a process table this machine could not answer is unverifiable, never none", () => {
  const ledger = openProcessLedger({ stageRoot: STAGE, readTable: tableOf([row(4, 0, "System")]) });
  const collected = collectProcessLedger(ledger, {
    query: queriesOf({ [STAGE]: [row(900, 4, "msedge.exe")] }),
    readTable: tableOf([row(4, 0, "System"), row(900, 4, "msedge.exe")]),
  });
  const reading = closeProcessLedger(ledger, collected, { readTable: () => null, endedByRun: [900] });
  assert.equal(reading.collateral, null);
  assert.equal(reading.entries[0].stillAliveAfter, null, "unknown is not false");
  assert.match(describeProcessLedger(reading).join("\n"), /collateral unverifiable:collected/u);
});

test("a collect that could not read the table records no entries and says which reading failed", () => {
  const ledger = openProcessLedger({ stageRoot: STAGE, readTable: tableOf([row(4, 0, "System")]) });
  const collected = collectProcessLedger(ledger, { query: queriesOf({}), readTable: () => null });
  assert.deepEqual(collected.entries, []);
  assert.equal(collected.evidence, "process_table_unavailable");
});

test("the reading names the marker population it examined, so a zero is a measurement", () => {
  const ledger = openProcessLedger({ stageRoot: STAGE, gameDir: GAME_DIR, readTable: tableOf([]) });
  const collected = collectProcessLedger(ledger, { query: queriesOf({}), readTable: tableOf([]) });
  const reading = closeProcessLedger(ledger, collected, { readTable: tableOf([]) });
  assert.match(
    describeProcessLedger(reading)[0],
    /markers=\[stage,game-smapi\(created\),game-client\(created\)\] examined 0 run-owned, leftovers 0/u,
  );
});

test("the Host pid this run launched is recorded even when the table no longer holds it", () => {
  const ledger = openProcessLedger({ stageRoot: STAGE, hostPid: 8080, readTable: tableOf([]) });
  const collected = collectProcessLedger(ledger, { query: queriesOf({}), readTable: tableOf([]) });
  assert.deepEqual(
    collected.entries.map((entry) => [entry.pid, entry.commandLineMarker, entry.name, entry.startTime]),
    [[8080, "host", null, null]],
    "the pid came from launch.json, so it is this run's Host whether or not it is still alive",
  );
});

test("a stepwise run keeps everything it started, and says why per pid", () => {
  const entries = [
    { pid: 900, commandLineMarker: "stage" },
    { pid: 8080, commandLineMarker: "host" },
  ];
  assert.deepEqual(
    deliberatelyKept(entries, { stepwise: true }).map((entry) => entry.pid),
    [900, 8080],
  );
  assert.match(deliberatelyKept(entries, { stepwise: true })[0].reason, /next phase/u);
});

test("an ordinary close leaves the supervisor's tree alone and stops everything else", () => {
  const entries = [
    { pid: 900, commandLineMarker: "stage" },
    { pid: 8080, commandLineMarker: "host" },
    { pid: 9090, commandLineMarker: "guardian-tree" },
  ];
  const kept = deliberatelyKept(entries);
  assert.deepEqual(
    kept.map((entry) => entry.pid),
    [9090],
    "the game under the supervisor is the player's world; the Host is this run's AI authority and the browser is this run's to stop",
  );
  assert.match(kept[0].reason, /never the player's game/u);
});

test("a kept list that does not cover a live process leaves it a leftover", () => {
  const ledger = openProcessLedger({ stageRoot: STAGE, readTable: tableOf([row(4, 0, "System")]) });
  const collected = collectProcessLedger(ledger, {
    query: queriesOf({ [STAGE]: [row(900, 4, "msedge.exe")] }),
    readTable: tableOf([row(4, 0, "System"), row(900, 4, "msedge.exe")]),
  });
  const reading = closeProcessLedger(ledger, collected, {
    readTable: tableOf([row(4, 0, "System"), row(900, 4, "msedge.exe")]),
    keptAlive: deliberatelyKept([], { stepwise: true }),
  });
  assert.deepEqual(
    reading.leftovers.map((entry) => entry.pid),
    [900],
    "the ledger reports what it can see, not what the caller meant",
  );
});

test("a record with nothing in it says which of the three zeroes it is", () => {
  const ledger = openProcessLedger({ stageRoot: STAGE, readTable: tableOf([row(4, 0, "System")]) });
  const quiet = closeProcessLedger(
    ledger,
    collectProcessLedger(ledger, { readTable: tableOf([row(4, 0, "System")]) }),
    {
      readTable: tableOf([row(4, 0, "System")]),
    },
  );
  assert.equal(quiet.population, "nothing_created", "an invocation that spawned nothing has nothing to leave behind");
  assert.match(describeProcessLedger(quiet)[0], /created no process that outlived its work/u);

  const registeredButUnanswered = closeProcessLedger(
    ledger,
    collectProcessLedger(ledger, {
      registry: [{ pid: 4242, role: "capture:w-game-launch" }],
      readTable: tableOf([row(4, 0, "System")]),
    }),
    { readTable: tableOf([row(4, 0, "System")]) },
  );
  // The registered pid is recorded even after it exited, so this reading is a measurement, not the gap above.
  assert.equal(registeredButUnanswered.population, "measured");
  assert.match(describeProcessLedger(registeredButUnanswered)[0], /examined 1 run-owned, leftovers 0/u);
});

test("an unmeasured population is named, never printed as a clean zero", () => {
  // The shape this guards: a table read that came back empty while the run had registered pids. The record is
  // then silent about leftovers, so the line has to say so - `examined 0 run-owned, leftovers 0` alone is a
  // reading that agrees with itself.
  const ledger = openProcessLedger({ stageRoot: STAGE, readTable: tableOf([row(4, 0, "System")]) });
  const collected = collectProcessLedger(ledger, { registry: [], readTable: tableOf([row(4, 0, "System")]) });
  const reading = closeProcessLedger(
    ledger,
    { ...collected, registered: 3 },
    { readTable: tableOf([row(4, 0, "System")]) },
  );
  assert.equal(reading.population, "unmeasured");
  assert.match(describeProcessLedger(reading)[0], /UNMEASURED: 3 registered pid/u);
});

test("a kept pid that exited on its own is neither a leftover nor 'left behind'", () => {
  // Measured 2026-11-15: a stepwise `check` run marked every entry kept, including one whose process had
  // already exited, and the line read `deliberately left 36396(...)` about a pid that was gone - a sentence
  // about a process that did not exist. The kept list says what MAY stay; the table says what DID.
  const ledger = openProcessLedger({ stageRoot: STAGE, readTable: tableOf([row(4, 0, "System")]) });
  const collected = collectProcessLedger(ledger, {
    query: queriesOf({ [STAGE]: [row(900, 4, "msedge.exe")] }),
    readTable: tableOf([row(4, 0, "System"), row(900, 4, "msedge.exe")]),
  });
  const reading = closeProcessLedger(ledger, collected, {
    readTable: tableOf([row(4, 0, "System")]),
    keptAlive: deliberatelyKept(collected.entries, { stepwise: true }),
  });
  assert.deepEqual(reading.leftovers, []);
  assert.deepEqual(reading.deliberatelyLeft, [], "a pid that is gone was not left behind by anyone");
  assert.equal(reading.entries[0].stillAliveAfter, false);
  assert.doesNotMatch(describeProcessLedger(reading).join("\n"), /deliberately left/u);
});

test("the reading says how many rows the process table could not date, instead of leaving a blank column", () => {
  const ledger = openProcessLedger({ stageRoot: STAGE, readTable: tableOf([row(4, 0, "System")]) });
  const collected = collectProcessLedger(ledger, {
    registry: [{ pid: 4242, role: "launch-driver" }],
    query: queriesOf({}),
    readTable: tableOf([row(4, 0, "System")]),
  });
  const reading = closeProcessLedger(ledger, collected, { readTable: tableOf([row(4, 0, "System")]) });
  assert.match(
    describeProcessLedger(reading).join("\n"),
    /1 of 1 entries had already exited when the ledger collected them/u,
    "a registry row with no name and no start time is partial, and the reading has to say so",
  );
});
