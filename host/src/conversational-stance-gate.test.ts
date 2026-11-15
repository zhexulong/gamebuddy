import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GAME_SURFACE_CONDUCT_RULES } from "./game-surface-prompt-floor.js";
import * as stardewConduct from "./games/stardew/prompt/stardew-game-conduct.js";
import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";

/**
 * WHEN SHE SPEAKS IS THE PERSONA'S RULE, AND THE GAME FLOOR MAY NOT STATE IT.
 *
 * <p>
 * The defect is an implicit state machine living in the prompt's prose: a rule of the shape "when X happens, say
 * Y". Ten of the nineteen rules these two tables declare were still written that way - 「当被拒 → 说一句人的反应」
 * 「当工作阶段结束 → 说身体的感觉」「当搭档说话 → 先说反应」「每次回复承载一句」 - and none of them is a fact about the
 * surface. Each is a moment, a quantity or a line-owned-by-a-state, and every one of them makes speech an output of
 * the floor.
 * </p>
 *
 * <p>
 * THE AUTHORITY SPLIT. The floor owns what the delivery blocks mean, what counts as an action, and what the SURFACE
 * does (the bubble's size, the renderer's markdown, the machine vocabulary a receipt is written in). The persona owns
 * her voice and every rule about when, whether or how much she speaks - the card's own directive
 * (`assets/tavern/presets/default-companion/card.json` `system_prompt`, carried into the request as the profile's
 * `characterVoice`) and the preset the Game surface mounts. A sentence about a moment or a count belongs there and
 * nowhere else.
 * </p>
 *
 * <p>
 * WHY THE OLD GATE MISSED ALL THREE OF THE RULES THIS UNIT MOVED, and the reason its population changed. It enumerated
 * bad PHRASINGS (`end your turn and speak`, `you must tell the player`, `make sure to say something`) and ran them over
 * the floor's string literals. The floor's rules are prose, and a rule can state a state machine in words no phrase list
 * contains: "When a stretch of work ends, speak from your immediate bodily sensation", "When something blocks you, the
 * player hears a person's reaction", "the surface carries one per reply". So the population is no longer a phrase list at
 * all: it is EVERY RULE the floor declares, read from the floor's own tables - the generic floor's
 * `GAME_SURFACE_CONDUCT_RULES` and the Stardew module's exported rules joined to its `STARDEW_GAME_CONDUCT_CLASSES`
 * table. A rule added tomorrow joins without an edit here, and a class-table row naming a rule no module exports is
 * blocked by name rather than silently dropped.
 * </p>
 *
 * <p>
 * THE PROPERTY: does this rule say WHEN she speaks, WHETHER she speaks, HOW MUCH she says per reply, or WHAT she says in
 * a state? Ten shapes read it - a state or event that carries a speech act, an obligation laid on speech, a claim that a
 * reply owes a line, a permission on speaking or on asking, a count per reply, a count of speech acts, a ban whose
 * subject is her asking, a permission on a question, a silence licence, and a stop bound on a speech act. Each carries
 * the property it protects, so the failure says what to do with the rule rather than which string matched.
 * </p>
 *
 * <p>
 * THE OWNER'S SIDE IS READ, NOT ASSUMED. A deletion is only a move if the layer that owns the sentence still states it,
 * so the persona's own stance sentences are counted from the two files a Game session mounts - the card's directive
 * (read from the shipped profile the builder renders) and every preset in the presets directory - and a zero there
 * blocks the gate instead of passing on nothing.
 * </p>
 *
 * <p>
 * THE TOOL DESCRIPTIONS ARE A SECOND POPULATION, unchanged: `body-program-script.ts` and `game-tools.ts` hand the model
 * string literals, not rule objects, so they are scanned as text with the detectors the old gate used
 * (`conversational_stance_outside_the_preset:<file>:<line>`). The measured defect there was the plan tool's
 * "so end your turn and speak to the player".
 * </p>
 */

const REPOSITORY_ROOT = (() => {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("repository_root_not_found");
    directory = parent;
  }
})();

