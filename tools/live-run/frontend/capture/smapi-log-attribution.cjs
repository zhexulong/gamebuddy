// WHICH SMAPI LOG LINES ARE THIS RUN'S, and how many are somebody else's.
//
// THE FILE IS SHARED AND IT IS NOT A HINT OF SHARING. SMAPI keeps ONE log file per game SESSION in
// `%APPDATA%\StardewValley\ErrorLogs`: `SMAPI-latest.txt`, plus `SMAPI-latest.player-N.txt` for the extra
// split-screen players of the same session. A game that starts later TRUNCATES `SMAPI-latest.txt` and writes
// its own header at offset 0, while an earlier game keeps appending at its own file offset - so on a machine
// running two games the same file holds this run's header and the other game's lines, in no order and with
// no marker between them.
//
// Measured 2026-11-26 (`ROUND33`, `.tmp/lane-round33c.md` §6): the launch-chain driver read that file as
// "the launched game's own log", took the LAST match of its save pattern, and reported another lane's
// `GameBuddyFixturePaired_453048112` as this run's loaded world - while this run's own world was
// `GameBuddyFarm_455241764`. The `bridge session unavailable` lines it quoted may equally have been that
// lane's. Nothing in the earlier reader could tell.
//
// NO LINE CARRIES A PID, so "attribute by pid" has to be said the way the file can answer it: by the
// per-run MARKER the process was started with. SMAPI's header is
//
//     [03:39:33 INFO  SMAPI] SMAPI 4.5.2 with Stardew Valley 1.6.15 build 24356 ...
//     [03:39:33 INFO  SMAPI] Mods go here: <the --mods-path the game was started with>
//     [03:39:33 TRACE SMAPI] (Using custom --mods-path argument. Game folder: ...)
//     [03:39:33 TRACE SMAPI] Log started at 2026-11-25T19:39:33 UTC
//
// and `Mods go here:` is the Host's own `--mods-path <this run's declared data root>/.../player-host/Mods` -
// a path only this run can produce, which is the same marker `lib/run-game.mjs` claims a run's game by.
// `Context: loaded save '<slot>'` carries the world name the run's fixture claimed (`fixture-world.cjs`).
//
// THE THREE COUNTS, and what each one may be used for:
//
//   this_run        every line of a file that holds exactly ONE session, whose `Mods go here:` names this
//                   run (nothing contradicts it); or the lines that carry this run's marker / world name.
//   other_run       a `Mods go here:` naming another path, a `Context: loaded save '<name>'` naming a world
//                   that is not this run's, or a session start beside this run's own.
//   unattributable  no marker either way, in a file that is contested: these are NOT this run's and are
//                   never used for a fact. A `bridge session unavailable` line is this, and the honest
//                   answer for it is "somebody's, and this reader cannot say whose".
//
// WHAT THIS CANNOT DO, and why the real gate is the machine (`lib/machine-quiet.mjs`) and not this file: a
// foreign game whose header was overwritten and whose surviving lines carry no path leaves no trace at all,
// and its lines then read as this run's by the one-header rule. Only a machine with no other game on it can
// make that residue empty - which is exactly why a launch refuses to start on one.
const { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } = require("node:fs");
const path = require("node:path");

/** How much of one log file is read: the head, where the session header is. */
const READ_BUDGET_BYTES = 4 * 1024 * 1024;

/** The files SMAPI keeps for every game on the machine. */
const LOG_FILE_NAME = /^SMAPI-latest(?:\.player-\d+)?\.txt$/iu;

/** The session's own first fact, and the two markers a reader can bind a line to. */
const SESSION_START = /\] Log started at /u;
const MODS_GO_HERE = /\] Mods go here: (.*)$/u;
const SAVE_LOADED = /Context: loaded save '([^']+)'/u;

