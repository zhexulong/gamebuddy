/**
 * Whose sentence each part of the player's note is: his own business, or a thing for her to do.
 *
 * <p>
 * THE DEFECT THIS CLOSES, measured on the fishing objective (three attempts, `2026-11-11`). The note was, in the
 * player's own words, `我今天去镇上办事。找片水，钓条鱼回来。你看着办。` - his errand first, then the job he was giving
 * her. `<player-note>` carried all three sentences as one unbroken block of his text, and the prompt's only sentence
 * about it was "answer what &lt;player-note&gt; says": grammatically the note was a statement she replies to, never a
 * work order. `fish_here` was dispatched 0 times in 151 delivered bundles while it was published, mounted, addressable
 * (`waterTargets rows=32`), and the fact `可下竿的水面` printed 58-77 times in one run; her thinking in attempt B3 (131
 * entries) named fish once, as `Player's note: he's going fishing.` - the sentence that carried the assignment read to
 * her as something HE was doing. Attempt B1 (162 thinking entries) never wrote fish or water at all. The capability, the
 * vocabulary, the fact and the address were all present; what was missing was whose task it is.
 * </p>
 *
 * <p>
 * SO THE NOTE IS CLASSIFIED where it is composed, and each class gets its own label inside the block. This module owns
 * the rule and the words; `fact-brief.ts` owns the block it lands in.
 * </p>
 *
 * <h2>The rule</h2>
 *
 * <p>
 * The note is split at every sentence end (`。！？；!?;` plus the whitespace that follows it, so the parts join back to
 * his exact text) and each utterance is read in this order:
 * </p>
 *
 * <ol>
 *   <li>A REQUEST FRAME with him as the one who benefits - `帮我`, `给我`, `替我`, `陪我`, `带我`, `教我`, `让我`,
 *     `告诉我`, or the English `for me` / `help me` / `tell me` / `give me` / `with me` - is hers. It contains `我` and
 *     he is still not the doer, which is why this test runs first.</li>
 *   <li>An EXCLUSIVE FIRST-PERSON subject - `我`, `俺`, `咱` (each except before `们`), or the English `I`/`I'm`/`I'll`/
 *     `I've`/`I'd`/`my`/`myself` - is his. The sentence says what he is doing and asks nothing of her.</li>
 *   <li>Everything else is hers. No exclusive first-person subject means nobody in the sentence is the doer but her:
 *     the imperative drops its subject in his own language (`找片水，钓条鱼回来`), an inclusive `我们` already includes
 *     her (`我们今天去钓鱼`), a second-person subject is addressed to her (`你看着办`), and a bare remark is aimed at
 *     her (`早`).</li>
 * </ol>
 *
 * <p>
 * `我们`/`咱们` are deliberately NOT exclusive. A joint plan is an assignment to take part, and reading it as "his own
 * business" would reproduce the very defect this module exists for, one word over.
 * </p>
 *
 * <h2>Which way it errs, and what that costs</h2>
 *
 * <p>
 * It errs toward HERS. A subjectless remark about the world (`下雨了`, `今天真热`) is labelled `给你做的`, because
 * nobody in it is the doer and the only other person in the conversation is her; so is a plan sentence that continues
 * his own without repeating its subject (`我今天去镇上办事。晚上回来。` - the second sentence has no `我`). The cost is
 * a small, reversible action taken on something he only mentioned: the block never adds an object he did not say, so no
 * objective is invented, and the surface's own conduct makes her decide and lets the player redirect her. The opposite
 * error is the measured one: a job he did give her, read as his own business, and a whole in-game day spent in Town,
 * the SeedShop, Backwoods, Mountain and the Mine while the water she was told to find went unfished. Carrying a subject
 * across sentence ends would close the first case and reopen the second, which is why it is not done.
 * </p>
 *
 * <p>
 * The length of the false-positive tail is bounded by the one test that is NOT about grammar: `asksForWork`. When no
 * utterance is hers at all, the block says so in a sentence of its own (`上面没有给你做的事`), so "he asked me for
 * nothing" is a statement she can read rather than an absence she has to notice - the honest answer to a note that only
 * tells her about his day.
 * </p>
 */

/** The two readings one utterance of the note can have. */
const PLAYER_NOTE_ADDRESS = Object.freeze({
  /** He is telling her about himself; the sentence asks nothing of her. */
  hisOwn: "his_own",
  /** The words are for her to do or to answer; whoever is to act in them, it is not him. */
  toCompanion: "to_companion",
} as const);

type PlayerNoteAddress = (typeof PLAYER_NOTE_ADDRESS)[keyof typeof PLAYER_NOTE_ADDRESS];

/** One utterance of the note: his exact characters, and whose it is. */
type PlayerNoteUtterance = Readonly<{ text: string; address: PlayerNoteAddress }>;

type PlayerNoteReading = Readonly<{
  /** In his order. `map(text).join("")` is his note, character for character. */
  utterances: readonly PlayerNoteUtterance[];
  /** Whether any part of the note is hers - i.e. whether he asked her for anything at all. */
  asksForWork: boolean;
}>;

