// The two readings a SECOND ATTEMPT needs, kept out of the driver so a node test can see them red without a
// game: which step the panel is offering after a game the Host watched end, and whether the Chat that was
// open before the attempt is still the one on screen after it.
import { readFileSync } from "node:fs";
import path from "node:path";

// WHY THEY ARE ONE MODULE. They are one scenario: the retry, and the surface it must not disturb. Chat and
// Game are independent surfaces that share only the continuity identity they are bound to (project rules
// #1651/#1062), so a retry that re-mounted the Chat selection, dropped its transcript or wrote into it would
// be the product coupling them at the one moment a player cares that it does not.
//
// WHAT IS NOT DERIVED HERE. The step is READ OFF THE PANEL the player is looking at - the same
// `data-testid` controls `capture/game-surface-states.cjs` reads - never re-derived from
// `dialogue-web/src/game-lifecycle-controls.ts`. A second copy of that derivation is a disagreement scheduled
// for later, and the driver's whole point is that the press it makes is the press a player makes.
//
// THE ONE WORD THIS MODULE DOES SPELL is `restart_gamebuddy`. The panel's quarantine sentence is drawn from
// the phase whose only step is a GameBuddy restart, and that step is off the page entirely (it is a tray
// quit, `GGameSessionForwardAction.restart_gamebuddy` in `game-lifecycle-controls.ts`). So "the panel offers
// nothing and states the quarantine" has to be reported as what it is - the only step left being one this
// page cannot take - or a reader would mistake the refusal for a driver that gave up.

/** The prefix of the lines this reading contributes to driver X's report. */
export const SECOND_ATTEMPT_PREFIX = "SECOND-ATTEMPT";

const refused = (code, detail, extra = {}) =>
  Object.freeze({ kind: "refused", code, onlyStep: null, detail, ...extra });

/**
 * The press a player would make next, from the controls the panel is drawing right now.
 *
 * STEP 1 BEFORE STEP 2. `activate` is the press that hands the ended attempt back and stages the next
 * instance (`settleEndedAttempt` then the reservation that takes the durable registration's next number,
 * `host/src/stardew-production-lifecycle-coordinator.internal.ts:1905-1939`); step 2's launch is what that
 * staging makes possible. Both are drawn for a game the Host watched end whenever the ended instance still
 * publishes a generation (`deriveGameLifecycleControlAvailability`), so the order is the reading order of the
 * guide the player is working through - step 1 first - and not a preference.
 *
 * `facts` is `readGameFacts()` from `capture/game-surface-states.cjs`: `controls` is
 * `{ activate, launch, disconnect, ... }` as `{ visible, disabled, name }`, and `sentences.quarantined` is the
 * panel's quarantine paragraph.
 *
 * THE ESCAPE IS A PRESS, AND IT IS NOT THE RETRY. Measured live 2026-11-23 at commit `09484648` (driver X, stage
 * `E:\gb-lanes\gen2live`): a game the Host watched end still published `attachment: attached`, and
 * `deriveGameSessionControls` led with the attachment, so the panel drew `断开游戏连接` and `结束游戏` and no
 * staging step at all - `ended_attempt_ready` was unreachable in that shape. The attachment's own release is then
 * the only control a player can press, so it is offered here as `release_attachment` - by its own name, AFTER
 * both staging steps, so a reader can never mistake it for the retry. A panel that draws a staging step gets
 * that step, because that is the press the product is offering. Re-measured at `9682e223`, where the derivation
 * leads with the ending instead (`.tmp/lane-gen2end.md` §3e): the same crash shape drew `activate` alone, with
 * `attachment: attached` still latched, and this function answered `{ step: "activate" }` without pressing the
 * disconnect at all.
 */
