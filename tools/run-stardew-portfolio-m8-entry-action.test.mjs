import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("M8 entry runner owns exactly the independent Mine-exterior to floor-1 lifecycle", async () => {
  const source = await readFile(new URL("./run-stardew-portfolio-m8-entry-action.mjs", import.meta.url), "utf8");
  const skipProbeIndex = source.indexOf("client.probeSkipEvent(skipProbeRequest)");
  const skipStartIndex = source.indexOf("client.startSkipEvent(skipRequest)");
  const skipTerminalIndex = source.indexOf("validSkipEventTerminal(skipEventTerminal");
  const probeIndex = source.indexOf("client.probeMineEntry(probeRequest)");
  const startIndex = source.indexOf("client.startMineEntry(request)");
  const freshIndex = source.indexOf("client.readMineEntryFreshFloor");
  assert.ok(skipProbeIndex >= 0 && skipStartIndex > skipProbeIndex && skipTerminalIndex > skipStartIndex);
  assert.ok(probeIndex > skipTerminalIndex && startIndex > probeIndex && freshIndex > startIndex);
  assert.equal(source.indexOf("connectBootstrap"), source.lastIndexOf("connectBootstrap"));
  assert.equal(source.match(/\.connect\(|connectForTest|new PortfolioStardewBridgeClient/g)?.length ?? 0, 0);
  assert.match(source, /const ACTION = "enter_mine"/);
  assert.match(source, /const SKIP_EVENT_ACTION = "skip_event"/);
  assert.match(source, /const TARGET_FLOOR = 1/);
  assert.match(source, /Re-probe on every fresh snapshot/);
  assert.match(source, /if \(skipEventEnabled\)/);
  assert.doesNotMatch(source, /m8_skip_event_not_skippable|eventObserved && !skipEventProbe\.eventSkippable/);
  assert.match(source, /if \(skipEventProbe\.eventObserved\)/);
  assert.match(source, /skipEventTerminals\.push\(terminalView\(skipEventTerminal\)\)/);
  assert.match(source, /state: "M8_SEQUENCE_READY"/);
  assert.match(source, /skipEventTerminals,/);
  assert.match(source, /terminal\.reasonCode === "skip_event_completed"/);
  assert.match(source, /terminal\.evidence\?\.postEventStateClean === true/);
  assert.match(source, /terminal\.reasonCode !== "enter_mine_floor_used"/);
  assert.match(source, /m8_entry_terminal_invalid/);
  assert.match(source, /m8_entry_fresh_floor_invalid/);
  assert.match(source, /m8_entry_given_wait_timeout/);
  assert.match(source, /m8_entry_not_observed/);
  assert.match(source, /fixed default Mine-entry transition directly/);
  assert.match(source, /Mod-owned native seam/);
  assert.doesNotMatch(source, /if \(probe\.entryInteractionAvailable !== true\)/);
  assert.doesNotMatch(source, /PathFindController|source-locked producer/);
  assert.doesNotMatch(source, /code === "m8_entry_interaction_unavailable"/);
  assert.match(source, /state: "M8_ACTION_TERMINAL"/);
  assert.match(source, /process\.argv\.includes\("--execute"\)/);
  assert.doesNotMatch(
    source,
    /probeMineLadder|startMineLadder|readMineLadderFreshFloor|probeMineElevator|startMineElevator|readMineElevatorFreshFloor|M8_CHECKPOINT|Game1\.enterMine|SaveGame\.Save|readNativeSaveReopen|drive-stardew-ui|DialogueBox|receiveKeyPress|receiveLeftClick|activeClickableMenu\s*=|eventsSeen|P0bLifecycle|sleepAndAdvanceDay|cancelMine/,
  );
});

test("M8 entry runner reports bootstrap failure as a bounded verdict without a temporal-dead-zone crash", async () => {
  const env = {
    ...process.env,
    GAMEBUDDY_PORTFOLIO_PIPE_NAME: "gamebuddy-stardew-portfolio-missing-entry-test",
    GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN: "a".repeat(32),
    GAMEBUDDY_PORTFOLIO_SAVE_ID: "445880081",
    GAMEBUDDY_PORTFOLIO_WORLD_ID: "world_445880081",
    GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID: "player_445880081",
    GAMEBUDDY_PORTFOLIO_COMPANION_ID: "portfolio_companion",
  };
  await assert.rejects(
    () =>
      execFileAsync(process.execPath, ["tools/run-stardew-portfolio-m8-entry-action.mjs", "--preflight"], {
        cwd: repositoryRoot,
        env,
        windowsHide: true,
        timeout: 10_000,
      }),
    (error) => {
      assert.equal(error.code, 2);
      assert.doesNotMatch(String(error.stderr), /Cannot access 'ActionBlocked' before initialization/);
      const verdict = JSON.parse(String(error.stdout).trim());
      assert.equal(verdict.state, "BLOCKED");
      assert.equal(verdict.action, "enter_mine");
      assert.match(verdict.code, /ENOENT|portfolio_bridge|connect|portfolio_pipe_not_published/);
      return true;
    },
  );
});
