/*
 * What the second attempt is allowed to be, held against the panels a player can actually be looking at.
 *
 * WHY THIS EXISTS. The review of lane GEN2MEASURE read the product's own panel after a crash and found one step
 * left: `restart_gamebuddy`, a quit from the tray. Lane GEN2MEASURE's slice replaced the derivation that produced
 * it (`dialogue-web/src/game-lifecycle-controls.ts`: `ended_attempt_ready`, whose step is `activate`), and proved
 * the Host hands the ended attempt back - but nothing had pressed it in a browser on a real world. Driver X does
 * that press now, and this file is the part of it that can go red without a game: which step the panel offers,
 * what "attached at the next generation" means, and whether the Chat that was open survived.
 *
 * red-proof: inject  the `activate` branch removed from `secondAttemptPress`: `✖ the panel a game the Host
 *                   watched end draws offers Enable companion play before anything else` fails with
 *                   `second_attempt_only_restart_gamebuddy`, and the message names restart_gamebuddy as the only
 *                   step - the pre-slice reading, reproduced by deleting the branch rather than by editing this
 *                   file.
 * red-proof: inject  `classifySecondAttempt`'s comparison relaxed to `nextNumber === null` (any number
 *                   accepted): `✖ an attempt that attaches at the number it just ended is not a second attempt`
 *                   fails, because the reading then reports `measured` for a retry that asked for an instance the
 *                   registration had already spent.
 * red-proof: inject  the `disconnect` branch removed from `secondAttemptPress` (the panel's own escape):
 *                   `✖ a game that ended under a held attachment offers its release, named as the escape it is`
 *                   fails with `actual: 'refused'` for the live shape, which is what the panel really drew before
 *                   the escape press existed (`second_attempt_not_offered`).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  chatSurvivedSecondAttempt,
  classifySecondAttempt,
  SECOND_ATTEMPT_PREFIX,
  secondAttemptPress,
} from "./second-attempt.mjs";

/**
 * The panel as `readGameFacts()` reports it, from the controls a phase draws.
 *
 * The end shape is the panel after a game the Host watched end, BEFORE the slice: `launch_failed`
 * (`0ba6c160`'s `if (instance.status === "crashed") return build("launch_failed", {}, ["restart_gamebuddy"])`),
 * which withholds the whole getting-going guide and states the quarantine paragraph. Both facts are what the
 * panel really paints for that phase (`dialogue-web/src/components/GameStatePanel.tsx`: `restartRequired`
 * replaces the guide with `game-launch-quarantined`), so this fixture is that reading rather than an invention.
 */
const panel = ({
  activate = null,
  launch = null,
  disconnect = null,
  endgame = null,
  quarantined = null,
  surfacePresent = true,
} = {}) => ({
  surfacePresent,
  state: "available",
  facts: {},
  sentences: { waitingForGame: null, disconnectedWorldRunning: null, notRead: null, quarantined },
  controls: {
    activate,
    launch,
    disconnect,
    endgame,
    stop: null,
    endgameConfirm: null,
    reopen: null,
    resume: null,
    reread: null,
  },
});

const pressable = (name) => ({ visible: true, disabled: false, name });

test("the panel a game the Host watched end draws offers Enable companion play before anything else", () => {
  const reading = secondAttemptPress({ facts: panel({ activate: pressable("Enable companion play") }) });
  assert.deepEqual(reading, { kind: "press", step: "activate", name: "Enable companion play" });
});

test("a settled attempt's panel offers Start the game, and activation is not drawn beside it", () => {
  const reading = secondAttemptPress({ facts: panel({ launch: pressable("Start the game") }) });
  assert.deepEqual(reading, { kind: "press", step: "launch", name: "Start the game" });
});

test("both controls drawn is step 1 first: activation is what stages the instance step 2 launches", () => {
  const reading = secondAttemptPress({
    facts: panel({ activate: pressable("Enable companion play"), launch: pressable("Start the game") }),
  });
  assert.equal(reading.kind, "press");
  assert.equal(reading.step, "activate");
});

test("the pre-slice panel names restart_gamebuddy as the only step, not a driver that gave up", () => {
  const reading = secondAttemptPress({
    facts: panel({ quarantined: "This Host cannot start another game; quit GameBuddy from its tray icon." }),
  });
  assert.equal(reading.kind, "refused");
  assert.equal(reading.code, "second_attempt_only_restart_gamebuddy");
  assert.equal(reading.onlyStep, "restart_gamebuddy");
  assert.match(reading.detail, /restart_gamebuddy/);
});