/** The directory every Stardew process on this machine writes its log into, or `null` with no APPDATA. */
function smapiLogDir() {
  const appData = process.env.APPDATA;
  if (typeof appData !== "string" || appData.length === 0) return null;
  return path.join(appData, "StardewValley", "ErrorLogs");
}

/** A path as it is compared: one separator, one case, because SMAPI spells what it was given. */
const normalized = (text) => String(text).replace(/\//gu, "\\").toLowerCase();

/** Whether `text` names any of `markers` - this run's stage paths, or the world it claimed. */
function namesAny(text, markers) {
  const haystack = normalized(text);
  return markers.some((marker) => typeof marker === "string" && marker.length > 0 && haystack.includes(normalized(marker)));
}

/**
 * One SMAPI log file, bounded: `{ name, file, bytes, writtenAtMs, lines, truncated }`, or `{ name, file, reason }`
 * when it could not be read.
 */
function readLogFile(file) {
  const name = path.basename(file);
  let size;
  let writtenAtMs;
  try {
    const info = statSync(file);
    size = info.size;
    writtenAtMs = info.mtimeMs;
  } catch (error) {
    return { name, file, reason: `unreadable:${String(error?.code ?? error)}` };
  }
  if (size === 0) return { name, file, bytes: 0, writtenAtMs, lines: [], truncated: false };
  let text;
  try {
    const fd = openSync(file, "r");
    try {
      const length = Math.max(0, Math.min(READ_BUDGET_BYTES, size));
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, 0);
      text = buffer.toString("utf8", 0, read);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return { name, file, reason: `unreadable:${String(error?.code ?? error)}` };
  }
  return {
    name,
    file,
    bytes: size,
    writtenAtMs,
    truncated: size > READ_BUDGET_BYTES,
    lines: text.split(/\r?\n/gu).filter((line) => line.trim().length > 0),
  };
}

/**
 * Every SMAPI log file on this machine, in a stable order.
 *
 * `state` is `read` / `absent` (no log directory: no game has ever run here) / `unreadable` (the directory
 * exists and could not be listed). A caller must not fold `absent` into an empty read: one means "nothing
 * to read", the other means "nobody looked".
 */
function smapiLogFiles({ logDir = smapiLogDir() } = {}) {
  if (typeof logDir !== "string" || logDir.length === 0)
    return { state: "absent", logDir: null, files: [], reason: "no APPDATA, so this machine's SMAPI log directory is unknown" };
  let names;
  try {
    names = readdirSync(logDir);
  } catch (error) {
    return {
      state: "unreadable",
      logDir,
      files: [],
      reason: `the SMAPI log directory could not be listed: ${String(error?.code ?? error)}`,
    };
  }
  const matched = names.filter((name) => LOG_FILE_NAME.test(name)).sort((left, right) => left.localeCompare(right));
  return { state: "read", logDir, files: matched.map((name) => readLogFile(path.join(logDir, name))), reason: null };
}

/**
 * One file's lines, attributed: `{ name, decision, lines: {thisRun, otherRun, unattributable}, ownLines, ... }`.
 *
 * The decision names how the file was read, because "every line is this run's" and "only the three lines
 * naming this run are" are different claims about the same file:
 *
 *   absent              empty file (SMAPI created it and wrote nothing yet)
 *   foreign_session     one session header, and its `Mods go here:` is another run's
 *   one_session_of_this_run  one session header, this run's, and nothing contradicts it
 *   contested           this run's header beside another game's markers, or more than one session start
 *   no_session_header   no `Log started at` line survived; only lines carrying this run's marker are used
 */
function attributeLogFile(file, { ownMarkers, ownWorldNames }) {
  const base = { name: file.name, file: file.file, bytes: file.bytes ?? 0, writtenAtMs: file.writtenAtMs ?? null };
  if (file.reason !== undefined)
    return { ...base, decision: "unreadable", reason: file.reason, lines: { thisRun: 0, otherRun: 0, unattributable: 0 }, ownLines: [], foreignSaves: [], modsPaths: [] };
  const lines = file.lines;
  if (lines.length === 0)
    return { ...base, decision: "absent", lines: { thisRun: 0, otherRun: 0, unattributable: 0 }, ownLines: [], foreignSaves: [], modsPaths: [] };

  const modsPaths = [];
  const saveNames = [];
  let sessionStarts = 0;
  for (const line of lines) {
    if (SESSION_START.test(line)) sessionStarts += 1;
    const mods = MODS_GO_HERE.exec(line);
    if (mods !== null) modsPaths.push(mods[1].trim());
    const save = SAVE_LOADED.exec(line);
    if (save !== null && !saveNames.includes(save[1])) saveNames.push(save[1]);
  }
  const ownModsPaths = modsPaths.filter((entry) => namesAny(entry, ownMarkers));
  const foreignModsPaths = modsPaths.filter((entry) => namesAny(entry, ownMarkers) === false);
  // A save name is another run's only when this run's own world name is KNOWN; with no world claimed yet
  // the reader has nothing to compare against and claims nothing either way.
  const knowsWorld = ownWorldNames.length > 0;
  const ownSaves = saveNames.filter((name) => namesAny(name, ownWorldNames));
  const foreignSaves = knowsWorld ? saveNames.filter((name) => namesAny(name, ownWorldNames) === false) : [];

  const contested = foreignModsPaths.length > 0 || foreignSaves.length > 0 || sessionStarts > 1;
  const ownSession =
    contested === false && sessionStarts === 1 && ownModsPaths.length > 0 ? "one_session_of_this_run" : null;
  const decision =
    ownSession ??
    (sessionStarts >= 1 && ownModsPaths.length === 0 && foreignModsPaths.length > 0
      ? "foreign_session"
      : contested
        ? "contested"
        : "no_session_header");

  const lines_ = { thisRun: 0, otherRun: 0, unattributable: 0 };
  const ownLines = [];
  if (decision === "one_session_of_this_run") {
    lines_.thisRun = lines.length;
    ownLines.push(...lines);
  } else {
    for (const line of lines) {
      if (namesAny(line, ownMarkers) || namesAny(line, ownWorldNames)) {
        lines_.thisRun += 1;
        ownLines.push(line);
        continue;
      }
      const mods = MODS_GO_HERE.exec(line);
      const save = SAVE_LOADED.exec(line);
      const namesOtherMods = mods !== null && namesAny(mods[1].trim(), ownMarkers) === false;
      const namesOtherSave = save !== null && namesAny(save[1], ownWorldNames) === false && knowsWorld;
      if (namesOtherMods || namesOtherSave) {
        lines_.otherRun += 1;
        continue;
      }
      lines_.unattributable += 1;
    }
  }
  return {
    ...base,
    decision,
    reason: null,
    sessionStarts,
    modsPaths,
    saveNames,
    foreignSaves,
    ownSaves,
    truncated: file.truncated === true,
    lines: lines_,
    ownLines,
  };
}

/**
 * Every SMAPI log file on this machine, attributed against this run's own markers.
 *
 * `ownMarkers` are paths only this run can produce (`<stage>`, `<stage>/root/GameBuddy/data`, ...);
 * `ownWorldNames` are the world names this run's fixture claimed. Both are optional, and the reading says
 * which of them it had - an attribution made without a world name cannot call a save line another run's.
 */
function attributeSmapiLog({ logDir, ownMarkers = [], ownWorldNames = [], logFiles = null } = {}) {
  const listed = logFiles ?? smapiLogFiles({ logDir });
  const files = Array.isArray(listed.files)
    ? listed.files.map((file) => attributeLogFile(file, { ownMarkers, ownWorldNames }))
    : [];
  const lines = { thisRun: 0, otherRun: 0, unattributable: 0 };
  const ownLines = [];
  const foreignSaves = [];
  const headers = [];
  for (const file of files) {
    lines.thisRun += file.lines.thisRun;
    lines.otherRun += file.lines.otherRun;
    lines.unattributable += file.lines.unattributable;
    ownLines.push(...file.ownLines);
    for (const name of file.foreignSaves ?? []) if (!foreignSaves.includes(name)) foreignSaves.push(name);
    for (const mods of file.modsPaths ?? [])
      if (namesAny(mods, ownMarkers) === false && !headers.includes(mods)) headers.push(mods);
  }
  const writtenAtMs = files.reduce(
    (newest, file) => (typeof file.writtenAtMs === "number" && (newest === null || file.writtenAtMs > newest) ? file.writtenAtMs : newest),
    null,
  );
  return {
    state: listed.state,
    reason: listed.reason ?? null,
    logDir: listed.logDir ?? null,
    ownMarkers,
    ownWorldNames,
    files,
    lines,
    ownLines,
    foreignSaves,
    foreignModsPaths: headers,
    writtenAtMs,
    source: files.length === 0 ? null : files.map((file) => file.name).join(" + "),
  };
}

/** The last line attributable to THIS run, as `{ line, writtenAtMs, source }`, or `null`. */
function lastOwnLine(reading) {
  if (reading === null || reading === undefined || reading.ownLines.length === 0) return null;
  return {
    line: reading.ownLines[reading.ownLines.length - 1],
    writtenAtMs: reading.writtenAtMs,
    source: reading.source,
  };
}

/**
 * The one line every reading prints, and the per-file decision behind it.
 * `smapi_lines:` is the count a reader compares across a run; the `smapi_attribution:` line per file says
 * how each file was decided, so "0 other_run" on a contested file is never mistaken for a clean one. The last
 * line is the RUN'S WORLD JOIN, printed because it is the identity the chain's rung 4 rests on.
 */
function describeSmapiAttribution(reading) {
  if (reading === null || reading === undefined) return ["smapi_lines: this_run=0 other_run=0 unattributable=0 (no SMAPI log was read)"];
  const head = `smapi_lines: this_run=${String(reading.lines.thisRun)} other_run=${String(reading.lines.otherRun)} unattributable=${String(reading.lines.unattributable)}`;
  if (reading.state !== "read")
    return [`${head} (${reading.reason ?? "no SMAPI log directory on this machine"})`];
  const detail = reading.files.map((file) => {
    const counts = `${String(file.bytes)} bytes, ${String(file.lines.thisRun + file.lines.otherRun + file.lines.unattributable)} line(s)${file.truncated === true ? ", head only" : ""}`;
    if (file.decision === "unreadable") return `smapi_attribution: ${file.name} (${counts}): ${file.reason}`;
    if (file.decision === "absent") return `smapi_attribution: ${file.name} (${counts}): empty - nothing to attribute`;
    if (file.decision === "one_session_of_this_run")
      return `smapi_attribution: ${file.name} (${counts}, 1 session start, this run's Mods go here): every line is this run's`;
    const others = [
      file.foreignSaves.length === 0 ? null : `save(s) ${file.foreignSaves.map((name) => `'${name}'`).join(", ")}`,
      file.modsPaths.filter((entry) => namesAny(entry, reading.ownMarkers) === false).length === 0
        ? null
        : `${String(file.modsPaths.length)} \`Mods go here:\` path(s), none this run's`,
    ].filter((entry) => entry !== null);
    return `smapi_attribution: ${file.name} (${counts}, ${String(file.sessionStarts)} session start(s)) -> ${file.decision}: ${String(file.lines.thisRun)} line(s) name this run; ${others.length === 0 ? "no line names another game by name" : others.join(" and ")}; ${String(file.lines.unattributable)} line(s) cannot be attributed to either and are not used`;
  });
  return [head, ...detail, describeSaveJoin(reading)];
}

/**
 * Which identity a save line is joined to, and how many lines this run's own world was claimed from.
 *
 * `Context: loaded save '<x>'` carries a save SLOT - the game's folder name, which is the farm name the product
 * staged filtered into a file name plus the unique id the game mints (`SaveGame.cs:448`). It never carries the
 * farm name itself, so a run that claims its farm name as a world name compares two different things and calls
 * its own save line another run's: measured 2026-11-26 (`.tmp/lane-roundw.md` §5.4), `other_run=1`,
 * `unattributable=95`, and rung 4 unclaimable on a run whose save really was loaded. The claim is the slot
 * (`capture/fixture-world.cjs` `ownWorldSlots`), and this line says which field it joined on and how many save
 * lines it bound - printed even at zero, so "rung 4 could not be claimed" is a reading rather than an absence.
 */
function describeSaveJoin(reading) {
  const slots = Array.isArray(reading?.ownWorldNames) ? reading.ownWorldNames : [];
  const joined = (reading?.ownLines ?? []).filter((line) => {
    const save = SAVE_LOADED.exec(line);
    return save !== null && namesAny(save[1], slots);
  });
  return `rung4_join: field=save slot this_run=${String(joined.length)} own_slots=[${slots.join(", ")}] - \`Context: loaded save '<slot>'\` carries the save folder, and the farm name this run staged is display text that is never compared with it`;
}

/* ---------------------------------------------------------------- the rungs the game's log proves */

const { CHAIN_STEPS } = require("./game-launch-verdict.mjs");

/**
 * The rungs of the chain the launched GAME is the only witness of, each as the line that proves it.
 *
 * The Host's own state route answers `launching/none` for a whole launch and cannot say whether a save was
 * loaded or a cabin was built; the game can, in its own words. Each pattern is the engine's or the Mod's
 * own sentence (`Context: loaded save` is SMAPI echoing the engine; the cabin line is `ModEntry`'s own log
 * of the native construction path).
 */
const CHAIN_LOG_PATTERNS = Object.freeze([
  { rung: CHAIN_STEPS.saveLoaded, pattern: /Context: loaded save '([^']+)'/u },
  {
    // Two sentences, one fact: the Mod's own answer for this world's Cabin. The first is a build on a free
    // cabin pad; the second is a world whose own starting Cabin was already there, with the engine's own
    // unclaimed native slot released so the companion can be provisioned into it (a fresh world always
    // answers this way). Both leave a Cabin this companion may use, which is what the rung names.
    rung: CHAIN_STEPS.cabinReady,
    pattern:
      /gave the companion world a native Cabin.*cabins_now=(\d+)|released the unclaimed native Farmhand slot .*provisioned into it/u,
  },
]);