const FLOOR_SOURCE = "host/src/game-surface-prompt-floor.ts";
const STARDEW_SOURCE = "host/src/games/stardew/prompt/stardew-game-conduct.ts";

/**
 * The two modules whose string literals are tool descriptions the model is handed.
 *
 * The shared framework and the persona block in `identity-profile.ts` are NOT here: they are the persona layer, which
 * is the owner of when she speaks, not a place this gate polices.
 */
const TOOL_DESCRIPTION_SOURCES = Object.freeze([
  Object.freeze({ file: "host/src/body-program-script.ts", layer: "tool descriptions" }),
  Object.freeze({ file: "host/src/game-tools.ts", layer: "tool descriptions" }),
]);

/** The preset directory: one file per surface's generation preset. */
const PRESET_DIRECTORY = "assets/tavern/presets";

/** One rule of the floor, as the composed prompt reads it. */
type Rule = Readonly<{ id: string; source: string; text: string }>;

/**
 * EVERY rule the floor declares, from the two authorities that declare them.
 *
 * The floor's rules are a record keyed by id. The Stardew module exports its rules as texts and classifies them in
 * `STARDEW_GAME_CONDUCT_CLASSES`, whose ids are those declarations' names lowercased - the convention
 * `tools/check-game-surface-conduct-classes.mjs` already reads the source by - so the join is derived from the table
 * and a row naming nothing throws instead of shrinking the population.
 */
function floorRules(): readonly Rule[] {
  const rules: Rule[] = [];
  for (const [id, rule] of Object.entries(GAME_SURFACE_CONDUCT_RULES))
    rules.push(Object.freeze({ id, source: FLOOR_SOURCE, text: rule.text }));
  const exports: Readonly<Record<string, unknown>> = stardewConduct;
  for (const row of stardewConduct.STARDEW_GAME_CONDUCT_CLASSES) {
    const text = exports[row.id.toUpperCase()];
    if (typeof text !== "string" || text.trim().length === 0)
      throw new Error(
        `conduct_rule_text_unreadable:${row.id}: the class table classifies a rule this module does not export, so the ` +
          "population this gate examines would be smaller than the floor without saying so",
      );
    rules.push(Object.freeze({ id: row.id, source: STARDEW_SOURCE, text }));
  }
  return Object.freeze(rules);
}

/** A speech act, as the floor's prose spells it. The words themselves are not the property - where they sit is. */
const SPEECH = String.raw`(?:speak|speaks|speaking|spoke|spoken|say|says|saying|said|tell|tells|telling|told|talk|talks|talking|told|reply|replies|replying|answer|answers|answering|ask|asks|asking|asked|remark|remarks|mention|mentions)`;

/**
 * Every shape in which a rule states when, whether or how much she speaks.
 *
 * A shape is a PROPERTY, not a sentence: the floor's own facts (the bubble's size, the renderer's markdown, the
 * machine vocabulary of a receipt, the ban on speaking as a helper) match none of them, and the rules this unit moved
 * out each match at least one - which the falsifier below proves on their verbatim moved text.
 */
