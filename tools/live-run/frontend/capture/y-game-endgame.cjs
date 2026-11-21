// Driver Y: the explicit endgame, after the game has already ended - architecture invariant 506.
//
// `game.endgame` is the only operation that may terminate the Player (`host/src/game-browser-contract/index.ts:
// 594-617`), and the invariant this driver exists for is that it SETTLES even when the game died first: the
// coordinator has already observed a `role_exited`, and a terminal operation that then refuses leaves the world
// in a state nobody can settle. So the reading is `gameended` in the SAME Host session that saw the exit, with
// the pid gone.
//
// The control is pressed when the surface offers it. After a crash of an unattached instance the panel offers
// only `restart_gamebuddy` (`dialogue-web/src/game-lifecycle-controls.ts:390`), so when no endgame control is
// drawn the driver sends the product's authenticated route with the page's own session and records the absent
// control as its own fact (`offered: false`) - the invariant is about the operation, and a missing control is a
// separate, named finding, not a reason to skip the invariant.
//
// Same death as driver X, and the same exact-pid rule.
const { shot } = require("./common.cjs");
const S = require("./game-surface-states.cjs");
const { classifyEndgame, NOT_MEASURED_REASONS } = require("./game-states-verdict.mjs");

(async () => {
  const { say, flush, facts, record, notMeasured, browser, page, problems, target } = await S.startStateDriver({
    driver: "y",
    scenario: "endgame_after_exit",
    reportFile: "y-game-endgame.txt",
  });
  const kill = S.killExactPid(target.pid);
  record("kill", { pid: target.pid, name: target.name, outcome: kill });
  if (kill === "unavailable")
    return await notMeasured(browser, NOT_MEASURED_REASONS.noGamePid, `the kill of pid ${String(target.pid)} could not be performed`);

  // The session must have OBSERVED the exit before the endgame is asked for: invariant 506 is about what the
  // terminal operation does in a session that already holds the `role_exited`, not about a race with it.
  const exit = await S.waitForState(page, (reading) => reading.ok === true && reading.playerHostExitCode !== undefined, 90_000);
  record("role exit observed", { settled: exit.settled, state: exit.state });
  if (!exit.settled)
    return await notMeasured(
      browser,
      NOT_MEASURED_REASONS.gameNeverReady,
      `the Host never published a playerHostExitCode within 90s of the kill, so no session observed the exit for the endgame to settle (last ${JSON.stringify(exit.state)})`,
    );

  // The endgame, through the control when the panel draws one.
  const before = await page.evaluate(S.readGameFacts);
  const offeredControl = before.controls.endgame;
  record("endgame control", { offered: offeredControl, controls: before.controls });
  let attempted = "control";
  if (offeredControl !== null && offeredControl.visible === true) {
    await page.locator('[data-testid="game-endgame-open"]').first().click();
    const confirm = await S.waitForControl(page, "endgameConfirm", 15_000);
    record("endgame confirm", { settled: confirm.settled, control: confirm.facts.controls.endgameConfirm });
    if (!confirm.settled)
      return await notMeasured(browser, NOT_MEASURED_REASONS.endgameControlAbsent, "the endgame control armed no confirm step, so the operation could not be asked for through the surface");
    await page.locator('[data-testid="game-endgame-confirm-yes"]').first().click();
  } else {
    attempted = "route";
    say("the panel offered no endgame control after the exit (dialogue-web/src/game-lifecycle-controls.ts:390: a crashed unattached instance offers only restart_gamebuddy); asking the product's authenticated route instead");
  }

  // Whether it was pressed or posted, the operation's outcome is read the same way: the route's own answer.
  const began = Date.now();
  let answer = null;
  if (attempted === "route") {
    answer = await S.postGameRoute(page, "/game/endgame", {
      expectedAttachmentGeneration: Math.max(1, exit.state.attachmentGeneration ?? 1),
      confirm: true,
    });
  } else {
    // The pressed control's own answer arrives as the panel's failure sentence or as the state settling below.
    const settled = await S.waitForState(
      page,
      (reading) => reading.ok === true && (reading.instanceStatus === "stopped" || reading.instanceStatus === "none"),
      S.BUDGET.endgameMs,
    );
    record("endgame by control", { settled: settled.settled, elapsedMs: Date.now() - began, state: settled.state });
    answer = settled.settled
      ? { status: 200, body: { status: "gameended" } }
      : { status: "control_did_not_settle", body: null, code: problems.get("game/endgame")?.code ?? null };
  }
  record("endgame answer", { attempted, answer, problems: [...problems.entries()] });

  const aliveAfter = S.pidAlive(target.pid);
  const after = await page.evaluate(S.readGameFacts);
  record("after the endgame", { pidAlive: aliveAfter, facts: after.facts, state: after.state });
  await shot(page, "97-game-endgame-after.png");

  const reading = classifyEndgame({
    offered: attempted === "control",
    result: answer.body ?? null,
    gameAliveAfter: aliveAfter,
    refusalCode: answer.code ?? null,
  });
  return await S.conclude({ browser, say, flush, driver: "y", scenario: "endgame_after_exit", facts, reading });
})().catch((error) => {
  console.log("DRIVER Y FAILED:", String(error).slice(0, 900));
  process.exit(1);
});
