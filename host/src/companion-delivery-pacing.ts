import { IncrementalSpeechAccumulator } from "./companion-speech-incremental.js";

/**
 * How long one piece of companion speech takes to type, as the reference
 * companion products model it (`ref/MaiBot/src/chat/utils/utils.py`
 * `calculate_typing_time`): a per-character cost that differs between Chinese
 * and other characters, a multiplier for a reply that is a single character,
 * a constant for the enter key, and one speed multiplier.
 */
export type CompanionTypingPace = Readonly<{
  chineseMsPerChar: number;
  latinMsPerChar: number;
  /** Applied instead of the per-character sum when the whole reply is one Chinese character. */
  singleCharacterFactor: number;
  /** Charged once per piece, after the characters. */
  enterKeyMs: number;
  /** 0 delivers instantly, 1 is the measured default, 2 is twice as slow. */
  speed: number;
}>;

/**
 * One interjection emitted before the substantive reply. The vocabulary is
 * closed and keyed by language subtag, so the sound is always in the player's
 * own language; a language with no entry says nothing rather than inventing one.
 */
export type CompanionReactionPace = Readonly<{
  byLanguage: Readonly<Record<string, readonly string[]>>;
}>;

/** The most characters one delivered piece may carry. */
export type CompanionLengthBudget = Readonly<{ maxChars: number }>;

/**
 * The one pacing policy a surface selects, as three independently switchable
 * mechanisms. `null` means off: that mechanism contributes nothing at all, so a
 * surface that switches every mechanism off delivers exactly what it delivered
 * before pacing existed.
 */
export type CompanionDeliveryPacing = Readonly<{
  typing: CompanionTypingPace | null;
  reaction: CompanionReactionPace | null;
  lengthBudget: CompanionLengthBudget | null;
}>;

/**
 * The in-game surface's pacing, read by `companion-loop.ts` (which passes the
 * `typing` half to the native-content observer and applies `reaction` and
 * `lengthBudget` to every piece it presents). The Game bubble is a small,
 * glanceable box, so it is the surface where a long paragraph and an instantly
 * complete answer both read as machine output rather than as company.
 */
export const GAME_DELIVERY_PACING: CompanionDeliveryPacing = Object.freeze({
  typing: Object.freeze({
    chineseMsPerChar: 300,
    latinMsPerChar: 150,
    singleCharacterFactor: 3,
    enterKeyMs: 300,
    speed: 1,
  }),
  reaction: Object.freeze({
    byLanguage: Object.freeze({
      zh: Object.freeze(["嗯。", "唔。", "哦。", "欸。"]),
      en: Object.freeze(["Mm.", "Hm.", "Ah.", "Oh."]),
      ja: Object.freeze(["うん。", "ん。", "あ。", "へえ。"]),
    }),
  }),
  lengthBudget: Object.freeze({ maxChars: 80 }),
});

/**
 * The Chat surface's pacing when the player turns the switch ON.
 *
 * Same three mechanisms as the game bubble, with two differences that follow
 * from what a transcript is. The reaction vocabulary is the same closed set: a
 * sound before the reply is still a sound, not a claim. The length budget is
 * wider, because a Chat row has room for a sentence that a glanceable bubble
 * does not, and splitting a transcript into eighty-character pieces would make
 * it harder to read back, not easier.
 */
export const CHAT_PACED_DELIVERY: CompanionDeliveryPacing = Object.freeze({
  typing: Object.freeze({
    chineseMsPerChar: 300,
    latinMsPerChar: 150,
    singleCharacterFactor: 3,
    enterKeyMs: 300,
    speed: 1,
  }),
  reaction: GAME_DELIVERY_PACING.reaction,
  lengthBudget: Object.freeze({ maxChars: 240 }),
});

/**
 * The Chat surface's pacing: all three mechanisms off, read as the observer's
 * default for any surface that does not opt in (`native-companion-content.ts`,
 * which is where the Chat transcript's observer is configured). The Chat row is
 * a durable transcript the player scrolls back through, not a bubble that
 * appears while the game runs, so splitting it into pieces or preceding it with
 * a sound would edit the record instead of the delivery - unless the player asks
 * for it, which is what `CHAT_PACED_DELIVERY` above is for.
 */