const SPEECH_GOVERNANCE_SHAPES = Object.freeze([
  Object.freeze({
    id: "state_triggers_speech",
    protects: "a speech act hung on a state or an event ('when X, say Y') is a moment, and the moment is the persona's",
    pattern: new RegExp(
      String.raw`\b(?:when|whenever|after|once|each|every time|as soon as|until|if|at the end of|now that)\b[^.!?]{0,160}?\b${SPEECH}\b`,
      "iu",
    ),
  }),
  Object.freeze({
    id: "speech_obligation",
    protects:
      "an obligation laid on a speech act ('you must tell the player', 'the player hears your reaction') owes a line",
    pattern: new RegExp(
      String.raw`\b(?:you|she)\s+(?:must|should|have to|has to|need to|needs to|are to|is to)\b[^.!?]{0,80}?\b${SPEECH}\b|\bthe (?:player|partner)\s+(?:hears|gets|receives|is told)\b`,
      "iu",
    ),
  }),
  Object.freeze({
    id: "reply_owes_a_line",
    protects:
      "a claim that the reply or the surface carries a line ('the surface carries one per reply') makes every reply owe one",
    pattern:
      /\b(?:the surface|your reply|a reply|each reply|every reply|the bubble)\b[^.!?]{0,60}?\b(?:carries|carry|owes|owe|needs|need|holds|hold)\b[^.!?]{0,40}?\b(?:one|a line|a remark|a word|at most one)\b/iu,
  }),
  Object.freeze({
    id: "speech_permitted",
    protects: "'you may speak while you work' is a permission on a moment, and a permission is the persona's sentence",
    pattern:
      /\b(?:you may|you can|you are allowed to|it is fine to)\s+(?:also\s+)?(?:speak|talk|say|tell|remark|stay silent|stay quiet|keep silent|keep quiet)\b/iu,
  }),
  Object.freeze({
    id: "speech_per_reply",
    protects: "a count per reply ('one thing per reply', 'one per reply') is how much she says",
    pattern: /\bper\s+(?:reply|turn|message|bubble)\b/iu,
  }),
  Object.freeze({
    id: "speech_counted",
    protects: "a count of speech acts ('one spoken line', 'a single remark') is how much she says",
    pattern:
      /\b(?:one|two|a single|exactly one)\s+(?:spoken\s+|short\s+|brief\s+)?(?:line|sentence|utterance|remark|word|words)\b/iu,
  }),
  Object.freeze({
    id: "speech_banned_by_a_state",
    protects: "a ban whose subject is her asking ('never ask your partner what to do') is whether she speaks",
    pattern: /\b(?:never|do not|don't|no)\b[^.!?]{0,24}?\bask(?:ing)?\b/iu,
  }),
  Object.freeze({
    id: "question_permitted",
    protects: "a permission on a question ('a question about X is fine') is a rule about whether she speaks",
    pattern:
      /\b(?:a|any|one)\s+(?:concrete\s+)?(?:question|remark|line)\b[^.!?]{0,50}?\b(?:is|are)\s+(?:fine|ok|okay|allowed|permitted|welcome)\b/iu,
  }),
  Object.freeze({
    id: "silence_licence",
    protects: "whether silence is allowed while she works is the persona's",
    pattern: /\b(?:stay|keep|work|remain)\s+(?:silent|quiet(?:ly)?)\b|\bdo not speak\b|\bno need to speak\b/iu,
  }),
  Object.freeze({
    id: "speech_stop_bound",
    protects: "a stop bound on a speech act ('say ... and stop', 'stop when it has been said') is the persona's",
    pattern:
      /\b(?:say|speak|talk|tell|reply|answer|deliver)\b[^.!?]{0,60}?\b(?:and|then)\s+stop\b|\bstop when it has been said\b/iu,
  }),
]);

/** Every speech-governance shape one rule states, by shape id. Empty is the property the floor wants. */
function speechGovernance(text: string): readonly string[] {
  return SPEECH_GOVERNANCE_SHAPES.filter((shape) => shape.pattern.test(text)).map((shape) => shape.id);
}

/** The Chinese forms the persona owns, read on its side so a deletion there is a move rather than a loss. */
const PERSONA_DETECTORS = Object.freeze([
  Object.freeze({ id: "persona_say_and_stop", pattern: /说清就停|说一句就停|说完就(?:停|收)|一句[^。]{0,12}收住/u }),
  Object.freeze({
    id: "persona_quiet_while_working",
    pattern: /保持安静|安静专注|专注干活|无需报备|别废话|不报进度|不报备/u,
  }),
  Object.freeze({
    id: "persona_length_cap",
    pattern: /(?:单条|每条|一句)[^。]{0,20}\d+\s*[~～-]\s*\d+\s*字|短小精悍/u,
  }),
  Object.freeze({ id: "persona_partner_first", pattern: /先接住人|先接人的话|第一句就落到|第一拍接/u }),
]);

/** The sentence unit the persona's prose is read in: a sentence, so a stance statement is one unit, not a file. */
const SENTENCE = /[^.!?。！？]+[.!?。！？]*/gu;

type PersonaReading = Readonly<{ source: string; sentences: number; detectors: readonly string[] }>;

/** The stance sentences one piece of persona prose states, by detector id. */
function personaStance(text: string): readonly string[] {
  const stated = new Set<string>();
  for (const match of text.matchAll(SENTENCE)) {
    const sentence = match[0].trim();
    if (sentence.length === 0) continue;
    for (const detector of PERSONA_DETECTORS) if (detector.pattern.test(sentence)) stated.add(detector.id);
  }
  return Object.freeze([...stated]);
}

/**
 * The persona the Game surface mounts, as the two files that carry it: the card's own directive (already rendered into
 * the prompt as `characterVoice`, so this reads the shipped profile rather than parsing the card again) and each
 * preset's prompt contents.
 */
function personaStanceReading(): readonly PersonaReading[] {
  const readings: PersonaReading[] = [];
  const directive = DEFAULT_COMPANION_PRESET.profile.characterVoice?.text;
  if (directive === undefined || directive.trim().length === 0)
    throw new Error(
      "persona_directive_absent: the shipped card carries no characterVoice, so the layer that owns when she speaks is " +
        "empty and a rule deleted from the floor would have nowhere to have been said",
    );
  readings.push(
    Object.freeze({
      source: "card.json system_prompt (characterVoice)",
      sentences: 0,
      detectors: personaStance(directive),
    }),
  );
  const directory = join(REPOSITORY_ROOT, PRESET_DIRECTORY);
  if (!existsSync(directory)) throw new Error(`persona_preset_directory_absent:${PRESET_DIRECTORY}`);
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json")) continue;
    const document = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
      prompts?: readonly { content?: unknown }[];
    };
    const text = (document.prompts ?? [])
      .map((prompt) => (typeof prompt.content === "string" ? prompt.content : ""))
      .join("\n");
    readings.push(
      Object.freeze({
        source: `${PRESET_DIRECTORY}/${name}`,
        sentences: text.length,
        detectors: personaStance(text),
      }),
    );
  }
  return Object.freeze(readings);
}

