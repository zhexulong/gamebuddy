/**
 * What one live lane owns, and what it can only share.
 *
 * Two facts here were MEASURED, not assumed (`design/research/stardew-live-run-isolation-probe.md`,
 * `design/tasks/active/stardew-multiday-loop-and-harness-hardening-implementation.md` §4):
 *
 *  - The game reads its saves from ONE root, `%APPDATA%\StardewValley\Saves`, and cannot be pointed anywhere else.
 *    SMAPI 4.5.2 has no `--save-path` (it does not even have `--help`: asking for it started the game), and setting
 *    `APPDATA` for the child does not move .NET's `SpecialFolder.ApplicationData` (measured: with
 *    `APPDATA=C:\FakeAppData` the property still resolved to the real profile). A per-lane save ROOT would therefore
 *    be a claim the game does not honour - the fixture would materialise a save the game never loads, and read back a
 *    slot the game never wrote. A lane owns a save SLOT instead: one directory NAME under the shared root.
 *  - SMAPI names its log by PLAYER INDEX, not by lane. Two instances coexist (measured 2026-10-16: neither crashed),
 *    the first writes `SMAPI-latest.txt` and the second `SMAPI-latest.player-2.txt`, and which lane gets which is
 *    decided inside the game at startup. There is no `--log-path` to ask for a name, and an unknown argument is
 *    silently ignored, so a name can never be verified by looking for the flag. The log a lane CAN own is the
 *    console stream of the process IT launched.
 *
 * Everything a lane can own is derived from its own fixture root - the directory the fixture transaction, the Mod
 * directory and the transaction lock already key off - and an explicitly supplied value always wins over a derived
 * one. The derived values are pure functions of that root, so two lanes get disjoint ones without any coordination.
 */
import { createHash } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";

const SAVE_ROOT_SEGMENTS = Object.freeze(["StardewValley", "Saves"]);
/** The prefix every fixture save name must carry, and the grammar is the fixture library's `assertFixtureLogicalName`. */
const SAVE_NAME_PREFIX = "GameBuddyFixture";
/** A lane's own log lives below its fixture root, where no other lane can write. */
const LANE_LOG_DIRECTORY = "logs";
const LANE_SMAPI_LOG_FILENAME = "smapi-console.log";

/**
 * The game's save root: the only one it reads, and therefore the default a lane gets.
 *
 * Named rather than spelled out at each call site because a second spelling of this path is a lane silently
 * writing a save the game will not load.
 */
export function gameStardewSaveRoot({ appData = process.env.APPDATA } = {}) {
  if (typeof appData !== "string" || !appData.length || !isAbsolute(appData))
    throw new Error("stardew_appdata_unavailable");
  return join(resolve(appData), ...SAVE_ROOT_SEGMENTS);
}

/** An explicit `--stardew-save-root` wins, including a wrong one: the fixture library is what refuses it. */
export function resolveLaneSaveRoot({ stardewSaveRoot, appData } = {}) {
  return stardewSaveRoot === undefined ? gameStardewSaveRoot({ appData }) : stardewSaveRoot;
}

/**
 * The logical save name this lane's bootstrap creates, when the caller does not name one.
 *
 * A save's directory name embeds the native save file name (`prepare-stardew-action-fixture.ps1` refuses
 * `SaveName !== TemplateName` for that reason), and a bootstrap observes `<logical>_<nativeId>`. Two lanes
 * bootstrapping the same world can therefore receive the SAME native id - the logical half is what keeps their
 * slots apart, so it is derived from the lane's own root. The digest covers roots whose readable part sanitises to
 * the same slug (`gb-lane-a-1` and `gb.lane_a.1`), which would otherwise collide on one machine.
 */
export function laneSaveName({ fixtureRoot, saveName } = {}) {
  if (saveName !== undefined) return saveName;
  const root = requireAbsoluteRoot(fixtureRoot);
  const slug = basename(root)
    .replaceAll(/[^A-Za-z0-9]/gu, "")
    .slice(0, 32);
  const identity = createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 16);
  return `${SAVE_NAME_PREFIX}${slug}${identity}`;
}

/**
 * Where this lane's SMAPI console stream is written, when the caller does not name a path.
 *
 * Read by the lane's own readers INSTEAD of the machine-global `SMAPI-latest*.txt`: those are numbered by player
 * index, so under two lanes the unsuffixed file belongs to whichever instance SMAPI numbered first - a reader that
 * takes it reads the other lane's run.
 */
export function laneSmapiLogPath({ fixtureRoot, logPath } = {}) {
  if (logPath !== undefined) return logPath;
  return join(requireAbsoluteRoot(fixtureRoot), LANE_LOG_DIRECTORY, LANE_SMAPI_LOG_FILENAME);
}

function requireAbsoluteRoot(fixtureRoot) {
  if (typeof fixtureRoot !== "string" || !fixtureRoot.length || !isAbsolute(fixtureRoot))
    throw new Error("invalid_lane_fixture_root");
  return resolve(fixtureRoot);
}