export function secondAttemptPress({ facts }) {
  if (facts?.surfacePresent !== true)
    return refused(
      "second_attempt_no_game_surface",
      "the Game surface did not mount, so none of its steps could be pressed",
    );
  const pressable = (control) =>
    control !== null && control !== undefined && control.visible === true && control.disabled !== true;
  if (pressable(facts.controls?.activate))
    return Object.freeze({ kind: "press", step: "activate", name: facts.controls.activate.name ?? null });
  if (pressable(facts.controls?.launch))
    return Object.freeze({ kind: "press", step: "launch", name: facts.controls.launch.name ?? null });

  if (pressable(facts.controls?.disconnect))
    return Object.freeze({
      kind: "press",
      step: "release_attachment",
      name: facts.controls.disconnect.name ?? null,
      why: "the panel draws no staging step after the game ended and its attachment release is the only control it draws: the ending did not release the attachment, so ended_attempt_ready is unreachable until it is",
    });
  const quarantined = typeof facts.sentences?.quarantined === "string" && facts.sentences.quarantined.length > 0;
  if (quarantined)
    return refused(
      "second_attempt_only_restart_gamebuddy",
      `the panel draws no control after the game ended: it states ${JSON.stringify(facts.sentences.quarantined)}, and the only step left is restart_gamebuddy - a quit from the tray, off this page`,
      { onlyStep: "restart_gamebuddy" },
    );
  return refused(
    "second_attempt_not_offered",
    `the panel draws no control after the game ended and states nothing about why: controls=${JSON.stringify(facts.controls ?? null)} sentences=${JSON.stringify(facts.sentences ?? null)}`,
  );
}

/**
 * Whether the second attempt reached the attached world AS a new attempt.
 *
 * Three readings, and each one is a fact the product publishes:
 *
 *   after.attachmentStatus  `attached` is the surface's only word for "the companion is in the farm", and
 *                           the whole retry exists to reach it (`game_browser_api/v1`).
 *   the instance number     `registration.instanceGeneration` is the number the durable registration issued
 *                           the attempt, read from the same record the coordinator reads it from
 *                           (`readBoundInstanceGeneration`,
 *                           `host/src/stardew-production-lifecycle-coordinator.internal.ts:1811`). The ENDED
 *                           attempt still holds that record - which is why the retry can be refused with
 *                           `stardew_bootstrap_registration_held` - so reading it before the press and after
 *                           it answers the one question a constant cannot: did this surface start the
 *                           registration's NEXT attempt, or re-read the one that ended? An attempt that kept
 *                           the same number is the latching defect this slice removed, and a launch bound to a
 *                           spent number is refused by name (`stardew_game_instance_generation_conflict`). The
 *                           state route cannot answer it from its own words: the failed shape publishes
 *                           generation 0 by design ("the failed states say this lifecycle owns no running
 *                           Player Host", `stardew-role-lifecycle-projection.internal.ts:24`) and the attached
 *                           shape publishes 0 again for the same reason.
 *   chat                    the Chat that was open before the attempt, read after it. `unobserved` is not a
 *                           pass: a retry whose Chat reading could not be taken has proved nothing about not
 *                           disturbing it, and the verdict says so instead of counting it green.
 */
