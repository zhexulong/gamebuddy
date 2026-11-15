import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildGameCompanionSystemPrompt } from "./game-surface-prompt-floor.js";
import {
  DEFAULT_IDENTITY_PROFILE,
  buildChatCompanionSystemPrompt,
  companionFrameworkLines,
} from "./identity-profile.js";

/**
 * THE SHARED FRAMEWORK STATES THE WRAPPER, AND A ROLEPLAY RULE IS THE PRESET'S.
 *
 * <p>
 * WHAT THE DEFECT IS. `companionFrameworkLines` is the immutable head of both surfaces' Tier-1 prefix - it renders
 * before the surface block, before the identity block, and before the card's own directive - so a behaviour rule
 * written there beats the preset the player actually mounted. Five sentences were written there anyway: how long a turn
 * is, whose voice the turn may use, the reply's pacing, the fourth wall, and the assistant register. SillyTavern's own
 * division puts every one of those in the PRESET (Main Prompt: "global roleplay rules - tone, structure, behavior";
 * Post-History Instructions: reply length and pacing), so the framework was carrying a second authority over the
 * player's own preset, and the one that spoke first.
 * </p>
 *
 * <p>
 * THE PROPERTY, and why it is not a phrase list. The population is the framework's OWN shared sentences, read from the
 * function that builds them rather than transcribed here, so a sentence added tomorrow is examined without an edit in
 * this file. The property is a KIND, not a wording: a sentence that constrains tone, length, pacing, roleplay scope or
 * the fourth wall belongs to the preset, and the shapes below are the kinds that kind appears in. A rule reworded into
 * words no phrase list anticipates still matches a shape, because the shape names what the rule DOES.
 * </p>
 *
 * <p>
 * THE OTHER HALF: A DELETION IS ONLY A MOVE IF SOMEBODY STILL SAYS IT. The five sentences this unit removed are listed
 * below with the owner that states each one, and each owner is read from the product's own text - the persona corpus
 * (the card's `system_prompt`/`post_history_instructions` and every preset's `prompts[].content`) or the Chat surface
 * block. A rule that leaves the framework and is stated nowhere reds as
 * `retired_roleplay_rule_without_owner:<slug>`, which is the failure a bare deletion produces: the rule silently stops
 * existing, and the next run measures a companion nobody told. The corpus is the files a session mounts, and a zero
 * population there is blocked rather than passed.
 * </p>
 *
 * <p>
 * WHAT THIS GATE DOES NOT READ, stated so the next reader does not mistake its boundary for the whole authority split:
 * the Game floor's own rules (its class table and `conversational-stance-gate.test.ts` hold those), and the Chat surface
 * block's own sentences - which now legitimately carry one surface-scoped roleplay rule, because it is true on Chat and
 * false on Game. What this gate holds is the SHARED list: the text both surfaces read before their own.
 * </p>
 */

const REPOSITORY_ROOT = (() => {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(directory, "assets", "tavern", "presets"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("repository_root_not_found");
    directory = parent;
  }
})();

const PRESETS_DIRECTORY = "assets/tavern/presets";
const DEFAULT_CARD = join(PRESETS_DIRECTORY, "default-companion", "card.json");

/** The language this gate renders the framework with. Any locale works: no shape below reads it. */
const LANGUAGE = "en-US";

/** One kind of roleplay rule, with the property it protects - so a failure says what to do, not which string matched. */
type RoleplayShape = Readonly<{ id: string; property: string; pattern: RegExp }>;

/**
 * The shapes a roleplay rule appears in. Each is a KIND OF CONSTRAINT, never a sentence: the five sentences this unit
 * removed match five different ones, and a rule written tomorrow in new words matches the one whose property it states.
 */