test("a panel that offers no control and no sentence is refused by its own name", () => {
  const reading = secondAttemptPress({ facts: panel() });
  assert.equal(reading.kind, "refused");
  assert.equal(reading.code, "second_attempt_not_offered");
  assert.equal(reading.onlyStep, null);
});

/*
 * The shape the live run met on 2026-11-23 (stage E:\gb-lanes\gen2live): `instance=crashed` with
 * `playerHostExitCode=1` and `attachmentStatus: attached`, so the panel draws the attachment's own controls and
 * no staging step. Both controls below are the panel's real ones, quoted from that run's facts file.
 */
test("a game that ended under a held attachment offers its release, named as the escape it is", () => {
  const reading = secondAttemptPress({
    facts: panel({
      disconnect: pressable("断开游戏连接"),
      endgame: pressable("结束游戏"),
    }),
  });
  assert.equal(reading.kind, "press");
  assert.equal(reading.step, "release_attachment");
  assert.equal(reading.name, "断开游戏连接");
  assert.match(reading.why, /ended_attempt_ready is unreachable/u);
});

test("a staging step drawn beside the release is still the press: the retry comes before the escape", () => {
  const reading = secondAttemptPress({
    facts: panel({ activate: pressable("启用陪玩"), disconnect: pressable("断开游戏连接") }),
  });
  assert.equal(reading.step, "activate");
});

test("a control the panel draws disabled is not a press this driver may make", () => {
  const reading = secondAttemptPress({
    facts: panel({ activate: { visible: true, disabled: true, name: "Enable companion play" } }),
  });
  assert.equal(reading.kind, "refused");
  assert.equal(reading.code, "second_attempt_not_offered");
});

test("a Game surface that never mounted is named, not read as a panel with no controls", () => {
  const reading = secondAttemptPress({ facts: panel({ surfacePresent: false }) });
  assert.equal(reading.code, "second_attempt_no_game_surface");
});

const attachedAt = () => ({
  ok: true,
  instanceStatus: "running",
  attachmentStatus: "attached",
  instanceGeneration: 0,
  attachmentGeneration: 2,
});
const intact = { kind: "intact", code: "chat_intact", detail: "the same conversation is still mounted" };
const held = { read: true, instanceGeneration: 1, holdingAnAttempt: true };
const next = { read: true, instanceGeneration: 2, holdingAnAttempt: true };
const staged = { ok: true, instanceStatus: "none", instanceGeneration: 2 };
const presses = ["activate", "launch"];

test("a second attempt that attaches at the registration's next number, with the Chat intact, is measured", () => {
  const reading = classifySecondAttempt({
    presses,
    staged,
    after: attachedAt(),
    registration: { before: held, after: next },
    chat: intact,
  });
  assert.equal(reading.verdict, "measured");
  assert.match(reading.detail, /registration moved 1 -> 2/u);
});

test("an attempt that attaches at the number it just ended is not a second attempt", () => {
  const reading = classifySecondAttempt({
    presses,
    staged,
    after: attachedAt(),
    registration: { before: held, after: held },
    chat: intact,
  });
  assert.equal(reading.verdict, "failed");
  assert.equal(reading.reason, "second_attempt_generation_not_advanced:1->1");
});

test("a retry reached through the panel's own escape says so, so it cannot be read as a crash offering a retry", () => {
  const reading = classifySecondAttempt({
    presses: ["release_attachment", "activate", "launch"],
    staged,
    after: attachedAt(),
    registration: { before: held, after: next },
    chat: intact,
  });
  assert.equal(reading.verdict, "measured");
  assert.match(reading.detail, /pressed release_attachment then activate then launch/u);
  assert.match(reading.detail, /the product still offers no retry for a crash/u);
});

test("a retry that never attaches names the pair it settled at", () => {
  const reading = classifySecondAttempt({
    presses,
    staged,
    after: { ok: true, instanceStatus: "launching", attachmentStatus: "none", instanceGeneration: 0 },
    registration: { before: held, after: next },
    chat: intact,
  });
  assert.equal(reading.verdict, "failed");
  assert.equal(reading.reason, "second_attempt_did_not_attach:launching/none");
});

