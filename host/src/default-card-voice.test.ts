import assert from "node:assert/strict";
import test from "node:test";

import { MAX_COMPANION_PRESENTATION_TEXT_CHARS } from "./companion-presentation-transport.js";
import { dehydrateCompanionSpeech, isEmptyAfterDehydration } from "./companion-speech-dehydration.js";
import { buildGameCompanionSystemPrompt } from "./game-surface-prompt-floor.js";
import { DEFAULT_IDENTITY_PROFILE, validateIdentityProfile } from "./identity-profile.js";
import { buildChatCompanionSystemPrompt, renderIdentityProfile } from "./companion-prompt-assembly.js";
import { CHAT_SURFACE_SKIP_SIGNATURE, COMPANION_ACTION_SYNTAX } from "./chat-surface-block.js";
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

test("a preset example fits what the transport carries, so the delivery never has to cut one", () => {
  // The bound is the wire's own (`companion-presentation-transport.ts`), not the bubble's: the bubble draws two lines and
  // clamps itself with `…` on screen, and the chat line keeps the whole text. This case used to hold the examples to an
  // 80-character "bubble" that described neither surface. What it still protects is that a recorded example can be
  // DELIVERED at all - an example past the transport's ceiling would be refused by the wire and reach nobody.
  const maxChars = MAX_COMPANION_PRESENTATION_TEXT_CHARS;
  for (const example of presetExamples) {
    const delivered = deliveredLength(example.companion);
    assert.ok(
      delivered <= maxChars,
      `example delivers ${delivered} characters, past the ${maxChars} the presentation transport carries: ` +
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

test("the card's directive explicitly rejects itinerary reporting and state-machine logging", () => {
  const directive = DEFAULT_COMPANION_PRESET.profile.characterVoice?.text ?? "";
  assert.match(
    directive,
    /拒绝.*(汇报|报备)|对讲机/u,
    "the card directive must explicitly forbid walkie-talkie telemetry and itinerary reporting",
  );
  assert.match(
    directive,
    /去班味|冷幽默/u,
    "the card directive must demand the companion's actual persona tone (post-workplace dry humour)",
  );
  assert.doesNotMatch(
    directive,
    /要：「啊？行，我过去。」/u,
    "the directive must not offer flat robotic compliance as a positive example",
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

/**
 * One `【…】` section heading of the card's directive, as the card writes them: at the start of a
 * line. A name in brackets inside a sentence (`…伙伴【琥珀】`) is not a section, and counting it
 * here would measure the order against the preamble instead of the card's own craft sections.
 */
const SECTION_HEADING = /^【[^】]+】/gmu;

test("the card's directive reaches the person before it reaches any later craft rule", () => {
  // The invariant is ORDER, and the clause it was originally ordered against - "the body
  // goes to the game in stardew_express_emote / stardew_face_direction" - was deleted
  // with the two surface-bound clauses of this bullet, because the Host's own Game floor
  // states that channel (identity-profile.ts, GAME_SURFACE_INTERACTION_CONDUCT) and the
  // Chat surface draws the asterisk instead. The force is kept rather than dropped: the
  // clause that made her answer the person has to stay the card's FIRST craft instruction,
  // which is the position that beat the measured farm report. Its neighbours are derived
  // from the card's own headings, so a new section that drifts in front of it fails here.
  const directive = DEFAULT_COMPANION_PRESET.profile.characterVoice?.text ?? "";
  const personAt = directive.search(PERSON_FIRST_CLAUSE);
  assert.ok(
    personAt >= 0,
    `the directive no longer names answering the player as its own rule; the guard looks for ` +
      `${PERSON_FIRST_CLAUSE}. The measured failure it protects against is a status question answered ` +
      "with a farm report, and the phrasing moved out from under it.",
  );
  const headings = [...directive.matchAll(SECTION_HEADING)].map((match) => ({ at: match.index ?? 0, text: match[0] }));
  const [, firstLater] = headings;
  assert.ok(firstLater !== undefined, "the directive's sections are what this order is measured against");
  assert.ok(
    personAt < firstLater.at,
    `a later section (${firstLater.text} at ${firstLater.at}) now opens before the clause that answers ` +
      `the player (at ${personAt}); that is the order that produced the report.`,
  );
});

test("the game's body channel stays on the Game surface, out of the Chat prompt the card also feeds", () => {
  // Measured defect: the shipped card's directive named `stardew_express_emote` and
  // `stardew_face_direction` and forbade asterisk beats, and the directive renders into BOTH
  // surfaces. On Chat no such tool is mounted and the asterisk IS the beat the renderer draws,
  // so the card's clause was false there - while on Game the Host's own conduct already states
  // both facts, which is why the card can lose them without the Game losing anything.
  const profile = DEFAULT_COMPANION_PRESET.profile;
  const chat = buildChatCompanionSystemPrompt(profile, "zh-CN");
  const game = buildGameCompanionSystemPrompt(profile, "zh-CN");
  const EMOTE_TOOLS = /stardew_express_emote|stardew_face_direction/u;
  assert.doesNotMatch(chat, EMOTE_TOOLS, "the Chat prompt tells her to move a body this surface does not mount");
  // The Game body channel is two MOUNTED tools, and the conduct names them: the registry declares these two actions
  // expression-only, so a plan surface keeps their tools and drops their plan steps instead.
  const BODY_IS_A_MOUNTED_TOOL = /Body language has its own tool/u;
  assert.match(game, BODY_IS_A_MOUNTED_TOOL, "the Game prompt must keep the body channel it really has");
  assert.match(game, EMOTE_TOOLS, "the Game prompt must name the tools a Game session mounts for the body");
  assert.doesNotMatch(
    game,
    /Body language is an action in the plan you submit/u,
    "a gesture is one step by nature, so the plan is not where the prompt sends it",
  );
  // The Game conduct is Host-owned, so removing the card's duplicate cannot have emptied it.
  assert.match(game, /Write no bracketed stage direction at all/u);
});

/**
 * The three clauses the Chat block used to answer an authored "no asterisks" with, quoted verbatim from the version
 * `858f0c87` replaced (`git show 858f0c87^:host/src/identity-profile.ts`), not paraphrased.
 *
 * A CLOSED list, because the register has to be refused by name: "just one more reminder" is how a form rule comes
 * back wearing a channel's clothes.
 */
const RETIRED_ASTERISK_OVERRIDE: readonly string[] = Object.freeze([
  "even if an authored voice forbids it",
  "the surface decides what it draws, not the voice",
  "does not stop that asterisk from drawing as the beat",
]);

test("an authored voice that forbids asterisks keeps the style question, and the surface keeps only the channel fact", () => {
  // The ST card format has no surface-scoped field, so a third-party card's "no asterisks" lands in the Chat prompt
  // verbatim, after this block. The question is who decides.
  //
  // It used to be the surface, by overruling the card. Two reasons that was wrong, and both are checked here rather
  // than asserted in a comment: it is a FORM rule wearing a CHANNEL's clothes - how often she reaches for a beat belongs
  // to the card, by the same ruling that put the turn's shape there - and NOTHING in the pipeline needs the marker to
  // appear, so there is no product need to state beside the card's style. The channel keeps only what it can honestly
  // claim.
  const forbiddingText = "绝不写星号动作，也不要在文字里做任何动作描写。";
  const forbidding = validateIdentityProfile({
    ...DEFAULT_COMPANION_PRESET.profile,
    characterVoice: { text: forbiddingText, source: "card" },
  });
  const chat = buildChatCompanionSystemPrompt(forbidding, "zh-CN");
  assert.ok(chat.includes(forbiddingText), "the authored directive still reaches Chat verbatim");

  // The channel fact survives, so a beat she DOES write still draws: the syntax is named - derived from the constant the
  // Chat block exports rather than transcribed here - and the renderer's treatment with it. This is the part a "remove
  // the override" change must not take with it.
  assert.ok(chat.includes(COMPANION_ACTION_SYNTAX), "the surface still names the syntax it draws");
  assert.match(chat, /draws that asterisk form as the action beat/u);

  // The override is gone, in all three of its clauses.
  for (const clause of RETIRED_ASTERISK_OVERRIDE)
    assert.equal(
      chat.includes(clause),
      false,
      `the Chat block still overrules the authored voice: ${JSON.stringify(clause)}`,
    );

  // And the frequency is the CARD's, so the block does not state it at all: a permission about how much she speaks is
  // ②'s claim, and that sentence was the last speech licence the Chat floor carried. Refused by name, the way the
  // override clauses above are, because "just one more reminder of who decides" is how the licence comes back.
  assert.doesNotMatch(
    chat,
    /is your voice's call|How often you reach for one/u,
    "the block still claims a say in how often she reaches for a beat",
  );
  // The sentence Magic Context skips on is one the block actually carries, stated exactly once: two spellings is how the
  // formula grew back the first time.
  assert.equal(
    chat.split(CHAT_SURFACE_SKIP_SIGNATURE).length - 1,
    1,
    "the signature Magic Context skips on is stated exactly once",
  );

  // WHY the card wins, executed rather than described: no consumer needs the marker. The bubble strips a beat when one
  // is written and passes asterisk-free text through unchanged, so an authored ban on beats costs the pipeline nothing -
  // and a prompt sentence overruling the card buys nothing either.
  assert.equal(dehydrateCompanionSpeech("我把锄头扛上肩。"), "我把锄头扛上肩。");
  assert.equal(dehydrateCompanionSpeech("*扛起锄头* 走了。").includes("*"), false);
});

test("the preset's examples reach the system prompt under a labelled dialogue block", () => {
  const rendered = renderIdentityProfile(DEFAULT_COMPANION_PRESET.profile, "zh-CN");
  assert.match(rendered, /\[Dialogue Examples\]/);
  for (const example of presetExamples)
    assert.ok(rendered.includes(example.companion), "every example must be rendered, not silently dropped");
});