const ROLEPLAY_SHAPES: readonly RoleplayShape[] = Object.freeze([
  Object.freeze({
    id: "length",
    property:
      "how long a turn is - a cap, a floor, a count of sentences, paragraphs, lines or words - is the preset's reply-length instruction, which SillyTavern's own division puts in the Post-History Instructions",
    pattern:
      /\b(long|short|brief|terse|concise|verbose)\b[^.!?]*\b(speech|speeches|essay|essays|paragraph|paragraphs|monologue|sentence|sentences|word|words|line|lines|reply|replies|turn|turns)\b/iu,
  }),
  Object.freeze({
    id: "pacing",
    property: "the reply's pacing or energy - how fast, how much at once, whose lead sets it - is the preset's",
    pattern: /\b(pace|pacing|energ(?:y|ies)|tempo|rhythm)\b/iu,
  }),
  Object.freeze({
    id: "roleplay-scope",
    property:
      "whose voice the turn may use - whether she may write the player's reactions, choices or words - is the preset's roleplay scope",
    pattern:
      /\bspeak (?:solely|only) for yourself\b|\bonly your own (?:words|voice)\b|\b(?:leave|leaves|leaving|keep)\b[^.!?]*\bthe player'?s? (?:reactions|choices|voice|words)\b|\bdo not (?:write|speak|act|talk) for (?:the player|your partner)\b/iu,
  }),
  Object.freeze({
    id: "fourth-wall",
    property:
      "the fourth wall - whether she may tell the player this is a game, a fiction or a roleplay, or break character - is the preset's frame, and it is false on any surface whose preset names the game",
    pattern:
      /\bthis is a (?:game|fiction|roleplay|role-play|story)\b|\b(?:remind|telling|tell)\b[^.!?]*\b(?:game|fiction|roleplay|role-play|story)\b|\bbreak the (?:fiction|fourth wall|character)\b|\bstay in character\b/iu,
  }),
  Object.freeze({
    id: "meta-machinery",
    property:
      "the machinery behind the turn - prompts, instructions, models, systems, how she works - is the same fourth wall, stated about the apparatus instead of the frame",
    pattern: /\b(?:prompts?|instructions?|models?|systems?)\b|\bhow you work\b/iu,
  }),
  Object.freeze({
    id: "helper-register",
    property:
      "the assistant or customer-service register - the opening offer of help, the closing offer of more - is the preset's tone",
    pattern:
      /\bcustomer[- ]service\b|\bhow can i help\b|\bhappy to help\b|\bi'?m here to (?:help|assist)\b|\bnot a helper\b|\bas an assistant\b|\blet me know if you need\b/iu,
  }),
]);

/** The sentence as a failure code names it: a stable slug, because the sentence's own words will be reworded. */
function slugOf(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .slice(0, 6)
    .join("-");
}

/**
 * The gate's reading: every sentence that states one of the shapes above, as the failure code that names it.
 *
 * Exported so the falsifier can drive the SAME classifier with text the product does not carry - a gate whose red case
 * runs a different code path has been shown able to fail for a reason the product will never produce.
 */
export function roleplayRuleFindings(sentences: readonly string[]): readonly string[] {
  const findings: string[] = [];
  for (const sentence of sentences) {
    const shape = ROLEPLAY_SHAPES.find((candidate) => candidate.pattern.test(sentence));
    if (shape !== undefined) findings.push(`framework_states_a_roleplay_rule:${slugOf(sentence)}`);
  }
  return findings;
}

/** The framework's shared sentences: the population, derived from the builder both surfaces call. */
const FRAMEWORK_SENTENCES: readonly string[] = companionFrameworkLines(DEFAULT_IDENTITY_PROFILE, LANGUAGE).filter(
  (line) => line.trim().length > 0,
);

/** One retired sentence, and every owner whose own text may carry it. */
type RetiredRule = Readonly<{
  slug: string;
  sentence: string;
  homes: readonly Readonly<{ source: string; pattern: RegExp }>[];
}>;

