/*
 * Which lines of the machine's one SMAPI log belong to this run.
 *
 * What these assertions protect: `SMAPI-latest.txt` holds every game's lines on this machine, and on
 * 2026-11-26 the launch-chain driver read the LAST `Context: loaded save '…'` in it and reported another
 * lane's world (`GameBuddyFixturePaired_453048112`) as this run's, while this run's own world was
 * `GameBuddyFarm_455241764` (`.tmp/lane-round33c.md` §6). A reader that cannot say which lines are its own
 * turns somebody else's game into this run's evidence.
 *
 * The three counts are asserted through ONE line, `smapi_lines: this_run=<n> other_run=<n> unattributable=<n>`,
 * because that is the line a reader compares across runs; the per-file decision behind it is asserted
 * separately, so "0 other_run" on a file whose header was overwritten is never read as a clean file.
 *
 * red-proof: inject  `attributeLogFile` treating a foreign `Context: loaded save '<name>'` as ordinary
 *                   (no `foreignSaves`, no contest): `✖ another game's save line makes the file contested and
 *                   is counted as another run's` fails on `lines.otherRun`, exit 1 (measured 2026-11-26).
 * red-proof: inject  the one-session decision kept when a foreign save line is present: the same assertion
 *                   fails on `decision` (`one_session_of_this_run` instead of `contested`), exit 1.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

// The kit is CommonJS beside the drivers it shares; `require` from an ESM test file is how every
// `capture/*.test.mjs` reaches its subject when the subject is a `.cjs` module.
const require = createRequire(import.meta.url);
const {
  attributeSmapiLog,
  describeSmapiAttribution,
  lastOwnLine,
  smapiLogFiles,
} = require("./smapi-log-attribution.cjs");

/** This run's own stage root, and the data root the Host passes to SMAPI as `--mods-path`. */
const STAGE = "D:\\gb-runs\\round33c-out2.stage";
const DATA_ROOT = `${STAGE}\\root\\GameBuddy\\data`;
const OWN_MODS = `${DATA_ROOT}\\stardew-private-bootstrap\\131eb164-0000\\player-host\\Mods`;
const OWN_WORLD = "GameBuddyFarm_455241764";

/** Another lane's mods path, as that lane's `--mods-path` wrote it into the same file. */
const OTHER_MODS = "E:\\projects\\ai-game-companion\\.tmp\\multiplayer-loop-0c58ace1\\probe\\host";
const OTHER_WORLD = "GameBuddyFixturePaired_453048112";

/** A file as `readLogFile` shapes it; the fs path is exercised separately below. */
const file = (lines, name = "SMAPI-latest.txt", extra = {}) => ({
  name,
  file: `C:\\logs\\${name}`,
  bytes: 1024,
  writtenAtMs: 1_800_000_000_000,
  truncated: false,
  lines,
  ...extra,
});

/** SMAPI's own header, as the machine writes it for a game started with `--mods-path`. */
const header = (modsPath, at = "2026-11-25T19:29:42 UTC") => [
  "[03:29:42 INFO  SMAPI] SMAPI 4.5.2 with Stardew Valley 1.6.15 build 24356 on Windows 11 (10.0.26300.0)",
  `[03:29:42 INFO  SMAPI] Mods go here: ${modsPath}`,
  "[03:29:42 TRACE SMAPI] (Using custom --mods-path argument. Game folder: D:\\Steam\\steamapps\\common\\Stardew Valley.)",
  `[03:29:42 TRACE SMAPI] Log started at ${at}`,
];

const own = { ownMarkers: [STAGE, DATA_ROOT], ownWorldNames: [OWN_WORLD] };

test("one session, this run's, and nothing contradicting it: every line is this run's", () => {
  const reading = attributeSmapiLog({
    ...own,
    logFiles: {
      state: "read",
      logDir: "C:\\logs",
      reason: null,
      files: [
        file([
          ...header(OWN_MODS),
          `[03:29:51 TRACE game] Context: loaded save '${OWN_WORLD}', starting season 0 of year 1`,
          "[03:29:52 TRACE GameBuddy] gave the companion world a native Cabin on the free pad; cabins_now=1",
        ]),
      ],
    },
  });
  assert.equal(reading.files[0].decision, "one_session_of_this_run");
  assert.deepEqual(reading.lines, { thisRun: 6, otherRun: 0, unattributable: 0 });
  assert.equal(describeSmapiAttribution(reading)[0], "smapi_lines: this_run=6 other_run=0 unattributable=0");
  // The last own line is the one a progress line quotes; its source travels with it.
  assert.deepEqual(lastOwnLine(reading), {
    line: "[03:29:52 TRACE GameBuddy] gave the companion world a native Cabin on the free pad; cabins_now=1",
    writtenAtMs: 1_800_000_000_000,
    source: "SMAPI-latest.txt",
  });
});

