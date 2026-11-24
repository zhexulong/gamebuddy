const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

/**
 * Deterministic rule parser for the presence audit dimension "承诺可兑现性"
 * (design/architecture/stardew-companion-presence-audit-dimensions.md §3).
 *
 * Pure tooling: no Host import, no game or model access. It classifies
 * caller-supplied companion turn text into opaque actionIds of first-person
 * self-commitments, and projects per-turn claims against the same-turn
 * capability face (visibleActions) and receipts. Every output is recomputable
 * from the same inputs; missing or malformed input fails closed instead of
 * silently matching nothing.
 *
 * TWO READINGS, ONE SUBJECT: what she said about her promises (the projection
 * below, design §3 承诺可兑现性) and what she said about her own BODY
 * (`readBodyClaims` at the end of this file). The second exists because the
 * first is right by design not to charge a claim with no receipt at all, and the
 * interaction gate judges the world rather than her body - so `round99` presented
 * 「还在往上爬。」 while the mine exit it had just been refused, and nothing named
 * the disagreement.
 *
 * §3.2 boundary 1 (subject & mood guardrail): a mention of an action keyword
 * only counts as a claim when its sentence is an unconditional first-person
 * self-commitment (前置主语词 我/我去/我来/我这就/我已经/我刚/我正在 + 简单窗口匹配).
 *
 * §3.2 boundary 2: fulfillment converges on the same turn (N = 0); no
 * cross-turn tracking.
 */
