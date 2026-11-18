import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import {
  buildChatCompanionSystemPrompt,
  COMPANION_FORMAT_TEMPLATES,
  fillTemplate,
  renderIdentityProfile,
} from "./companion-prompt-assembly.js";
import { buildGameCompanionSystemPrompt, GAME_SURFACE_CONDUCT_RULES } from "./game-surface-prompt-floor.js";
import { DEFAULT_IDENTITY_PROFILE, type IdentityProfile, identityProfileMacros } from "./identity-profile.js";
import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";
import { renderMacros } from "./tavern/macro-engine.js";

/**
 * THE FRAMEWORK EMITS NO INPUT AT ALL, AND THIS FILE HOLDS THAT STRUCTURALLY - BESIDE THE TWO LEDGERS THE
 * DELETIONS LEFT.
 *
 * <p>
 * THE DEFECT, IN THREE MOVES. (1) `identity-profile.ts` holds the PROFILE and used to RENDER it: a data module doing
 * the assembly layer's job, which is why it grew sentences that were nobody's to write. (2) The sentences it grew - a
 * binding line, a form line, and a language constraint - sat at the immutable head of the Tier-1 prefix, so whatever
 * was written there outranked the preset the player mounted and the card they imported. (3) The card's own text was
 * wrapped in an invented header (`【角色演出指导…】`), an invented framing sentence ("Your author wrote what follows…") and
 * a closing precedence bound, and the player's addition got the same treatment - a wrapper that trusted neither, and
 * whose "what is stated above wins" formula asked the MODEL to arbitrate two statements that should never have been
 * made twice.
 * </p>
 *
 * <p>
 * WHAT REPLACED IT, and the canon's own words for it. SillyTavern's Format Templates are "string templates used to
 * WRAP the information pulled from World Info and Character Cards" - wrapping, no content - and its precedence is
 * POSITIONAL: Main, then the character's fields, then the world info, then the history, then the post-history
 * instructions. The canon writes no "what is stated above wins" anywhere, because position IS the mechanism. So the
 * identity block renders through one declared table of templates (`COMPANION_FORMAT_TEMPLATES`), the card's directive
 * loads bare where the card's voice belongs, the player's words load under the player-turn template, and the ORDER - the
 * whole of the precedence rule - is declared once, as a list, at the top of `companion-prompt-assembly.ts`.
 * </p>
 *
 * <p>
 * GATE ONE, `framework_emits_an_input_sentence:<sentence>`. Population: every string and template literal in the two
 * modules that may emit prompt text, read out of their sources rather than transcribed here. Property: a FIELD LABEL or a
 * TEMPLATE DELIMITER — and NOTHING ELSE. A string that states a second person, a modal rule, a precedence claim, or runs
 * longer than a label fails. There is no exemption any more: `d50c3017` kept one affirmative closing line per authored
 * block, and this unit deleted it, because a bound stated as a sentence is a promise a later edit breaks without a test
 * noticing while a bound asserted as a position is a test that fails. Where the card's block sits relative to the
 * closing-direction slot is `companion-prompt-assembly.test.ts`'s reading, over the appender the request really goes
 * through. The profile's own stored values (`DEFAULT_IDENTITY_PROFILE`) are counted separately and never classified: a
 * value the framework CARRIES is the card-shaped data a player replaces, not a sentence it WRITES.
 * </p>
 *
 * <p>
 * GATE TWO, `assembled_block_has_no_instruction:<block>`. Population: every line of the assembled identity block, as the
 * product really renders it. Property: each line is explained by exactly one declared template bound to a field value,
 * so a sentence added to the block reds even if it is written in words no classifier anticipates.
 * </p>
 *
 * <p>
 * THE TWO LEDGERS, because a deletion is only a MOVE if somebody still says it. Every sentence this unit removed is
 * listed with the owner that states it now, and each owner is read from the product's own text - the persona corpus
 * (the card's `system_prompt`/`post_history_instructions`, every preset's `prompts[].content`), the surface blocks, or
 * the profile's own rendering. A rule that leaves and is stated nowhere reds as
 * `retired_roleplay_rule_without_owner:<slug>` or `retired_card_restatement_without_owner:<claim>`. Zero population in
 * either ledger is blocked, never passed.
 * </p>
 *
 * <p>
 * WHAT THIS GATE DOES NOT READ, stated so the next reader does not mistake its boundary for the whole authority split:
 * the surface blocks' own sentences (`game-surface-prompt-floor.ts` and `chat-surface-block.ts` hold those, with their
 * own class tables and gates - `input-claim-gate.test.ts` measures them against every other writer), and the preset's
 * own prose, which `presetOverlaps` reports. What this file holds is the FRAMEWORK's own emission and the two ledgers
 * of what left it.
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

/** The language the shared head renders with. Any locale works: no shape below reads it. */
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

/**
 * THE STRINGS THE FRAMEWORK MODULE EMITS: every string and template literal in its source, attributed to the
 * declaration that holds it.
 *
 * The population is the MODULE, not a list of sentences: a line added tomorrow is examined without an edit here.
 * `DEFAULT_IDENTITY_PROFILE`'s own text is counted separately and never classified - those strings are the placeholder
 * profile's FIELDS (the card-shaped data a player replaces), and a value the framework CARRIES is not a sentence the
 * framework WRITES. The split is printed on every run so the count cannot hide a shrinking population.
 */
type SourceString = Readonly<{ where: string; text: string; profileValue: boolean }>;

function declarationPath(node: ts.Node): string {
  const names: string[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) names.push(current.name.text);
    if (ts.isPropertyAssignment(current) && (ts.isIdentifier(current.name) || ts.isStringLiteral(current.name)))
      names.push(current.name.text);
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) names.push(current.name.text);
    current = current.parent;
  }
  return names.slice(0, 2).reverse().join(".");
}

