// Driver X: the game dies while a turn is running — and then the surface starts another one.
//
// The scenario a player meets by double-clicking the wrong thing, or by a mod crash: the world stops mid-turn,
// and the product has to say what happened instead of going quiet. Six readings, each one a fact the product
// publishes (`capture/game-states-verdict.mjs` and `capture/second-attempt.mjs` hold the judgements):
//
//   role exit   `game.instance.playerHostExitCode` - the native code the Guardian reported for the game.
//   host fact   the cabin read's bounded `stardew_player_host_exited`, not `state_unavailable`.
//   surface     the panel's own fact row carrying that code, and no relaunching word beside it.
//   turn        the turn that was in flight settled: not still streaming, and no NEW `succeeded`.
//   second attempt  the panel's own steps after the ending, pressed where a player presses them, reaching
//                   `instance=running` with `attachment=attached` - and the durable registration's number
//                   moving to the next attempt rather than the ended one being re-read.
//   chat        the Chat that was open before the world died is still the selected conversation, with its
//                   transcript, after the second attempt attached.
//
// WHY THE SECOND ATTEMPT IS HERE AND NOT IN A DRIVER OF ITS OWN. The world this reading needs is a world that
// has just ENDED, and this is the driver that ends one: it kills exactly one process, by pid, that this run's
// own launch created. A second driver would have to kill its own world first and would then be measuring the
// same thing one mount later. The two readings are one scenario - the ending, and the step out of it - so they
// are taken on one world, in one Host process, in the order a player meets them.
//
// WHAT THE SECOND ATTEMPT IS FOR. `dialogue-web/src/game-lifecycle-controls.ts` maps a game the Host watched
// end to `ended_attempt_ready`, whose step is `activate` (the guide's step 1) followed by `launch` (step 2).
// Before lane GEN2MEASURE both `crashed` and `stopped` mapped to a phase whose only step was
// `restart_gamebuddy` - a quit from the tray, off the page - and nothing had pressed the press that replaced
// it on a real world. The refusals this step can meet are named, not smoothed over: a panel that offers only
// `restart_gamebuddy` is `second_attempt_only_restart_gamebuddy`, and an attempt the Host refuses is the
// Host's own code in the driver's log.
//
// MEASURED FOUR TIMES, AND THE READINGS ARE THE POINT. At commit `09484648` (2026-11-23) a game the Host
// watched end left the panel with NO staging step at all - `attachment.status: "attached"` outlived the Player
// Host's exit, `deriveGameSessionControls` led with the attachment, and the surface drew only 断开游戏连接 /
// 结束游戏, so `ended_attempt_ready` was unreachable in that shape and the only way out was to disconnect
// first (`.tmp/lane-gen2live.md` §4c). At commit `9682e223` the derivation leads with the ending instead, and
// this driver's own press list says so: `SECOND-ATTEMPT the panel offered "activate"; pressed
// ["activate","launch"]`, with `activate` the only control the panel drew while `attachment: attached` was
// still latched (`.tmp/lane-gen2end.md` §3e); there the launch was refused (`409 game_unavailable`, `cause:
// stardew_player_host_launch_failed`) before any Player Host process existed.
//
// THE TWO RUNS AFTER THAT SEPARATE THE SESSION FROM THE HANDOFF, and neither is "the retry works":
//
//   `d7b7ac6a` (the guardian broker serves the next attempt on its own session, `.tmp/lane-guardsession.md`
//   §4a-4b): the retry armed on a FRESH session with its own hello and its own Guardian, launched a real
//   Player Host, and its world advertised two cabins - but after one cabin confirm the attach never latched
//   (`second_attempt_did_not_attach:running/none`) and the attempt's own record went `quarantined` /
//   `retry_required` AFTER the launch.
//
//   `b7c8de04` (`.tmp/lane-gen2prove.md` §8): the same fresh session, arm and Guardian again (`arm_attempt`,
//   `launch_role`, a second Guardian pid, a Player Host that loaded the run's own save and built the cabin,
//   `refusals: []`), and this time the cabin handoff was never reached at all: the panel's own read window ran
//   `8/30 -> 16/30 -> 25/30` and then drew `cabin-launch-wait-expired` with 0 choices and 0 confirms, while the
//   world published `state: ready` with two cabins three and a half minutes AFTER that window closed, and the
//   attempt's own record stayed `reserved` (revision 1) for the nine minutes its role ran. So a later reader
//   must not take either run for the other: the session half is fixed live, the attach half is open, and the
//   layer it stops at is different in each (the cabin handoff's bounded read vs. the attach after a confirm).
//
// THE FIFTH READING NAMES A LATER LAYER, AND ITS WORLD WAS FAST. At `6eec146a` (2026-11-24, stage
// `C:\gb-lanes\gen2close`, `.tmp/lane-gen2close.md` §4) the same crash and the same two presses ran on a retry whose
// own session document published `state: ready` **9 234 ms** after the launch press, so the panel's 30-read window
// never expired and the refresh this driver now holds in reserve was never what decided the run. What happened
// instead: two cabins were offered ("Cabin 1", "Cabin 2"), the driver pressed the confirm (one press), the game
// issued the signed Farmhand manifest and admitted the companion (SMAPI 04:34:50), the Guardian launched the
// ai-client half (04:34:52) and its trace records `hello` and an `observe_request` - and the attempt's own record
// then read `state: quarantined`, `cleanupDisposition: retry_required` (revision 2, 04:35:02): `attachment` never
// published. The panel's answer is its own sentence and its own ONE control - `确认结果仍在等待验证。请勿再次确认；…`
// with `再查一次游戏状态` (the `uncertain` state), not the cabin refresh `再读一次小屋`; `cabin-launch-wait-expired`
// is gone because the projection reads `instance=running`, and three presses of that control over 54 s did not
// change it. So the three runs since `d7b7ac6a` stop at three DIFFERENT named layers - the attach after a confirmed
// cabin, the read window, and now the confirm's publication - and none of them may be read as another.
//
// SO THE ESCAPE IS STILL ITS OWN NAMED PRESS. When the panel's staging step is not there and its attachment
// release is, this driver presses that release ONCE, records it as `release_attachment` beside the staging
// presses, and says what it was. It is the player's panic escape, not the product's answer: a run that reached
// the second attempt through it proves the staging chain still works, and proves nothing about a crash offering
// a retry. The verdict line carries both facts (`pressed release_attachment then activate then launch`), so no
// later reader can take one for the other. A panel that draws a staging step never reaches this branch.
//
// HOW THE GAME DIES. By killing exactly one process, by pid, that this driver's own launch created: the game
// client under the installation this run was configured with, appearing after this run started. Never by
// image name - the player may be running their own game from the same folder (#3715) - and never by a sweep.
//
// NOT-MEASURED, never a fabricated pass: no guardian server on this machine (`guardian_pipe_unreachable`, the
// pipe population travels in the detail), no registered installation, a launch that never reached ready, or no
// game process to kill. Each is a prerequisite this machine owes, not a fault in the product.
const { activateSurface, canStartTurn, createChat, readDurableTranscript, shot } = require("./common.cjs");
const S = require("./game-surface-states.cjs");
const { classifyDeath, NOT_MEASURED_REASONS, verdictLine } = require("./game-states-verdict.mjs");
const SECOND = require("./second-attempt.mjs");