export class PresenceProjectionError extends Error {
  constructor(code, detail = undefined) {
    super(code);
    this.name = "PresenceProjectionError";
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code, detail = undefined) => {
  throw new PresenceProjectionError(code, detail);
};

/**
 * Sentence windowing. Commas are deliberately NOT boundaries: in
 * "我这就去浇水,顺便除除草" the first-person subject carries across the comma,
 * so both action phrases stay a self-commitment. A clause that is bound by
 * someone else's subject earlier in the sentence is excluded conservatively by
 * the mixed-subject guard below.
 */
const SENTENCE_SPLIT = /[。！？…!?;；\n]+/;

// --- §3.2 boundary 1 guardrails (simple window matching, no LLM) ------------

/** Sentence-initial other-person subject: the promise is not the companion's. */
const OTHER_SUBJECT_START = /^(你|您|他|她|他们|她们|大家|我们|咱们)/;
/** Inclusive plural anywhere before the phrase widens the actor beyond 我. */
const INCLUSIVE_PLURAL = /(我们|咱们)/;
/** Causatives hand the action to someone else ("我要你去浇水" / "我请他翻地"). */
const CAUSATIVE = /(要|让|请|教|告诉)(你|您|他|她|他们|她们|大家|咱们)/;
/** "陪他去/她来": the OTHER party executes the action. */
const HELP_TO = /(陪|帮)(你|您|他|她|他们|她们|大家)(去|来)/;
/** Joint actions ("和你一起浇水", "和他翻地") are not a clean self-commitment. */
const JOINT = /(和|跟|与)(你|您|他|她|他们|她们|大家|我们|咱们)/;
/** Imperatives addressed to others ("帮我浇水", "替我去一趟"). */
const IMPERATIVE = /^(请|麻烦|帮我|替我|你帮我|快帮我)/;

/** Mixed subjects inside one sentence: the phrase's own verb performs it. */
const MIXED_SUBJECT = /(你|您|他|她|他们|她们|大家),(我|我们|咱们)(就|也|再|才|来|去)/;

/** Memory/cognition statements are not execution commitments. */
const KNOWING = ["记得", "听说", "知道", "觉得", "认为", "以为", "说过"];
/** Conditional / future / modal words; such sentences never make a claim. */
const INTENT = [
  "如果",
  "假如",
  "要是",
  "要不要",
  "明天",
  "改天",
  "以后",
  "下次",
  "将来",
  "可能",
  "或许",
  "可以",
  "会",
  "想要",
  "打算",
  "计划",
  "能",
  "想",
  "要",
];
/** Ability/attribute statements ("我其实很会除草", "我是负责浇水的"). */
const ABILITY = ["我是", "我很", "我擅长", "我其实很会", "我有", "我特别会"];
/** Preference statements ("我喜欢浇水") are not commitments either. */
const PREFERENCE = ["我喜欢", "我讨厌", "我超喜欢", "我爱"];

/** First-person commitment frames (design §3.2: 前置主语词). */
const FRAMES = ["我这就", "我已经", "我刚", "我正在", "我去", "我来", "我"];

/**
 * THE GUARDRAILS THAT DECIDE WHETHER A SENTENCE IS HER OWN ASSERTION AT ALL, shared by both readings below so that a
 * subject, mood or question cannot be admitted by one spelling of the rule and refused by the other.
 *
 * `prefix` is the text before the phrase the rule is looking for: an inclusive plural, a causative, a joint actor or a
 * memory verb BEFORE the verb hands the action to someone else, while the sentence-wide guards (another subject, an
 * imperative, a question) disqualify it wherever they sit.
 */
function sentenceIsOwnAssertion(sentence, prefix) {
  if (OTHER_SUBJECT_START.test(sentence)) return false;
  if (INCLUSIVE_PLURAL.test(prefix)) return false;
  if (CAUSATIVE.test(prefix)) return false;
  if (HELP_TO.test(prefix)) return false;
  if (JOINT.test(prefix)) return false;
  if (IMPERATIVE.test(sentence)) return false;
  if (MIXED_SUBJECT.test(sentence)) return false;
  // A question is not an assertion: "在往上爬吗?" asks about the body, and charging it would be charging a question
  // for not being true. `吗`/`呢` and the question mark, not a list of phrasings.
  if (/[吗呢？?]/u.test(sentence)) return false;
  if (KNOWING.some((word) => prefix.includes(word))) return false;
  if (INTENT.some((word) => sentence.includes(word))) return false;
  if (ABILITY.some((word) => prefix.includes(word))) return false;
  if (PREFERENCE.some((word) => prefix.includes(word))) return false;
  return true;
}

/**
 * One sentence of the turn is a self-commitment to `phrase` when none of the
 * subject/mood guardrails fire and a first-person frame precedes the phrase.
 */
function sentenceCommits(sentence, phrase) {
  const at = sentence.indexOf(phrase);
  if (at < 0) return false;
  const prefix = sentence.slice(0, at);
  if (!sentenceIsOwnAssertion(sentence, prefix)) return false;
  return FRAMES.some((frame) => prefix.includes(frame));
}

function validateActionVocabulary(actionVocabulary) {
  if (
    !actionVocabulary ||
    typeof actionVocabulary !== "object" ||
    Array.isArray(actionVocabulary) ||
    Object.keys(actionVocabulary).length === 0
  )
    fail("presence_action_vocabulary_invalid");
  for (const [actionId, phrases] of Object.entries(actionVocabulary)) {
    if (!IDENTIFIER.test(actionId)) fail("presence_action_id_invalid");
    if (!Array.isArray(phrases) || phrases.length === 0) fail("presence_action_vocabulary_invalid");
    for (const phrase of phrases)
      if (typeof phrase !== "string" || phrase.length === 0 || phrase.length > 256)
        fail("presence_claim_phrase_invalid");
  }
}

/**
 * Parses companion turn text into the opaque actionIds of first-person
 * self-commitments. Each actionId in the vocabulary is counted at most once
 * per text (首个命中的 phrase 即计入); the same sentence may commit to several
 * distinct actions. The vocabulary maps actionId -> Chinese phrases, each
 * matched as a substring within a sentence window.
 */
export function parseCompanionClaims(text, actionVocabulary) {
  if (typeof text !== "string" || text.length === 0) fail("presence_claim_text_invalid");
  if (text.length > 100_000) fail("presence_claim_text_too_large");
  validateActionVocabulary(actionVocabulary);
  const sentences = text.split(SENTENCE_SPLIT);
  const claims = [];
  for (const [actionId, phrases] of Object.entries(actionVocabulary)) {
    for (const phrase of phrases) {
      if (sentences.some((sentence) => sentenceCommits(sentence, phrase))) {
        claims.push(actionId);
        break;
      }
    }
  }
  return [...new Set(claims)];
}

function validateTurnTexts(turnTexts) {
  if (!Array.isArray(turnTexts)) fail("presence_turns_invalid");
  for (const turn of turnTexts) {
    if (
      !turn ||
      typeof turn !== "object" ||
      Array.isArray(turn) ||
      typeof turn.turnId !== "string" ||
      turn.turnId.length === 0 ||
      turn.turnId.length > 256 ||
      typeof turn.text !== "string" ||
      turn.text.length > 100_000
    )
      fail("presence_turn_invalid");
  }
}

function validateVisibleActionIds(visibleActionIds) {
  const values = visibleActionIds instanceof Set ? [...visibleActionIds] : visibleActionIds;
  if (!Array.isArray(values)) fail("presence_visible_action_ids_invalid");
  for (const actionId of values)
    if (typeof actionId !== "string" || !IDENTIFIER.test(actionId)) fail("presence_action_id_invalid");
}

/** The only "succeeded/accepted" states count as兑现 (design §3.3 / task). */
const FULFILLED_RECEIPT_STATES = new Set(["accepted", "succeeded"]);
/** Every state the projection understands; anything else fails closed. */
const KNOWN_RECEIPT_STATES = new Set([
  ...FULFILLED_RECEIPT_STATES,
  "running",
  "meaningful_progress",
  "partially_succeeded",
  "failed",
  // `blocked` is the Mod's own wire state for "the world refused this" (`ExecutionState.Blocked => "blocked"`,
  // `BridgeProtocolModels.cs:30`), and a real run mints it: `round99`'s exit navigation answered
  // `destination_access_indeterminate` with `state: blocked`. It was missing here, so this table would have refused the
  // one receipt that says a body move was refused.
  "blocked",
  "cancelled",
  "expired",
  "invalidated",
  "rejected",
  "uncertain",
  "in_progress",
  "pending",
]);

function validateReceipts(executedReceipts) {
  if (!Array.isArray(executedReceipts)) fail("presence_receipts_invalid");
  for (const receipt of executedReceipts) {
    if (
      !receipt ||
      typeof receipt !== "object" ||
      Array.isArray(receipt) ||
      typeof receipt.turnId !== "string" ||
      receipt.turnId.length === 0 ||
      receipt.turnId.length > 256 ||
      typeof receipt.actionId !== "string" ||
      !IDENTIFIER.test(receipt.actionId) ||
      typeof receipt.terminalState !== "string"
    )
      fail("presence_receipt_invalid");
    if (!KNOWN_RECEIPT_STATES.has(receipt.terminalState)) fail("presence_receipt_state_invalid");
  }
}

/**
 * Builds the §3.3 presence projection (claimsMade / claimsVisible /
 * claimsReceipted plus findings) per turn, from the same authoritative inputs
 * the audit dimension names: the capability face (visibleActionIds) and the
 * same-turn receipts (executedReceipts with terminalState; accepted/succeeded
 * being the兑现 anchor).
 *
 * Findings (both §3.3 red lines, deterministic):
 * - claim_not_visible: a claim resolves outside the visible action set;
 * - claim_unreceipted: the action was initiated in the same turn (a receipt
 *   exists) but never reached accepted/succeeded.
 *
 * Turns without any parsed claim produce no finding; future/conditional
 * mentions are parsed out as non-claims, so they can never produce a dangling
 * finding. A claim with no same-turn receipt at all is a countable row
 * (claimsReceipted 0) but not an integrity finding (design §3.1.3).
 */
export function buildPresenceProjection({ turnTexts, actionVocabulary, visibleActionIds, executedReceipts }) {
  validateTurnTexts(turnTexts);
  validateActionVocabulary(actionVocabulary);
  validateVisibleActionIds(visibleActionIds);
  validateReceipts(executedReceipts);
  const visible = new Set(visibleActionIds instanceof Set ? [...visibleActionIds] : visibleActionIds);
  const receiptsByTurn = new Map();
  for (const receipt of executedReceipts) {
    const list = receiptsByTurn.get(receipt.turnId) ?? [];
    list.push(receipt);
    receiptsByTurn.set(receipt.turnId, list);
  }
  const turns = [];
  const findings = [];
  for (const turn of turnTexts) {
    const { turnId, text } = turn;
    const claimsMade = text.length === 0 ? [] : parseCompanionClaims(text, actionVocabulary);
    const claimsVisible = claimsMade.filter((actionId) => visible.has(actionId)).length;
    const sameTurn = receiptsByTurn.get(turnId) ?? [];
    const initiated = new Set(sameTurn.map((receipt) => receipt.actionId));
    const fulfilled = new Set(
      sameTurn
        .filter((receipt) => FULFILLED_RECEIPT_STATES.has(receipt.terminalState))
        .map((receipt) => receipt.actionId),
    );
    const turnFindings = [];
    if (claimsVisible < claimsMade.length) turnFindings.push("claim_not_visible");
    for (const actionId of claimsMade)
      if (initiated.has(actionId) && !fulfilled.has(actionId)) turnFindings.push("claim_unreceipted");
    const uniqueFindings = [...new Set(turnFindings)];
    turns.push(
      Object.freeze({
        turnId,
        claimsMade: Object.freeze(claimsMade),
        claimsVisible,
        claimsReceipted: claimsMade.filter((actionId) => fulfilled.has(actionId)).length,
        findings: Object.freeze(uniqueFindings),
      }),
    );
    for (const finding of uniqueFindings) findings.push(Object.freeze({ turnId, finding }));
  }
  return Object.freeze({ turns: Object.freeze(turns), findings: Object.freeze(findings) });
}

// --- what her line says about her own BODY, against what the receipts prove --------------------------------------

const BODY_CLAIM_SCHEMA = "gamebuddy_body_claim_reading/v1";

/**
 * THE RECEIPTS THAT CAN SAY WHERE THE BODY IS, keyed by the action that minted them.
 *
 * <p>
 * The claim vocabulary below is DERIVED FROM THIS TABLE, never written beside it: every claim kind names the proof that
 * discharges it, and every proof is one of these receipt families. A phrase therefore cannot be added without naming
 * the receipt that would prove it, and a family cannot be added without naming what the Mod mints it from.
 * </p>
 * <p>
 * The ACTION ID is the axis rather than the reason code, because which action ran survives every terminal outcome:
 * `move_to_tile` proves the body stood on a tile it walked to, whatever route chose it, and a `navigate_to_destination`
 * / `enter_exit` / `enter_mine` / `use_mine_ladder` receipt proves it left one place for another. `warped` is the same
 * fact minted as a semantic event instead of an execution - the world moved the body - so it counts for transit too.
 * </p>
 */
const BODY_ARRIVAL_ACTIONS = Object.freeze(new Set(["move_to_tile"]));
const BODY_TRANSIT_ACTIONS = Object.freeze(
  new Set(["navigate_to_destination", "enter_exit", "enter_mine", "use_mine_ladder"]),
);
const BODY_MOVE_ACTIONS = Object.freeze(new Set([...BODY_ARRIVAL_ACTIONS, ...BODY_TRANSIT_ACTIONS]));
const WARP_REASON = "warped";
/** A receipt states where the body stands when its detail carries one of the Mod's place fields. */
const PLACE_FIELD = /(?:^|;)(?:tile|location|actual|arrived_map|destination)=/u;
/** States that are neither a landing nor a refusal: the action is still on its way. */
const IN_FLIGHT_RECEIPT_STATES = new Set([
  "running",
  "meaningful_progress",
  "partially_succeeded",
  "in_progress",
  "pending",
]);
/**
 * A REFUSAL is a terminal state that says the action did NOT land, derived from the module's own state table so a new
 * terminal state cannot be counted as a landing by omission.
 */
const REFUSED_RECEIPT_STATES = new Set(
  [...KNOWN_RECEIPT_STATES].filter(
    (state) => !(FULFILLED_RECEIPT_STATES.has(state) || IN_FLIGHT_RECEIPT_STATES.has(state)),
  ),
);

/**
 * THE CLAIM KINDS: one row per assertion about her body that a receipt can settle.
 *
 * <p>
 * `proof` is the receipt family that discharges the claim and `phrases` are the words that make the assertion. The
 * phrases are Chinese because the run speaks the player's language, and each one sits under the receipt that would
 * prove it - never under a list of adverbs to be trusted on its own.
 * </p>
 * <p>
 * THE FOUR FAMILIES, AND WHY WORK IS NOT LIKE MOVEMENT. `arrival` is the body standing on a tile it walked to;
 * `transit` is the body leaving one place for another; `standing` is the run's last word on where she is; `recorded`
 * is the world recording something she did - LANDED OR REFUSED, because a refused attempt is still the attempt a work
 * claim names ("在敲石头" is true while the rock refuses to break), which is the fourth backing the design lists ("an
 * explicit refusal she is responding to").
 * </p>
 * <p>
 * FOR MOVEMENT A REFUSAL IS THE OPPOSITE OF THE PROOF. `round99`'s window held a blocked `navigate_to_destination` and
 * one walked tile while the line said she was climbing up; a refusal of the way out is the receipt that she did NOT
 * get out, so the finding publishes it (`refusedInWindow`) instead of being discharged by it. An utterance that
 * REPORTS the refusal ("门打不开") carries no phrase of any kind and is therefore never charged at all.
 * </p>
 */
const BODY_CLAIM_KINDS = Object.freeze([
  Object.freeze({
    // A change of floor, map or place. Proven only by a TRANSIT: a walk on the same map cannot prove it, which is the
    // `round99` case exactly - the body walked one tile on the mine floor and the line said she was climbing up.
    kind: "place_change",
    proof: "transit",
    phrases: Object.freeze([
      "往上爬",
      "往上走",
      "往上",
      "上去",
      "下去",
      "下来",
      "上来",
      "下矿",
      "出去",
      "进去",
      "进矿",
      "出矿",
      "回屋",
      "回家",
      "回农场",
      "到镇上",
      "往镇上",
      "往回走",
    ]),
  }),
  Object.freeze({
    // Walking on the same map.
    kind: "motion",
    proof: "arrival",
    phrases: Object.freeze(["走过去", "走到", "过去", "绕过去", "绕路", "挪", "摸过去", "赶过去", "爬过去", "跑到"]),
  }),
  Object.freeze({
    // Work advancing. The weakest proof, deliberately: which work a phrase names cannot be attributed from prose, so
    // the claim is discharged by the world recording that ANYTHING she did landed in the window.
    kind: "progress",
    proof: "recorded",
    phrases: Object.freeze(["敲", "挖", "清", "割", "收", "浇", "种", "攒", "捡", "放倒", "砍", "整"]),
  }),
  Object.freeze({
    // Where she stands. A position PERSISTS until a receipt changes it, so this kind is discharged by the run's last
    // place receipt rather than by the window, and it charges only a run that never said where she stood at all.
    kind: "position",
    proof: "standing",
    phrases: Object.freeze(["矿洞里", "矿井里", "洞里", "这层", "农场里", "镇上", "屋里", "门口", "这儿", "那儿"]),
  }),
]);

/**
 * The frame that makes a sentence a statement about what her body is doing NOW.
 *
 * <p>
 * ONLY the ongoing frame is charged, and that is the rule's recall boundary stated as a guard. A sentence about what she
 * HAS done ("这层的石头敲穿了") is provable by anything earlier in the run, so charging it would charge a summary for
 * being a summary; a sentence about what she is about to do ("我下去敲两层铜矿") is a promise, which
 * `buildPresenceProjection` already judges against the capability face. "Still doing it" is the one shape that has to
 * be true at the moment it is said, and therefore the one shape a receipt can refute.
 * </p>
 * <p>
 * Two spellings, because Chinese puts the clock or the reason before the verb ("一点四十了，我还在矿洞里"). The second
 * requires an EXPLICIT 我/俺 subject, which is also what keeps a sentence about someone else out: "乔迪说她还在爬"
 * carries 她, never 我.
 * </p>
 */
const ONGOING_FRAME_START = /^(?:我|俺|我们)?(?:还|正在|正|在)在?/u;
const ONGOING_FRAME_SUBJECT = /(?:我|俺)(?:还|正在|正|在)在?/u;

function validateBodyUtterances(utterances) {
  if (!Array.isArray(utterances)) fail("body_claim_utterances_invalid");
  for (const utterance of utterances) {
    if (
      !utterance ||
      typeof utterance !== "object" ||
      Array.isArray(utterance) ||
      !Number.isInteger(utterance.atMs) ||
      utterance.atMs < 0 ||
      typeof utterance.text !== "string" ||
      utterance.text.length > 100_000
    )
      fail("body_claim_utterance_invalid");
  }
}

function validateBodyReceipts(receipts) {
  if (!Array.isArray(receipts)) fail("body_claim_receipts_invalid");
  for (const receipt of receipts) {
    if (
      !receipt ||
      typeof receipt !== "object" ||
      Array.isArray(receipt) ||
      !Number.isInteger(receipt.atMs) ||
      receipt.atMs < 0
    )
      fail("body_claim_receipt_invalid");
  }
}

/** What one receipt proves, in the proof families the claim kinds name. */
function receiptProofs(receipt) {
  const proofs = new Set();
  const actionId = typeof receipt.actionId === "string" ? receipt.actionId : null;
  const action = actionId !== null && BODY_MOVE_ACTIONS.has(actionId) ? actionId : null;
  const state = typeof receipt.state === "string" ? receipt.state : null;
  if (state !== null && REFUSED_RECEIPT_STATES.has(state)) {
    if (action !== null) proofs.add("refusal");
    proofs.add("refusal:any");
    return proofs;
  }
  const landed = state !== null && FULFILLED_RECEIPT_STATES.has(state);
  if (landed && action !== null && BODY_ARRIVAL_ACTIONS.has(action)) proofs.add("arrival");
  if ((landed && action !== null && BODY_TRANSIT_ACTIONS.has(action)) || receipt.reasonCode === WARP_REASON)
    proofs.add("transit");
  if (landed) proofs.add("recorded");
  if (typeof receipt.detail === "string" && PLACE_FIELD.test(receipt.detail)) proofs.add("standing");
  return proofs;
}

/** The claim one utterance makes about her body, or null. */
function readOngoingClaim(text) {
  const sentences = text.split(SENTENCE_SPLIT);
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length === 0) continue;
    const frame = ONGOING_FRAME_START.exec(trimmed) ?? ONGOING_FRAME_SUBJECT.exec(trimmed);
    // No ongoing frame: a summary of what she has done, or a promise about what she will do. Neither is this rule's.
    if (frame === null) continue;
    const framed = trimmed.slice(0, frame.index + frame[0].length);
    const rest = trimmed.slice(framed.length);
    if (rest.length === 0) continue;
    if (!sentenceIsOwnAssertion(trimmed, framed)) continue;
    for (const kind of BODY_CLAIM_KINDS)
      for (const phrase of kind.phrases)
        if (rest.startsWith(phrase)) return Object.freeze({ kind: kind.kind, proof: kind.proof, phrase });
  }
  return null;
}