/** Every owner's own text, read from the product, keyed by the name a failure prints. */
function ownerTexts(): readonly Readonly<{ source: string; where: string; text: string }>[] {
  const texts: Readonly<{ source: string; where: string; text: string }>[] = [];
  const PERSONA = "persona corpus";
  const directory = join(REPOSITORY_ROOT, PRESETS_DIRECTORY);
  const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
  const card = read(join(REPOSITORY_ROOT, DEFAULT_CARD)) as { data?: Record<string, unknown> };
  const directive = card.data ?? {};
  // The card's own directive is the ONE persona document both surfaces mount: `system_prompt` travels as the profile's
  // `characterVoice`, and `post_history_instructions` as the Chat tail. Everything the card says about how she speaks
  // is in these two fields.
  texts.push(
    Object.freeze({
      source: PERSONA,
      where: `${DEFAULT_CARD} data.system_prompt`,
      text: `${String(directive.system_prompt ?? "")}`,
    }),
  );
  texts.push(
    Object.freeze({
      source: PERSONA,
      where: `${DEFAULT_CARD} data.post_history_instructions`,
      text: `${String(directive.post_history_instructions ?? "")}`,
    }),
  );
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const document = read(join(directory, name)) as { prompts?: readonly { content?: unknown }[] };
    if (!Array.isArray(document.prompts)) continue;
    const content = document.prompts
      .map((prompt) => (typeof prompt.content === "string" ? prompt.content : ""))
      .filter((text) => text.length > 0)
      .join("\n");
    texts.push(
      Object.freeze({ source: PERSONA, where: `${PRESETS_DIRECTORY}/${name} prompts[].content`, text: content }),
    );
  }
  return Object.freeze(texts);
}

/**
 * The five sentences this unit took out of the framework, verbatim, and the owner that states each one now.
 *
 * The list is CLOSED on purpose: it is the ledger of what left, so the property "every rule that leaves has an owner"
 * is checkable at all. A new deletion adds a row here, which is the moment to name where it went.
 */
const RETIRED_RULES: readonly RetiredRule[] = Object.freeze([
  Object.freeze({
    slug: "do-not-write-long-speeches-or-essays",
    sentence:
      "Do not write long speeches or essays; match the player's energy and pacing, and let their lead set how much you say.",
    homes: Object.freeze([Object.freeze({ source: "persona corpus", pattern: /说清就停|说完就停|50~100\s*字/u })]),
  }),
  Object.freeze({
    slug: "speak-solely-for-yourself",
    sentence: "Speak solely for yourself, leaving the player's reactions, choices, and voice entirely in their hands.",
    homes: Object.freeze([Object.freeze({ source: "persona corpus", pattern: /留给他自己|只说自己/u })]),
  }),
  Object.freeze({
    slug: "do-not-remind-the-player-this-is-a-game",
    sentence: "Do not remind the player this is a game, fiction, or roleplay.",
    homes: Object.freeze([
      Object.freeze({ source: "Chat surface block", pattern: /not a reader of a story/iu }),
      Object.freeze({ source: "persona corpus", pattern: /创作元词汇|真实物理生活现场/u }),
    ]),
  }),
  Object.freeze({
    slug: "never-fall-back-on-customer-service-phrasing",
    sentence:
      'Never fall back on customer-service phrasing ("How can I help you?", "Let me know if you need anything", "I\'m here to assist"); you are a person in this scene, not a helper.',
    homes: Object.freeze([Object.freeze({ source: "persona corpus", pattern: /保姆腔|服务型助手/u })]),
  }),
  Object.freeze({
    slug: "never-mention-prompts-instructions-models-or-systems",
    sentence: "Never mention prompts, instructions, models, or systems, and never explain how you work.",
    homes: Object.freeze([
      Object.freeze({ source: "persona corpus", pattern: /不提提示词|不提.{0,6}(指令|模型|系统)/u }),
    ]),
  }),
]);

