/*
 * red-proof: inject  with the surface-code check in `classifyDeath` dropped, this suite fails on
 *
 *   "a surface that does not name the exit code is a failure, and the code says which"
 *
 * and with `classifyDisconnect`'s `gameAliveAfter !== true` branch inverted (a dead game accepted) it fails on
 *
 *   "an ordinary disconnect that stopped the game is a failure, not a pass"
 *
 * Both are the mutations a "green" run would otherwise hide: a surface describing a different game than the one
 * that ended, and a disconnect read as success while the player's world was gone. The disconnect's second half -
 * the word, the sentence and the step - is driven by the reading the live run really produced (`livenow10` §4.5:
 * the world alive, the attachment gone, `connectionStatus: "none"`), so its red is real history rather than a
 * shape invented here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyDeath, classifyDisconnect, classifyEndgame, verdictLine } from "./game-states-verdict.mjs";

/** The readings a healthy session produces, which each case below breaks in exactly one place. */
const healthyDeath = () => ({
  roleExit: { read: true, exitCode: 86 },
  hostFact: { status: 409, code: "stardew_player_host_exited" },
  surface: { instanceText: "已退出（退出代码 86）", launchingWord: false },
  turn: { streamingCompanionRows: 0, outcomeBefore: "none", outcomeAfter: "failed" },
});

test("a death that reached every named reading is measured", () => {
  const reading = classifyDeath(healthyDeath());
  assert.equal(reading.verdict, "measured");
  assert.match(reading.detail, /code 86/u);
  assert.match(verdictLine("death", reading), /^GAME-STATES death: measured - /u);
});