/**
 * The proof that discharges the claim, named, or null - named because "the rule examined it and a receipt backed it" and
 * "the rule never examined it" are different answers that a bare pass cannot tell apart.
 */
function dischargingProof(claim, proofs, hasStandingPlace) {
  if (claim.proof === "standing") return hasStandingPlace ? "standing" : null;
  if (proofs.has(claim.proof)) return claim.proof;
  if (claim.proof === "recorded" && proofs.has("refusal:any")) return "refusal";
  return null;
}

/**
 * What her line says about her own BODY, against what the receipts prove: the ONE reading that compares a description of
 * her motion, position or progress with the receipts of the same window.
 *
 * <p>
 * THE DEFECT THIS EXISTS FOR, measured 2026-11-24 (`round99`, `2026-11-24T09-55-06-982Z-multiday_routine`, day 3). At
 * 10:34:56 she presented 「还在往上爬。」. Between her previous line (10:34:05) and that one the run held a REFUSED exit
 * navigation (`destination_access_indeterminate`, `destination=Farm;topology=route_topology_invalid`) and one walked tile
 * (`target_reached move_to_tile tile=11,4`) - no ladder, no warp, no door - and at 01:40 she was still in the mine,
 * passing out at its entrance at 02:00. The run read green, and nothing in the tree could say otherwise:
 * `buildPresenceProjection` judges PROMISES, and by design (§3.1.3) a claim with no receipt at all is a countable row
 * rather than a finding, while `claim_unreceipted` needs the action to have been initiated; the interaction gate judges
 * what the WORLD did (`unobserved_event`), never her own body. A line that describes motion the receipts do not hold had
 * nowhere to be named.
 * </p>
 * <p>
 * THE PROPERTY, AS A CLASS: an utterance that asserts the actor's own motion, position or progress while it is happening
 * must be backed by a receipt in the same window - an arrival, a transit, a landing of any kind, or (for work) the
 * refused attempt it names. When nothing in the window backs it, that is a named finding:
 * `presence_claim_without_a_receipt:<claim kind>:<window>`, where the window is the interval
 * (`previousAtMs-thisAtMs`) a reader can find in the run's own timeline.
 * </p>
 * <p>
 * WHAT IT CANNOT SEE, stated so a green verdict is not over-read: an utterance about ANOTHER actor's action (「乔迪出去
 * 了」) or about the WORLD rather than her body (「这层没梯子」) is out of scope - the claim kinds are her own body's, and
 * the guards refuse a sentence whose subject is someone else. It also cannot attribute the work a progress phrase names,
 * so that kind is discharged by the world recording anything at all.
 * </p>
 *
 * `utterances` are `{ atMs, text }` in the run's own clock (the session record's lines); `receipts` are
 * `{ atMs, reasonCode?, state?, actionId?, detail? }` (the fact log's entries, projected to the fields a proof reads).
 */