export function classifySecondAttempt({ presses, staged, after, registration, chat }) {
  const pressesLine = presses.length === 0 ? "no press" : `pressed ${presses.join(" then ")}`;
  // The escape is named wherever the presses are quoted, so a run that reached the staging chain by
  // disconnecting first can never be read as a crash that offered a retry.
  const escapeLine =
    presses[0] === "release_attachment"
      ? " - but only after the panel's attachment release, which was the only step it drew: the product still offers no retry for a crash, and this reading does not say otherwise"
      : "";
  if (after?.ok !== true)
    return Object.freeze({
      verdict: "failed",
      reason: `second_attempt_state_unreadable:${String(after?.status ?? "no_reading")}`,
      detail: `the state route answered ${JSON.stringify(after?.status ?? null)} after ${pressesLine}`,
    });
  if (after.attachmentStatus !== "attached")
    return Object.freeze({
      verdict: "failed",
      reason: `second_attempt_did_not_attach:${String(after.instanceStatus)}/${String(after.attachmentStatus)}`,
      detail: `after ${pressesLine} the surface settled at instance=${String(after.instanceStatus)}/attachment=${String(after.attachmentStatus)} (generation ${String(after.instanceGeneration)}) instead of reaching attachment=attached${escapeLine}`,
    });
  const endedNumber = Number.isInteger(registration?.before?.instanceGeneration)
    ? registration.before.instanceGeneration
    : null;
  const nextNumber = Number.isInteger(registration?.after?.instanceGeneration)
    ? registration.after.instanceGeneration
    : null;
  const routeNumber = Number.isInteger(staged?.instanceGeneration) ? staged.instanceGeneration : null;
  if (endedNumber === null || nextNumber === null)
    return Object.freeze({
      verdict: "not_measured",
      reason: "second_attempt_generation_unread",
      detail: `after ${pressesLine} the game attached at instance=${String(after.instanceStatus)}/attachment=${String(after.attachmentStatus)}, but the durable instance number was not read on both sides of the press (before the press: ${describeRegistration(registration?.before)}, after it: ${describeRegistration(registration?.after)}; the state route published ${String(routeNumber)} while the attempt was staged), so "a second attempt" cannot be told from "the attempt that ended, re-read"${escapeLine}`,
    });
  if (nextNumber !== endedNumber + 1)
    return Object.freeze({
      verdict: "failed",
      reason: `second_attempt_generation_not_advanced:${String(endedNumber)}->${String(nextNumber)}`,
      detail: `the ended attempt held the registration's instance ${String(endedNumber)} and the attempt that attached holds ${String(nextNumber)}: a second attempt takes the registration's NEXT number, so anything else means this surface started no new attempt`,
    });
  if (chat?.kind === "unobserved")
    return Object.freeze({
      verdict: "not_measured",
      reason: "second_attempt_attached_without_a_chat_reading",
      detail: `after ${pressesLine} the game attached at instance=${String(after.instanceStatus)}/attachment=${String(after.attachmentStatus)}, and the registration moved ${String(endedNumber)} -> ${String(nextNumber)}; but no Chat reading could be taken across the attempt: ${chat.code} - ${chat.detail}${escapeLine}`,
    });
  if (chat?.kind !== "intact")
    return Object.freeze({
      verdict: "failed",
      reason: chat?.code ?? "chat_reading_missing",
      detail: `the game attached at instance=${String(after.instanceStatus)}/attachment=${String(after.attachmentStatus)} with the registration moved ${String(endedNumber)} -> ${String(nextNumber)} after ${pressesLine}, but ${chat?.detail ?? "the Chat reading is missing"}${escapeLine}`,
    });
  return Object.freeze({
    verdict: "measured",
    reason: "measured",
    detail: `after ${pressesLine} the game reached instance=${String(after.instanceStatus)}/attachment=${String(after.attachmentStatus)} with the registration moved ${String(endedNumber)} -> ${String(nextNumber)} (a new attempt, not the ended one), and ${chat.detail}${escapeLine}`,
  });
}

/**
 * The durable registration's own words for the attempt it is holding, read from its record.
 *
 * The record is the one `readStardewInstallationRegistration` publishes under the run's runtime root
 * (`stardew-installation-registration/registration.json`, `host/src/stardew-installation-registration.internal.ts:14-15`),
 * and it is the SAME record the coordinator reads the instance number from at the reservation that bound the
 * attempt. Reading it before and after the press is what makes "a second attempt" a measurement rather than a
 * constant: a run root that has already carried an attempt (a stepwise stage re-launched on the same root) does
 * not start at 1, and an assertion that said so would be a guess about somebody else's disk.
 *
 * Unreadable is a reading too: it answers `read: false` with its reason, and the verdict then says the number
 * was not read instead of inventing one.
 */
