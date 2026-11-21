/**
 * What a game that ENDS means, in the three ways a player can meet it: the game dies under a turn, the
 * surface disconnects while the game keeps running, and the explicit endgame that is the only operation
 * allowed to settle the world.
 *
 * One module for the three, because they share one question - "did the product say what happened, or did it
 * go quiet?" - and because the answer has to be the same wherever it is asked. The drivers that read a real
 * session (`x-game-death.cjs`, `y-game-endgame.cjs`, `z-game-disconnect.cjs`) call these; their test drives the
 * same functions with the readings a healthy run and a broken one would produce, so the judgement is red-able
 * without a game.
 *
 * THE WORDS ARE THE PRODUCT'S, NOT INVENTED HERE. `game.instance.playerHostExitCode` is the native code the
 * Guardian reported for the game (`host/src/game-browser-contract/index.ts:258-269`), `stardew_player_host_exited`
 * is the Host's bounded code for the same fact (`host/src/composed-reference-game-browser.ts:647-668`), and the
 * surface's instance row is `instanceLabel()` (`dialogue-web/src/game-presentation.ts:66-92`). A turn has no
 * "unknown" outcome to read - `latestOutcome` is `none | succeeded | failed | cancelled` - so "the turn settled
 * as unknown" is checked as the two things that are checkable: it stopped streaming, and the product did not
 * claim it succeeded.
 */

/** The prefix of the line these drivers contribute, beside `GAME-LAUNCH` for the launch driver. */
export const GAME_STATES_PREFIX = "GAME-STATES";

/** Which reading failed, so a failure names the link instead of the whole scenario. */
export const DEATH_READINGS = Object.freeze({
  roleExit: "role_exit",
  hostFact: "host_fact",
  surface: "surface",
  turn: "turn",
});

const measured = (detail) => Object.freeze({ verdict: "measured", reason: "measured", detail });
const failed = (reason, detail) => Object.freeze({ verdict: "failed", reason, detail });

/**
 * The game died: four readings, each one a fact the product publishes, and every one of them required.
 *
 *   roleExit  `{ read, exitCode }` - the state read carried `instance.playerHostExitCode`. Its ABSENCE is the
 *             failure `role_exit_not_published`: the Guardian's `role_exited` is the only producer of that
 *             field, so a death the Host did not publish is a death the product cannot tell the player about.
 *   hostFact  `{ status, code }` - the Host's own bounded code for the cabin read of a world that is gone. It
 *             must be `stardew_player_host_exited`, not `state_unavailable`: the first is knowledge, the second
 *             is the Host admitting it does not know.
 *   surface   `{ instanceText, launchingWord, factValues }` - what the player reads. `instanceText` is the one
 *             fact value that carries the exit code, found by its content rather than by a localized label, so a
 *             language change cannot make this reading report a missing row; `launchingWord` is the state
 *             route's own `instance=launching`, the word that draws the relaunching sentence. A surface painting
 *             "starting" over a dead game is the exact defect this scenario exists for, so both are required.
 *   turn      `{ inFlight, streamingCompanionRows, outcomeBefore, outcomeAfter }` - a turn in flight when the
 *             game died settled. Not streaming (a hung turn), and not a NEW `succeeded`: an outcome of
 *             `succeeded` published after the death, where there was none before it, is a claim nothing in that
 *             world could have earned. Comparing the two reads is what keeps a `succeeded` left over from an
 *             earlier turn from failing the scenario - it is the transition that is the claim, not the word.
 *             `inFlight: false` is the Game surface that offers no player input (the Chat surface's composer is
 *             not it, `frontend--r23`), and the verdict says which of the two it measured instead of reporting a
 *             settled turn that was never sent.
 */
