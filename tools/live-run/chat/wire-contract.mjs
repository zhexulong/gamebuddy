/**
 * The three things a captured provider request must satisfy, judged from the bytes the product posted.
 *
 * `run-chat-live-audit.mjs`'s wire mode answers "what did the product SEND" as sizes and digests. A size
 * says nothing about CONTENT, so a prompt that lost the card's closing direction, that advertised a Game
 * tool the Chat surface never mounts, or that seated the card's voice above the Host's own floor all read
 * as healthy numbers. These three judgements are the missing half, and each one is a SYNTHETIC SENTINEL
 * question: the harness writes a string no product prose contains through the product's own writers, and
 * the assertion is whether that string arrives, where it arrives, and what must not arrive beside it.
 *
 * They are pure functions over a captured request body, so the same code that reads a real run can be
 * handed a deliberately broken capture and must go red. Every verdict is `tools/live-run/core/
 * evidence-verdict.mjs`'s three-state vocabulary - `verified` / `failed` / `unobserved` - because a
 * capture that never arrived is not a pass and not a failure.
 */

import { EVIDENCE_STATE } from "../core/evidence-verdict.mjs";

/**
 * One wire message's text, from a string or from the text parts of a structured content array.
 *
 * Pi's `openai-completions` adapter posts `content` as an array of parts on some turns and as a bare
 * string on others, so a reading that assumes either one sees `undefined` on the other.
 */
export function wireMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => messagePartText(part)).join("");
}

/** One content part's text: a bare string, or a `{ type: "text", text }` part. */
function messagePartText(part) {
  if (typeof part === "string") return part;
  return typeof part?.text === "string" ? part.text : "";
}

/**
 * The card's closing direction, written through the product's own record writer (`post_history_
 * instructions.json`, the record `materializeTavernAuthoredStableCatalog` reads).
 *
 * Distinctive and macro-free on purpose: it must be findable with one `indexOf` and it must survive the
 * catalogue's macro rendering unchanged, or the assertion would be measuring the rendering instead.
 */
export const WIRE_POST_HISTORY_SENTINEL =
  "[wire-sentinel:post-history] Close every reply by raking the coals once, never twice.";

/**
 * The card's own voice, appended to the identity profile's `characterVoice` - the field the product
 * compiles from the card's `system_prompt` and renders AFTER the Host floor
 * (`host/src/identity-profile.ts`, `renderCharacterVoice`).
 */
export const WIRE_CARD_VOICE_SENTINEL = "[wire-sentinel:card-voice]";

/**
 * The Host floor anchor is NOT declared here.
 *
 * The caller supplies it from the product's own declaration (`COMPANION_ACTION_SYNTAX`,
 * `host/src/identity-profile.ts`), which renders inside the surface block that precedes both the identity
 * block and the card's directive. A transcribed copy would drift the day the floor's wording changed and
 * would then keep asserting against a sentence the product no longer ships, so a missing anchor is a
 * caller error this module reports rather than a default it invents.
 */

function failed(reason, detail) {
  return Object.freeze({ state: EVIDENCE_STATE.failed, reason, ...(detail === undefined ? {} : { detail }) });
}

function verified(detail) {
  return Object.freeze({ state: EVIDENCE_STATE.verified, reason: null, ...(detail === undefined ? {} : { detail }) });
}

function unobserved(reason) {
  return Object.freeze({ state: EVIDENCE_STATE.unobserved, reason });
}

/**
 * The card's `system_prompt` directive shape as the profile carries it, with a sentinel appended.
 *
 * Appended, never substituted: the ordering assertion needs the card's real directive present so that the
 * position it measures is the position the product actually placed it at. On a card that declares none the
 * sentinel becomes the whole value, which is still the product's own `characterVoice` path.
 */
export function characterVoiceWithSentinel(voice, sentinel = WIRE_CARD_VOICE_SENTINEL) {
  const base = typeof voice?.text === "string" ? voice.text : "";
  return Object.freeze({
    text: base.length === 0 ? sentinel : `${base}\n${sentinel}`,
    source: voice?.source ?? "card",
  });
}

/**
 * Assertion 1: the card's closing direction reached the request, and it reached the LAST message.
 *
 * The position is half the contract, not decoration: the field is a per-turn tail appended after the
 * transcript, which is what lets an edited direction take effect on the next turn without moving the
 * cached prefix. A version of it that rode the system prompt would satisfy a presence-only check and be
 * wrong in the way that costs a re-measurement.
 */
export function judgePostHistorySentinel({ request, sentinel = WIRE_POST_HISTORY_SENTINEL }) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  if (messages.length === 0) return unobserved("request_carried_no_messages");
  const positions = messages
    .map((message, index) => (wireMessageText(message).includes(sentinel) ? index : -1))
    .filter((index) => index >= 0);
  if (positions.length === 0) return failed("post_history_sentinel_absent");
  const lastIndex = messages.length - 1;
  const tail = positions[positions.length - 1];
  if (tail !== lastIndex) {
    return failed("post_history_sentinel_not_last", Object.freeze({ foundAt: tail, lastIndex }));
  }
  if (positions.length > 1) {
    return failed(
      "post_history_sentinel_repeated",
      Object.freeze({ occurrences: positions.length, indexes: Object.freeze(positions) }),
    );
  }
  if (messages[lastIndex]?.role !== "user") {
    return failed("post_history_sentinel_tail_not_user", Object.freeze({ role: String(messages[lastIndex]?.role) }));
  }
  return verified(Object.freeze({ messageIndex: tail, messageCount: messages.length }));
}

