/**
 * The one place that resolves the Stardew fixture roots.
 *
 * One lane owns two roots, and they are easy to confuse because the second is
 * nested inside the first by default:
 *
 * - `profileRoot` — `%LOCALAPPDATA%\GameBuddy` today. It owns
 *   `stardew-profiles\A-host|A-ai-client|A-ai-probe`, the
 *   `.stardew-fixture-profile.lock` transaction with its backups, and the
 *   Farmhand launcher's `farmhand-companion-preview-*` run roots.
 * - `fixturesRoot` — `%LOCALAPPDATA%\GameBuddy\stardew-fixtures` today. It owns
 *   the native save templates, the bootstrap binding artifacts and the
 *   `.stardew-native-local-player-fixture.lock` transaction that the
 *   single-process native-local helpers use.
 *
 * Both keep today's exact paths when nothing overrides them, so an unset
 * environment is byte-identical to the historical layout. A second concurrent
 * lane points `GAMEBUDDY_STARDEW_PROFILE_ROOT` (and therefore, by default, its
 * nested `stardew-fixtures` child) at a private directory, so the two lanes stop
 * sharing profiles, backups and locks. `GAMEBUDDY_STARDEW_FIXTURE_ROOT` moves
 * only the `stardew-fixtures` root.
 */
import { isAbsolute, join } from "node:path";

export const STARDEW_FIXTURE_PROFILE_ROOT_ENV = "GAMEBUDDY_STARDEW_PROFILE_ROOT";
export const STARDEW_FIXTURE_ROOT_ENV = "GAMEBUDDY_STARDEW_FIXTURE_ROOT";

const PRODUCT_ROOT_DIRECTORY = "GameBuddy";
const PROFILES_DIRECTORY = "stardew-profiles";
const FIXTURES_DIRECTORY = "stardew-fixtures";

/**
 * Resolve both roots in one place. An explicit argument wins over the
 * environment, which wins over the historical default. A configured root must
 * be absolute: a relative one would silently depend on the caller's cwd and let
 * two lanes disagree about which root they hold.
 */
export function resolveStardewFixtureRoots({ env = process.env, profileRoot, fixturesRoot } = {}) {
  const configuredProfileRoot = profileRoot ?? env?.[STARDEW_FIXTURE_PROFILE_ROOT_ENV];
  const profileRootOverridden = isNonEmptyString(configuredProfileRoot);
  const defaultProfileRoot = isNonEmptyString(env?.LOCALAPPDATA) ? join(env.LOCALAPPDATA, PRODUCT_ROOT_DIRECTORY) : "";
  const resolvedProfileRoot = profileRootOverridden ? configuredProfileRoot : defaultProfileRoot;
  if (!isAbsolute(resolvedProfileRoot)) throw new Error("stardew_fixture_profile_root_unresolved");

  const configuredFixturesRoot = fixturesRoot ?? env?.[STARDEW_FIXTURE_ROOT_ENV];
  const fixturesRootOverridden = isNonEmptyString(configuredFixturesRoot);
  const resolvedFixturesRoot = fixturesRootOverridden
    ? configuredFixturesRoot
    : join(resolvedProfileRoot, FIXTURES_DIRECTORY);
  if (!isAbsolute(resolvedFixturesRoot)) throw new Error("stardew_fixture_root_unresolved");

  return Object.freeze({
    profileRoot: resolvedProfileRoot,
    fixturesRoot: resolvedFixturesRoot,
    profilesDir: join(resolvedProfileRoot, PROFILES_DIRECTORY),
    profileRootOverridden,
    fixturesRootOverridden,
  });
}

/** One stable operator line naming both roots and how each was chosen. */
export function formatStardewFixtureRoots(roots) {
  const source = (overridden) => (overridden ? " (override)" : " (default)");
  return `[stardew-fixture-roots] profileRoot=${roots.profileRoot}${source(roots.profileRootOverridden)} fixturesRoot=${roots.fixturesRoot}${source(roots.fixturesRootOverridden)}`;
}

/**
 * Print the resolved roots once per process. Every helper in one run resolves
 * the same roots from the same environment, so the announcement is deduplicated
 * per sink: an operator sees which roots a run will use exactly once, not once
 * per resolve call. It goes to stderr because every CLI wrapper in this
 * directory writes parseable JSON to stdout.
 */
const announcedSinks = new WeakSet();

export function announceStardewFixtureRoots(roots, sink = process.stderr) {
  if (announcedSinks.has(sink)) return;
  announcedSinks.add(sink);
  sink.write(`${formatStardewFixtureRoots(roots)}\n`);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function cliMain(argv) {
  if (argv.length === 1 && argv[0] === "--print-json") {
    process.stdout.write(`${JSON.stringify(resolveStardewFixtureRoots())}\n`);
    return;
  }
  process.stderr.write("usage: stardew-fixture-roots.mjs --print-json\n");
  process.exitCode = 2;
}

const isCli = process.argv[1]?.replaceAll("\\", "/").endsWith("tools/lib/stardew-fixture-roots.mjs") === true;
if (isCli) cliMain(process.argv.slice(2));