test("the shared framework states the wrapper and no roleplay rule", () => {
  // The population is non-empty, or this gate would agree with itself.
  assert.ok(
    FRAMEWORK_SENTENCES.length > 0,
    "the shared framework rendered no sentence, so there is nothing to classify and no verdict to give",
  );
  const findings = roleplayRuleFindings(FRAMEWORK_SENTENCES);
  process.stdout.write(
    `sentences examined ${String(FRAMEWORK_SENTENCES.length)} · roleplay rules ${String(findings.length)}\n`,
  );
  assert.deepEqual(
    findings,
    [],
    [
      `${String(findings.length)} of ${String(FRAMEWORK_SENTENCES.length)} shared framework sentences state a roleplay rule:`,
      ...findings.map((finding) => {
        const sentence =
          FRAMEWORK_SENTENCES.find(
            (candidate) => `framework_states_a_roleplay_rule:${slugOf(candidate)}` === finding,
          ) ?? "";
        const shape = ROLEPLAY_SHAPES.find((candidate) => candidate.pattern.test(sentence));
        return `  ${finding}\n    "${sentence}"\n    ${shape?.property ?? ""}\n    -> the preset owns this; delete it here (or move it to the preset that states it)`;
      }),
    ].join("\n"),
  );
});

test("the classifier reds a roleplay rule of each shape, and passes the wrapper's own sentences", () => {
  // THE FALSIFIER. It drives the same classifier the gate runs, over text the product no longer carries: the five
  // sentences this unit removed, verbatim, plus one written tomorrow in words none of them uses. If the classifier
  // could not red these, the gate above would be decoration.
  const retired = RETIRED_RULES.map((rule) => rule.sentence);
  assert.deepEqual(
    roleplayRuleFindings(retired),
    RETIRED_RULES.map((rule) => `framework_states_a_roleplay_rule:${slugOf(rule.sentence)}`),
    "each retired sentence must still be classified as a roleplay rule, under the slug its own words derive",
  );
  const tomorrow =
    "Write at most two short paragraphs, and end every reply with a question so your partner has something to answer.";
  assert.deepEqual(
    roleplayRuleFindings([tomorrow]),
    [`framework_states_a_roleplay_rule:${slugOf(tomorrow)}`],
    "a rule reworded tomorrow must match on its shape, not on a phrase this file remembers",
  );
  // And the three sentences that stay are the wrapper: a binding, and the runtime's language. None of them may match.
  assert.deepEqual(
    roleplayRuleFindings(FRAMEWORK_SENTENCES),
    [],
    "the framework's own lines are the wrapper, so the classifier must not call them roleplay rules",
  );
});

test("every roleplay rule the framework gave up is stated by an owner that still mounts it", () => {
  const owners = ownerTexts();
  assert.ok(
    owners.length > 0,
    "no persona document was read, so 'the rule still exists somewhere' would be an unmeasured claim",
  );
  // The Chat surface block is an owner too, and it is read through the product's builder so a reworded rule follows.
  const chatPrompt = buildChatCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE, LANGUAGE);
  const gamePrompt = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE, LANGUAGE);
  const homes: readonly Readonly<{ source: string; where: string; text: string }>[] = [
    ...owners,
    Object.freeze({ source: "Chat surface block", where: "buildChatCompanionSystemPrompt", text: chatPrompt }),
  ];
  const orphaned: string[] = [];
  for (const rule of RETIRED_RULES) {
    const stated = homes.filter((home) =>
      rule.homes.some((candidate) => candidate.source === home.source && candidate.pattern.test(home.text)),
    );
    if (stated.length === 0)
      orphaned.push(
        `retired_roleplay_rule_without_owner:${rule.slug} - "${rule.sentence}" was removed from the framework and no owner states it (looked for it in ${rule.homes.map((home) => home.source).join(", ")})`,
      );
  }
  process.stdout.write(
    `retired rules examined ${String(RETIRED_RULES.length)} · stated by an owner ${String(RETIRED_RULES.length - orphaned.length)}\n`,
  );
  assert.deepEqual(orphaned, []);

  // The fourth wall is the one that is surface-scoped now: it must be TRUE on Chat and ABSENT from Game, whose own
  // preset names the game outright. A rule that reads the same on both surfaces is a shared rule and belongs in
  // neither block - so this pair is what makes the move visible rather than a comment.
  assert.match(chatPrompt, /not a reader of a story/iu, "the Chat surface carries the frame rule now");
  assert.doesNotMatch(
    gamePrompt,
    /not a reader of a story/iu,
    "the Game prompt must not carry the Chat frame rule: its preset says the game",
  );
});
