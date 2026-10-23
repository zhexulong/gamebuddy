import assert from "node:assert/strict";
import test from "node:test";

import { GAME_DELIVERY_PACING } from "./companion-delivery-pacing.js";
import { dehydrateCompanionSpeech, isEmptyAfterDehydration } from "./companion-speech-dehydration.js";
import { DEFAULT_IDENTITY_PROFILE, renderIdentityProfile } from "./identity-profile.js";
import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";

/**
 * The card has to teach a REGISTER, and it has to be the card that SPEAKS.
 *
 * 1. THE CARD THAT SPEAKS IS THE PRESET, NOT THE FALLBACK.
 *    `DEFAULT_IDENTITY_PROFILE` is the placeholder an unseeded root renders
 *    (`runtime-core.internal.ts:865`, `readOrCreateIdentityProfile`). A live run
 *    and a fresh player root both read the reviewed preset instead: the harness
 *    compiles `assets/tavern/presets/default-companion/card.json` through the
 *    product's own decoder (`tools/live-run/core/persona.mjs`, `provisionLiveRunPersona`),
 *    and `tavern/default-companion-seed.ts` installs the same card's compiled
 *    form. The previous version of this file asserted eight cases against the
 *    FALLBACK, went green, and certified nothing: every live run on disk mounted
 *    `gamebuddy.companion.imported` (琥珀, seven examples, no expression style)
 *    while the guarded text was a card nobody had rendered. So the substance
 *    below is the preset; the fallback keeps one case proving it is not empty,
 *    because it is still what an unseeded root speaks.
 *
 * 2. THE REGISTER IS BOUNDED BY THE DELIVERY SURFACE, NOT BY TASTE.
 *    `companion-delivery-pacing.ts:67` delivers a Game bubble at 80 characters
 *    per piece, and a bubble cannot be retracted. `companion-speech-dehydration.ts:46`
 *    strips `*...*` beats before the bubble is published, and a reply that is
 *    pure stage direction dehydrates to the empty string and is refused. So an
 *    example that only sounds like a person inside a beat teaches a voice the
 *    player never reads.
 *
 * 3. WHAT SEPARATES SPEECH FROM A WORK LOG IS NOT LENGTH.
 *    Measured on 4425 assistant messages that carried text and a tool call: 7%
 *    addressed the player, median 23 characters of procedure. After the card got
 *    examples, live run `6c4f1a6d266468165b5efceb` produced 157/178/144-character
 *    turns: four or five sentences of scene-setting and self-report. Same fault
 *    at the other extreme, and a character count cannot tell the two apart - the
 *    old work log and a good spoken line can both be 23 characters. What
 *    separates them is whether the turn is addressed to someone and whether it
 *    says one thing, so those are the cases, with length only as the surface's
 *    own upper bound.
 */

const presetExamples = DEFAULT_COMPANION_PRESET.profile.examples ?? [];
const fallbackExamples = DEFAULT_IDENTITY_PROFILE.examples ?? [];

/** Terminals that end a spoken sentence. Counting them counts how many things a turn says. */
const SENTENCE_TERMINALS = /[。！？!?…]+/gu;

function deliveredLength(text: string): number {
  return [...dehydrateCompanionSpeech(text)].length;
}

test("the card that renders is the shipped preset, and it carries dialogue examples", () => {
  // Register travels by sample; without examples the model picks its cheapest
  // register, which is what produced the 23-character work log.
  assert.ok(
    presetExamples.length >= 6,
    `expected the preset card to carry at least 6 examples, found ${presetExamples.length}`,
  );
});

test("the fallback profile is not an empty shell, so an unseeded root still has a voice", () => {
  // The fallback is not the product's card, but it is still spoken by a root
  // nothing seeded, so an empty one is a real regression rather than a
  // placeholder nobody sees.
  assert.ok(
    fallbackExamples.length >= 6,
    `expected the fallback to carry at least 6 examples, found ${fallbackExamples.length}`,
  );
  assert.doesNotMatch(DEFAULT_IDENTITY_PROFILE.persona?.expressionStyle ?? "", /^\s*$/u);
});

