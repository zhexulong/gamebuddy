import assert from "node:assert/strict";
import test from "node:test";

import { STARDEW_ACTION_TOOL_NAMES } from "./action-registry.js";
import {
  buildChatCompanionSystemPrompt,
  buildGameCompanionSystemPrompt,
  COMPANION_ACTION_SYNTAX,
} from "./identity-profile.js";
import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";

/**
 * A surface's own protocol must stay on that surface.
 *
 * The measured defect: the shipped card carried "打字里不用星号或括号写风景…交给游戏里那个身体
 * (stardew_express_emote / stardew_face_direction)" as a CHARACTER bullet, so the compiled Chat
 * prompt received the Game surface's channel rule verbatim - and a prohibition that speaks last is
 * the rule. A reporter measured `em.message-action` at 0 on Web Chat: the companion had stopped
 * writing the one syntax the Chat renderer draws.
 *
 * What is asserted here is the NEGATIVE, and its population is derived rather than listed:
 *
 *   - the mounted Game tool names come from `STARDEW_ACTION_TOOL_NAMES`, so a newly published
 *     action is covered by today's rule and a renamed one cannot slip past it;
 *   - the "channel rule" lines come from the COMPILED Game prompt, so a reworded rule is still
 *     covered and a deleted one fails the first test instead of passing this one quietly;
 *   - the stage-direction mark comes from `COMPANION_ACTION_SYNTAX`, the one constant that names
 *     the syntax, so a change of syntax follows.
 *
 * The profile is the SHIPPED card (`DEFAULT_COMPANION_PRESET`), not the bare default profile: this
 * defect was card-borne, and a gate compiled from an empty persona could not have seen it.
 */

const LOCALE = "zh-CN";

/** The compiled prompts, from the product's own builders, over the companion that actually ships. */
const CHAT_PROMPT = buildChatCompanionSystemPrompt(DEFAULT_COMPANION_PRESET.profile, LOCALE);
const GAME_PROMPT = buildGameCompanionSystemPrompt(DEFAULT_COMPANION_PRESET.profile, LOCALE);

/** Every mounted Game tool name: the registry's values, which are the names an Agent can call. */
const MOUNTED_GAME_TOOL_NAMES: readonly string[] = Object.freeze([
  ...new Set(Object.values(STARDEW_ACTION_TOOL_NAMES)),
]);

/**
 * The mark `COMPANION_ACTION_SYNTAX` delimits a stage direction with, read out of the constant.
 *
 * The syntax is `*a brief gesture*`, so the mark is whatever character wraps its example. Reading
 * it rather than writing `*` here is what keeps this gate on the day the syntax changes.
 */
const STAGE_DIRECTION_MARK: string = COMPANION_ACTION_SYNTAX.slice(0, 1);

/** The mounted Game tool names one text mentions. */
function toolNamesIn(text: string): readonly string[] {
  return MOUNTED_GAME_TOOL_NAMES.filter((name) => text.includes(name));
}

/**
 * A compiled prompt's sentences.
 *
 * Sentence granularity is the unit a rule travels in, and it is also the only granularity these two
 * blocks share: the Game conduct is joined with newlines and the Chat block with spaces, so a
 * line-for-line comparison could never match and would report clean forever. A rule copied from one
 * surface to the other arrives as a sentence either way.
 */
function sentences(text: string): readonly string[] {
  const out: string[] = [];
  for (const line of text.split("\n"))
    for (const piece of line.match(/[^。！？.!?]+[。！？.!?]*/gu) ?? []) {
      const trimmed = piece.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  return out;
}

/**
 * The compiled Game prompt's channel-protocol sentences: the ones naming a mounted Game tool, and
 * the ones speaking about the stage-direction mark.
 */
const GAME_CHANNEL_SENTENCES: readonly string[] = Object.freeze(
  sentences(GAME_PROMPT).filter(
    (sentence) => toolNamesIn(sentence).length > 0 || sentence.includes(STAGE_DIRECTION_MARK),
  ),
);

test("the Game prompt states its channel protocol, so there is a rule to isolate", () => {
  // The population this gate isolates is non-empty, and it is derived rather than listed. If the
  // Game prompt stops naming its body-language channel the game-side rule disappears, and every
  // assertion below would then guard nothing while staying green - which is exactly how an
  // isolation gate stops working.
  const named = toolNamesIn(GAME_PROMPT);
  assert.ok(
    named.length > 0,
    `the Game prompt must name at least one of the ${MOUNTED_GAME_TOOL_NAMES.length} mounted Game tools, or there is no surface rule to isolate`,
  );
  assert.ok(
    GAME_CHANNEL_SENTENCES.some((sentence) => toolNamesIn(sentence).length > 0),
    `the mounted names ${named.join(", ")} must appear inside a rule sentence, not as a stray token`,
  );
  assert.ok(
    GAME_CHANNEL_SENTENCES.some((sentence) => sentence.includes(STAGE_DIRECTION_MARK)),
    `the Game prompt must also state what happens to a ${STAGE_DIRECTION_MARK}-delimited beat, or that half of the protocol is unheld`,
  );
});

test("no mounted Game tool name reaches the Chat prompt", () => {
  const leaked = toolNamesIn(CHAT_PROMPT);
  assert.deepEqual(
    leaked,
    [],
    `the Chat prompt names Game-only tool${leaked.length === 1 ? "" : "s"} ${leaked.join(", ")}: a Chat mount cannot call ${
      leaked.length === 1 ? "it" : "them"
    }, so the instruction sends the companion's body language nowhere and competes with the syntax the Chat renderer draws`,
  );
});

test("no Game channel-rule sentence reaches the Chat prompt", () => {
  // The phrasing half, and the half that does not depend on a tool name being present: the Game
  // conduct also states what happens to a bracketed or asterisked beat, and a card that scoped THAT
  // sentence to the wrong surface is the same defect with a different subject.
  const chatSentences = new Set(sentences(CHAT_PROMPT));
  const leaked = GAME_CHANNEL_SENTENCES.filter((sentence) => chatSentences.has(sentence));
  assert.deepEqual(
    leaked,
    [],
    `the Chat prompt carries ${leaked.length} Game-surface channel rule sentence(s) verbatim: ${JSON.stringify(leaked)}`,
  );
});

test("the Chat prompt still names the one action syntax its renderer draws", () => {
  // The other direction, and the reason the defect was visible at all: Chat draws `<em>` for the
  // single-asterisk form and nothing else, so a Chat prompt that loses this sentence loses the
  // action beat. Measured consequence of the leak: `em.message-action` at 0.
  assert.ok(
    CHAT_PROMPT.includes(COMPANION_ACTION_SYNTAX),
    "the Chat prompt must still name the asterisk syntax the Chat renderer draws",
  );
  assert.match(CHAT_PROMPT, /draws that asterisk form as the action beat/u);
});