export function classifyDeath({ roleExit, hostFact, surface, turn }) {
  if (roleExit?.read !== true || !Number.isInteger(roleExit?.exitCode))
    return failed(
      "role_exit_not_published",
      `the state read carried no game.instance.playerHostExitCode after the game process was killed (${describeReading(roleExit)}); the Guardian's role_exited is that field's only producer`,
    );
  if (hostFact?.code !== "stardew_player_host_exited")
    return failed(
      "host_did_not_name_the_exit",
      `the cabin read answered ${JSON.stringify(hostFact ?? null)} instead of the bounded code stardew_player_host_exited - the Host either does not know the game ended or is reporting the wrong fact`,
    );
  if (surface?.instanceText === null || surface?.instanceText === undefined)
    return failed(
      `surface_does_not_name_the_exit_code:${String(roleExit.exitCode)}`,
      `no fact row on the panel carries the exit code the Host published (${String(roleExit.exitCode)}); the panel reads ${JSON.stringify(surface?.factValues ?? [])}: the surface is describing a game other than the one that ended`,
    );
  if (!String(surface.instanceText).includes(String(roleExit.exitCode)))
    return failed(
      `surface_does_not_name_the_exit_code:${String(roleExit.exitCode)}`,
      `the instance row reads ${JSON.stringify(surface.instanceText)}, which does not carry the exit code the Host published (${String(roleExit.exitCode)})`,
    );
  if (surface.launchingWord === true)
    return failed(
      "surface_still_says_launching",
      `the instance row reads ${JSON.stringify(surface.instanceText)} - the launching word over a game that has ended`,
    );
  if ((turn?.streamingCompanionRows ?? 0) > 0)
    return failed(
      `turn_hung_after_game_exit:${String(turn.streamingCompanionRows)}`,
      "a companion row was still streaming when the game died: the turn waited for a world that was gone instead of settling",
    );
  if (turn?.outcomeAfter === "succeeded" && turn?.outcomeBefore !== "succeeded")
    return failed(
      "turn_claimed_success_after_game_exit",
      `the game outcome moved to succeeded (was ${JSON.stringify(turn.outcomeBefore ?? null)}) after the game process ended: nothing in that world could have run`,
    );
  return measured(
    `the game ended with code ${String(roleExit.exitCode)}: the state read published it, the cabin read refused with stardew_player_host_exited, the surface named the code, and ${
      turn?.inFlight === false
        ? "no turn was in flight (the game surface offers no player input), so neither a hung turn nor a claimed success was possible"
        : "the turn in flight settled without claiming success"
    }`,
  );
}

/**
 * The surface disconnected while the game kept running.
 *
 * Product policy is the assertion: an ordinary close, a controller EOF and an AI failure stop AI authority and
 * NEVER the game world (`product policy 3023`). So the reading is inverted from the death case - a game that
 * died here is the failure, not the proof.
 *
 * Four things a player is owed, and each one names its own absence:
 *
 *   gameAliveAfter   the exact pid this run launched is still in the process table.
 *   after            `{ attachmentStatus, connectionStatus, actionAuthority }` from the product's own state read.
 *                     The authority must not be `active`: a silent `active` is the product resuming authority
 *                     nobody granted. The connection word must be `disconnected`, and that is the reading this
 *                     scenario exists for twice over: `none` is the word a session that has NEVER connected
 *                     publishes, so a deliberate disconnect published as `none` leaves the surface saying "not
 *                     connected yet" over a farm that is still running (`host/src/game-browser-contract`
 *                     declares `disconnected`, and the daily chain declares it for `game/disconnect`).
 *   forward          `{ offered, name }` - the one step the surface draws in this state. Measured red on
 *                     `livenow10`: every control was null, on a running world, which is the zero-forward-path
 *                     defect class - a reachable, non-terminal state with nothing the player can do. `name` is
 *                     what the player reads on the control, so a failure quotes it.
 *   worldRunningStated  the panel's own sentence for this state, or `null`. The promise the disconnect makes is
 *                     that the world survives it, so the surface has to SAY so: a panel that drops to "never
 *                     connected" tells the player the opposite of what just happened.
 *   replayed         a companion row appeared after the disconnect with no player line to cause it - the old
 *                     task replayed instead of staying suspended.
 */
export function classifyDisconnect({ gameAliveAfter, after, forward, worldRunningStated, replayed, disconnectedBy }) {
  if (gameAliveAfter !== true)
    return failed(
      "game_stopped_on_disconnect",
      `the game process this run launched is gone after the ${disconnectedBy ?? "surface"} disconnect: an ordinary close must stop AI authority and never the player's game world`,
    );
  if (after?.attachmentStatus === "attached")
    return failed(
      "attachment_survived_disconnect",
      `the product still publishes attachment=${String(after.attachmentStatus)}/${String(after.connectionStatus)} after the disconnect: the surface believes it is still driving a world it let go`,
    );
  if (after?.actionAuthority === "active")
    return failed(
      "authority_not_paused",
      `the product publishes actionAuthority=active with attachment=${String(after?.attachmentStatus)}: authority nobody re-granted`,
    );
  if (replayed === true)
    return failed(
      "replayed_after_disconnect",
      "a companion row appeared after the disconnect with no player line behind it: the old task resumed instead of staying suspended",
    );
  if (after?.connectionStatus !== "disconnected")
    return failed(
      "connection_word_erased",
      `the state route publishes connectionStatus=${JSON.stringify(after?.connectionStatus ?? null)} after a deliberate disconnect: \`none\` is the word for a session that never connected, so the panel cannot tell "you let go" from "you never joined" (the contract declares \`disconnected\`, and the daily chain declares it for game/disconnect)`,
    );
  if (worldRunningStated !== true)
    return failed(
      "world_running_not_stated",
      'the panel states no sentence for this state, so the player is left reading "not connected yet" over a farm that is still running: a disconnect stops AI authority and never the player\'s world, and the surface has to say so',
    );
  if (forward?.offered !== true)
    return failed(
      "no_forward_step_offered",
      `the surface offers nothing to press after the disconnect while the world is still running (measured: ${JSON.stringify(forward ?? null)}): a reachable, non-terminal state with no forward action leaves the player stranded with a farm they can see and no control`,
    );
  return measured(
    `the ${disconnectedBy ?? "surface"} disconnect left the game running and the surface at attachment=${String(after?.attachmentStatus)}/${String(after?.connectionStatus)} with actionAuthority=${String(after?.actionAuthority)}, said the world is still running, and offered ${JSON.stringify(forward?.name ?? null)} as the step`,
  );
}

