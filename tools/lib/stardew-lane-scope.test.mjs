import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { gameStardewSaveRoot, laneSaveName, laneSmapiLogPath, resolveLaneSaveRoot } from "./stardew-lane-scope.mjs";
import { STARDEW_MOD_FOLDER } from "./stardew-mod-folder.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const bootstrapCli = join(repoRoot, "tools", "bootstrap-stardew-native-local-player-fixture.mjs");
const BUNDLE_FILES = [
  "GameBuddy.Stardew.dll",
  "GameBuddy.Stardew.Core.dll",
  "manifest.json",
  "GameBuddy.Stardew.deps.json",
];

/** Two lane roots that exist on disk, because the derivation is a function of a real absolute path. */
function twoLaneRoots(t) {
  const base = mkdtempSync(join(tmpdir(), "gb-lane-scope-"));
  const roots = ["a", "b"].map((name) => {
    const root = join(base, `gb-lane-${name}`);
    mkdirSync(join(root, "mods"), { recursive: true });
    return root;
  });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return roots;
}

test("the game's save root is the current user's APPDATA Saves, and only that", () => {
  // Measured (design/research/stardew-live-run-isolation-probe.md): no `--save-path` exists and overriding `APPDATA`
  // does not move .NET's `SpecialFolder.ApplicationData`, so this path is not a default a lane may replace - it is
  // the one root the game reads.
  const appData = "C:\\Users\\lane\\AppData\\Roaming";
  assert.equal(gameStardewSaveRoot({ appData }), join(resolve(appData), "StardewValley", "Saves"));
  assert.throws(() => gameStardewSaveRoot({ appData: "" }), /stardew_appdata_unavailable/);
  assert.throws(() => gameStardewSaveRoot({ appData: "relative/appdata" }), /stardew_appdata_unavailable/);
});

test("a single lane keeps the save root the PowerShell drivers pass explicitly", () => {
  // The single-lane behaviour must be unchanged: `run-stardew-native-local-player-move-fixture.ps1` passes
  // `Join-Path $env:APPDATA "StardewValley\Saves"`, and resolving the default must produce the same path.
  const appData = "C:\\Users\\lane\\AppData\\Roaming";
  assert.equal(resolveLaneSaveRoot({ appData }), join(resolve(appData), "StardewValley", "Saves"));
  assert.equal(resolveLaneSaveRoot({ stardewSaveRoot: "C:\\elsewhere\\Saves", appData }), "C:\\elsewhere\\Saves");
});

test("two lane roots derive disjoint save names and disjoint log paths", (t) => {
  const [rootA, rootB] = twoLaneRoots(t);
  const nameA = laneSaveName({ fixtureRoot: rootA });
  const nameB = laneSaveName({ fixtureRoot: rootB });
  assert.notEqual(nameA, nameB);
  // The fixture library's grammar (`assertFixtureLogicalName`) is checked here for shape; the end-to-end case at the
  // bottom is the authority, because it runs that real validator on a derived name.
  for (const name of [nameA, nameB]) assert.match(name, /^GameBuddyFixture[A-Za-z0-9]{0,64}$/u);
  // Deterministic: the same lane root always yields the same name, which is what lets a later run find its slot.
  assert.equal(laneSaveName({ fixtureRoot: rootA }), nameA);

  const logA = laneSmapiLogPath({ fixtureRoot: rootA });
  const logB = laneSmapiLogPath({ fixtureRoot: rootB });
  assert.notEqual(logA, logB);
  assert.ok(logA.startsWith(rootA), logA);
  assert.ok(logB.startsWith(rootB), logB);
});

test("roots whose readable part sanitises the same still get distinct save names", (t) => {
  // `gb-lane-a-1` and `gb.lane_a.1` are different lanes whose slugs are identical; a name built from the slug alone
  // would put both lanes in one save slot.
  const base = mkdtempSync(join(tmpdir(), "gb-lane-slug-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const first = join(base, "gb-lane-a-1");
  const second = join(base, "gb.lane_a.1");
  mkdirSync(first);
  mkdirSync(second);
  assert.notEqual(laneSaveName({ fixtureRoot: first }), laneSaveName({ fixtureRoot: second }));
});

test("an explicit save name or log path wins over the derived one", (t) => {
  const [root] = twoLaneRoots(t);
  assert.equal(laneSaveName({ fixtureRoot: root, saveName: "GameBuddyFixtureStable2" }), "GameBuddyFixtureStable2");
  assert.equal(laneSmapiLogPath({ fixtureRoot: root, logPath: "C:\\lane\\own.log" }), "C:\\lane\\own.log");
});

test("a relative or empty fixture root is refused instead of deriving a name from the process cwd", () => {
  assert.throws(() => laneSaveName({ fixtureRoot: "relative/lane" }), /invalid_lane_fixture_root/);
  assert.throws(() => laneSmapiLogPath({ fixtureRoot: "" }), /invalid_lane_fixture_root/);
});

test("the bootstrap CLI writes the derived per-lane save name into its own config", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gb-lane-boot-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const releaseDir = join(base, "release");
  mkdirSync(releaseDir, { recursive: true });
  for (const name of BUNDLE_FILES) writeFileSync(join(releaseDir, name), `stub ${name}\n`, "utf8");
  const configured = (lane) => {
    const root = join(base, `gb-lane-${lane}`);
    const modsPath = join(root, "mods");
    const modRoot = join(modsPath, STARDEW_MOD_FOLDER);
    mkdirSync(modRoot, { recursive: true });
    execFileSync(
      process.execPath,
      [
        bootstrapCli,
        "--root",
        root,
        "--mods-path",
        modsPath,
        "--release-dir",
        releaseDir,
        "--backup-name",
        "lane-scope-fixture-backup",
        "--action",
        "till_soil",
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 120_000 },
    );
    return { root, config: JSON.parse(readFileSync(join(modRoot, "config.json"), "utf8")) };
  };
  const laneA = configured("a");
  const laneB = configured("b");
  // The derived name reaches the field the Mod reads, and the slot the game will create is `<logical>_<nativeId>`.
  assert.equal(laneA.config.NativeLocalPlayerFixture.LogicalSaveName, laneSaveName({ fixtureRoot: laneA.root }));
  assert.equal(laneB.config.NativeLocalPlayerFixture.LogicalSaveName, laneSaveName({ fixtureRoot: laneB.root }));
  assert.notEqual(
    laneA.config.NativeLocalPlayerFixture.ObservedSaveSlot,
    laneB.config.NativeLocalPlayerFixture.ObservedSaveSlot,
  );
});
