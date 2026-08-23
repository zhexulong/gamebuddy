import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("M8 ladder runner uses only the ladder typed route and rejects legacy route composition", async () => {
  const source = await readFile(new URL("./run-stardew-portfolio-m8-ladder-action.mjs", import.meta.url), "utf8");
  const probeIndex = source.indexOf("client.probeMineLadder(probeRequest)");
  const startIndex = source.indexOf("client.startMineLadder(request)");
  const freshIndex = source.indexOf("client.readMineLadderFreshFloor");
  assert.ok(probeIndex >= 0 && startIndex > probeIndex && freshIndex > startIndex);
  assert.match(source, /const ACTION = "use_mine_ladder"/);
  assert.match(source, /m8_ladder_not_observed/);
  assert.match(source, /probe\.ladderObserved !== true/);
  assert.doesNotMatch(source, /interaction_unavailable|ladderInteractionAvailable/);
  assert.match(source, /m8_ladder_terminal_invalid/);
  assert.match(source, /m8_ladder_fresh_floor_invalid/);
  assert.match(source, /terminal\.reasonCode !== "mine_ladder_floor_used"/);
  assert.match(source, /terminal\.postcondition\?\.targetFloor !== probe\.targetFloor/);
  assert.doesNotMatch(
    source,
    /enter_mine|startMineEntry|probeMineEntry|readMineEntryFreshFloor|startMineElevator|probeMineElevator|readMineElevatorFreshFloor|M8_CHECKPOINT|Game1\.enterMine/,
  );
  assert.match(source, /hasPreflight = process\.argv\.includes\("--preflight"\)/);
  assert.match(source, /hasAction = process\.argv\.includes\("--action"\)/);
  assert.doesNotMatch(source, /SaveGame\.Save|readNativeSaveReopen|drive-stardew-ui|P0bLifecycle/);
});

test("M8 ladder runner reports a bootstrap connection failure without a temporal-dead-zone crash", async () => {
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
      execFileAsync(process.execPath, ["tools/run-stardew-portfolio-m8-ladder-action.mjs", "--preflight"], {
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
      assert.equal(verdict.action, "use_mine_ladder");
      assert.match(verdict.code, /ENOENT|portfolio_bridge|connect|portfolio_pipe_not_published/);
      return true;
    },
  );
});
