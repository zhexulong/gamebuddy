import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("M8 mine-route runner chains independent entry and ladder routes over one bootstrap connection", async () => {
  const source = await readFile(new URL("./run-stardew-portfolio-m8-mine-route-action.mjs", import.meta.url), "utf8");
  const entryProbeIndex = source.indexOf("client.probeMineEntry(probeRequest)");
  const entryStartIndex = source.indexOf("client.startMineEntry(entryRequest)");
  const entryFreshIndex = source.indexOf("client.readMineEntryFreshFloor");
  const ladderProbeIndex = source.indexOf("client.probeMineLadder(probeRequest)");
  const ladderStartIndex = source.indexOf("client.startMineLadder(ladderRequest)");
  const ladderFreshIndex = source.indexOf("client.readMineLadderFreshFloor");
  assert.ok(entryProbeIndex >= 0 && entryStartIndex > entryProbeIndex && entryFreshIndex > entryStartIndex);
  assert.ok(
    ladderProbeIndex > entryFreshIndex && ladderStartIndex > ladderProbeIndex && ladderFreshIndex > ladderStartIndex,
  );
  assert.equal(
    source.indexOf("connectBootstrap"),
    source.lastIndexOf("connectBootstrap"),
    "exactly one bootstrap connection preserves one bridge generation",
  );
  assert.equal(source.match(/\.connect\(|connectForTest|new PortfolioStardewBridgeClient/g)?.length ?? 0, 0);
  assert.match(source, /const ACTION = "enter_mine"/);
  assert.match(source, /const ENTRY_ACTION = "enter_mine"/);
  assert.match(source, /const LADDER_ACTION = "use_mine_ladder"/);
  assert.match(source, /const ROUTE = "enter_mine_use_mine_ladder"/);
  assert.match(source, /entryTerminal\.reasonCode !== "enter_mine_floor_used"/);
  assert.match(source, /ladderTerminal\.reasonCode !== "mine_ladder_floor_used"/);
  assert.match(source, /m8_route_entry_terminal_invalid/);
  assert.match(source, /m8_route_entry_fresh_floor_invalid/);
  assert.match(source, /m8_route_ladder_terminal_invalid/);
  assert.match(source, /m8_route_ladder_fresh_floor_invalid/);
  assert.match(source, /m8_route_entry_given_wait_timeout/);
  assert.match(source, /m8_route_ladder_given_wait_timeout/);
  assert.match(source, /m8_route_entry_not_observed/);
  assert.match(source, /m8_route_ladder_not_observed/);
  assert.match(source, /probe\.ladderObserved !== true/);
  assert.doesNotMatch(source, /interaction_unavailable|ladderInteractionAvailable/);
  assert.match(source, /\n\s+if \(!waitableLadderGivenCode\(givenCode\)\)/);
  assert.match(source, /state: "M8_ACTION_TERMINAL"/);
  assert.match(source, /process\.argv\.includes\("--execute"\)/);
  // No elevator, sleep, checkpoint, save, UI, or P0b machinery; the ladder
  // request must be unreachable until the entry Given and terminal hold.
  assert.doesNotMatch(
    source,
    /probeMineElevator|startMineElevator|readMineElevatorFreshFloor|M8_CHECKPOINT|Game1\.enterMine|SaveGame\.Save|readNativeSaveReopen|drive-stardew-ui|P0bLifecycle|sleepAndAdvanceDay|cancelMine/,
  );
  assert.match(source, /hasPreflight = process\.argv\.includes\("--preflight"\)/);
  assert.match(source, /hasAction = process\.argv\.includes\("--action"\)/);
});

test("M8 mine-route runner reports a bootstrap connection failure without a temporal-dead-zone crash", async () => {
  const env = {
    ...process.env,
    GAMEBUDDY_PORTFOLIO_PIPE_NAME: "gamebuddy-stardew-portfolio-missing-test",
    GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN: "a".repeat(32),
    GAMEBUDDY_PORTFOLIO_SAVE_ID: "445880081",
    GAMEBUDDY_PORTFOLIO_WORLD_ID: "world_445880081",
    GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID: "player_445880081",
    GAMEBUDDY_PORTFOLIO_COMPANION_ID: "portfolio_companion",
  };
  await assert.rejects(
    () =>
      execFileAsync(process.execPath, ["tools/run-stardew-portfolio-m8-mine-route-action.mjs", "--preflight"], {
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
      assert.equal(verdict.route, "enter_mine_use_mine_ladder");
      assert.match(verdict.code, /ENOENT|portfolio_bridge|connect|portfolio_pipe_not_published/);
      return true;
    },
  );
});
