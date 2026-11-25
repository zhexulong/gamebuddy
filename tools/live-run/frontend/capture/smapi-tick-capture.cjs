// THE RUN'S OWN COPY OF THE GAME'S LAST WORDS, taken at every plateau poll.
//
// THE FILE IS SHARED, SO A READING IS NOT A COPY. `SMAPI-latest.txt` holds one session at a time and every game
// start TRUNCATES it (`smapi-log-attribution.cjs`): a sibling game that starts after this run's Player Host has
// died destroys this run's lines and keeps its own. That is not a hypothesis - it is what happened
// (`.tmp/lane-whycrah.md` §1): the Host's game ended at 21:02:02, a sibling truncated the file at 05:02:11, and
// the only surviving statement about the death was the single line the driver had PRINTED while the file still
// held it. Every later reader had to re-derive the exit from frame counters and a trace that lied (§4).
//
// So the sampler keeps what it read. Every plateau poll (`w-game-launch.cjs` `sampleLaunchFacts`, through the
// reading it refreshes) hands this module the attribution it just made, and the lines ATTRIBUTED TO THIS RUN are
// written to `<state>/smapi/<tick>.txt`. A sibling overwriting the machine's one log cannot reach a copy this run
// already wrote, and the run's own state directory is the same directory the launch state, the ledger and the run
// config live in.
//
// A TICK IS A DISTINCT STATE OF THE LOG, not a clock. The sampler reads the same file several times per progress line
// and once more per cabin step; writing a copy per READ would spend the whole window on 24 copies of one unchanged
// file. A reading whose files look exactly as they did at the previous tick adds no file, and the tick it returns is
// still the one that holds those lines.
//
// WHY IT IS BOUNDED, AND HOW THE ONE TICK THAT MATTERS SURVIVES THE BOUND. A launch wait of the default 300 s at
// the 5 s poll is 60 copies of a growing log, and the cabin handoff after it adds more; keeping every one of them
// would cost megabytes per run for text whose only value is its END. The last `KEPT_TICKS` polls are kept instead.
// The exception is the tick that carried a save or an exit sentence: it is pinned, so the drain can quote the line
// the run exists to quote even when a hundred quiet polls came after it. That is also why the collection is
// bounded-and-drained rather than simply truncated: eviction never removes the newest tick that carried the fact
// the collection is for.
const { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } = require("node:fs");
const path = require("node:path");

/**
 * How many tick files survive: 24 polls. At the launch wait's 5 s cadence that is the last two minutes, which is
 * an order of magnitude more than the interval between the last useful line and the process's end in the run this
 * instrument exists for (11 s of game life, 1.3 s from the last 60 fps heartbeat to the last trace flush), while
 * capping the evidence at a few megabytes. The pinned save/exit tick is kept beside them (`keep + 1` at most).
 */
const KEPT_TICKS = 24;

/** One tick file, named by its poll number so a directory listing is the run's own timeline. */
const TICK_FILE = /^(\d{4,})\.txt$/u;

/**
 * The sentences that say a save or an exit HAPPENED, each with where its spelling comes from. A tick that carries
 * one is the tick a reader goes back to, and the set is printed when the drain finds none, so "no line mentions a
 * save or an exit" is a reading of a known population instead of an absence.
 *
 *   `SaveGame.Save()`  the engine's own save. Measured 2026-11-26, the last line the run read while its world was
 *                      live: `SaveGame.Save() completed without exceptions.`
 *   `saving=true`      the Mod's own tick instrumentation publishes `saving={Game1.game1.IsSaving}`
 *                      (`ModEntry.Instrumentation.cs`), which is the only place a save IN PROGRESS is visible.
 *   `ReturnedToTitle`  the engine's own word for leaving a world, and the Mod's event of the same name.
 *   `Disposing`        SMAPI tears down on a rolling log file, and a shutdown sentence has NO RECORDED SPELLING in
 *                      this repository - the run that would have carried one was truncated. The WORD is matched
 *                      instead, and whatever line carries it is quoted, never interpreted.
 */
const SAVE_OR_EXIT = Object.freeze([
  /SaveGame\.Save\(\)/u,
  /\bsaving=true\b/u,
  /\bReturnedToTitle\b/u,
  /\bDisposing\b/u,
]);

/** The set as the drain prints it, because a search whose pattern is invisible cannot be judged. */
const SAVE_OR_EXIT_NAMES = Object.freeze(["SaveGame.Save()", "saving=true", "ReturnedToTitle", "Disposing"]);

/** The last line of `lines` that mentions a save or an exit, or `null` when none does. */
function saveOrExitLine(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (typeof line === "string" && SAVE_OR_EXIT.some((pattern) => pattern.test(line))) return line;
  }
  return null;
}

/** One reading as the log looked, so an unchanged file does not spend a tick of the window. */
function readingSignature(reading) {
  if (reading === null || reading === undefined) return "none";
  const files = Array.isArray(reading.files) ? reading.files : [];
  return `${String(reading.state)}|${files.map((file) => `${String(file.name)}:${String(file.bytes)}:${String(file.writtenAtMs)}`).join(",")}`;
}

/** Every tick file this run wrote into `directory`, oldest first, by its own poll number. */
function tickFiles(directory) {
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const matched = TICK_FILE.exec(name);
      return matched === null ? null : { tick: Number(matched[1]), file: path.join(directory, name) };
    })
    .filter((entry) => entry !== null)
    .sort((left, right) => left.tick - right.tick);
}

