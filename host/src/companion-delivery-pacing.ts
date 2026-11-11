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
 * The in-game surface's pacing, read by `companion-loop.ts`, which passes it whole to the native-content
 * observer. The Game bubble is a small, glanceable box, so it is the surface where a long paragraph and an
 * instantly complete answer both read as machine output rather than as company.
 *
 * <p>
 * What each mechanism does on the bubble's own unit (one prompt turn, one bubble): `reaction` is the
 * interjection at the HEAD of that bubble's text, `lengthBudget` is the ceiling the bubble is cut to, and
 * `typing` paces the mid-message working remark, which only the message unit has - a turn's speech cannot
 * leave before the turn ends, so there is nothing to delay. Keeping the record whole means the surface
 * still names all three even where one of them has nowhere to apply.
 * </p>
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
 * Same three mechanisms as the game bubble, except the length budget. A bubble
 * is a separate item each time, so splitting a long remark into two bubbles is
 * coherent; a transcript row is ONE message, and its final text is the durable
 * record, so a budget there cannot shorten a message without losing the text
 * before the last piece. Typing pace and the opening sound stay, because those
 * two are what make the reply read as speech rather than as output.
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
  lengthBudget: null,
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
  const units = speechSentences(text);
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

/**
 * The head of one turn's speech that fits a single bubble, and what keeping it cost.
 *
 * <p>
 * A bubble holds `budget.maxChars`, so a turn whose whole speech is longer than that cannot arrive
 * whole - and one bubble per turn means the tail is what goes, not a second bubble. The cut lands on
 * the last complete sentence that fits, using the same sentence units `budgetedSpeechPieces` splits
 * on, so a bubble never ends inside a quote, a stage beat or a scaffolding frame.
 * </p>
 * <p>
 * One sentence longer than the budget has no boundary to cut at, so it is cut at the character
 * ceiling instead: `sentencesDropped` 0 beside a non-zero `truncatedChars` is that shape and the
 * only one, which is what tells a reader the reply had no complete sentence to stop at.
 * </p>
 */
export function budgetedSpeechHead(
  text: string,
  budget: CompanionLengthBudget,
): Readonly<{ text: string; truncatedChars: number; sentencesDropped: number }> {
  if (text.length <= budget.maxChars) return Object.freeze({ text, truncatedChars: 0, sentencesDropped: 0 });
  const units = speechSentences(text).filter((unit) => unit.length > 0);
  const head = budgetedSpeechPieces(text, budget)[0] ?? "";
  if (head.length > budget.maxChars) {
    const cut = text.slice(0, budget.maxChars).trimEnd();
    return Object.freeze({
      text: cut,
      truncatedChars: text.length - cut.length,
      sentencesDropped: Math.max(0, units.length - 1),
    });
  }
  let kept = 0;
  let width = 0;
  for (const unit of units) {
    if (width + unit.length > head.length) break;
    width += unit.length;
    kept += 1;
  }
  return Object.freeze({
    text: head,
    truncatedChars: text.length - head.length,
    sentencesDropped: units.length - kept,
  });
}

/** The sentences of one text, as both budget readers above walk them. */
function speechSentences(text: string): readonly string[] {
  const accumulator = new IncrementalSpeechAccumulator();
  return Object.freeze([...accumulator.push(text), accumulator.flush()]);
}