/** The characters that end an utterance, and stay with it. */
const SENTENCE_ENDS: ReadonlySet<string> = new Set(["。", "！", "？", "；", "!", "?", ";"]);

/**
 * A request frame: a verb whose object is him, so the request is his even though `我` is in the sentence.
 *
 * The English half is here because a voice note can arrive in `en-US` (`PlayerInput.locale`) while the brief stays
 * Chinese - without it every English note would be labelled entirely hers, which is the pre-fix reading.
 */
const REQUEST_FRAME = /(?:帮|给|替|陪|带|教|让|告诉)我|\b(?:for|help|tell|give|with|join)\s+me\b/iu;

/** A subject that makes him the doer: `我`/`俺`/`咱`, each except when it opens `我们`/`咱们`/`俺们`. */
const EXCLUSIVE_FIRST_PERSON = /我(?!们)|俺(?!们)|咱(?!们)|\b(?:I|my|myself)\b/iu;

/**
 * The note as utterances, in his order, joining back to his exact text.
 *
 * The trailing whitespace of a sentence end belongs to the utterance it follows, so nothing is dropped between them. A
 * fragment with no sentence end (`找片水`) is its own utterance rather than lost, because a note typed without
 * punctuation is still a note.
 */
function readPlayerNote(text: string): PlayerNoteReading {
  const utterances: PlayerNoteUtterance[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!SENTENCE_ENDS.has(text.charAt(index))) continue;
    index = skipWhitespace(text, index + 1) - 1;
    utterances.push({ text: text.slice(start, index + 1), address: addressOf(text.slice(start, index + 1)) });
    start = index + 1;
  }
  if (start < text.length) utterances.push({ text: text.slice(start), address: addressOf(text.slice(start)) });
  return Object.freeze({
    utterances: Object.freeze(utterances),
    asksForWork: utterances.some((utterance) => utterance.address === PLAYER_NOTE_ADDRESS.toCompanion),
  });
}

function skipWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/u.test(text.charAt(index))) index += 1;
  return index;
}

function addressOf(utterance: string): PlayerNoteAddress {
  if (REQUEST_FRAME.test(utterance)) return PLAYER_NOTE_ADDRESS.toCompanion;
  return EXCLUSIVE_FIRST_PERSON.test(utterance) ? PLAYER_NOTE_ADDRESS.hisOwn : PLAYER_NOTE_ADDRESS.toCompanion;
}

/** What the block says before the labels: whose words these are, and that the labels are not part of them. */
const NOTE_VERBATIM_LINE = "他跟你说的，一个字没改：";

/** One label per class, on the one axis the two differ by: is this for her to do, or is it about him. */
const ADDRESS_LABEL: Readonly<Record<PlayerNoteAddress, string>> = Object.freeze({
  [PLAYER_NOTE_ADDRESS.hisOwn]: "他的事，不是给你做的：",
  [PLAYER_NOTE_ADDRESS.toCompanion]: "给你做的：",
});

/** What the block says when no utterance is hers: the absence, stated rather than left to be noticed. */
const NO_WORK_LINE = "上面没有给你做的事：这些是他自己的事，你不用动手。";

/**
 * The body of `<player-note>`: his words in his order, each run under the label it belongs to.
 *
 * NOTHING IS PARAPHRASED. Every character of a note appears exactly once, inside `「」`, in the order he wrote it; the
 * labels are the only added text, and they say which side of one line each run falls on. A run of consecutive
 * utterances with the same reading shares one label rather than repeating it - his words are the content, not the
 * headings.
 */
export function playerNoteLines(notes: readonly string[]): readonly string[] {
  const lines: string[] = [];
  const texts = notes.map((note) => note.trim()).filter((note) => note !== "");
  if (texts.length === 0) return lines;
  lines.push(NOTE_VERBATIM_LINE);
  for (const text of texts) {
    const reading = readPlayerNote(text);
    for (const group of groupsOf(reading.utterances))
      lines.push(
        `${ADDRESS_LABEL[group.address]}${group.uttered.map((utterance) => `「${utterance.trimEnd()}」`).join("")}`,
      );
    if (!reading.asksForWork) lines.push(NO_WORK_LINE);
  }
  return lines;
}

type PlayerNoteGroup = Readonly<{
  address: PlayerNoteAddress;
  uttered: readonly string[];
}>;

/** Consecutive utterances with the same reading, in his order. */
function groupsOf(utterances: readonly PlayerNoteUtterance[]): readonly PlayerNoteGroup[] {
  const groups: PlayerNoteGroup[] = [];
  for (const utterance of utterances) {
    const last = groups.at(-1);
    if (last !== undefined && last.address === utterance.address) {
      groups[groups.length - 1] = { address: last.address, uttered: [...last.uttered, utterance.text] };
      continue;
    }
    groups.push({ address: utterance.address, uttered: [utterance.text] });
  }
  return groups;
}