test("a durable number that could not be read on both sides is not measured, never assumed", () => {
  const reading = classifySecondAttempt({
    presses,
    staged,
    after: attachedAt(),
    registration: { before: { read: false, reason: "registration_unreadable:ENOENT" }, after: next },
    chat: intact,
  });
  assert.equal(reading.verdict, "not_measured");
  assert.equal(reading.reason, "second_attempt_generation_unread");
  assert.match(reading.detail, /registration_unreadable/u);
});

test("a retry that attached without a Chat reading is not measured as one that left the Chat alone", () => {
  const reading = classifySecondAttempt({
    presses,
    staged,
    after: attachedAt(),
    registration: { before: held, after: next },
    chat: { kind: "unobserved", code: "chat_not_read_before_the_attempt", detail: "no conversation was mounted" },
  });
  assert.equal(reading.verdict, "not_measured");
  assert.equal(reading.reason, "second_attempt_attached_without_a_chat_reading");
  assert.match(reading.detail, /registration moved 1 -> 2/u);
});

test("a retry that attached and moved the Chat is a failure that names the Chat's own code", () => {
  const reading = classifySecondAttempt({
    presses,
    staged,
    after: attachedAt(),
    registration: { before: held, after: next },
    chat: { kind: "failed", code: "chat_selection_changed", detail: "moved to another conversation" },
  });
  assert.equal(reading.verdict, "failed");
  assert.equal(reading.reason, "chat_selection_changed");
});

const chatBefore = {
  ok: true,
  selection: { chatHandle: "chat-1", generation: 4, stateRevision: "rev-9" },
  transcript: [
    { role: "player", text: "你好" },
    { role: "companion", text: "我在。" },
  ],
};

test("the same conversation with the same rows survived the attempt", () => {
  const reading = chatSurvivedSecondAttempt({ before: chatBefore, after: chatBefore });
  assert.equal(reading.kind, "intact");
  assert.equal(reading.code, "chat_intact");
});

test("a conversation that arrived a row across the attempt still holds every row it had", () => {
  const reading = chatSurvivedSecondAttempt({
    before: chatBefore,
    after: { ...chatBefore, transcript: [...chatBefore.transcript, { role: "companion", text: "还有。" }] },
  });
  assert.equal(reading.kind, "intact");
  assert.equal(reading.code, "chat_transcript_extended");
});

test("a selection that moved is the failure, whatever the transcript still holds", () => {
  const reading = chatSurvivedSecondAttempt({
    before: chatBefore,
    after: { ...chatBefore, selection: { ...chatBefore.selection, chatHandle: "chat-2" } },
  });
  assert.equal(reading.kind, "failed");
  assert.equal(reading.code, "chat_selection_changed");
});

test("the same handle re-mounted under the player is caught by the selection generation", () => {
  const reading = chatSurvivedSecondAttempt({
    before: chatBefore,
    after: { ...chatBefore, selection: { ...chatBefore.selection, generation: 5 } },
  });
  assert.equal(reading.code, "chat_selection_generation_changed");
});

test("a transcript that lost a row names the row that left", () => {
  const reading = chatSurvivedSecondAttempt({
    before: chatBefore,
    after: { ...chatBefore, transcript: chatBefore.transcript.slice(0, 1) },
  });
  assert.equal(reading.kind, "failed");
  assert.equal(reading.code, "chat_transcript_lost:1");
  assert.match(reading.detail, /我在。/u);
});

test("a transcript whose row was replaced is a change, not a loss", () => {
  const reading = chatSurvivedSecondAttempt({
    before: chatBefore,
    after: { ...chatBefore, transcript: [chatBefore.transcript[0], { role: "companion", text: "我在这儿。" }] },
  });
  assert.equal(reading.code, "chat_transcript_changed:1");
});

test("no conversation mounted before the attempt is unobserved, never a pass", () => {
  const reading = chatSurvivedSecondAttempt({
    before: { ok: true, selection: null, transcript: [] },
    after: chatBefore,
  });
  assert.equal(reading.kind, "unobserved");
  assert.equal(reading.code, "chat_not_read_before_the_attempt");
});

test("a Chat read that stops answering after the attempt is the failure it is", () => {
  const reading = chatSurvivedSecondAttempt({ before: chatBefore, after: { ok: false, status: 502 } });
  assert.equal(reading.code, "chat_not_read_after_the_attempt:502");
});

test("the prefix this reading prints under is its own", () => {
  assert.equal(SECOND_ATTEMPT_PREFIX, "SECOND-ATTEMPT");
});