export function readRegistrationGeneration(declaredDataRoot) {
  if (typeof declaredDataRoot !== "string" || declaredDataRoot.length === 0)
    return Object.freeze({ read: false, reason: "no_declared_data_root" });
  const file = path.join(declaredDataRoot, "stardew-installation-registration", "registration.json");
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    return Object.freeze({
      read: true,
      instanceGeneration: Number.isInteger(record?.instanceGeneration) ? record.instanceGeneration : null,
      // The ended attempt is the one whose pointer is still held; a record with none is a registration whose
      // attempt was handed back, which is the other shape a reader has to be able to tell apart.
      holdingAnAttempt: record?.activeAttempt !== null && record?.activeAttempt !== undefined,
      file,
    });
  } catch (error) {
    return Object.freeze({
      read: false,
      reason: `registration_unreadable:${String(error?.message ?? error).slice(0, 160)}`,
      file,
    });
  }
}

/** One registration reading, for a failure's detail: a reason, never a bare `undefined`. */
function describeRegistration(reading) {
  if (reading === null || reading === undefined) return "not read";
  if (reading.read !== true) return `unreadable (${String(reading.reason ?? "no_reason")})`;
  return `instance ${String(reading.instanceGeneration)}${reading.holdingAnAttempt === true ? ", pointer held" : ""}`;
}

/**
 * The same Chat, read twice: selected conversation, selection generation, and the transcript's rows.
 *
 * IDENTITY COMES FROM CONTENT, and from the mounted lease's own identities: `chatHandle` and `generation` are
 * minted by the lease's projection, so they change together the moment the Host mounts a different
 * conversation and never while the same one stays mounted (`capture/common.cjs` `readDurableTranscript`). The
 * transcript is compared as the ordered sequence of `role:text`, so a row that vanished, was replaced, or
 * appeared with nobody typing is a difference this reading names.
 */
export function chatSurvivedSecondAttempt({ before, after }) {
  if (before?.ok !== true || before.selection === null || before.selection === undefined)
    return Object.freeze({
      kind: "unobserved",
      code: "chat_not_read_before_the_attempt",
      detail: `no conversation was mounted to read before the attempt (state route answered ${JSON.stringify(before?.status ?? null)})`,
    });
  if (after?.ok !== true)
    return Object.freeze({
      kind: "failed",
      code: `chat_not_read_after_the_attempt:${String(after?.status ?? "no_reading")}`,
      detail: `the Chat state route answered ${JSON.stringify(after?.status ?? null)} after the attempt, so the conversation that was open cannot be read back`,
    });
  if (after.selection === null || after.selection === undefined)
    return Object.freeze({
      kind: "failed",
      code: "chat_selection_dropped",
      detail: `the Chat that was open before the attempt (${JSON.stringify(before.selection.chatHandle)}) is no longer the mounted conversation: the state route publishes no selection at all`,
    });
  if (after.selection.chatHandle !== before.selection.chatHandle)
    return Object.freeze({
      kind: "failed",
      code: "chat_selection_changed",
      detail: `the mounted conversation moved from ${JSON.stringify(before.selection.chatHandle)} to ${JSON.stringify(after.selection.chatHandle)} across the game retry, and nothing in the product asked it to`,
    });
  if (after.selection.generation !== before.selection.generation)
    return Object.freeze({
      kind: "failed",
      code: "chat_selection_generation_changed",
      detail: `the conversation is ${JSON.stringify(after.selection.chatHandle)} on both reads, but its selection generation moved ${String(before.selection.generation)} -> ${String(after.selection.generation)}: the lease was re-mounted under the player instead of being left alone`,
    });
  const rows = (transcript) =>
    (Array.isArray(transcript) ? transcript : []).map((row) => `${String(row.role)}:${String(row.text)}`);
  const rowsBefore = rows(before.transcript);
  const rowsAfter = rows(after.transcript);
  if (rowsAfter.length < rowsBefore.length)
    return Object.freeze({
      kind: "failed",
      code: `chat_transcript_lost:${String(rowsBefore.length - rowsAfter.length)}`,
      detail: `the transcript held ${String(rowsBefore.length)} row(s) before the attempt and ${String(rowsAfter.length)} after it: ${JSON.stringify(rowsBefore.slice(rowsAfter.length))} left the conversation`,
    });
  for (let index = 0; index < rowsBefore.length; index += 1)
    if (rowsBefore[index] !== rowsAfter[index])
      return Object.freeze({
        kind: "failed",
        code: `chat_transcript_changed:${String(index)}`,
        detail: `row ${String(index)} of the transcript reads ${JSON.stringify(rowsAfter[index])} after the attempt, where it read ${JSON.stringify(rowsBefore[index])} before it`,
      });
  if (rowsAfter.length > rowsBefore.length)
    return Object.freeze({
      kind: "intact",
      code: "chat_transcript_extended",
      detail: `the same conversation (${JSON.stringify(after.selection.chatHandle)}, selection generation ${String(after.selection.generation)}) is still mounted with all ${String(rowsBefore.length)} row(s) it held, and ${String(rowsAfter.length - rowsBefore.length)} row(s) arrived in it across the attempt`,
    });
  return Object.freeze({
    kind: "intact",
    code: "chat_intact",
    detail: `the same conversation (${JSON.stringify(after.selection.chatHandle)}, selection generation ${String(after.selection.generation)}) is still mounted with its ${String(rowsBefore.length)} transcript row(s) unchanged`,
  });
}

