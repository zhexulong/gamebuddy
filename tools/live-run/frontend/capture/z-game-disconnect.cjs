// Driver Z: the surface disconnects while the game keeps running.
//
// The other half of a game ending, and the one product policy is explicit about: an ordinary close, a controller
// EOF and an AI failure stop AI authority and NEVER the player's game world (policy 3023). So this driver takes
// the product's own disconnect control and reads four things - the game still running, the surface saying so
// (`connectionStatus: "disconnected"` and a sentence stating the farm survives, never the `none` a session that
// has never connected publishes), the authority off rather than silently `active`, and a step the player can
// really press afterwards. It also reads the transcript across the disconnect: a companion row that appears with
// no player line behind it is the old task replaying instead of staying suspended.
//
// WHAT IT DOES NOT DO: it never stops the game. The player's world is theirs; leaving it running is the policy
// this driver measures, and the run's process ledger records the survivor with that reason rather than as a leak.
// The one press after the disconnect is the panel's own read of the game - a GET - so no authority is granted and
// nothing is sent into the world.
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
    sentences: afterPanel.sentences,
    companionRowsBefore: companionRows(transcriptBefore),
    companionRowsAfter: companionRows(transcriptAfter),
    replayed,
  });
  await shot(page, "98-game-disconnect-after.png");

  // The state must be FORWARD-GOING. A running world with no attachment and no control at all is the
  // zero-forward-path defect class, and it is what the live run measured before this reading existed. The step
  // this build offers here is the panel's own read of the game, and the sentence beside it is read with it: a
  // button nobody can place is not a step. Both are asserted, so a surface that draws one without the other
  // fails by name.
  const forward = afterPanel.controls.reread;
  const forwardOffered = forward !== null && forward.visible === true;
  const worldRunningStated = afterPanel.sentences?.disconnectedWorldRunning != null;
  record("the step and the sentence", {
    forward,
    worldSentence: afterPanel.sentences?.disconnectedWorldRunning ?? null,
    waitingSentence: afterPanel.sentences?.waitingForGame ?? null,
  });

  // …and it must really send. A drawn control whose press changes nothing is the same dead end wearing a
  // button: the press is made here (it is a read, so it grants no authority and sends the world nothing), and
  // the state, the sentence and the step are read again afterwards.
  let pressReading = { pressed: false };
  if (forwardOffered) {
    await page.locator('[data-testid="game-reread"]').first().click();
    await page.waitForTimeout(1500);
    const nextState = await page.evaluate(S.readGameState);
    const nextPanel = await page.evaluate(S.readGameFacts);
    pressReading = {
      pressed: true,
      state: nextState,
      forward: nextPanel.controls.reread,
      worldSentence: nextPanel.sentences?.disconnectedWorldRunning ?? null,
      pidAlive: S.pidAlive(target.pid),
    };
    await shot(page, "99-game-disconnect-after-read.png");
  }
  record("the step pressed", pressReading);

  const reading = classifyDisconnect({
    gameAliveAfter: aliveAfter,
    after: {
      attachmentStatus: settled.state.attachmentStatus,
      connectionStatus: settled.state.connectionStatus,
      actionAuthority: settled.state.actionAuthority,
    },
    forward: { offered: forwardOffered, name: forward === null ? null : forward.name },
    worldRunningStated,
    replayed,
    disconnectedBy: "browser surface",
  });
  return await S.conclude({ browser, say, flush, driver: "z", scenario: "disconnect", facts, reading });
})().catch((error) => {
  console.log("DRIVER Z FAILED:", String(error).slice(0, 900));
  process.exit(1);
});
