// Driver Z: the surface disconnects while the game keeps running.
//
// The other half of a game ending, and the one product policy is explicit about: an ordinary close, a controller
// EOF and an AI failure stop AI authority and NEVER the player's game world (policy 3023). So this driver takes
// the product's own disconnect control and reads three things - the game still running, the surface saying so
// (`actionAuthority=paused`, not a silent `active`), and a fresh explicit instruction (`game-reopen`) being what
// restores authority. It also reads the transcript across the disconnect: a companion row that appears with no
// player line behind it is the old task replaying instead of staying suspended.
//
// WHAT IT DOES NOT DO: it never stops the game. The player's world is theirs; leaving it running is the policy
// this driver measures, and the run's process ledger records the survivor with that reason rather than as a leak.
const { shot } = require("./common.cjs");
const S = require("./game-surface-states.cjs");
const { classifyDisconnect, NOT_MEASURED_REASONS } = require("./game-states-verdict.mjs");

(async () => {
  const { say, flush, facts, record, notMeasured, browser, page, problems, target } = await S.startStateDriver({
    driver: "z",
    scenario: "disconnect",
    reportFile: "z-game-disconnect.txt",
  });

  const before = await page.evaluate(S.readGameState);
  const transcriptBefore = await page.evaluate(S.readGameTranscript);
  record("before the disconnect", { state: before, rows: transcriptBefore.rows, notice: transcriptBefore.notice });

  const disconnectControl = (await page.evaluate(S.readGameFacts)).controls.disconnect;
  record("disconnect control", disconnectControl);
  if (disconnectControl === null || disconnectControl.visible !== true)
    return await notMeasured(
      browser,
      NOT_MEASURED_REASONS.disconnectControlAbsent,
      `the panel drew no usable disconnect control at attachment=${String(before.attachmentStatus)}/${String(before.connectionStatus)}: ${JSON.stringify(disconnectControl)}`,
    );
  await page.locator('[data-testid="game-disconnect"]').first().click();
  say(`the product's own disconnect control was pressed (${JSON.stringify(disconnectControl.name)})`);

  // The surface must SETTLE: the attachment let go, and the game left running.
  const settled = await S.waitForState(
    page,
    (reading) => reading.ok === true && reading.attachmentStatus !== "attached" && reading.connectionStatus !== "active",
    S.BUDGET.disconnectMs,
  );
  record("after the disconnect", { settled: settled.settled, elapsedMs: settled.elapsedMs, state: settled.state, problems: [...problems.entries()] });
  if (!settled.settled)
    return await notMeasured(
      browser,
      NOT_MEASURED_REASONS.disconnectControlAbsent,
      `the disconnect never settled within ${String(S.BUDGET.disconnectMs)}ms (last ${JSON.stringify(settled.state)})${problems.get("game/disconnect") === undefined ? "" : `; the route answered ${JSON.stringify(problems.get("game/disconnect"))}`}`,
    );

  // The game must still be running: an ordinary close never ends the player's world.
  const aliveAfter = S.pidAlive(target.pid);
  const afterPanel = await page.evaluate(S.readGameFacts);
  // Nothing may have been sent to the world since, so any new companion row is the old task replaying.
  const transcriptAfter = await page.evaluate(S.readGameTranscript);
  const companionRows = (transcript) => transcript.rows.filter((row) => row.role === "companion").length;
  const replayed = companionRows(transcriptAfter) > companionRows(transcriptBefore);
  record("readings", {
    pidAlive: aliveAfter,
    facts: afterPanel.facts,
    state: afterPanel.state,
    controls: afterPanel.controls,
    companionRowsBefore: companionRows(transcriptBefore),
    companionRowsAfter: companionRows(transcriptAfter),
    replayed,
  });
  await shot(page, "98-game-disconnect-after.png");

  // Reconnect is an operation with fresh authentication and a fresh observation, not a state the surface drifts
  // back into: the explicit instruction must be offered, and it is NOT pressed here - pressing it would grant
  // authority nobody asked for, and this driver measures the state between the two.
  const reopenOffered = afterPanel.controls.reopen !== null && afterPanel.controls.reopen.visible === true;
  const reading = classifyDisconnect({
    gameAliveAfter: aliveAfter,
    after: { attachmentStatus: settled.state.attachmentStatus, connectionStatus: settled.state.connectionStatus, actionAuthority: settled.state.actionAuthority },
    reopenOffered,
    replayed,
    disconnectedBy: "browser surface",
  });
  return await S.conclude({ browser, say, flush, driver: "z", scenario: "disconnect", facts, reading });
})().catch((error) => {
  console.log("DRIVER Z FAILED:", String(error).slice(0, 900));
  process.exit(1);
});