/**
 * What the game's own log proves about a launch, or why it proves nothing - and ONLY from the lines
 * attributable to that run.
 *
 * The earlier reader took the LAST match of each pattern anywhere in the machine's shared file; measured
 * 2026-11-26 (`ROUND33`), that is how another lane's `Context: loaded save 'GameBuddyFixturePaired_453048112'`
 * was reported as this run's loaded world while this run's own world was `GameBuddyFarm_455241764`. The
 * pattern list is unchanged; the POPULATION it is searched over is this run's own lines.
 *
 * Freshness stays part of the proof: the file is rewritten by each game start and it outlives the process,
 * so a tail written before the launch cannot be cited for it.
 */
function claimChainFacts(reading, launchBeganMs) {
  if (reading === null || reading === undefined || reading.files.length === 0)
    return { read: false, reason: reading?.reason ?? "no SMAPI log to read on this machine", facts: {} };
  if (Number.isFinite(launchBeganMs) && (reading.writtenAtMs === null || reading.writtenAtMs < launchBeganMs))
    return {
      read: true,
      writtenAtMs: reading.writtenAtMs,
      reason: `the SMAPI log was last written ${
        reading.writtenAtMs === null ? "at an unreadable time" : new Date(reading.writtenAtMs).toISOString()
      }, before this launch`,
      facts: {},
    };
  const facts = {};
  for (const { rung, pattern } of CHAIN_LOG_PATTERNS) {
    // `line` is the fragment the rung names; `raw` is the whole line it was found on, which is what a
    // reader of a DIFFERENT fact on that line needs (the launch locale lives at the end of the save-loaded
    // line, outside the pattern). Measured 2026-11-16: reading the locale out of `line` found nothing, so
    // the verdict said the run and the game agreed while the game was English.
    const found = [...reading.ownLines]
      .reverse()
      .map((text) => ({ text, match: pattern.exec(text) }))
      .find((entry) => entry.match !== null);
    if (found !== undefined) facts[rung] = { line: found.match[0], captured: found.match[1] ?? null, raw: found.text };
  }
  return { read: true, writtenAtMs: reading.writtenAtMs, reason: missingSaveReason(reading, facts), facts };
}