export function readBodyClaims({ utterances, receipts } = {}) {
  validateBodyUtterances(utterances);
  validateBodyReceipts(receipts);
  const spoken = [...utterances].sort((left, right) => left.atMs - right.atMs);
  const timed = [...receipts]
    .sort((left, right) => left.atMs - right.atMs)
    .map((receipt) => Object.freeze({ atMs: receipt.atMs, proofs: receiptProofs(receipt) }));
  const findings = [];
  const claims = [];
  // The last receipt at or before the line under judgement that said where she stands: a position persists until a
  // receipt changes it, which is why that kind is not decided by the window.
  let placed = false;
  let cursor = 0;
  let windowStart = 0;
  let previousAtMs = null;
  for (const utterance of spoken) {
    while (cursor < timed.length && timed[cursor].atMs <= utterance.atMs) {
      if (timed[cursor].proofs.has("standing")) placed = true;
      cursor += 1;
    }
    while (windowStart < cursor && previousAtMs !== null && timed[windowStart].atMs <= previousAtMs) windowStart += 1;
    const window = timed.slice(windowStart, cursor);
    const claim = readOngoingClaim(utterance.text);
    if (claim !== null) {
      const proofs = new Set(window.flatMap((entry) => [...entry.proofs]));
      const dischargedBy = dischargingProof(claim, proofs, placed);
      const from = previousAtMs === null ? "start" : String(previousAtMs);
      const windowLabel = `${from}-${String(utterance.atMs)}`;
      claims.push(
        Object.freeze({
          text: utterance.text,
          claimKind: claim.kind,
          phrase: claim.phrase,
          atMs: utterance.atMs,
          window: windowLabel,
          dischargedBy,
        }),
      );
      if (dischargedBy === null)
        findings.push(
          Object.freeze({
            text: utterance.text,
            claimKind: claim.kind,
            phrase: claim.phrase,
            atMs: utterance.atMs,
            window: windowLabel,
            receiptsInWindow: window.length,
            // A refusal in the same window is published rather than silently spent: it is the receipt that says the
            // body move she is narrating was refused, and a reader has to be able to see that it was there.
            refusedInWindow: proofs.has("refusal"),
            finding: `presence_claim_without_a_receipt:${claim.kind}:${windowLabel}`,
          }),
        );
    }
    previousAtMs = utterance.atMs;
  }
  const measured = spoken.length > 0;
  // `failed` outranks the sample states: a real finding about her line is reported as a finding, and a run with no line
  // at all says so instead of passing over an empty population.
  let verdict = "passed";
  if (findings.length > 0) verdict = "failed";
  else if (!measured) verdict = "not_measured";
  let reason = null;
  if (findings.length > 0) reason = findings[0].finding;
  else if (!measured) reason = "no_spoken_lines";
  return Object.freeze({
    schema: BODY_CLAIM_SCHEMA,
    verdict,
    reason,
    examined: Object.freeze({ utterances: spoken.length, ongoingClaims: claims.length, receipts: timed.length }),
    claims: Object.freeze(claims),
    findings: Object.freeze(findings),
    reading: `body claims: ${claims.length} of ${spoken.length} utterances assert an ongoing claim · receipts ${timed.length} · findings ${findings.length}`,
  });
}
