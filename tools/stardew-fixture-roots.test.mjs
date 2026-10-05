import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  STARDEW_FIXTURE_PROFILE_ROOT_ENV,
  STARDEW_FIXTURE_ROOT_ENV,
  announceStardewFixtureRoots,
  formatStardewFixtureRoots,
  resolveStardewFixtureRoots,
} from "./lib/stardew-fixture-roots.mjs";
import { inspectFixtureTransaction } from "./lib/stardew-fixture-profile.mjs";

const execFile = promisify(execFileCallback);
const TOOLS_DIR = fileURLToPath(new URL(".", import.meta.url));

function restoreEnv(name, previous) {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

function collectingSink() {
  const written = [];
  return { written, write: (line) => written.push(line) };
}

test("no override keeps today's exact profile and fixtures roots", () => {
  const localAppData = join(tmpdir(), "gamebuddy-roots-default");
  const roots = resolveStardewFixtureRoots({ env: { LOCALAPPDATA: localAppData } });
  assert.equal(roots.profileRoot, join(localAppData, "GameBuddy"));
  assert.equal(roots.fixturesRoot, join(localAppData, "GameBuddy", "stardew-fixtures"));
  assert.equal(roots.profilesDir, join(localAppData, "GameBuddy", "stardew-profiles"));
  assert.equal(roots.profileRootOverridden, false);
  assert.equal(roots.fixturesRootOverridden, false);
});

test("a lane moves its profile root and the fixtures root follows it", () => {
  const laneRoot = join(tmpdir(), "gamebuddy-lane-b");
  const roots = resolveStardewFixtureRoots({
    env: {
      LOCALAPPDATA: join(tmpdir(), "gamebuddy-roots-default"),
      [STARDEW_FIXTURE_PROFILE_ROOT_ENV]: laneRoot,
    },
  });
  assert.equal(roots.profileRoot, laneRoot);
  assert.equal(roots.fixturesRoot, join(laneRoot, "stardew-fixtures"));
  assert.equal(roots.profilesDir, join(laneRoot, "stardew-profiles"));
  assert.equal(roots.profileRootOverridden, true);
  // The fixtures root followed the profile root, so it is not itself overridden.
  assert.equal(roots.fixturesRootOverridden, false);
});

test("the fixtures root can move on its own without moving the profile root", () => {
  const localAppData = join(tmpdir(), "gamebuddy-roots-shared");
  const laneFixtures = join(tmpdir(), "gamebuddy-lane-c-fixtures");
  const roots = resolveStardewFixtureRoots({
    env: { LOCALAPPDATA: localAppData, [STARDEW_FIXTURE_ROOT_ENV]: laneFixtures },
  });
  assert.equal(roots.profileRoot, join(localAppData, "GameBuddy"));
  assert.equal(roots.fixturesRoot, laneFixtures);
  assert.equal(roots.profileRootOverridden, false);
  assert.equal(roots.fixturesRootOverridden, true);
});

test("an explicit argument wins over the environment", () => {
  const explicitProfileRoot = join(tmpdir(), "gamebuddy-explicit-profile");
  const explicitFixturesRoot = join(tmpdir(), "gamebuddy-explicit-fixtures");
  const roots = resolveStardewFixtureRoots({
    env: {
      LOCALAPPDATA: join(tmpdir(), "gamebuddy-roots-env"),
      [STARDEW_FIXTURE_PROFILE_ROOT_ENV]: join(tmpdir(), "gamebuddy-env-lane"),
      [STARDEW_FIXTURE_ROOT_ENV]: join(tmpdir(), "gamebuddy-env-fixtures"),
    },
    profileRoot: explicitProfileRoot,
    fixturesRoot: explicitFixturesRoot,
  });
  assert.equal(roots.profileRoot, explicitProfileRoot);
  assert.equal(roots.fixturesRoot, explicitFixturesRoot);
  assert.equal(roots.profileRootOverridden, true);
  assert.equal(roots.fixturesRootOverridden, true);
});

test("an unresolvable or relative root fails closed", () => {
  assert.throws(() => resolveStardewFixtureRoots({ env: {} }), /stardew_fixture_profile_root_unresolved/);
  assert.throws(() => resolveStardewFixtureRoots({ env: {}, profileRoot: "relative-lane" }), {
    message: "stardew_fixture_profile_root_unresolved",
  });
  assert.throws(
    () =>
      resolveStardewFixtureRoots({
        env: {
          LOCALAPPDATA: join(tmpdir(), "gamebuddy-roots-relative"),
          [STARDEW_FIXTURE_ROOT_ENV]: "relative\\fixtures",
        },
      }),
    { message: "stardew_fixture_root_unresolved" },
  );
});

test("the resolved roots are announced once per process, and name both roots", () => {
  const roots = resolveStardewFixtureRoots({ env: { LOCALAPPDATA: join(tmpdir(), "gamebuddy-roots-announce") } });
  const line = `${formatStardewFixtureRoots(roots)}\n`;
  assert.ok(line.startsWith("[stardew-fixture-roots] profileRoot="));
  assert.ok(line.includes(`profileRoot=${roots.profileRoot} (default)`));
  assert.ok(line.includes(`fixturesRoot=${roots.fixturesRoot} (default)`));

  const sink = collectingSink();
  announceStardewFixtureRoots(roots, sink);
  announceStardewFixtureRoots(roots, sink);
  assert.deepEqual(sink.written, [line]);

  // A different sink (a different process/stream) still gets its own single line.
  const otherSink = collectingSink();
  announceStardewFixtureRoots(roots, otherSink);
  assert.deepEqual(otherSink.written, [line]);
});

test("the CLI prints the process environment's roots as JSON", async () => {
  const localAppData = join(tmpdir(), "gamebuddy-roots-cli");
  const env = { ...process.env, LOCALAPPDATA: localAppData };
  delete env[STARDEW_FIXTURE_PROFILE_ROOT_ENV];
  delete env[STARDEW_FIXTURE_ROOT_ENV];
  const { stdout } = await execFile(
    process.execPath,
    [join(TOOLS_DIR, "lib", "stardew-fixture-roots.mjs"), "--print-json"],
    {
      env,
      windowsHide: true,
    },
  );
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.profileRoot, join(localAppData, "GameBuddy"));
  assert.equal(parsed.fixturesRoot, join(localAppData, "GameBuddy", "stardew-fixtures"));
  assert.equal(parsed.profilesDir, join(localAppData, "GameBuddy", "stardew-profiles"));
});