function sourceStrings(file: string): readonly SourceString[] {
  const path = join(REPOSITORY_ROOT, file);
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ESNext, true);
  const strings: SourceString[] = [];
  const visit = (node: ts.Node): void => {
    const isLiteral =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node);
    if (isLiteral) {
      let profileValue = false;
      let moduleSpecifier = false;
      for (let ancestor: ts.Node | undefined = node.parent; ancestor !== undefined; ancestor = ancestor.parent) {
        if (
          ts.isVariableDeclaration(ancestor) &&
          ts.isIdentifier(ancestor.name) &&
          ancestor.name.text === "DEFAULT_IDENTITY_PROFILE"
        )
          profileValue = true;
        if (ts.isImportDeclaration(ancestor) || ts.isExportDeclaration(ancestor)) moduleSpecifier = true;
      }
      // An import specifier is a path this module reads, never text it hands the model.
      if (moduleSpecifier) {
        ts.forEachChild(node, visit);
        return;
      }
      strings.push(
        Object.freeze({
          where: `${file.replace(/^host\/src\//u, "")}:${declarationPath(node)}`,
          text: node.text,
          profileValue,
        }),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return strings;
}

/**
 * A string that instructs, in the shapes an instruction takes.
 *
 * THE PROPERTY IS A KIND, NOT A WORDING: a sentence aimed at her (a second person or an imperative verb), a precedence
 * claim ("wins", "holds", "still", "above"), or a rule with a modal ("never", "always", "must"). A field label and a
 * template delimiter carry none of those, which is why they pass and a sentence cannot.
 */
const INSTRUCTION_KINDS: readonly Readonly<{ id: string; pattern: RegExp }>[] = Object.freeze([
  Object.freeze({
    id: "second-person",
    pattern: /\b(?:you|your|yours|yourself|you're)\b|你|您|自己/iu,
  }),
  Object.freeze({
    id: "modal-rule",
    pattern:
      /\b(?:never|always|must|should|do not|don't|only|unless|instead|follow|keep|avoid)\b|不要|不准|绝不|严禁|一律|始终|必须|不得|千万别/iu,
  }),
  Object.freeze({
    id: "precedence-claim",
    pattern:
      /\b(?:wins?|winning|holds?|above|below|supreme|outranks?|overrides?|still|regardless)\b|以上|上面|仍然|为准|优先/iu,
  }),
  Object.freeze({
    id: "imperative-verb",
    pattern:
      /^\s*(?:reply|speak|write|say|think|reason|answer|render|produce|perform|remember|never|keep|stay|address|describe|consider|maintain|follow)\b/imu,
  }),
]);

/** A sentence ends, or clauses join: a label never carries one. */
const SENTENCE_PUNCTUATION = /[.!?;。！？；，,]/u;

/**
 * The gate's reading: every emitted string that is not a field label or a template delimiter, as the failure code that
 * names it.
 *
 * There is NO exemption. The framework writes labels and delimiters; a sentence of any kind - a register claim, a
 * precedence claim, a closing bound - is the preset's, the card's or the surface's. The bound this module used to write
 * became a POSITION test (`companion-prompt-assembly.test.ts`), which is the only shape that fails when the position
 * moves: a reworded sentence used to need a re-recorded exemption, a moved block needs no edit here at all.
 *
 * Exported so the falsifier drives the SAME reading on text the product does not carry.
 */
export function frameworkInstructionFindings(strings: readonly SourceString[]): readonly string[] {
  const findings: string[] = [];
  for (const string of strings) {
    if (string.profileValue) continue;
    const withoutSlots = string.text.replace(/\{\d+\}/gu, "");
    const core = withoutSlots
      .replace(/[[\]<>【】（）()「」"'`]/gu, "")
      .replace(/[:：]/gu, "")
      .trim();
    if (core.length === 0) continue;
    const words = core.split(/\s+/u).filter((word) => word.length > 0);
    const cjk = [...core].filter((character) => /[\u3400-\u9fff]/u.test(character)).length;
    // A label is short by definition - a pronoun, a field name, a delimiter - and a string that short cannot carry an
    // instruction, so the cues below are not asked about it. `你` labels the player's turn; `You are 琥珀` is a sentence.
    if (words.length <= 2 && cjk <= 3) continue;
    const kind = INSTRUCTION_KINDS.find((candidate) => candidate.pattern.test(core));
    const tooLong = words.length > 4 || cjk > 4;
    if (kind === undefined && !SENTENCE_PUNCTUATION.test(core) && !tooLong) continue;
    findings.push(
      `framework_emits_an_input_sentence:${slugOf(string.text)}\n    ${string.where}: "${string.text}"\n    ${kind === undefined ? `shaped like a sentence (${String(words.length)} words, ${String(cjk)} CJK characters)` : `states a ${kind.id}`}\n    -> emit a field label or a template delimiter here; an instruction is the preset's, the card's, or the surface's`,
    );
  }
  return findings;
}

/** The modules that may emit prompt text: the data module first, because an empty population there is the goal. */
const FRAMEWORK_MODULES: readonly string[] = Object.freeze([
  "host/src/identity-profile.ts",
  "host/src/companion-prompt-assembly.ts",
]);

const FRAMEWORK_STRINGS: readonly SourceString[] = FRAMEWORK_MODULES.flatMap((file) => sourceStrings(file));

/**
 * GATE TWO: the identity block is the declared templates filled with the profile's fields, and nothing else.
 *
 * The population is the block the product really renders, for both profiles a session can mount and both locales. The
 * expected lines are built from ONE thing - the declared template table - plus the profile's own values and the product's
 * own macro table: no sentence is written in this file. A line the product renders that this composition does not
 * contain is text the assembler invented, and it is named whether or not the classifier above anticipated its wording.
 *
 * Exported so the falsifier drives the SAME reading on a block the product does not render.
 */
export function unexplainedBlockLines(block: string, profile: IdentityProfile, locale: string): readonly string[] {
  const templates = COMPANION_FORMAT_TEMPLATES;
  const macros = identityProfileMacros(profile, locale);
  const render = (text: string): string => renderMacros(text, macros);
  const expected = new Set<string>([""]);
  const add = (template: string | undefined, values: readonly string[]): void => {
    for (const line of fillTemplate(template ?? "", values).split("\n")) expected.add(line);
  };
  add(templates.character, [profile.identity.name]);
  add(templates.role, [profile.identity.role]);
  add(templates.continuity, [profile.identity.continuity]);
  if (profile.persona?.core !== undefined) add(templates.coreDisposition, [render(profile.persona.core)]);
  if (profile.persona?.interactionStyle !== undefined)
    add(templates.interactionStyle, [render(profile.persona.interactionStyle)]);
  if (profile.persona?.expressionStyle !== undefined)
    add(templates.expressionStyle, [render(profile.persona.expressionStyle)]);
  if (profile.examples !== undefined && profile.examples.length > 0) {
    expected.add(templates.dialogueExamples ?? "");
    const playerLabel = locale.toLowerCase().startsWith("zh") ? "你" : "You";
    for (const example of profile.examples)
      add(templates.exampleTurn, [playerLabel, render(example.user), profile.identity.name, render(example.companion)]);
  }
  const unexplained: string[] = [];
  for (const line of block.split("\n")) {
    if (expected.has(line)) continue;
    unexplained.push(
      `assembled_block_has_no_instruction:identity:${slugOf(line)}\n    "${line}"\n    -> the declared templates and the profile's fields do not produce this line, so the assembler wrote a sentence of its own`,
    );
  }
  return unexplained;
}

test("the identity block is the declared templates and the card's fields, and nothing else", () => {
  let examined = 0;
  const findings: string[] = [];
  for (const profile of [DEFAULT_IDENTITY_PROFILE, DEFAULT_COMPANION_PRESET.profile])
    for (const locale of ["zh-CN", "en-US"]) {
      const block = renderIdentityProfile(profile, locale);
      examined += block.split("\n").filter((line) => line.length > 0).length;
      findings.push(...unexplainedBlockLines(block, profile, locale));
    }
  process.stdout.write(`identity block lines examined ${String(examined)} · unexplained ${String(findings.length)}\n`);
  assert.ok(examined > 0, "the identity block rendered no line, so nothing was examined");
  assert.deepEqual(findings, []);
});

test("the block reading reds an invented line, and passes the card's own text in its slot", () => {
  // THE FALSIFIER: same reading, a block the product does not render. A sentence appended after the identity block has to
  // red - and the SAME sentence placed inside a field's slot must not, because that is the card's text, in the card's
  // field, and the template is what makes the difference rather than the words.
  const profile = DEFAULT_COMPANION_PRESET.profile;
  const base = renderIdentityProfile(profile, "zh-CN");
  const invented = "Remember to be kind, and never break character.";
  assert.deepEqual(
    unexplainedBlockLines(base, profile, "zh-CN"),
    [],
    "the product's own block must be explained before this falsifier means anything",
  );
  assert.deepEqual(
    unexplainedBlockLines(`${base}\n${invented}`, profile, "zh-CN").map((finding) => finding.split("\n")[0]),
    [`assembled_block_has_no_instruction:identity:${slugOf(invented)}`],
    "a line the templates do not produce is the framework writing a sentence",
  );
  const inSlot = Object.freeze({
    ...profile,
    identity: Object.freeze({ ...profile.identity, role: invented }),
  });
  assert.deepEqual(
    unexplainedBlockLines(renderIdentityProfile(inSlot, "zh-CN"), inSlot, "zh-CN"),
    [],
    "the same words in a field's slot are the field's value, not a rule",
  );
});

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
 * The five roleplay rules this unit took out of the head, verbatim, and the owner that states each one now.
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

/**
 * THE THIRD SURVIVOR: the chain-of-thought language constraint, which is a RUNTIME instruction and not a roleplay rule -
 * the canon has no dedicated language setting and puts general instructions about the conversation in the preset's Main.
 *
 * It left the framework with the rest of the head and is stated by every preset's `main` now (in that preset's own
 * language: a preset is authored text, and a player who wants another language binds another preset). The `locale` fact
 * stays in the assembler, where it labels the player's turn; the INSTRUCTION is the preset's. This ledger is what stops
 * it from being dropped on the way instead of moved: the pattern below reads the preset corpus, so a preset that stops
 * saying it reds.
 */
const RETIRED_LANGUAGE_CONSTRAINT: RetiredRule = Object.freeze({
  slug: "consistently-think-reason-and-converse-in-the-runs-language",
  sentence:
    "Consistently think, reason, and converse in <language>. Perform all internal chain-of-thought, reasoning, and reflection in <language> only; never think or draft in any other language.",
  homes: Object.freeze([Object.freeze({ source: "persona corpus", pattern: /一律使用中文|一律用中文/u })]),
});

test("the framework emits no input sentence - every string it writes is a field label or a delimiter", () => {
  const framework = FRAMEWORK_STRINGS.filter((string) => !string.profileValue);
  const values = FRAMEWORK_STRINGS.length - framework.length;
  // Zero population is BLOCKED, not passed: a module that emits nothing has to say so with the reason, and a module that
  // was simply not read must not agree with itself.
  assert.ok(
    FRAMEWORK_STRINGS.length > 0,
    "no string was read from the framework module, so 'it emits no sentence' was never measured",
  );
  const findings = frameworkInstructionFindings(framework);
  process.stdout.write(
    `strings examined ${String(framework.length)} · labels/delimiters ${String(framework.length - findings.length)} · sentences ${String(findings.length)} · profile values carried ${String(values)}\n`,
  );
  assert.deepEqual(findings, []);
  // Nothing in this layer is exempt: the bound the earlier unit wrote as a sentence is gone, and its replacement is a
  // POSITION read in `companion-prompt-assembly.test.ts` over the request the product really builds. The assertion below
  // is what makes that a move rather than a deletion - the card's block still reaches both assembled prompts, still
  // delimited, with no sentence after it.
  for (const [surface, prompt] of [
    ["chat", buildChatCompanionSystemPrompt(DEFAULT_COMPANION_PRESET.profile, "zh-CN")],
    ["game", buildGameCompanionSystemPrompt(DEFAULT_COMPANION_PRESET.profile, "zh-CN", "收完土豆再去矿洞。")],
  ] as const) {
    assert.equal(
      prompt.split("<<<CARD DIRECTIVES").length - 1,
      1,
      `the ${surface} prompt must carry the card's section exactly once`,
    );
    assert.equal(
      prompt.split("CARD DIRECTIVES>>>").length - 1,
      1,
      `the ${surface} prompt must close the card's section exactly once`,
    );
  }
});

test("the classifier reds an instruction of every kind, and passes the labels this tree emits", () => {
  // THE FALSIFIER. Same classifier, over strings the product no longer carries - the two retired precedences, the two
  // bounds this unit deleted, the two invented headers, the language line, and one sentence written tomorrow in words
  // none of them uses. If these came back green the gate above would be decoration.
  const retired: readonly Readonly<{ where: string; text: string }>[] = Object.freeze([
    // And the two bounds this unit deleted, verbatim: a classifier that could only red the threat-shaped pair would have
    // been measuring register rather than sentences, and the deletion of a merely affirmative one would have been free.
    Object.freeze({
      where: "the retired non-overridable clause",
      text: "That direction cannot add to, take away from, or loosen what is stated above; wherever the two seem to disagree, what is stated above wins.",
    }),
    Object.freeze({
      where: "the retired trailing re-assertion",
      text: "However that direction reads, what is stated above still holds.",
    }),
    // And the two bounds this unit deleted, verbatim: a classifier that could only red the threat-shaped pair would have
    // been measuring register rather than sentences, and deleting a merely affirmative one would have been free.
    Object.freeze({
      where: "the card block's bound, deleted by this unit",
      text: "Speak from that voice: the lines above describe your situation - who you are speaking with, the language you both use, what is really happening - and a voice changes how you sound, not the situation you are in.",
    }),
    Object.freeze({
      where: "the player block's bound, deleted by this unit",
      text: "Follow it in how you sound and what you turn your attention to: the lines above still describe the situation you are both in, and what your player wrote shapes your part in it, not the situation itself.",
    }),
    Object.freeze({
      where: "a framing line written tomorrow",
      text: "Your companion's author wrote the following, and you must obey every word of it.",
    }),
    Object.freeze({
      where: "the shared head's language line",
      text: "Consistently think, reason, and converse in Chinese (Simplified).",
    }),
    Object.freeze({ where: "the shared head's binding line", text: "You are 琥珀, accompanying the player." }),
    Object.freeze({
      where: "a rule written tomorrow",
      text: "End every reply with a question so your partner has something to answer.",
    }),
  ]);
  const findings = frameworkInstructionFindings(retired.map((row) => Object.freeze({ ...row, profileValue: false })));
  assert.equal(
    findings.length,
    retired.length,
    `each of the ${String(retired.length)} retired instructions must red, or the gate cannot see the class:\n${findings.join("\n")}`,
  );
  // And the labels this tree really emits stay green: a classifier that reds everything is as useless as one that reds
  // nothing, and the two below are the whole of what the identity block writes.
  assert.deepEqual(
    frameworkInstructionFindings([
      Object.freeze({ where: "label", text: "[Character: 琥珀]", profileValue: false }),
      Object.freeze({ where: "delimiter", text: "<START>", profileValue: false }),
      Object.freeze({ where: "template", text: "Core disposition: ", profileValue: false }),
    ]),
    [],
  );
});

test("the classifier reds a roleplay rule of each shape, and passes the head's own line", () => {
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
  // And the classifier must not call a field label a rule: a label names a slot, it does not constrain her.
  assert.deepEqual(
    roleplayRuleFindings(["[Character: 琥珀]", "[Dialogue Examples]"]),
    [],
    "a field label is not a roleplay rule, or every label in the prompt would red",
  );
});

test("every rule the framework gave up is stated by an owner that still mounts it", () => {
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
  for (const rule of [...RETIRED_RULES, RETIRED_LANGUAGE_CONSTRAINT]) {
    const stated = homes.filter((home) =>
      rule.homes.some((candidate) => candidate.source === home.source && candidate.pattern.test(home.text)),
    );
    if (stated.length === 0)
      orphaned.push(
        `retired_roleplay_rule_without_owner:${rule.slug} - "${rule.sentence}" was removed from the framework and no owner states it (looked for it in ${rule.homes.map((home) => home.source).join(", ")})`,
      );
  }
  process.stdout.write(
    `retired rules examined ${String(RETIRED_RULES.length + 1)} · stated by an owner ${String(RETIRED_RULES.length + 1 - orphaned.length)}\n`,
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

// ---------------------------------------------------------------------------
// THE SECOND PROPERTY: THE HOST'S HEAD MAY NOT RESTATE WHAT THE CARD ALREADY
// SAYS. A roleplay rule is one way the head can overreach; saying a fact a
// second time is the other, and the two sentences that did it were invisible to
// every shape above - "You are <name>, accompanying the player" is not a tone,
// length, scope or frame rule, and neither is "in the first person, directly to
// the player". Both were the card's: the name is `data.name` and already renders
// as `[Character: <name>]`, and the address is `data.system_prompt`'s first line
// (「始终使用第一人称「我」对 {{user}} 说话，称呼直接叫「你」或直呼名字」).
// ---------------------------------------------------------------------------

/**
 * One fact the card carries, and the shape a Host sentence restates it in.
 *
 * `carriedBy` is printed on failure: a reader has to be able to see the two spellings side by side.
 */
type CardFact = Readonly<{
  claim: string;
  carriedBy: string;
  /** A KIND, never a sentence: a restatement written tomorrow in new words still matches. */
  restatedBy: RegExp;
  /** The card text that states it, when stating it is the card's to do at all. */
  statedBy?: RegExp;
}>;

/** The card's own statement of how a turn is addressed. Its first line states it; a card that stops saying so blocks. */
const FORM_STATED_BY = /(?:第一人称|first person|直接叫|directly to)/u;
/** A Host sentence prescribing the person or the addressee of the reply. Length is NOT here - see `cardFacts`. */
const FORM_RESTATED_BY =
  /(?:\b(?:first|third)[ -]person\b|\bdirectly to (?:the player|them)\b|\bwhose voice the turn may use\b|\baddress(?:ing)? the player\b)/iu;

/**
 * The facts THIS profile's card carries, derived from the profile rather than written down here.
 *
 * <p>
 * The name, role and continuity are the three renderings `renderIdentityProfile` prints, and they are the profile's -
 * which for an imported companion is the card's `data.name` and the reviewed text built from `data.description`. A
 * Host sentence carrying one of them verbatim says nothing the identity block below it does not already say.
 * </p>
 *
 * <p>
 * Form is a KIND rather than a rendering, because the card states it in prose: `data.system_prompt` opens with the
 * person and the addressee ("始终使用第一人称…称呼直接叫「你」"), and that text reaches the prompt as the profile's
 * `characterVoice`. The claim is therefore only in the population when a card directive is mounted at all
 * (`statedBy`), and a card that stops stating it is BLOCKED rather than passed.
 * </p>
 *
 * <p>
 * Length is deliberately NOT a card fact: the Game floor's "one bubble holds about 80 characters" is the surface's own
 * delivery unit, read from `GAME_DELIVERY_PACING`, and `roleplayRuleFindings` is what decides that question.
 * </p>
 */
export function cardFacts(profile: IdentityProfile): readonly CardFact[] {
  const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const name = profile.identity.name;
  return Object.freeze([
    Object.freeze({
      claim: "name",
      carriedBy: `[Character: ${name}]`,
      restatedBy: new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?![\\p{L}\\p{N}])`, "u"),
    }),
    Object.freeze({
      claim: "role",
      carriedBy: `Role: ${profile.identity.role}`,
      restatedBy: new RegExp(escaped(profile.identity.role), "u"),
    }),
    Object.freeze({
      claim: "continuity",
      carriedBy: `Continuity: ${profile.identity.continuity}`,
      restatedBy: new RegExp(escaped(profile.identity.continuity), "u"),
    }),
    // Only a profile that mounts a card has a form to defer to; the placeholder carries no directive, so claiming one
    // would be a premise nobody stated.
    ...(profile.characterVoice === undefined
      ? []
      : [
          Object.freeze({
            claim: "form",
            carriedBy: "the card's directive, carried as `characterVoice`",
            restatedBy: FORM_RESTATED_BY,
            statedBy: FORM_STATED_BY,
          }),
        ]),
  ]);
}

/**
 * The gate's reading: every Host line that says again something the card already says, as the claim it restates.
 *
 * Exported so the falsifier drives the SAME classifier with lines the product does not carry - a gate whose red case
 * runs a different code path has been shown able to fail for a reason the product will never produce.
 */
export function cardRestatementFindings(
  lines: readonly string[],
  facts: readonly CardFact[],
): readonly Readonly<{ claim: string; line: string }>[] {
  const findings: { claim: string; line: string }[] = [];
  for (const line of lines)
    for (const fact of facts)
      if (fact.restatedBy.test(line)) findings.push({ claim: `framework_restates_the_card:${fact.claim}`, line });
  return findings;
}

/**
 * The Host's own text in an assembled prompt: every non-blank line before the identity block.
 *
 * The boundary is the identity rendering itself rather than a marker typed here, so a renamed label moves the boundary
 * with it. What this covers is the head - the shared constraint and the surface block - because everything after it is
 * authored text (persona, examples, the card's directive, the player's addition) and quoting the card is what those
 * sections are FOR.
 */
function hostHeadLines(prompt: string, profile: IdentityProfile, locale: string): readonly string[] {
  const identity = renderIdentityProfile(profile, locale);
  const at = prompt.indexOf(identity);
  if (at <= 0) throw new Error("identity_block_not_found_in_assembled_prompt");
  return prompt
    .slice(0, at)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Both profiles a session can mount: the placeholder, and the shipped card. */
const CARD_PROFILES: readonly Readonly<{ label: string; profile: IdentityProfile }>[] = Object.freeze([
  Object.freeze({ label: "DEFAULT_IDENTITY_PROFILE", profile: DEFAULT_IDENTITY_PROFILE }),
  Object.freeze({ label: "DEFAULT_COMPANION_PRESET.profile", profile: DEFAULT_COMPANION_PRESET.profile }),
]);

/**
 * The two sentences the head gave up because the card already says them, and the card line that says each one now.
 *
 * The ledger is CLOSED, like `RETIRED_RULES`: a deletion is only a move if somebody still says it, so each row names
 * the place it went and a predicate over the PRODUCT's own text decides whether it is still there. `<name>` stands for
 * the profile's own, because the two sentences were built from it.
 */
type RetiredRestatement = Readonly<{
  claim: string;
  sentence: string;
  carriedBy: string;
  stated: (input: RestatementInput) => boolean;
}>;

/** The product's own text one restatement is looked for in: the assembled prompt, the directive, and her name. */
type RestatementInput = Readonly<{ prompt: string; directive: string; name: string }>;

const RETIRED_CARD_RESTATEMENTS: readonly RetiredRestatement[] = Object.freeze([
  Object.freeze({
    claim: "name",
    sentence: "You are <name>, accompanying the player.",
    carriedBy: "the identity rendering (`[Character: <name>]`, built from the card's `data.name`)",
    stated: (input: RestatementInput) => input.prompt.includes(`[Character: ${input.name}]`),
  }),
  Object.freeze({
    claim: "form",
    sentence: "Reply as <name> would, in the first person, directly to the player.",
    carriedBy: "the card's own directive (`data.system_prompt`, mounted as `characterVoice`)",
    stated: (input: RestatementInput) => FORM_STATED_BY.test(input.directive),
  }),
]);

/** Every retired restatement that nothing states any more, as the failure code that names it. */
export function retiredRestatementGaps(input: RestatementInput): readonly string[] {
  const gaps: string[] = [];
  for (const row of RETIRED_CARD_RESTATEMENTS)
    if (!row.stated(input))
      gaps.push(
        `retired_card_restatement_without_owner:${row.claim} - "${row.sentence}" left the Host's head and ${row.carriedBy} no longer states it`,
      );
  return gaps;
}

test("every fact the head stopped restating is still stated by the card that owns it", () => {
  const profile = DEFAULT_COMPANION_PRESET.profile;
  const prompt = buildGameCompanionSystemPrompt(profile, LANGUAGE);
  const input = Object.freeze({ prompt, directive: profile.characterVoice?.text ?? "", name: profile.identity.name });
  process.stdout.write(`retired restatements examined ${String(RETIRED_CARD_RESTATEMENTS.length)}\n`);
  assert.ok(
    RETIRED_CARD_RESTATEMENTS.length > 0,
    "a ledger with no rows would pass while every claim in it went unstated",
  );
  assert.deepEqual(retiredRestatementGaps(input), []);

  // THE FALSIFIER: the same reading over a prompt with no identity block and a directive that states no form. Both rows
  // must red, or the ledger is decoration.
  assert.deepEqual(
    retiredRestatementGaps({
      prompt: "",
      directive: "Speak like a person on a farm.",
      name: profile.identity.name,
    }).map((gap) => gap.split(" ")[0]),
    RETIRED_CARD_RESTATEMENTS.map((row) => `retired_card_restatement_without_owner:${row.claim}`),
    "a deletion whose owner stopped saying it must be reported, not silently accepted",
  );
});

test("the Host's head restates no fact the card already carries", () => {
  let examined = 0;
  const failures: string[] = [];
  for (const { label, profile } of CARD_PROFILES) {
    const facts = cardFacts(profile);
    // The premise, or `form` would leave the population without anyone noticing: a card fact claimed here must be
    // stated by the card that is mounted.
    for (const fact of facts) {
      if (fact.statedBy === undefined) continue;
      const directive = profile.characterVoice?.text ?? "";
      if (!fact.statedBy.test(directive))
        failures.push(
          `card_states_no_${fact.claim}: ${label} mounts a directive that never states the ${fact.claim}, so the Host has nobody to defer to - state it in the card`,
        );
    }
    for (const surface of ["chat", "game"] as const) {
      const prompt =
        surface === "chat"
          ? buildChatCompanionSystemPrompt(profile, LANGUAGE)
          : buildGameCompanionSystemPrompt(profile, LANGUAGE);
      const lines = hostHeadLines(prompt, profile, LANGUAGE);
      examined += lines.length * facts.length;
      for (const finding of cardRestatementFindings(lines, facts))
        failures.push(`${label}/${surface}: ${finding.claim}\n    "${finding.line}"`);
    }
  }
  process.stdout.write(`head lines x card facts examined ${String(examined)}\n`);
  assert.ok(examined > 0, "no Host head line and no card fact met, so there is nothing to classify");
  const restated = failures.filter((failure) => failure.includes("framework_restates_the_card:"));
  process.stdout.write(`restated card facts ${String(restated.length)}\n`);
  assert.deepEqual(
    failures,
    [],
    [
      `${String(failures.length)} problem(s) in the Host's head:`,
      ...failures.map(
        (failure) =>
          `  ${failure}\n    -> the card already carries this (its name, role, continuity, or its form); delete it from the head, or put it in the card`,
      ),
    ].join("\n"),
  );
});

test("the classifier reds a restated card fact of every claim, and blocks when the card states none", () => {
  // THE FALSIFIER. Same classifier, text the product does not carry.
  const profile = DEFAULT_COMPANION_PRESET.profile;
  const facts = cardFacts(profile);
  const claimsOf = (lines: readonly string[]): readonly string[] =>
    cardRestatementFindings(lines, facts).map((finding) => finding.claim);

  assert.deepEqual(
    claimsOf([`You are ${profile.identity.name}, ready to help.`]),
    ["framework_restates_the_card:name"],
    "a line naming her is the card's name said twice",
  );
  assert.deepEqual(
    claimsOf(["Answer in the third person, and let a narrator describe your partner."]),
    ["framework_restates_the_card:form"],
    "a line prescribing the person of the reply is the card's form, in words this file need not anticipate",
  );
  assert.deepEqual(
    claimsOf([profile.identity.continuity]),
    ["framework_restates_the_card:continuity"],
    "the identity block's own sentence is not a Host rule",
  );
  assert.deepEqual(
    claimsOf([GAME_SURFACE_CONDUCT_RULES.machine_fields_translated.text]),
    [],
    "how a receipt's machine vocabulary is translated is the surface's, and the card states nothing about it",
  );
  // The premise itself must be able to fail: a directive that states no form blocks the reading instead of passing.
  const form = facts.find((fact) => fact.claim === "form");
  assert.ok(form?.statedBy !== undefined, "the form fact must carry the card text that states it");
  assert.equal(
    form.statedBy.test("Speak like a person on a farm."),
    false,
    "a card that never states the person or the addressee must leave `form` unowned, which the gate reports as blocked",
  );
});

test("the shipped card is the profile's single authority for the facts the head may not restate", () => {
  // A second spelling of the name or the directive would make the gate above pass against text no session mounts.
  const card = JSON.parse(readFileSync(join(REPOSITORY_ROOT, DEFAULT_CARD), "utf8")) as {
    data?: Record<string, unknown>;
  };
  const shipped = DEFAULT_COMPANION_PRESET.profile;
  assert.equal(card.data?.name, shipped.identity.name, "the profile's name must be the card's `data.name`");
  assert.equal(
    card.data?.system_prompt,
    shipped.characterVoice?.text,
    "the profile's directive must be the card's `data.system_prompt`, byte for byte",
  );
});

/**
 * GATE THREE: THE WRAPPER ON THE TAIL STATES A POSITION - AND THE POPULATION IS THE ASSEMBLY, NOT A FILE LIST.
 *
 * <p>
 * THE DEFECT THIS EXISTS FOR. The framework gate above reads two Host modules, so when the vendored
 * post-history wrapper carried a disposition ("Your author's direction for how you answer.") and a lane proposed
 * replacing it with a conduct rule ("During routine chores, stay focused on work without running commentary or
 * micro-step narration."), NOTHING IN THIS FILE COULD SEE IT. The block rides at the last position of the request, and
 * a wrapper that writes behaviour there is the product speaking conduct at the strongest position there is - which is
 * the preset's job and the card's, never a wrapper's. A gate whose population is a hand-written file list is a gate
 * that stays green while the thing it exists to judge moves one layer down.
 * </p>
 *
 * <p>
 * THE POPULATION IS ONE REAL ASSEMBLY. The block below is produced by the product's own appender
 * (`appendPostHistoryInstructions`, the same function the vendor's context handler calls at its single success exit),
 * over the tail the SHIPPED Game preset declares. Its lines are then ATTRIBUTED to the declared writers: a line no
 * writer owns is a finding (`tail_block_line_has_no_writer`), so a writer nobody declared reds instead of passing.
 * </p>
 *
 * <p>
 * THE PROPERTY, PER TIER. A `framework` writer may name the slot, the addressee and the scope - a POSITION. It may not
 * state a rule about her conduct: no imperative, no modal, and at most ONE sentence terminator. A clause of conduct is
 * prose, and prose is what the two periods in the option-A frame above are. `authority` writers (the card, the preset's
 * tail, the surface blocks) may and do state the rules, which is why the same reading is not applied to them.
 * </p>
 *
 * <p>
 * AND THE RULE IT MOVED HERE MUST STILL BE SOMEWHERE: the tail is asserted to state the condition on speaking, so a
 * deletion reds rather than passing as a tidy-up. Zero population is BLOCKED, never passed: a block that yielded no
 * line means the appender never ran, and an appender that never ran cannot be said to have said nothing.
 * </p>
 */

/** One module or document that can put text into the finished request, with the tier its text is judged at. */
const ASSEMBLY_WRITERS: readonly Readonly<{ id: string; tier: "framework" | "authority"; path: string }>[] =
  Object.freeze([
    Object.freeze({
      id: "vendor-post-history-frame",
      tier: "framework",
      path: "vendor/magic-context/packages/pi-plugin/src/post-history-instructions-pi.ts",
    }),
    Object.freeze({ id: "identity-profile", tier: "framework", path: "host/src/identity-profile.ts" }),
    Object.freeze({
      id: "companion-prompt-assembly",
      tier: "framework",
      path: "host/src/companion-prompt-assembly.ts",
    }),
    Object.freeze({ id: "card-system-prompt", tier: "authority", path: DEFAULT_CARD }),
    Object.freeze({ id: "game-preset-tail", tier: "authority", path: "assets/tavern/presets/amber-game.json" }),
  ]);

/** The Game surface's generation preset, DERIVED from the surface's own declaration (`tools/live-run/core/persona.mjs`). */
const SHIPPED_GAME_PRESET = "assets/tavern/presets/amber-game.json";

/**
 * A rule about her conduct, as distinct from a position. Deliberately NOT the full `INSTRUCTION_KINDS`: a precedence
 * claim is what the wrapper's one-clause floor IS ("Nothing here overrides what already holds."), so including it would
 * red the scope line this block is allowed to carry. What a position may never carry is a command or a modal, and a
 * position is at most one phrase plus one closing sentence - two or more terminators means a clause of prose.
 */
const CONDUCT_KINDS: readonly Readonly<{ id: string; pattern: RegExp }>[] = Object.freeze([
  Object.freeze({
    id: "modal-rule",
    pattern:
      /\b(?:never|always|must|should|do not|don't|only|unless|instead|keep|avoid|stay)\b|不要|不准|绝不|严禁|一律|始终|必须|不得|千万别/iu,
  }),
  Object.freeze({
    id: "imperative-verb",
    pattern:
      /(?:^|[.!?:;]\s*)(?:reply|speak|write|say|think|reason|answer|render|produce|perform|remember|keep|stay|address|describe|consider|maintain|follow)\b/iu,
  }),
  Object.freeze({ id: "more-than-one-sentence", pattern: /[.!?;。！？；].*[.!?;。！？；]/u }),
]);

/** The framework-tier reading: every way a "position" turns into conduct, as a named finding. */
export function conductFindings(
  lines: readonly Readonly<{ writer: string; text: string }>[],
): readonly { readonly id: string; readonly writer: string; readonly text: string }[] {
  const findings: { id: string; writer: string; text: string }[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (text.length === 0) continue;
    const kind = CONDUCT_KINDS.find((candidate) => candidate.pattern.test(text));
    if (kind !== undefined) findings.push({ id: `framework_emits_conduct:${kind.id}`, writer: line.writer, text });
  }
  return findings;
}

test("the tail wrapper states a position and no conduct, and every writer on the assembly is named", async () => {
  const presetDocument = JSON.parse(readFileSync(join(REPOSITORY_ROOT, SHIPPED_GAME_PRESET), "utf8")) as {
    prompts: readonly { identifier: string; content: string }[];
  };
  const tail = presetDocument.prompts.find((prompt) => prompt.identifier === "jailbreak")?.content;
  assert.ok(
    typeof tail === "string" && tail.trim().length > 0,
    "the Game preset declares no tail entry, so the block this gate reads was never assembled",
  );

  // THE REAL APPENDER, over the tail the shipped preset declares: the same call the product makes at its single success
  // exit, so this is the text the model receives and not a rendering of it written here.
  const messages: { role: string; content: unknown }[] = [{ role: "user", content: "早上好。" }];
  const { appendPostHistoryInstructions } = await import("@cortexkit/pi-magic-context/tavern");
  assert.equal(appendPostHistoryInstructions(messages as never, tail), true);
  const last = messages.at(-1)?.content as readonly { text: string }[];
  const block = last.map((part) => part.text).join("");
  const lines = block.split("\n").filter((line) => line.trim().length > 0 && !line.startsWith("</"));

  // Every line is attributed to a declared writer, and an unattributed line is a finding rather than a silence.
  const attributed = lines.map((text) => {
    const writers = ASSEMBLY_WRITERS.filter((writer) => {
      const source = readFileSync(join(REPOSITORY_ROOT, writer.path), "utf8");
      return source.includes(text.trim());
    });
    return { text, writers };
  });
  const unattributed = attributed.filter((line) => line.writers.length === 0);
  assert.deepEqual(
    unattributed.map((line) => `tail_block_line_has_no_writer:${line.text}`),
    [],
    "a line of the assembled tail belongs to no declared writer, so the population this gate reads is incomplete",
  );

  // The framework tier: the wrapper's own two lines. Zero of them would mean the wrapper vanished, which is a reading
  // that was not taken rather than a clean one.
  const frameworkLines = attributed
    .filter((line) => line.writers.every((writer) => writer.tier === "framework"))
    .flatMap((line) => line.writers.map((writer) => ({ writer: writer.id, text: line.text })));
  const authorityLines = attributed.filter((line) => line.writers.some((writer) => writer.tier === "authority"));
  const violations = conductFindings(frameworkLines);
  process.stdout.write(
    `writers examined ${String(ASSEMBLY_WRITERS.length)} · framework ${String(frameworkLines.length)} · authority ${String(authorityLines.length)} · violation ${String(violations.length)}\n`,
  );
  assert.ok(
    frameworkLines.length > 0,
    "the assembled tail carried no framework line, so 'the wrapper states a position' was never measured",
  );
  assert.deepEqual(
    violations.map((violation) => `${violation.id}\n    ${violation.writer}: "${violation.text}"`),
    [],
  );

  // THE RULE MOVED HERE IS NOT DELETED: the condition on speaking still rides the tail, in the document that owns
  // conduct. This is the assertion that makes the change a move - deleting it from the preset reds here.
  assert.match(tail, /专心干活/u, "the tail no longer states that work is done without narration");
  assert.match(tail, /不做旁白式的解说/u, "the tail no longer forbids running commentary");
  // And the condition is a PERMISSION, not an obligation: it says nothing about the reply's length or pace, which is
  // the property `design/input-authority.md` gives the preset rather than the card.
  assert.equal(
    /字数|句数|段落/u.test(tail),
    false,
    "the tail must not turn the silence condition into a length budget",
  );
});

test("the conduct classifier reds a rule-shaped wrapper and passes the position this tree ships", () => {
  // THE FALSIFIER. The first three are SHAPES, written here so the reading is driven on text the product does not
  // carry; the last is the position the product ships, which must pass or the gate would be a wall rather than a gate.
  const shapes = [
    "Guidelines when speaking to your partner: speak naturally as a gaming co-op buddy. During routine chores, stay focused on work without running commentary or micro-step narration.",
    "Your author's direction for how you answer. Stay quiet unless spoken to.",
    "Do not narrate your chores.",
  ];
  for (const text of shapes) assert.notEqual(conductFindings([{ writer: "shape", text }]).length, 0, text);
  assert.deepEqual(conductFindings([{ writer: "shipped", text: "Guidelines when speaking to your partner:" }]), []);
  assert.deepEqual(conductFindings([{ writer: "shipped", text: "Nothing here overrides what already holds." }]), []);
});