/**
 * Why the game's log carries no save of THIS run's, when it carries a save of somebody else's.
 *
 * The distinction is the whole point of the attribution: "the game logged nothing" and "the game logged
 * another game's world" are different findings, and only the second says a second game is on this machine.
 */
function missingSaveReason(reading, facts) {
  if (facts[CHAIN_STEPS.saveLoaded] !== undefined) return null;
  if (reading.foreignSaves.length > 0)
    return `the SMAPI log names another game's save (${reading.foreignSaves.map((name) => JSON.stringify(name)).join(", ")}), not this run's (${reading.ownWorldNames.length === 0 ? "no world claimed yet" : reading.ownWorldNames.map((name) => JSON.stringify(name)).join(", ")})`;
  return `no line attributable to this run carries a save load (${String(reading.lines.otherRun)} line(s) name another game, ${String(reading.lines.unattributable)} cannot be attributed to either)`;
}

/**
 * One run's reading of this machine's SMAPI log: refreshed as the game writes, printed when it changes.
 *
 * `ownMarkers` and `ownWorldNames` are held BY REFERENCE, so a driver can add the world name it claimed with
 * `ownWorldNames.push(...)` after the fixture ran and every later refresh uses it - the world is only known
 * once the fixture has read the product's staged request, and the game's save line only appears after that.
 * `say` is called with the whole `smapi_lines:` block the first time and whenever the head line or the
 * per-file reasoning changes; the counts alone move on every tick and repeating them would bury the log.
 */