/**
 * One Chat turn, settled, and the conversation it landed in - read BEFORE the world dies.
 *
 * A fresh run root may hold no conversation at all: the product's own New Chat control is the step that makes
 * one, and it lands in the Chat it made (`capture/common.cjs` `createChat`). The turn is a real provider turn
 * through the surface the player uses, and `settled` is the surface's own three facts: nothing running, no
 * streaming row, and one more settled companion row than before. A turn that did not settle is NOT a Chat to
 * protect, so it answers `ok: false` with its own name rather than handing the retry a reading it never took.
 */
async function openChatWithOneTurn({ page, say, record }) {
  await activateSurface(page, "聊天");
  await page.waitForTimeout(1500);
  let mounted = await readDurableTranscript(page);
  if (mounted.ok !== true || mounted.selection === null || mounted.selection === undefined) {
    const created = await createChat(page);
    say(`no conversation was mounted, so one was made through the product's own New Chat control: ${JSON.stringify(created)}`);
    if (!created.landed)
      return {
        ok: false,
        reason: `chat_create_did_not_land:${String(created.started)}`,
        detail: `the New Chat control answered ${JSON.stringify(created)} and no conversation is mounted to write into`,
      };
    mounted = await readDurableTranscript(page);
    say(`the conversation the New Chat control landed in: ${JSON.stringify(mounted.selection ?? null)}`);
  }
  const gate = await canStartTurn(page);
  if (!gate.ok)
    return {
      ok: false,
      reason: `chat_composer_refused:${gate.reason}`,
      detail: `the Chat surface's composer refuses a turn (${gate.reason}): ${gate.sentence ?? "(no sentence)"}`,
    };
  const rowsBefore = await page.evaluate(SECOND.readChatTurnState);
  await page.evaluate((line) => {
    const area = document.querySelector(".composer-textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(area, line);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }, S.PLAYER_LINE);
  await page.waitForTimeout(250);
  await page.locator(".composer-button.send-button").first().click();
  say(`one player line sent in the Chat surface: ${JSON.stringify(S.PLAYER_LINE)}`);
  const settledNow = (turn) =>
    turn.running === false && turn.streamingRows === 0 && turn.settledCompanionRows > rowsBefore.settledCompanionRows;
  const began = Date.now();
  let turn = await page.evaluate(SECOND.readChatTurnState);
  while (Date.now() - began < S.BUDGET.turnMs && !settledNow(turn)) {
    await page.waitForTimeout(1000);
    turn = await page.evaluate(SECOND.readChatTurnState);
  }
  const settled = settledNow(turn);
  const snapshot = await readDurableTranscript(page);
  const rows = Array.isArray(snapshot.transcript) ? snapshot.transcript.length : null;
  record("the chat turn before the world dies", {
    settled,
    elapsedMs: Date.now() - began,
    before: rowsBefore,
    turn,
    selection: snapshot.selection ?? null,
    rows,
  });
  if (!settled)
    return {
      ok: false,
      reason: `chat_turn_did_not_settle:${String(Date.now() - began)}`,
      detail: `the Chat turn had not settled after ${String(Date.now() - began)}ms (${JSON.stringify(turn)}), so there is no settled conversation to protect across the retry`,
    };
  say(
    `the Chat turn settled in ${String(Date.now() - began)}ms: conversation ${JSON.stringify(snapshot.selection?.chatHandle ?? null)}, selection generation ${String(snapshot.selection?.generation ?? "unobserved")}, ${String(rows)} transcript row(s)`,
  );
  return { ok: true, before: snapshot };
}

/**
 * The second attempt, pressed where the player presses it: the panel's own step 1, then its step 2.
 *
 * NOTHING HERE IS DERIVED: each press is the control the panel is drawing (`second-attempt.mjs`
 * `secondAttemptPress`), and the wait after each press is for the step the panel offers NEXT - which is what a
 * player waits for too. The cabin handoff is the guide's third step and the only path from a launched Player
 * Host to an attachment, so it is driven again here for the second attempt: the world is the same one, and a
 * companion that has to move in again is exactly what the product says it is doing.
 *
 * THE ESCAPE GETS ITS OWN PRESS AND ITS OWN NAME. A game the Host watched end still publishes
 * `attachment: attached`, so the panel draws the attachment's own controls and no staging step (see this
 * file's header). The panel's `game-disconnect` is then the only step a player can take, so this function takes
 * it ONCE, records it as `release_attachment`, and waits for the staging step it makes reachable. A run whose
 * presses start with `release_attachment` proves the staging chain; it does NOT prove that a crash offers a
 * retry, and the verdict line names the difference.
 */
async function driveSecondAttempt({ page, say, record, problems }) {
  /** The Host's own refusal on one of the routes this step presses, when it answered one. */
  const problemLine = (route) => {
    const problem = problems?.get(route) ?? null;
    if (problem === null)
      return " and the Host answered no refusal on that route (the press was either admitted or never reached the Host)";
    return ` (the Host answered HTTP ${String(problem.status)} ${JSON.stringify(problem.code)}${typeof problem.cause === "string" && problem.cause.length > 0 ? ` (cause: ${problem.cause})` : ""})`;
  };
  const declaredDataRoot = S.readLaunchState().state?.declaredDataRoot ?? null;
  const registration = { before: SECOND.readRegistrationGeneration(declaredDataRoot), after: null };
  const before = await page.evaluate(S.readGameState);
  record("before the second attempt", { state: before, registration: registration.before });

  const presses = [];
  const testIdOf = { release_attachment: "game-disconnect", activate: "game-activate", launch: "game-launch" };
  const press = async (step, name) => {
    const what =
      step === "release_attachment"
        ? "attachment release (the panel's own escape from a crash it will not stage)"
        : step === "activate"
          ? "step 1"
          : "step 2";
    say(`pressing the panel's own ${what} through ${JSON.stringify(name)}`);
    await page.locator(`[data-testid="${testIdOf[step]}"]`).first().click();
    presses.push(step);
  };
  const offered = async () => SECOND.secondAttemptPress({ facts: await page.evaluate(S.readGameFacts) });

  /** Poll the panel until it offers the exact step this retry needs next, or the budget runs out. */
  const waitForStep = async (expected, budgetMs) => {
    const began = Date.now();
    let next = await offered();
    while (Date.now() - began < budgetMs) {
      if (next.kind === "press" && next.step === expected) return next;
      await page.waitForTimeout(1000);
      next = await offered();
    }
    return next;
  };

  let decision = await offered();
  record("the step the panel offers after the ending", { decision, state: before });
  if (decision.kind !== "press") {
    say(`${SECOND.SECOND_ATTEMPT_PREFIX} ${decision.code}: ${decision.detail}`);
    return { kind: "refused", decision, presses, before, staged: null, after: before, registration };
  }
  await press(decision.step, decision.name);

  if (decision.step === "release_attachment") {
    /*
     * The escape, recorded for what it is. What follows is the shop for the reading's own question: with the
     * attachment released, is the staging step there - and does the attempt it stages reach an attached world
     * at a number above the one the ended attempt held?
     */
    say(
      `${SECOND.SECOND_ATTEMPT_PREFIX} escape: the panel offered no staging step after the game ended and its attachment release was the only one it drew; that escape has been pressed once (release_attachment), and the staging step is what is waited for next - the product's answer to a crash is still missing, and this press does not stand in for it`,
    );
    decision = await waitForStep("activate", S.BUDGET.activationMs);
    record("the step the release produced", {
      decision,
      state: await page.evaluate(S.readGameState),
      problem: problems?.get("game/disconnect") ?? null,
    });
    if (decision.kind !== "press" || decision.step !== "activate") {
      const refusal =
        decision.kind === "refused"
          ? decision
          : {
              code: "second_attempt_no_staging_step_after_the_escape",
              detail: `the attachment release was pressed and, ${String(S.BUDGET.activationMs)}ms later, the panel still offers ${JSON.stringify(decision)} rather than the staging step${problemLine("game/disconnect")}`,
            };
      say(`${SECOND.SECOND_ATTEMPT_PREFIX} ${refusal.code}: ${refusal.detail}`);
      return { kind: "refused", decision: refusal, presses, before, staged: null, after: before, registration };
    }
    await press(decision.step, decision.name);
  }

  // Step 2 is what step 1 stages. The panel re-reads the Game projection after an activation, and while that
  // read is in flight neither control is pressable - which is a wait, not a refusal, so the budget is what ends
  // this loop and the LAST reading is what the refusal would quote.
  let staged = null;
  if (decision.step === "activate") {
    const next = await waitForStep("launch", S.BUDGET.activationMs);
    staged = await page.evaluate(S.readGameState);
    record("the step the activation produced", {
      decision: next,
      state: staged,
      registration: SECOND.readRegistrationGeneration(declaredDataRoot),
    });
    if (next.kind !== "press" || next.step !== "launch") {
      const refusal =
        next.kind === "refused"
          ? next
          : {
              code: "second_attempt_activation_produced_no_step",
              detail: `the activation was pressed and, ${String(S.BUDGET.activationMs)}ms later, the panel still offers ${JSON.stringify(next)} rather than the launch step (state ${JSON.stringify(staged)})${problemLine("lifecycle/activate")}`,
            };
      say(`${SECOND.SECOND_ATTEMPT_PREFIX} ${refusal.code}: ${refusal.detail}`);
      return { kind: "refused", decision: refusal, presses, before, staged, after: staged, registration };
    }
    await press(next.step, next.name);
  }

  // ---- the launch, and the guide's third step, in one wait ----
  //
  // THE LAST REFRESH IS HELD FOR THE WORLD, and that is the whole point of this loop's shape. Measured
  // 2026-11-24 at `b7c8de04` (`.tmp/lane-gen2prove.md` §8d): the panel's own bounded read window ran
  // `8/30 -> 16/30 -> 25/30` and drew `cabin-launch-wait-expired`, while the retry's world published
  // `state: ready` three and a half minutes AFTER that window closed - so every press this driver had made
  // asked a world that had not loaded its save yet, and no press happened once it had. Two presses may be spent
  // on a launch that is still loading; the third waits until the world says it is ready (`readAttemptWorld`,
  // named by the registration's own attempt pointer), which is the state the panel's sentence leaves the player.
  const attachBegan = Date.now();
  let state = await page.evaluate(S.readGameState);
  let confirms = 0;
  let confirmPressedAtMs = null;
  let refreshes = 0;
  let lastRefreshAtMs = attachBegan;
  let handoff = null;
  let world = null;
  let worldReadyAtMs = null;
  let reservedPressAtMs = null;
  while (Date.now() - attachBegan < S.BUDGET.retryAttachMs) {
    if (state.ok === true && state.attachmentStatus === "attached") break;
    handoff = await page.evaluate(SECOND.readSecondAttemptHandoff);
    world = SECOND.readAttemptWorld({
      declaredDataRoot,
      bootstrapCorrelation: SECOND.readRegistrationGeneration(declaredDataRoot).bootstrapCorrelation,
    });
    if (world.read === true && world.state === "ready" && worldReadyAtMs === null) {
      worldReadyAtMs = Date.now();
      say(
        `the retry's world published ready after ${String(worldReadyAtMs - attachBegan)}ms (${JSON.stringify(world)}); the panel's own refresh control is what is left to press`,
      );
    }
    const offer =
      handoff.present === true
        ? (handoff.choices.find(
            (choice) => choice.confirm !== null && choice.confirm.visible === true && choice.confirm.disabled !== true,
          ) ?? null)
        : null;
    const mayPress = confirmPressedAtMs === null || Date.now() - confirmPressedAtMs >= 20_000;
    if (offer !== null && mayPress && confirms < 3) {
      say(
        `the cabins the Host offers this attempt: ${JSON.stringify(handoff.choices.map((choice) => choice.label))}; pressing ${JSON.stringify(offer.confirm.name)}`,
      );
      await page.locator('[data-testid="cabin-choice-list"] li.game-choice button').first().click();
      confirms += 1;
      confirmPressedAtMs = Date.now();
    } else if (
      handoff.present === true &&
      handoff.choices.length === 0 &&
      refreshes < 3 &&
      Date.now() - lastRefreshAtMs >= 20_000 &&
      (refreshes < 2 || (world.read === true && world.state === "ready"))
    ) {
      const refresh = handoff.secondary.find((control) => control.visible === true && control.disabled !== true) ?? null;
      if (refresh !== null) {
        if (refreshes === 2) reservedPressAtMs = Date.now();
        say(
          `no cabin offer yet (${JSON.stringify(handoff.launchLine)}); pressing the handoff's own ${JSON.stringify(refresh.name)}${refreshes === 2 ? ` - the refresh held for the world, which reads ${JSON.stringify(world)}` : ""}`,
        );
        await page
          .locator('[data-testid="game-surface"] section.stardew-cabin-handoff button.game-secondary-action')
          .first()
          .click();
        refreshes += 1;
        lastRefreshAtMs = Date.now();
      }
    }
    await page.waitForTimeout(1000);
    state = await page.evaluate(S.readGameState);
  }
  registration.after = SECOND.readRegistrationGeneration(declaredDataRoot);
  record("after the second attempt", {
    presses,
    confirms,
    refreshes,
    reservedPressAtMs,
    state,
    handoff,
    world,
    worldReadyAtMs,
    registration,
    elapsedMs: Date.now() - attachBegan,
  });
  if (state.ok === true && state.attachmentStatus === "attached")
    say(
      `the second attempt attached: ${JSON.stringify({
        instance: state.instanceStatus,
        attachment: state.attachmentStatus,
        attachmentGeneration: state.attachmentGeneration,
        registrationBefore: registration.before.instanceGeneration ?? null,
        registrationAfter: registration.after.instanceGeneration ?? null,
        stagedGeneration: staged?.instanceGeneration ?? null,
        confirms,
      })}`,
    );
  else say(`the second attempt did not attach within ${String(S.BUDGET.retryAttachMs)}ms: ${JSON.stringify(state)}; the world it waited for read ${JSON.stringify(world)}${problemLine("game/launch")}`);
  return { kind: "pressed", presses, before, staged, after: state, registration };
}

/** The conversation that was open, read again after the retry settled. */
async function readSameChat({ page }) {
  await activateSurface(page, "聊天");
  const after = await readDurableTranscript(page);
  return { after, rendered: await page.evaluate(SECOND.readChatTurnState) };
}

(async () => {
  const { say, flush, facts, record, notMeasured, browser, page, problems, gameDir, target } =
    await S.startStateDriver({ driver: "x", scenario: "death", reportFile: "x-game-death.txt" });
  await shot(page, "95-game-death-ready.png");

  /*
   * ---- 0. the Chat that must survive the retry ----
   *
   * Taken BEFORE the world dies, because that is the only moment the precondition can be established: a Chat
   * turn settled while the game is attached. It is the reading that closes the precondition lane GEN2MEASURE
   * argued structurally only (`design/` ADR-0015 §9.4 item 2 - eleven readings of the desktop composition and
   * none of them "a second game attempt leaves the mounted Chat alone").
   */
  const chat = await openChatWithOneTurn({ page, say, record });
  if (chat.ok !== true)
    say(`no Chat reading could be taken across the retry: ${chat.reason} - ${chat.detail}; the second attempt below still runs, and its verdict says the Chat half was not measured`);
  await activateSurface(page, "游戏");
  await page.waitForTimeout(1000);

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

  const death = classifyDeath({
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

  // ---- 5. the second attempt: the panel's own steps, on the world that just ended ----
  const retry = await driveSecondAttempt({ page, say, record, problems });
  const chatAfter = await readSameChat({ page });
  record("the chat after the second attempt", { rendered: chatAfter.rendered, selection: chatAfter.after.selection ?? null });
  const chatReading = SECOND.chatSurvivedSecondAttempt({ before: chat.ok === true ? chat.before : null, after: chatAfter.after });
  say(`${SECOND.SECOND_ATTEMPT_PREFIX} ${chatReading.code}: ${chatReading.detail}`);

  const secondAttempt =
    retry.kind === "refused"
      ? { verdict: "failed", reason: retry.decision.code, detail: retry.decision.detail }
      : SECOND.classifySecondAttempt({
          presses: retry.presses,
          staged: retry.staged,
          after: retry.after,
          registration: retry.registration,
          chat: chatReading,
        });
  record("second attempt reading", secondAttempt);
  say("=== ITEM: the death ===");
  say(verdictLine("death", death));
  say("=== ITEM: the second attempt ===");
  say(verdictLine("second_attempt", secondAttempt));
  say(`=== ITEM: the second attempt's own steps ===`);
  say(
    `${SECOND.SECOND_ATTEMPT_PREFIX} the panel offered ${JSON.stringify(
      retry.kind === "refused" ? retry.decision : (retry.presses[0] ?? null),
    )}; pressed ${JSON.stringify(retry.presses)}; state ${JSON.stringify(retry.after)}; registration ${JSON.stringify({ before: retry.registration.before, after: retry.registration.after })}`,
  );

  // The death reading is the scenario's own; a death that failed is reported first, because a retry measured
  // on a world whose ending the product never published is a retry of something else.
  const reading = death.verdict === "measured" ? secondAttempt : death;
  return await S.conclude({ browser, say, flush, driver: "x", scenario: "death", facts, reading });
})().catch((error) => {
  console.log("DRIVER X FAILED:", String(error).slice(0, 900));
  process.exit(1);
});