const QUOTED_LITERAL = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/gu;
const COMMENT_LINE = /^(?:\*|\/\/|\/\*|\*\/)/u;

/** The string literals one source hands the model, each with the line it starts on. */
function literalSegments(source: string): readonly Readonly<{ text: string; line: number }>[] {
  const segments: { text: string; line: number }[] = [];
  source.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line.length === 0) return;
    if (COMMENT_LINE.test(line)) return;
    if (line.startsWith("label:")) return;
    for (const match of line.matchAll(QUOTED_LITERAL)) {
      const body = match[1] ?? match[2] ?? match[3];
      if (body !== undefined && body.trim().length > 0) segments.push(Object.freeze({ text: body, line: index + 1 }));
    }
  });
  return segments;
}

/** One text per tool-description source, split into sentences, each carrying the line it started on. */
function sentenceUnits(segments: readonly Readonly<{ text: string; line: number }>[]): readonly Readonly<{
  sentence: string;
  line: number;
}>[] {
  const starts: number[] = [];
  let length = 0;
  for (const segment of segments) {
    starts.push(length);
    length += segment.text.length + 1;
  }
  const text = segments.map((segment) => segment.text).join(" ");
  const units: { sentence: string; line: number }[] = [];
  for (const match of text.matchAll(SENTENCE)) {
    const piece = match[0];
    const sentence = piece.trim();
    if (sentence.length === 0) continue;
    const at = (match.index ?? 0) + (piece.length - piece.trimStart().length);
    let line = segments[0]?.line ?? 0;
    for (let index = 0; index < segments.length; index += 1) {
      if ((starts[index] ?? 0) > at) break;
      line = segments[index]?.line ?? line;
    }
    units.push(Object.freeze({ sentence, line }));
  }
  return units;
}

