// Driver X: the game dies while a turn is running.
//
// The scenario a player meets by double-clicking the wrong thing, or by a mod crash: the world stops mid-turn,
// and the product has to say what happened instead of going quiet. Four readings, each one a fact the product
// publishes (`capture/game-states-verdict.mjs` holds the judgement):
//
//   role exit   `game.instance.playerHostExitCode` - the native code the Guardian reported for the game.
//   host fact   the cabin read's bounded `stardew_player_host_exited`, not `state_unavailable`.
//   surface     the panel's own fact row carrying that code, and no relaunching word beside it.
//   turn        the turn that was in flight settled: not still streaming, and no NEW `succeeded`.
//
// HOW THE GAME DIES. By killing exactly one process, by pid, that this driver's own launch created: the game
// client under the installation this run was configured with, appearing after this driver started. Never by
// image name - the player may be running their own game from the same folder (#3715) - and never by a sweep.
//
// NOT-MEASURED, never a fabricated pass: no guardian server on this machine (`guardian_pipe_unreachable`, the
// pipe population travels in the detail), no registered installation, a launch that never reached ready, or no
// game process to kill. Each is a prerequisite this machine owes, not a fault in the product.
const { canStartTurn, shot } = require("./common.cjs");
const S = require("./game-surface-states.cjs");
const { classifyDeath, NOT_MEASURED_REASONS } = require("./game-states-verdict.mjs");

(async () => {
  const { say, flush, facts, record, notMeasured, browser, page, problems, gameDir, target } =
    await S.startStateDriver({ driver: "x", scenario: "death", reportFile: "x-game-death.txt" });
  await shot(page, "95-game-death-ready.png");

  // A turn in flight: the player says one line and the world dies before the companion can answer.
  //
  // The gate is asked OF THE GAME SURFACE, because that is the surface this driver acts on: the Game
  // surface is the lifecycle panel and mounts no composer, while the Chat surface always mounts one, so a
  // document-wide question answered `ok` for a surface with no input and the fill then handed a native
  // setter `null` (`Illegal invocation`, measured on `frontend--r23`). With no input to send, the world
  // still dies and the three product readings below are still measured; what cannot be produced is a
  // turn left in flight, and the record says so rather than fabricating one.
  const turnGate = await canStartTurn(page, { surface: "game-surface" });
  record("turn gate", turnGate);
  const transcriptBefore = await page.evaluate(S.readGameTranscript);
  const stateBefore = await page.evaluate(S.readGameState);
  record("turn before", {
    playerRows: transcriptBefore.rows.filter((row) => row.role === "player").length,
    outcome: stateBefore.latestOutcome,
  });
  let inFlight = transcriptBefore;
  if (turnGate.ok) {
    await page.evaluate((line) => {
      const scope = document.querySelector('[data-testid="game-surface"]');
      const area = scope.querySelector("textarea.composer-textarea");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(area, line);
      area.dispatchEvent(new Event("input", { bubbles: true }));
    }, S.PLAYER_LINE);
    await page.waitForTimeout(250);
    await page.locator('[data-testid="game-surface"] .composer-button.send-button').first().click();
    say(`one player line sent in the game surface: ${JSON.stringify(S.PLAYER_LINE)}`);
    const acceptedBegan = Date.now();
    inFlight = await page.evaluate(S.readGameTranscript);
    while (Date.now() - acceptedBegan < 20_000) {
      const playerRows = inFlight.rows.filter((row) => row.role === "player").length;
      const streaming = inFlight.rows.filter((row) => row.streaming === true).length;
      if (playerRows > transcriptBefore.rows.filter((row) => row.role === "player").length || streaming > 0) break;
      await page.waitForTimeout(500);
      inFlight = await page.evaluate(S.readGameTranscript);
    }
  } else
    say(
      `the game surface offers no player input (${String(turnGate.reason)}): no turn can be in flight when the world dies, so the settle reading reports the product's own exit facts and does not claim a turn it never sent`,
    );
  record("turn in flight", { rows: inFlight.rows, notice: inFlight.notice });

  // The one destructive act: one process, by the exact pid this driver's own launch created.
  const kill = S.killExactPid(target.pid);
  record("kill", { pid: target.pid, name: target.name, startTime: target.startTime, outcome: kill, why: `the game under ${gameDir} this run launched` });
  say(`killed the game by exact pid ${String(target.pid)} (${String(target.name)}): ${kill}`);
  if (kill === "unavailable")
    return await notMeasured(browser, NOT_MEASURED_REASONS.noGamePid, `the kill of pid ${String(target.pid)} could not be performed; nothing died, so nothing was measured`);

  // Reading 1: the exit the Guardian reported reaches the state route.
  const exit = await S.waitForState(page, (reading) => reading.ok === true && reading.playerHostExitCode !== undefined, 90_000);
  record("role exit", { settled: exit.settled, elapsedMs: exit.elapsedMs, state: exit.state });
  // Reading 2: the Host's bounded code for a world that is gone.
  const cabin = await S.readCabinFact(page);
  record("host fact", cabin);
  // Reading 3: the panel's own sentence.
  const afterPanel = await page.evaluate(S.readGameFacts);
  const factValues = Object.values(afterPanel.facts);
  const exitCode = exit.settled === true ? exit.state.playerHostExitCode : null;
  const instanceText = exitCode === null ? null : (factValues.find((value) => String(value).includes(String(exitCode))) ?? null);
  record("surface after the death", { state: afterPanel.state, facts: afterPanel.facts, controls: afterPanel.controls });

  // Reading 4: the turn settles. A turn that keeps streaming is waiting for a world that no longer exists.
  const settleBegan = Date.now();
  let settledTranscript = await page.evaluate(S.readGameTranscript);
  while (Date.now() - settleBegan < S.BUDGET.settleMs && settledTranscript.rows.some((row) => row.streaming === true)) {
    await page.waitForTimeout(1000);
    settledTranscript = await page.evaluate(S.readGameTranscript);
  }
  const stateAfter = await page.evaluate(S.readGameState);
  record("turn after the death", {
    elapsedMs: Date.now() - settleBegan,
    streamingCompanionRows: settledTranscript.rows.filter((row) => row.streaming === true && row.role === "companion").length,
    rows: settledTranscript.rows,
    notice: settledTranscript.notice,
    outcome: stateAfter.latestOutcome,
  });
  await shot(page, "96-game-death-after.png");

  const reading = classifyDeath({
    roleExit: { read: exitCode !== null, exitCode },
    hostFact: cabin,
    surface: {
      instanceText,
      launchingWord: exit.state?.instanceStatus === "launching",
      factValues,
    },
    turn: {
      inFlight: turnGate.ok,
      streamingCompanionRows: settledTranscript.rows.filter((row) => row.streaming === true && row.role === "companion").length,
      outcomeBefore: stateBefore.latestOutcome,
      outcomeAfter: stateAfter.latestOutcome,
    },
  });
  return await S.conclude({ browser, say, flush, driver: "x", scenario: "death", facts, reading });
})().catch((error) => {
  console.log("DRIVER X FAILED:", String(error).slice(0, 900));
  process.exit(1);
});