test("the profile transaction defaults to the shared profile root and the environment moves it", async (t) => {
  const localAppData = await mkdtemp(join(tmpdir(), "gamebuddy-roots-profile-"));
  const laneRoot = await mkdtemp(join(tmpdir(), "gamebuddy-roots-lane-"));
  t.after(() => rm(localAppData, { recursive: true, force: true }));
  t.after(() => rm(laneRoot, { recursive: true, force: true }));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const previousProfileRoot = process.env[STARDEW_FIXTURE_PROFILE_ROOT_ENV];
  t.after(() => {
    restoreEnv("LOCALAPPDATA", previousLocalAppData);
    restoreEnv(STARDEW_FIXTURE_PROFILE_ROOT_ENV, previousProfileRoot);
  });

  process.env.LOCALAPPDATA = localAppData;
  delete process.env[STARDEW_FIXTURE_PROFILE_ROOT_ENV];
  const byDefault = await inspectFixtureTransaction({ processNames: [] });
  assert.equal(byDefault.root, join(localAppData, "GameBuddy"));
  assert.equal(byDefault.mutationPerformed, false);

  process.env[STARDEW_FIXTURE_PROFILE_ROOT_ENV] = laneRoot;
  const byLane = await inspectFixtureTransaction({ processNames: [] });
  assert.equal(byLane.root, laneRoot);
  assert.equal(byLane.mutationPerformed, false);
});

test("the default-computing entries delegate to the shared resolver", async () => {
  const launcher = await readFile(join(TOOLS_DIR, "start-farmhand-launcher.ps1"), "utf8");
  assert.match(launcher, /stardew-fixture-roots\.mjs --print-json/);
  assert.match(launcher, /\$fixtureRoot = \[string\]\$fixtureRoots\.profileRoot/);
  assert.doesNotMatch(launcher, /\$fixtureRoot = Join-Path \$env:LOCALAPPDATA "GameBuddy"/);

  const navigation = await readFile(join(TOOLS_DIR, "launch-stardew-navigation-fixture.ps1"), "utf8");
  assert.match(navigation, /lib\/stardew-fixture-roots\.mjs/);
  assert.match(
    navigation,
    /\$ModsPath = Join-Path \(\[string\]\$fixtureRoots\.profilesDir\) "native-local-navigation"/,
  );
  assert.doesNotMatch(navigation, /Join-Path \$env:LOCALAPPDATA "GameBuddy\\stardew-fixtures"/);
  assert.doesNotMatch(navigation, /Join-Path \$env:LOCALAPPDATA "GameBuddy\\stardew-profiles/);

  const ladder = await readFile(join(TOOLS_DIR, "live-run", "game", "launch-ladder-live.mjs"), "utf8");
  assert.match(ladder, /resolveStardewFixtureRoots\(\{ fixturesRoot: option\("root", null\) \}\)/);
  assert.doesNotMatch(ladder, /path\.join\(process\.env\.LOCALAPPDATA, "GameBuddy", "stardew-fixtures"\)/);
});