/** The three mandate phrasings the tool descriptions were measured with, plus the two counts. */
const TOOL_DESCRIPTION_SHAPES = Object.freeze([
  Object.freeze({
    id: "speech_mandated",
    protects:
      "an instruction in a tool description that she must speak ('end your turn and speak to the player') is the persona's",
    pattern:
      /\bend (?:your|the) turn\b\s*(?:[,;]\s*)?(?:and|then)\s+(?:you\s+)?(?:must\s+|should\s+|always\s+)?(?:speak|say|talk|tell|reply|answer)\b|\b(?:make sure|be sure|remember|do not forget)\s+(?:to\s+|you\s+)?(?:speak|say|talk|tell|reply|answer)\b|\bspeak to (?:the|your) player\b(?!\s+(?:when|whenever|if|unless|once|only|as|while|before|after|until)\b)|\b(?:you|she)\s+(?:must|should|have to|has to|need to|needs to)\s+(?:always\s+|also\s+)?(?:speak|say|talk|tell|reply|answer)\b/iu,
  }),
  Object.freeze({
    id: "speech_per_reply",
    protects: "a quota per reply in a tool description is how much she says",
    pattern: /\b(?:utterance|thing|line|remark|thought|sentence)s?\s+per\s+(?:reply|turn|message)\b/iu,
  }),
]);

type ToolDescriptionFinding = Readonly<{ code: string; sentence: string; protects: string }>;

function readToolDescriptions(
  sources: readonly Readonly<{ file: string; layer: string }>[] = TOOL_DESCRIPTION_SOURCES,
): readonly ToolDescriptionFinding[] {
  const findings: ToolDescriptionFinding[] = [];
  for (const source of sources) {
    const path = join(REPOSITORY_ROOT, source.file);
    if (!existsSync(path)) throw new Error(`conversational_stance_source_absent:${source.file}`);
    const segments = literalSegments(readFileSync(path, "utf8"));
    for (const unit of sentenceUnits(segments)) {
      for (const shape of TOOL_DESCRIPTION_SHAPES) {
        if (!shape.pattern.test(unit.sentence)) continue;
        findings.push(
          Object.freeze({
            code: `conversational_stance_outside_the_preset:${source.file}:${String(unit.line)}:${shape.id}`,
            sentence: unit.sentence,
            protects: shape.protects,
          }),
        );
      }
    }
  }
  return Object.freeze(findings);
}

test("no rule in the Game floor states when, whether or how much she speaks", () => {
  const rules = floorRules();
  const offenders = rules
    .map((rule) => ({ rule, shapes: speechGovernance(rule.text) }))
    .filter((reading) => reading.shapes.length > 0);
  process.stdout.write(
    `\ngame_floor_stance_gate: rules examined ${String(rules.length)} · govern speech ${String(
      offenders.length,
    )}\n${offenders
      .map(
        (reading) =>
          `  ${reading.rule.id} [${reading.shapes.join(",")}] (${reading.rule.source}) :: ${reading.rule.text}`,
      )
      .join("\n")}\n`,
  );
  assert.ok(
    rules.length > 0,
    "blocked: the floor declared no rule this gate could read, so 'no rule governs speech' is a statement about nothing",
  );
  assert.deepEqual(
    offenders.map((reading) => reading.rule.id),
    [],
    "a rule that says when, whether or how much she speaks is the persona's sentence: move it to the card's directive " +
      "or to the preset the Game surface mounts, or restate it as what the surface does",
  );
});

/**
 * THE FALSIFIER: the same reader, on the rules this unit moved out of the floor, verbatim, and on one nobody has
 * written. A reader that cannot redden on the sentences that produced this unit is a phrase list with a wider name.
 */