function createSmapiLogReading({ ownMarkers = [], ownWorldNames = [], say = null, logDir, logFiles = null } = {}) {
  let reading = null;
  let said = null;
  const refresh = () => {
    reading = attributeSmapiLog({ logDir, logFiles, ownMarkers, ownWorldNames });
    if (typeof say !== "function") return reading;
    const lines = describeSmapiAttribution(reading);
    const head = lines[0];
    const reasoning = lines.slice(1).join("\n");
    if (said !== null && said.head === head && said.reasoning === reasoning) return reading;
    said = { head, reasoning };
    for (const line of lines) say(line);
    return reading;
  };
  return {
    refresh,
    current: () => reading ?? refresh(),
    // A progress line quotes a FRESH last word: the file it comes from is rewritten by every game start, so a
    // cached reading is a quote from an earlier machine state.
    last: () => lastOwnLine(refresh()),
    claim: (launchBeganMs) => claimChainFacts(reading ?? refresh(), launchBeganMs),
    describe: () => describeSmapiAttribution(reading ?? refresh()),
  };
}

module.exports = {
  attributeSmapiLog,
  createSmapiLogReading,
  describeSmapiAttribution,
  lastOwnLine,
  smapiLogDir,
  smapiLogFiles,
  // Spelled out for the tests that hold the decision rule against a synthetic file.
  CHAIN_LOG_PATTERNS,
  LOG_FILE_NAME,
  MODS_GO_HERE,
  SAVE_LOADED,
  SESSION_START,
};