/**
 * Assertion 2: the Chat surface carries no published Game tool name.
 *
 * The population is the caller's `gameToolNames` - `Object.values(STARDEW_ACTION_TOOL_NAMES)` read from
 * the registry at the call site - never a list written here. Chat mounts `allowedToolNames = []`, so a
 * Game name can only arrive by two routes, and both are checked: a declared tool on the request, and a
 * mention in any message the model reads. The second is the one that would otherwise pass: a prompt that
 * tells the model to call `stardew_express_emote` describes a capability the surface never gave it.
 */
export function judgeGameToolAbsence({ requests, gameToolNames }) {
  const list = (Array.isArray(requests) ? requests : []).map((entry) => entry?.body ?? entry);
  if (list.length === 0) return unobserved("wire_capture_received_no_request");
  const names = Array.isArray(gameToolNames) ? gameToolNames.filter((name) => typeof name === "string" && name) : [];
  if (names.length === 0) return unobserved("game_tool_name_population_empty");
  const forbidden = new Set(names);
  const declared = [];
  const mentioned = [];
  for (const [index, body] of list.entries()) {
    for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
      const name = tool?.function?.name;
      if (typeof name === "string" && forbidden.has(name)) declared.push({ requestIndex: index + 1, name });
    }
    for (const message of Array.isArray(body?.messages) ? body.messages : []) {
      const text = wireMessageText(message);
      for (const name of names) {
        if (text.includes(name)) mentioned.push({ requestIndex: index + 1, name, role: String(message?.role) });
      }
    }
  }
  if (declared.length > 0) {
    return failed(
      "game_tool_declared_on_chat_wire",
      Object.freeze({ declared: Object.freeze(declared.map((hit) => hit.name)), requests: list.length }),
    );
  }
  if (mentioned.length > 0) {
    return failed(
      "game_tool_named_in_chat_prompt",
      Object.freeze({ named: Object.freeze([...new Set(mentioned.map((hit) => hit.name))]), requests: list.length }),
    );
  }
  return verified(Object.freeze({ requests: list.length, checkedNames: names.length }));
}

/**
 * Assertion 3: the card's voice sits AFTER the Host's own floor.
 *
 * Ordering is the mechanism, not a preference: the floor is the immutable head of the prefix and the card
 * performs inside the stage the Host draws. A card voice seated above the floor would be the last word on
 * what she does, which is the one thing the layering exists to prevent - and no byte count would show it.
 */
export function judgeCardVoiceOrdering({ systemPrompt, houseFloor, cardVoice = WIRE_CARD_VOICE_SENTINEL }) {
  if (typeof systemPrompt !== "string" || systemPrompt.length === 0)
    return unobserved("request_carried_no_system_prompt");
  if (typeof houseFloor !== "string" || houseFloor.length === 0) return unobserved("house_floor_anchor_not_supplied");
  const floorAt = systemPrompt.indexOf(houseFloor);
  if (floorAt < 0) return failed("house_floor_anchor_absent");
  const voiceAt = systemPrompt.indexOf(cardVoice);
  if (voiceAt < 0) return failed("card_voice_sentinel_absent");
  if (voiceAt <= floorAt) {
    return failed("card_voice_not_after_floor", Object.freeze({ cardVoiceIndex: voiceAt, floorIndex: floorAt }));
  }
  return verified(Object.freeze({ cardVoiceIndex: voiceAt, floorIndex: floorAt }));
}

/** The system message of a captured body (the Host's own instruction text for this surface). */
export function systemPromptOf(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const system = messages.find((message) => message?.role === "system");
  return system === undefined ? "" : wireMessageText(system);
}

/**
 * The three judgements over the requests a run captured, in one envelope.
 *
 * `requests` is the stub's own log (`provider.requests`), and the reading is taken over the LAST request
 * that arrived, because that is the turn whose tail and ordering a reader cares about. Every field here is
 * a state, a bounded reason or a number - never the prompt text, which carries the player's own words.
 */
export function buildWireContractReading({ requests, gameToolNames, houseFloor }) {
  const bodies = (Array.isArray(requests) ? requests : [])
    .map((entry) => entry?.body ?? entry)
    .filter((body) => body !== undefined);
  const last = bodies.at(-1);
  const checks = [
    Object.freeze({
      id: "postHistoryReachesTail",
      ...judgePostHistorySentinel({ request: last }),
    }),
    Object.freeze({
      id: "noGameToolOnChatWire",
      ...judgeGameToolAbsence({ requests: bodies, gameToolNames }),
    }),
    Object.freeze({
      id: "cardVoiceAfterFloor",
      ...judgeCardVoiceOrdering({ systemPrompt: systemPromptOf(last), houseFloor }),
    }),
  ];
  const firstFailure = checks.find((check) => check.state === EVIDENCE_STATE.failed);
  const firstGap = checks.find((check) => check.state === EVIDENCE_STATE.unobserved);
  let state = EVIDENCE_STATE.verified;
  if (firstFailure !== undefined) state = EVIDENCE_STATE.failed;
  else if (firstGap !== undefined) state = EVIDENCE_STATE.unobserved;
  return Object.freeze({
    state,
    reason: firstFailure?.reason ?? firstGap?.reason ?? null,
    requests: bodies.length,
    checks: Object.freeze(checks),
  });
}

/**
 * One line per check, for the run log. Prints the state and the bounded reason only: the bytes the checks
 * read are never echoed (`tools/live-run/README.md` §4).
 */
export function narrateWireContract(reading) {
  const lines = [`[chat-live-audit] wire contract state=${reading.state} over ${reading.requests} request(s)`];
  for (const check of reading.checks) {
    lines.push(`  ${check.id}: ${check.state}${check.reason === null ? "" : ` (${check.reason})`}`);
  }
  return lines.join("\n");
}