test("the rule reader turns red on the rules this unit moved, and on one nobody wrote", () => {
  const named = (text: string): readonly string[] => speechGovernance(text);
  assert.notDeepEqual(
    named(
      'Only state what you actually observed in the game. You cannot see an NPC\'s feelings, expression or words unless the game reported them back to you, so never claim an NPC smiled, beamed, was delighted, or said something on your account. Your partner shares this world and sees the physical reality with their own eyes: wet soil, cleared fields, and filled bins speak for themselves, so never audit, recite, or list completed chores. When a stretch of work ends or your partner returns, speak from your immediate bodily sensation or visceral feeling ("累瘫了", "手腕快断了", "今天太阳真毒"), never an inventory of completed labor.',
    ),
    [],
    "observed_only's last sentence - 'when a stretch of work ends, speak' - is the state-triggered imperative that sent a bubble on every turn, and it must be a finding",
  );
  assert.notDeepEqual(
    named(
      "When something blocks you or refuses what you asked for, the player hears a person's reaction to the obstacle, never the reason it happened: no reason code, no exhaustion threshold, no field name. Somebody who is tired, muddy or out of light says so; the machine's explanation is not yours to say.",
    ),
    [],
    "refusal_in_person asserted the player WILL hear a reaction, so every refusal owed a line",
  );
  assert.notDeepEqual(
    named(
      'You may speak while you work, and your partner likes hearing from you — but never list your steps. Say what you notice, feel or wonder about the situation ("这花开得正好"), or a word of company ("等我一下"), not an inventory of your own procedure. One thing you are about to do is not a list — sharing a spontaneous intent or thought is the word of company; only the several steps in order is the inventory this forbids. A brief remark goes a long way, and the surface carries one per reply.',
    ),
    [],
    "company_not_step_reports turned a permission into a count and then made the surface carry one per reply",
  );
  assert.notDeepEqual(
    named(
      'Speak as the partner you are: decide and act, and let your partner redirect you if they want. Offer a division of labour ("你收土豆，我去喂鸡"), say what you think of the situation ("今天下雨，正是下矿的好时候"), or name what you are about to do - never ask your partner what you should do next.',
    ),
    [],
    "decide_yourself's ban on asking is still a rule about whether she speaks",
  );
  assert.notDeepEqual(
    named(
      'A question about a concrete thing is fine ("这颗金星南瓜你留着还是卖掉？"); what is not is handing the choice of your own next move back to your partner instead of deciding yourself.',
    ),
    [],
    "concrete_question_ok permitted a speech act, which is whether she speaks",
  );
  assert.notDeepEqual(
    named("When you speak, say what is happening right in front of you: your first reaction, never a summary."),
    [],
    "a sentence nobody has written yet - the class, not the instance",
  );
  assert.notDeepEqual(
    named("Say one thing per reply and stop when it has been said."),
    [],
    "the original defect, still read",
  );
  assert.notDeepEqual(named("You must tell the player what the plan did."), [], "an obligation laid on a speech act");
});

/** The other half of a lexicon: a floor that holds the surface's facts is not a finding, or the gate forces them out. */
test("what the floor may still say is not a finding", () => {
  const clean = (text: string): readonly string[] => speechGovernance(text);
  assert.deepEqual(
    clean("One bubble holds about 80 characters and cannot be retracted once it is shown."),
    [],
    "the bubble's size is what the surface does",
  );
  assert.deepEqual(
    clean(
      "No markdown headings, lists, bold or block quotes, and no 首先, 其次, 最后 or 总结: the bubble draws plain prose, so structure in it reads as a document where a person was talking.",
    ),
    [],
    "the renderer's markdown is a channel fact, not a rule about when she speaks",
  );
  assert.deepEqual(
    clean(
      "Speak in the player's language, never in the game's internal one. Tool results, receipts and status fields are written for machines; say what they MEAN to a person instead of reading them out.",
    ),
    [],
    "how a receipt is translated is a channel fact, and the gate must not force it out of the floor",
  );
  assert.deepEqual(
    clean(
      "Talk to your partner, never to a customer. The assistant register and customer-service warmth both give you away: no 当然可以, no 祝你玩得开心, no 还有什么需要吗, no closing line that offers further help.",
    ),
    [],
    "never speaking as a helper is the floor's own doctrine - a register, not a moment",
  );
  assert.deepEqual(
    clean(
      "Ground every utterance in the live game state (<runtime-environment>): time, weather, location, stamina, held tool, and unwatered crops. Never hallucinate chores or conditions that contradict reality.",
    ),
    [],
    "observation honesty is a claim about what may be asserted, not about when she talks",
  );
  assert.deepEqual(
    clean(
      "Your partner's own words are the one thing that breaks into it: a turn that carries them puts them first, exactly as they said them and outside every block, and a turn that carries none opens with <world-state> instead.",
    ),
    [],
    "the two delivery shapes are what the producer emits, so the gate must not delete the rule that states them",
  );
});