/**
 * The cabin step of the SECOND attempt, as the panel draws it: the offers, their one confirm, and the
 * panel's own launch line.
 *
 * The first attempt's handoff is driven by driver W through the same panel controls; this reader exists
 * because the second attempt is a second walk through the same third step and the driver that takes it must
 * not import the launch driver's whole closure to read one section.
 */
export const readSecondAttemptHandoff = () => {
  const surface = document.querySelector('[data-testid="game-surface"]');
  const handoff = surface === null ? null : surface.querySelector("section.stardew-cabin-handoff");
  if (handoff === null) return { present: false, choices: [], secondary: [], launchLine: null };
  const describe = (button) => {
    const rect = button.getBoundingClientRect();
    return {
      name: (button.getAttribute("aria-label") ?? button.textContent ?? "").replace(/\s+/gu, " ").trim(),
      disabled: button.disabled === true || button.getAttribute("aria-disabled") === "true",
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(button).visibility !== "hidden",
    };
  };
  const list = handoff.querySelector('[data-testid="cabin-choice-list"]');
  const choices =
    list === null
      ? []
      : [...list.querySelectorAll("li.game-choice")].map((row) => {
          const button = row.querySelector("button");
          return {
            label: (row.querySelector(".game-choice-label")?.textContent ?? "").trim(),
            confirm: button === null ? null : describe(button),
          };
        });
  const line = handoff.querySelector(
    '[data-testid="cabin-launch-found"], [data-testid="cabin-launch-reading"], [data-testid="cabin-launch-wait-expired"]',
  );
  return {
    present: true,
    choices,
    secondary: [...handoff.querySelectorAll("button.game-secondary-action")].map(describe),
    launchLine:
      line === null
        ? null
        : { testId: line.getAttribute("data-testid"), text: (line.textContent ?? "").replace(/\s+/gu, " ").trim() },
  };
};

/** The mounted conversation's turn, as the Chat surface draws it: in flight, streaming, and settled rows. */
export const readChatTurnState = () => {
  const root = document.querySelector('[data-testid="chat-surface"]') ?? document;
  return {
    chatSurfacePresent: document.querySelector('[data-testid="chat-surface"]') !== null,
    running: root.querySelector(".composer-button.stop-button, .composer-button.composer-busy") !== null,
    streamingRows: root.querySelectorAll(".message-list > li.message[data-streaming]").length,
    settledCompanionRows: root.querySelectorAll(".message-list > li.message.companion:not([data-streaming])").length,
    settledPlayerRows: root.querySelectorAll(".message-list > li.message.player:not([data-streaming])").length,
  };
};