test("every preset example survives dehydration as speech the player can read", () => {
  // Only the SPEAKABLE part has to carry the turn. An example may not live
  // mostly inside `*...*`, because the bubble strips that: the player would get
  // the leftover fragment, or nothing at all (`isEmptyAfterDehydration`).
  for (const example of presetExamples) {
    const spoken = dehydrateCompanionSpeech(example.companion);
    const spokenLength = [...spoken].length;
    assert.ok(
      spokenLength > 0,
      `example dehydrates to nothing, so the player would never read it: ${JSON.stringify(example.companion)}`,
    );
    assert.ok(
      spokenLength >= [...example.companion].length * 0.6,
      `example puts most of its voice where bubbles strip it: ` +
        `${spokenLength} of ${[...example.companion].length} characters survive: ${JSON.stringify(example.companion)}`,
    );
    assert.equal(isEmptyAfterDehydration(example.companion), false);
  }
});

test("a preset example fits one Game bubble, so the surface never has to cut it", () => {
  const budget = GAME_DELIVERY_PACING.lengthBudget;
  assert.ok(budget !== null, "the game surface must declare a length budget for this case to mean anything");
  for (const example of presetExamples) {
    const delivered = deliveredLength(example.companion);
    assert.ok(
      delivered <= budget.maxChars,
      `example delivers ${delivered} characters, past the ${budget.maxChars}-character bubble: ` +
        JSON.stringify(example.companion),
    );
  }
});

test("a preset example says one thing and stops, instead of stacking bulletins", () => {
  // This is the case that separates speech from the measured prose failure. Live
  // run `6c4f1a6d266468165b5efceb` answered "你好，今天农场怎么样？" with five
  // sentences: an offer to sit down, the kettle, the seeds that sprouted, and how
  // her arms felt from yesterday's digging. Four unrelated bulletins in one turn
  // is not a person talking; it is a status report wearing a voice.
  //
  // `tavern-cards/references/rules.md` names the rule (一句一意: write one
  // judgement and stop rather than appending a restatement of it), and
  // `TavernWeave/skills/rewrite-natural-prose/references/natural-chinese-review.md`
  // names the same fault as 补述. Two terminals is the bound: a greeting plus the
  // one thing, or a question plus its own answer.
  for (const example of presetExamples) {
    const terminals = dehydrateCompanionSpeech(example.companion).match(SENTENCE_TERMINALS)?.length ?? 0;
    assert.ok(terminals <= 2, `example says ${terminals} things in one turn: ${JSON.stringify(example.companion)}`);
  }
});

test("most preset examples involve the player rather than reporting at them", () => {
  // A companion speaks TO someone. Second person or a question does that; a bare
  // statement about the world does not, and a card made only of those produced
  // the narrator voice. A bare imperative ("先去洗把脸吧") also addresses the
  // player but carries no lexical marker this can detect, so this counts only the
  // forms it can see and the threshold is a FLOOR, not a ceiling.
  const addressed = presetExamples.filter((e) => /[你咱]/u.test(e.companion) || /[？?]/u.test(e.companion));
  assert.ok(
    addressed.length >= Math.ceil(presetExamples.length * 0.6),
    `${addressed.length} of ${presetExamples.length} examples involve the player`,
  );
});