export const CHAT_DELIVERY_PACING: CompanionDeliveryPacing = Object.freeze({
  typing: null,
  reaction: null,
  lengthBudget: null,
});

/**
 * The pacing one surface delivers with, given what the player chose.
 *
 * The stored preference is ONE record and answers only "did the player turn it
 * on". Which surfaces honour it, and what an unset record falls to, is this
 * function's decision and nobody else's - that is why the store takes no surface
 * argument.
 *
 * Game is paced unless the player turned it off: the bubble is glanceable and
 * transitory, and a wall of text there reads as output rather than company.
 * Chat is paced only if the player turned it on: the transcript is durable and
 * read back, so changing its delivery is the player's call, not our default.
 */
export function deliveryPacingFor(surface: "game" | "chat", pacedChosenByPlayer: boolean): CompanionDeliveryPacing {
  if (surface === "game") return pacedChosenByPlayer ? GAME_DELIVERY_PACING : CHAT_DELIVERY_PACING;
  return pacedChosenByPlayer ? CHAT_PACED_DELIVERY : CHAT_DELIVERY_PACING;
}

const HAN = /[\u4e00-\u9fff]/u;

/**
 * The typing time of one piece, in milliseconds.
 *
 * Content-proportional rather than flat: a ten-character piece waits less than
 * a hundred-character one, and a piece that is a single Chinese character waits
 * longer than a two-character one because a lone sound is a considered reply
 * rather than a short line. `speed <= 0` is the reference's own "fastest"
 * setting and types instantly, which is also how a caller disables the delay
 * without switching the whole mechanism off.
 */
export function typingDurationMs(text: string, pace: CompanionTypingPace): number {
  if (pace.speed <= 0) return 0;
  let chineseChars = 0;
  let total = pace.enterKeyMs;
  for (const char of text) {
    if (HAN.test(char)) {
      chineseChars += 1;
      total += pace.chineseMsPerChar;
    } else {
      total += pace.latinMsPerChar;
    }
  }
  if (chineseChars === 1 && text.trim().length === 1)
    total = pace.chineseMsPerChar * pace.singleCharacterFactor + pace.enterKeyMs;
  return Math.round(total * pace.speed);
}

/**
 * The one sound this turn opens with, or `null` when the turn's language has no
 * vocabulary. Selection is seeded by the turn identity (the authenticated source
 * event), so the same turn always produces the same sound: a replay or a test
 * reproduces it exactly, while two turns differ.
 */
export function selectReactionSound(seed: string, locale: string, pace: CompanionReactionPace): string | null {
  const language = locale.split("-")[0]?.toLowerCase() ?? "";
  const vocabulary = pace.byLanguage[language];
  if (vocabulary === undefined || vocabulary.length === 0) return null;
  // FNV-1a over the turn id: a small stable hash, not a security primitive.
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return vocabulary[hash % vocabulary.length] ?? null;
}

/**
 * Splits one delivered piece into sentence-bounded pieces of at most
 * `budget.maxChars` characters, using the same accumulator the streaming lane
 * already uses, so a split point is always a real sentence end and never a cut
 * inside a quote, a stage beat, or a scaffolding block.
 *
 * A single sentence that is longer than the budget is delivered whole: the
 * budget bounds how much arrives at once, it never deletes speakable dialogue.
 * Concatenating the result always reproduces `text` exactly.
 */
export function budgetedSpeechPieces(text: string, budget: CompanionLengthBudget): readonly string[] {
  if (text.length <= budget.maxChars) return Object.freeze([text]);
  const accumulator = new IncrementalSpeechAccumulator();
  const units = [...accumulator.push(text), accumulator.flush()];
  const pieces: string[] = [];
  let current = "";
  for (const unit of units) {
    if (unit.length === 0) continue;
    if (current.length > 0 && current.length + unit.length > budget.maxChars) {
      pieces.push(current);
      current = "";
    }
    current += unit;
  }
  if (current.length > 0) pieces.push(current);
  return Object.freeze(pieces);
}