/**
 * The explicit endgame, after the game has already ended - architecture invariant 506.
 *
 * The operation is the product's own (`game-endgame` control, or its authenticated route when the surface does
 * not offer the control), and it must SUCCEED in the same Host session that observed the exit. A control the
 * surface withheld is recorded as `controlOffered: false` beside the reading rather than folded into it: the
 * invariant is about the operation settling, and a missing control is a separate, named finding.
 *
 *   offered       the surface drew the endgame control.
 *   result        `{ status }` from the route, or `{ code }` from its refusal.
 *   gameAliveAfter the pid is gone - the operation terminated the world.
 */
export function classifyEndgame({ offered, result, gameAliveAfter, refusalCode = null, refusedWith = null }) {
  if (refusalCode !== null)
    return failed(
      `endgame_refused_after_exit:${refusalCode}`,
      `the explicit endgame was refused with ${refusalCode} in the session that observed the exit${refusedWith === null ? "" : ` (${refusedWith})`}: invariant 506 says the terminal operation settles the world whatever ended it`,
    );
  if (result?.status !== "gameended")
    return failed(
      `endgame_not_settled:${String(result?.status ?? "no_status")}`,
      `the explicit endgame answered ${JSON.stringify(result)} instead of gameended, so nothing authoritative settled the world`,
    );
  if (gameAliveAfter === true)
    return failed(
      "game_alive_after_endgame",
      "the endgame reported gameended while the game process this run launched is still alive",
    );
  return measured(
    `the explicit endgame settled the world in the session that observed the exit (control ${offered === true ? "offered by the surface" : "not offered; the authenticated route was used"}); gameended, and the pid is gone`,
  );
}

/** What a reading held, for a failure's detail: never a bare `undefined` in a sentence a reader has to decode. */
function describeReading(value) {
  if (value === null || value === undefined) return "no reading";
  return JSON.stringify(value);
}

/**
 * The named prerequisite absences this family of drivers reports instead of a verdict.
 *
 * They are NOT failures: on a machine with no guardian server, no game process can exist to be killed, and a
 * driver that reported that as a product fault would be lying about the machine.
 */
export const NOT_MEASURED_REASONS = Object.freeze({
  guardianPipeUnreachable: "guardian_pipe_unreachable",
  installationNotRegistered: "game_installation_not_registered",
  lifecycleNotActivated: "game_lifecycle_not_activated",
  launchRefused: "game_launch_refused",
  gameNeverReady: "game_never_reached_ready",
  /*
   * `instance.status: "unread"` - the Host holds no reading of the game, which is a prerequisite absence of
   * its own and not an activated/unactivated question: the product's step for that shape is the reread, and
   * neither the activate nor the launch control is offered for it
   * (`dialogue-web/src/game-lifecycle-controls.ts:388-408`).
   */
  gameNotRead: "game_state_not_read",
  noGamePid: "game_process_not_found",
  noTurnInFlight: "no_turn_in_flight",
  gameSurfaceAbsent: "no_game_surface",
  endgameControlAbsent: "endgame_control_absent",
  disconnectControlAbsent: "disconnect_control_absent",
});

/** `GAME-STATES <scenario>: measured|failed|not_measured ...` - one line per driver, with its own counts. */
export function verdictLine(scenario, reading) {
  if (reading.verdict === "not_measured")
    return `${GAME_STATES_PREFIX} ${scenario}: not_measured ${reading.reason} - ${reading.detail}`;
  if (reading.verdict === "failed")
    return `${GAME_STATES_PREFIX} ${scenario}: failed ${reading.reason} - ${reading.detail}`;
  return `${GAME_STATES_PREFIX} ${scenario}: measured - ${reading.detail}`;
}
