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
 * One sentence of the turn is a self-commitment to `phrase` when none of the
 * subject/mood guardrails fire and a first-person frame precedes the phrase.
 */
function sentenceCommits(sentence, phrase) {
  const at = sentence.indexOf(phrase);
  if (at < 0) return false;
  const prefix = sentence.slice(0, at);
  if (OTHER_SUBJECT_START.test(sentence)) return false;
  if (INCLUSIVE_PLURAL.test(prefix)) return false;
  if (CAUSATIVE.test(prefix)) return false;
  if (HELP_TO.test(prefix)) return false;
  if (JOINT.test(prefix)) return false;
  if (IMPERATIVE.test(sentence)) return false;
  if (MIXED_SUBJECT.test(sentence)) return false;
  if (sentence.endsWith("吗")) return false;
  if (KNOWING.some((word) => prefix.includes(word))) return false;
  if (INTENT.some((word) => sentence.includes(word))) return false;
  if (ABILITY.some((word) => prefix.includes(word))) return false;
  if (PREFERENCE.some((word) => prefix.includes(word))) return false;
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