/** One tick file's lines, or `null` when it cannot be read any more. */
function readTick(file) {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/u).filter((line) => line.length > 0);
  } catch {
    return null;
  }
}

/**
 * The run's per-tick copy of the game's own log.
 *
 * `directory` is `<stage>/state/smapi`; a run with no state directory passes `null` and gets a capture that writes
 * nothing and says WHY, because a run with no copy and a run with a copy of nothing are different facts.
 *
 * `capture(reading, atMs)` keeps one tick and returns it (`{tick, file, atMs, lines, lifecycle}`), or `null` when
 * the copy could not be written (the reason then travels in `describe()`). A reading that says the log looks
 * exactly as it did at the previous tick writes no new file and returns the previous tick: a tick is a distinct
 * state of the game's own log, so identical polls do not spend the window (the sampler reads the same file twice per
 * progress line and several times per cabin step, and 24 copies of one unchanged file are 24 copies of nothing).
 * `drain(reading, atMs)` keeps the last copy and answers which SURVIVING tick holds the last save/exit line.
 */
function createSmapiTickCapture({ directory, keep = KEPT_TICKS } = {}) {
  const enabled = typeof directory === "string" && directory.length > 0;
  const keptCount = Number.isSafeInteger(keep) && keep > 0 ? keep : KEPT_TICKS;
  let tick = 0;
  let pinned = null;
  let last = null;
  let signature = null;
  let evicted = 0;
  let failure = enabled
    ? null
    : "this run was handed no launch state, so it cannot name its own state directory to keep a copy in";

  const evict = () => {
    const files = tickFiles(directory);
    const excess = files.length - keptCount;
    if (excess <= 0) return;
    let removed = 0;
    for (const entry of files) {
      if (removed >= excess) break;
      if (entry.tick === pinned) continue;
      try {
        unlinkSync(entry.file);
        removed += 1;
      } catch {
        // A file that cannot be removed is still a file the drain can read; the bound is best-effort by design.
        break;
      }
    }
    evicted += removed;
  };

  const capture = (reading, atMs = Date.now()) => {
    if (!enabled) return null;
    const lines = Array.isArray(reading?.ownLines) ? reading.ownLines : [];
    const seen = readingSignature(reading);
    if (seen === signature && last !== null) return last;
    tick += 1;
    const file = path.join(directory, `${String(tick).padStart(4, "0")}.txt`);
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(file, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
    } catch (error) {
      failure = `tick ${String(tick)} could not be kept: ${String(error?.code ?? error)}`;
      return null;
    }
    signature = seen;
    const lifecycle = saveOrExitLine(lines);
    if (lifecycle !== null) pinned = tick;
    last = { tick, file, atMs, lines: lines.length, lifecycle };
    evict();
    return last;
  };

  /** Which tick file the run still holds carries the last save/exit line: the fact the drain prints. */
  const lastSaveOrExit = () => {
    const files = tickFiles(directory);
    let examined = 0;
    for (let index = files.length - 1; index >= 0; index -= 1) {
      const lines = readTick(files[index].file);
      if (lines === null) continue;
      examined += 1;
      const line = saveOrExitLine(lines);
      if (line !== null) return { tick: files[index].tick, file: files[index].file, line, examined };
    }
    return { tick: null, file: null, line: null, examined, held: files.length };
  };

  const describe = () => {
    const files = tickFiles(directory);
    if (!enabled || (tick === 0 && failure !== null))
      return [
        `smapi_tick_capture: no copy of the game's own log was kept (${String(failure)}) - a sibling game that overwrites SMAPI-latest.txt would destroy this run's only evidence`,
      ];
    const head =
      `smapi_tick_capture: ${String(tick)} distinct observation(s) of the game's own log kept the lines attributed to this run in ${directory}; ` +
      `${String(files.length)} tick file(s) survive (keep=${String(keptCount)} ticks, plus the newest tick that carried a save or an exit, which eviction never removes${evicted === 0 ? "" : `; ${String(evicted)} evicted`})`;
    const lines = [head, ...(failure === null ? [] : [`smapi_tick_capture_failure: ${failure}`])];
    if (last !== null)
      lines.push(
        `smapi_tick_capture_latest: tick ${String(last.tick)} at ${new Date(last.atMs).toISOString()}: ${String(last.lines)} line(s) of this run's in ${last.file}`,
      );
    const found = lastSaveOrExit();
    lines.push(
      found.line === null
        ? `smapi_tick_capture_last_save_or_exit: none - none of the ${String(found.examined)} readable tick file(s) carries a line mentioning one of [${SAVE_OR_EXIT_NAMES.join(", ")}] (the game logged no save and no exit this run kept)`
        : `smapi_tick_capture_last_save_or_exit: tick ${String(found.tick)} at ${found.file}: ${JSON.stringify(found.line)}`,
    );
    return lines;
  };

  return {
    capture,
    // The block the drain prints: how many ticks survived, the latest one, and which tick holds the last save or exit.
    describe,
    // The drain: one more copy at the moment the run ends, then the block above.
    drain: (reading, atMs = Date.now()) => {
      capture(reading, atMs);
      return describe();
    },
  };
}

module.exports = {
  createSmapiTickCapture,
  saveOrExitLine,
  // Spelled out for the tests that hold the bound and the drain against files a sibling game has overwritten.
  KEPT_TICKS,
  SAVE_OR_EXIT_NAMES,
};