test("no preset example voices the turn inside a stage direction", () => {
  // `companion-speech-dehydration.ts:46` removes `*...*`; a full-width
  // parenthesis is performed by the voice channel as an audio tag instead of
  // being spoken. Body language has its own native channel in Game
  // (`stardew_express_emote`, `stardew_face_direction`), which is strictly
  // better than an asterisk the bubble discards - so the samples are pure
  // speech, and a turn is complete without a beat.
  for (const example of presetExamples) {
    assert.ok(
      !/[*（(]/u.test(example.companion),
      `example's own line carries a beat: ${JSON.stringify(example.companion)}`,
    );
  }
});

test("the card's own directive states a register, and states it as speech", () => {
  // ST v2/v3 has no expression-style field, so the decoder never produces one
  // (`st-card-import.ts:379-385`): an imported card's register can only reach
  // the model through `system_prompt`, which lands as `characterVoice` after the
  // Host floor. That is the right owner - the floor governs what she may never
  // do, the card governs how she sounds.
  const directive = DEFAULT_COMPANION_PRESET.profile.characterVoice?.text ?? "";
  assert.notEqual(directive, "", "the shipped card must carry a performance directive");
  assert.match(directive, /说|话|一句/u, "the directive must govern how she sounds, not only what she may not do");
  // The rule that produced the prose has to be gone, not merely softened: it
  // fixed every turn at "1 natural action + 1-2 casual replies", which is a
  // slot count, and a slot count is how 157 characters became the norm.
  assert.doesNotMatch(
    directive,
    /1句自然动作/u,
    "a per-turn slot count makes every reply the same shape; the card must not state one",
  );
});

/**
 * The two clauses of the card's directive whose ORDER is the invariant.
 *
 * Live run `c24ae01fa0afc93c555a47c1` produced the report `早上巡视了一圈，东边那畦防风草都冒芽了，
 * 绿点点一片。` for `今天农场怎么样？` - a correct inventory of the farm, addressed to
 * nobody. The card's directive caused it: item 2 was 动率先于言 (produce action
 * material) and item 3 was 说话冲着人说 (answer the person), and a model reads a
 * numbered list in order, so the earlier instruction won.
 *
 * MaiBot's `AttentionDriftConfig.reaction_style` (`ref/MaiBot/src/config/official_configs.py`)
 * names the order that works: 「偶尔先用短句、吐槽或语气词接住话题，再继续回复」 - react
 * to the person first, then continue. So the guard is that the clause telling her
 * to land on the player's line comes BEFORE the clause telling her how to carry
 * her body. Each marker is one short distinctive phrase of one clause, named here
 * once; a failure names which one drifted so the next edit knows what to fix.
 */
const PERSON_FIRST_CLAUSE = /落到他的句子上|接住人|先接住玩家/u;
const BODY_CHANNEL_CLAUSE = /交给游戏里那个身体|动作交给自己身体/u;

test("the card's directive tells her to answer the person before it tells her how to carry her body", () => {
  const directive = DEFAULT_COMPANION_PRESET.profile.characterVoice?.text ?? "";
  const personAt = directive.search(PERSON_FIRST_CLAUSE);
  const bodyAt = directive.search(BODY_CHANNEL_CLAUSE);
  assert.ok(
    personAt >= 0,
    `the directive no longer names answering the player as its own rule; the guard looks for ` +
      `${PERSON_FIRST_CLAUSE}. The measured failure it protects against is a status question answered ` +
      "with a farm report, and the phrasing moved out from under it.",
  );
  assert.ok(bodyAt >= 0, `the directive no longer names the body channel; the guard looks for ${BODY_CHANNEL_CLAUSE}.`);
  assert.ok(
    personAt < bodyAt,
    `the body clause now precedes the person clause, which is the order that produced the report: ` +
      `answering the player begins at ${personAt}, carrying her body at ${bodyAt}.`,
  );
});

test("the preset's examples reach the system prompt under a labelled dialogue block", () => {
  const rendered = renderIdentityProfile(DEFAULT_COMPANION_PRESET.profile, "zh-CN");
  assert.match(rendered, /\[Dialogue Examples\]/);
  for (const example of presetExamples)
    assert.ok(rendered.includes(example.companion), "every example must be rendered, not silently dropped");
});