test("another game's save line makes the file contested and is counted as another run's", () => {
  /*
   * THE MEASURED FILE. Our header is at offset 0 (our game truncated the file when it started), and the
   * earlier lane's game kept appending at its own offset - so the surviving save line is THAT lane's world.
   * One session header does not make the file ours, and the reader must not use what it cannot bind.
   */
  const reading = attributeSmapiLog({
    ...own,
    logFiles: {
      state: "read",
      logDir: "C:\\logs",
      reason: null,
      files: [
        file([
          ...header(OWN_MODS),
          "[03:29:47 TRACE SMAPI]    GameBuddy (from Mods\\GameBuddy\\GameBuddy.Stardew.dll, ID: zhexulong.GameBuddy)...",
          `[03:29:49 TRACE game] Context: loaded save '${OTHER_WORLD}', starting season 0 of year 1`,
          "[03:29:52 INFO  GameBuddy] salient event TimeMilestone skipped: bridge session unavailable.",
          "[03:29:53 WARN  SMAPI] another game's line with no path at all",
        ]),
      ],
    },
  });
  const [only] = reading.files;
  assert.equal(only.decision, "contested");
  assert.deepEqual(only.foreignSaves, [OTHER_WORLD]);
  // Our header's `Mods go here:` line is ours; the other game's save line is not.
  assert.equal(only.lines.thisRun, 1);
  assert.equal(only.lines.otherRun, 1);
  // Everything else - the version line, the `--mods-path` note, `Log started at`, the Mod's own lines, the
  // `bridge session unavailable` line - carries no marker: nobody can say which game wrote it, so it is used
  // for nothing.
  assert.equal(only.lines.unattributable, 6);
  assert.deepEqual(reading.lines, { thisRun: 1, otherRun: 1, unattributable: 6 });
  assert.match(
    describeSmapiAttribution(reading)[1],
    /-> contested: 1 line\(s\) name this run; save\(s\) 'GameBuddyFixturePaired_453048112'; 6 line\(s\) cannot be attributed to either and are not used$/u,
  );
  // The only line this reader will quote is the header it can prove.
  assert.equal(lastOwnLine(reading).line, `[03:29:42 INFO  SMAPI] Mods go here: ${OWN_MODS}`);
});

test("a file whose only session is another run's attributes nothing to this run", () => {
  const reading = attributeSmapiLog({
    ...own,
    logFiles: {
      state: "read",
      logDir: "C:\\logs",
      reason: null,
      files: [
        file([
          ...header(OTHER_MODS, "2026-11-25T19:29:09 UTC"),
          `[03:29:15 TRACE game] Context: loaded save '${OTHER_WORLD}', starting season 0 of year 1`,
        ]),
      ],
    },
  });
  assert.equal(reading.files[0].decision, "foreign_session");
  assert.equal(reading.lines.thisRun, 0);
  assert.equal(lastOwnLine(reading), null);
  // Two lines name the other game by name (its `Mods go here:` and its save); the rest of its header binds to
  // nothing, and neither game's lines are guessed.
  assert.match(describeSmapiAttribution(reading)[0], /^smapi_lines: this_run=0 other_run=2 unattributable=3$/u);
});

test("an empty file and an absent log directory are different answers, and neither is a zero game", () => {
  const empty = attributeSmapiLog({
    ...own,
    logFiles: {
      state: "read",
      logDir: "C:\\logs",
      reason: null,
      files: [file([], "SMAPI-latest.player-2.txt", { bytes: 0 })],
    },
  });
  assert.equal(empty.files[0].decision, "absent");
  assert.match(
    describeSmapiAttribution(empty)[1],
    /^smapi_attribution: SMAPI-latest\.player-2\.txt \(0 bytes, 0 line\(s\)\): empty - nothing to attribute$/u,
  );

  const absent = attributeSmapiLog({
    ...own,
    logFiles: {
      state: "absent",
      logDir: null,
      files: [],
      reason: "no APPDATA, so this machine's SMAPI log directory is unknown",
    },
  });
  assert.equal(absent.state, "absent");
  assert.equal(
    describeSmapiAttribution(absent)[0],
    "smapi_lines: this_run=0 other_run=0 unattributable=0 (no APPDATA, so this machine's SMAPI log directory is unknown)",
  );
});

test("the files are found by SMAPI's own naming, and a rotated crash log is not one of them", () => {
  const logDir = mkdtempSync(join(tmpdir(), "gb-smapi-attribution-"));
  writeFileSync(
    join(logDir, "SMAPI-latest.txt"),
    [...header(OWN_MODS), `[03:29:51 TRACE game] Context: loaded save '${OWN_WORLD}'`].join("\r\n"),
    "utf8",
  );
  writeFileSync(join(logDir, "SMAPI-latest.player-2.txt"), "", "utf8");
  writeFileSync(join(logDir, "SMAPI-crash.txt"), "[00:00:00 FATAL SMAPI] not a session\n", "utf8");
  writeFileSync(join(logDir, "gamebuddy-trace-20261126-032942.json"), "{}", "utf8");

  const listed = smapiLogFiles({ logDir });
  assert.equal(listed.state, "read");
  assert.deepEqual(
    listed.files.map((entry) => entry.name),
    ["SMAPI-latest.player-2.txt", "SMAPI-latest.txt"],
  );

  const reading = attributeSmapiLog({ ...own, logDir });
  assert.deepEqual(
    reading.files.map((entry) => entry.decision),
    ["absent", "one_session_of_this_run"],
  );
  assert.equal(describeSmapiAttribution(reading)[0], "smapi_lines: this_run=5 other_run=0 unattributable=0");
  assert.equal(reading.source, "SMAPI-latest.player-2.txt + SMAPI-latest.txt");
});