test("a death the Host never published is a failure, because the Guardian's exit is that field's only producer", () => {
  const reading = classifyDeath({ ...healthyDeath(), roleExit: { read: false, exitCode: null } });
  assert.equal(reading.verdict, "failed");
  assert.equal(reading.reason, "role_exit_not_published");
  assert.match(reading.detail, /role_exited is that field's only producer/u);
});

test("an exit code of 0 is a death too, and is not read as 'no exit'", () => {
  const reading = classifyDeath({
    ...healthyDeath(),
    roleExit: { read: true, exitCode: 0 },
    surface: { instanceText: "已退出（退出代码 0）", launchingWord: false },
  });
  assert.equal(reading.verdict, "measured", "the player quitting is an ending, and the reading must accept it");
});

test("the Host saying state_unavailable instead of naming the exit fails the host_fact reading", () => {
  const reading = classifyDeath({ ...healthyDeath(), hostFact: { status: 409, code: "state_unavailable" } });
  assert.equal(reading.reason, "host_did_not_name_the_exit");
  assert.match(reading.detail, /state_unavailable/u, "the failure quotes what the Host did answer");
});

test("a surface that does not name the exit code is a failure, and the code says which", () => {
  const reading = classifyDeath({
    ...healthyDeath(),
    surface: { instanceText: "Stardew Valley", launchingWord: false },
  });
  assert.equal(reading.verdict, "failed");
  assert.equal(reading.reason, "surface_does_not_name_the_exit_code:86");
  assert.match(reading.detail, /Stardew Valley/u, "the reading quotes the row it read");
});

test("the launching word over a dead game is the defect this scenario exists for", () => {
  const reading = classifyDeath({
    ...healthyDeath(),
    surface: { instanceText: "正在启动（退出代码 86）", launchingWord: true },
  });
  assert.equal(reading.reason, "surface_still_says_launching");
});

test("a turn still streaming after the game died is a hang, not a settle", () => {
  const reading = classifyDeath({
    ...healthyDeath(),
    turn: { streamingCompanionRows: 1, outcomeBefore: "none", outcomeAfter: "none" },
  });
  assert.equal(reading.reason, "turn_hung_after_game_exit:1");
});

test("an outcome that moves to succeeded after the death is a claim nothing could have earned", () => {
  const reading = classifyDeath({
    ...healthyDeath(),
    turn: { streamingCompanionRows: 0, outcomeBefore: "none", outcomeAfter: "succeeded" },
  });
  assert.equal(reading.reason, "turn_claimed_success_after_game_exit");
});

test("a succeeded outcome left over from an earlier turn is not read as this turn's claim", () => {
  const reading = classifyDeath({
    ...healthyDeath(),
    turn: { streamingCompanionRows: 0, outcomeBefore: "succeeded", outcomeAfter: "succeeded" },
  });
  assert.equal(reading.verdict, "measured", "the transition is the claim, not the word");
});

/** The readings a healthy disconnect produces, which each case below breaks in exactly one place. */
const healthyDisconnect = () => ({
  gameAliveAfter: true,
  after: { attachmentStatus: "none", connectionStatus: "disconnected", actionAuthority: "unavailable" },
  forward: { offered: true, name: "再读一次我的游戏" },
  worldRunningStated: true,
  replayed: false,
  disconnectedBy: "browser",
});

test("an ordinary disconnect that stopped the game is a failure, not a pass", () => {
  const reading = classifyDisconnect({ ...healthyDisconnect(), gameAliveAfter: false });
  assert.equal(reading.verdict, "failed");
  assert.equal(reading.reason, "game_stopped_on_disconnect");
  assert.match(reading.detail, /never the player's game world/u);
});

test("a disconnect that leaves the authority active is authority nobody re-granted", () => {
  const reading = classifyDisconnect({
    ...healthyDisconnect(),
    after: { ...healthyDisconnect().after, actionAuthority: "active" },
  });
  assert.equal(reading.reason, "authority_not_paused");
});

test("an attachment that survived the disconnect is the surface driving a world it let go", () => {
  const reading = classifyDisconnect({
    ...healthyDisconnect(),
    after: { attachmentStatus: "attached", connectionStatus: "connected_idle", actionAuthority: "paused" },
  });
  assert.equal(reading.reason, "attachment_survived_disconnect");
});

test("a companion row with no player line behind it is the old task replayed", () => {
  const reading = classifyDisconnect({ ...healthyDisconnect(), replayed: true });
  assert.equal(reading.reason, "replayed_after_disconnect");
});

/**
 * The reading the live run produced, verbatim (`livenow10` §4.5, `9e1c8e9e`): the world still running, the
 * attachment gone, and the state route publishing `none` - the word for a session that never connected.
 */
test("a disconnect published as `none` is the never-connected word, and the player reads it as such", () => {
  const reading = classifyDisconnect({
    ...healthyDisconnect(),
    after: { attachmentStatus: "none", connectionStatus: "none", actionAuthority: "unavailable" },
  });
  assert.equal(reading.verdict, "failed");
  assert.equal(reading.reason, "connection_word_erased");
  assert.match(reading.detail, /"none"/u, "the failure quotes the word the route really published");
  assert.match(reading.detail, /never connected/u);
});

test("a panel with no sentence for the running world does not state the promise a disconnect makes", () => {
  const reading = classifyDisconnect({ ...healthyDisconnect(), worldRunningStated: false });
  assert.equal(reading.verdict, "failed");
  assert.equal(reading.reason, "world_running_not_stated");
  assert.match(reading.detail, /still running/u);
});

test("a running world with nothing to press is the dead end this scenario exists for", () => {
  // The measured state: every control on the panel null, world alive, authority off.
  const reading = classifyDisconnect({ ...healthyDisconnect(), forward: { offered: false, name: null } });
  assert.equal(reading.verdict, "failed");
  assert.equal(reading.reason, "no_forward_step_offered");
  assert.match(reading.detail, /nothing to press/u);
});

test("a healthy disconnect is measured, and its detail carries the readings", () => {
  const reading = classifyDisconnect(healthyDisconnect());
  assert.equal(reading.verdict, "measured");
  assert.match(reading.detail, /attachment=none\/disconnected/u);
  assert.match(reading.detail, /actionAuthority=unavailable/u);
  assert.match(reading.detail, /再读一次我的游戏/u, "the step the surface offered is quoted, not assumed");
});

test("the endgame after an observed exit settles the world, and says whether the control was offered", () => {
  const measured = classifyEndgame({ offered: false, result: { status: "gameended" }, gameAliveAfter: false });
  assert.equal(measured.verdict, "measured");
  assert.match(measured.detail, /not offered; the authenticated route was used/u);
});

test("an endgame refused in the session that observed the exit breaks invariant 506", () => {
  const reading = classifyEndgame({
    offered: true,
    result: null,
    gameAliveAfter: true,
    refusalCode: "game_endgame_settlement_unavailable",
  });
  assert.equal(reading.verdict, "failed");
  assert.equal(reading.reason, "endgame_refused_after_exit:game_endgame_settlement_unavailable");
  assert.match(reading.detail, /invariant 506/u);
});

test("an endgame that answers something other than gameended settled nothing", () => {
  const reading = classifyEndgame({ offered: true, result: { status: "unavailable" }, gameAliveAfter: true });
  assert.equal(reading.reason, "endgame_not_settled:unavailable");
});

test("an endgame that reports gameended over a live pid did not terminate anything", () => {
  const reading = classifyEndgame({ offered: true, result: { status: "gameended" }, gameAliveAfter: true });
  assert.equal(reading.reason, "game_alive_after_endgame");
});

test("not-measured lines are their own shape, never a failure and never a pass", () => {
  assert.match(
    verdictLine("death", { verdict: "not_measured", reason: "guardian_pipe_unreachable", detail: "no endpoint" }),
    /^GAME-STATES death: not_measured guardian_pipe_unreachable - no endpoint$/u,
  );
  assert.match(
    verdictLine("death", { verdict: "failed", reason: "x", detail: "y" }),
    /^GAME-STATES death: failed x - y$/u,
  );
});

test("a surface with no player input says no turn was in flight, instead of crediting a settled one", () => {
  // `frontend--r23`: the Game surface mounts no composer, so nothing can be sent into it. The three product
  // readings are still the scenario; the settle reading must not claim a turn that was never sent.
  const reading = classifyDeath({
    ...healthyDeath(),
    turn: { inFlight: false, streamingCompanionRows: 0, outcomeBefore: "none", outcomeAfter: "none" },
  });
  assert.equal(reading.verdict, "measured");
  assert.match(reading.detail, /no turn was in flight/u);
  assert.doesNotMatch(
    reading.detail,
    /the turn in flight settled/u,
    "a turn nobody sent cannot be reported as settled",
  );
});