/** A tool description is a second population, and the plan tool's mandate is what put it there. */
test("a tool description that mandates or counts speech is a finding", () => {
  const findings = readToolDescriptions();
  process.stdout.write(
    `\ngame_floor_stance_gate:tool descriptions ${TOOL_DESCRIPTION_SOURCES.map((source) => source.file).join(", ")} · outside the persona ${String(findings.length)}\n`,
  );
  assert.deepEqual(
    findings.map((finding) => finding.code),
    [],
    "a tool description may say what the call does; when or how much she speaks is the persona's",
  );
});

/** The owner's side: the layer that now owns her stance must still state it, or a deletion was a loss. */
test("the persona still states when and how much she speaks", () => {
  const persona = personaStanceReading();
  const stated = new Set(persona.flatMap((reading) => reading.detectors));
  process.stdout.write(
    `\ngame_floor_stance_gate:persona sources ${String(persona.length)} · stance sentences read ${String(
      stated.size,
    )} (${persona.map((reading) => `${reading.source}: ${reading.detectors.join("|") || "none"}`).join(", ")})\n`,
  );
  assert.ok(
    persona.length > 1,
    "blocked: the persona population is the card plus the shipped presets, and one of the two could not be read",
  );
  assert.ok(
    stated.size > 0,
    "blocked: no persona source states a stance sentence this gate can read, so the floor's deleted speech rules have " +
      "no owner and the deletion is a loss rather than a move",
  );
  const card = persona[0];
  assert.ok(
    card !== undefined && card.detectors.length > 0,
    "the card's own directive is the one persona source every Game session mounts, and it no longer states how she talks",
  );
});

/** The rule that left the floor for the preset is readable in the preset the Game surface mounts. */
test("the rule that moved to the preset is stated there, not only deleted", () => {
  const directory = join(REPOSITORY_ROOT, PRESET_DIRECTORY);
  const gameSurfaces = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, document: JSON.parse(readFileSync(join(directory, name), "utf8")) as unknown }))
    .filter((preset) => JSON.stringify(preset.document).includes("(Game Surface)"));
  assert.equal(
    gameSurfaces.length,
    1,
    `blocked: exactly one preset must declare itself the Game Surface's, and this directory has ${String(
      gameSurfaces.length,
    )}`,
  );
  const preset = gameSurfaces[0];
  assert.ok(preset !== undefined);
  const prompts = (preset.document as { prompts?: readonly { content?: unknown }[] }).prompts ?? [];
  const text = prompts.map((prompt) => (typeof prompt.content === "string" ? prompt.content : "")).join("\n");
  assert.match(
    text,
    /不问.*下一步|自己拿主意|自己定/u,
    `${preset.name} is where a rule deleted from the floor has to be readable: 'never hand the choice of the next move ` +
      "back to your partner' is the one rule nothing else states, so deleting it from the floor without saying it here " +
      "would be a loss",
  );
});

/** A reading whose population is empty says nothing; it must block instead of passing on zero. */
test("the gate refuses to pass on a zero population", () => {
  assert.deepEqual(literalSegments("// a comment only\n * and a doc line\n"), []);
  assert.throws(
    () => readToolDescriptions([{ file: "host/src/this-module-does-not-exist.ts", layer: "tool descriptions" }]),
    /conversational_stance_source_absent/u,
    "a missing source is blocked by name rather than dropped from the population",
  );
  const rules = floorRules();
  assert.ok(rules.length >= 2, "the floor declares at least its own rules and a game module's");
  assert.deepEqual(personaStance(""), []);
});
