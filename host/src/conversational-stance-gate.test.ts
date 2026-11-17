import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { GAME_SURFACE_CONDUCT_RULES } from "./game-surface-prompt-floor.js";
import { FACT_PRODUCERS } from "./event-pump.js";
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
 *
 * <p>
 * THE FACT BLOCKS ARE THE THIRD, and the one that outlived the other two fixes. A fact block is neither a rule nor a
 * tool description, so a sentence in one was read by nothing: `companion-arrival-fact.ts` said the two things only the
 * Host knows and then told her to speak (see the population's own docblock below). The population is derived from the
 * pump's declared producers and the modules that spell a fact's text, and the detector is this file's own
 * `speech_mandated` - widened here to read a speech act at the head of a clause in either language, because the
 * sentence that shipped was Chinese and imperative.
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

/**
 * WHERE A COMMAND STARTS. A speech act is being ASKED of her when it heads a clause - after a sentence end, a comma,
 * a colon, or the start of the string - and reported when it sits inside one. That position, not the word, is what
 * separates "，说你想说的第一句话" (a command) from "玩家后来开口说话" (a report).
 */
const CLAUSE_START = String.raw`(?:^|[。！？：；，、:\n])`;

/**
 * The adverbs a Mandarin command may put before its verb, and nothing else: 「不要只说」 is a ban on a shape, not a
 * command to speak, and a lead set this small is what keeps the two apart without a phrase list of bans.
 */
const MANDARIN_LEAD = String.raw`(?:请|就|先|再|也|还是|快|立刻|马上|然后|接着|干脆)?\s*`;

const ENGLISH_LEAD = String.raw`(?:please\s+|just\s+|then\s+|and\s+|so\s+)?`;

/**
 * The verbs that are HER speaking, in the imperative.
 *
 * `talk` is deliberately absent: "Talk to a villager" is the game's own verb for an action (`game-tools.ts`), not an
 * instruction to her about speaking, and a detector that read it as one would red the tool-description population on
 * a phrase that is doing its job.
 */
const IMPERATIVE_SPEECH_EN = String.raw`say|speak|tell|reply|announce|narrate`;
const IMPERATIVE_SPEECH_ZH = String.raw`说|说出|说说|讲|讲讲|告诉|开口|聊|聊聊|回应|回答|喊`;

/**
 * THE ONE SPEECH-MANDATE DETECTOR, read over both text populations: the tool descriptions the model is handed, and
 * every string a fact producer contributes.
 *
 * <p>
 * The last two clauses are what this unit added, and why: the first four read phrasings in ENGLISH and in the third
 * person ("you must say", "the player hears"). The defect that survived three fixes of this class was Chinese and
 * imperative - 「用你自己一贯开口的语气，说你想说的第一句话」 - so the shape it belongs to had to become "a speech act at the
 * HEAD of a clause", in either language, whether it arrives as a command or as a description of the surface that
 * leaves silence no room ("your partner sees your bubble"). Each clause is read over both populations below, and the
 * falsifier in this file proves them on the verbatim sentence that shipped and on sentences nobody has written.
 * </p>
 */
const SPEECH_MANDATED = Object.freeze({
  id: "speech_mandated",
  protects:
    "an instruction that she must speak ('end your turn and speak to the player', 'say the first thing you want to say'), " +
    "in any language, is the persona's sentence",
  pattern: new RegExp(
    [
      String.raw`\bend (?:your|the) turn\b\s*(?:[,;]\s*)?(?:and|then)\s+(?:you\s+)?(?:must\s+|should\s+|always\s+)?(?:speak|say|talk|tell|reply|answer)\b`,
      String.raw`\b(?:make sure|be sure|remember|do not forget)\s+(?:to\s+|you\s+)?(?:speak|say|talk|tell|reply|answer)\b`,
      String.raw`\bspeak to (?:the|your) player\b(?!\s+(?:when|whenever|if|unless|once|only|as|while|before|after|until)\b)`,
      String.raw`\b(?:you|she)\s+(?:must|should|have to|has to|need to|needs to)\s+(?:always\s+|also\s+)?(?:speak|say|talk|tell|reply|answer)\b`,
      // A description of the surface counts, because it lands as an obligation: "your partner sees your bubble" has no
      // other reading than "therefore say something for them to see".
      String.raw`\b(?:your|the) (?:player|partner)\s+(?:hears|gets|receives|is told|sees|reads)\b[^.!?]{0,40}\b(?:bubble|words?|line|voice|reply)\b`,
      `${CLAUSE_START}\\s*(?:(?:in|with)\\s[^,:：\\n]{0,40}(?:voice|tone)[^,:：\\n]{0,10}[:：,]\\s*)?${ENGLISH_LEAD}(?:${IMPERATIVE_SPEECH_EN})\\b`,
      `${CLAUSE_START}\\s*(?:用[^，。：\\n]{0,30}(?:语气|口吻)[，：]\\s*)?${MANDARIN_LEAD}(?:${IMPERATIVE_SPEECH_ZH})`,
    ].join("|"),
    "iu",
  ),
});

/** The shape a tool description was measured with besides the mandate, plus the two counts. */
const TOOL_DESCRIPTION_SHAPES = Object.freeze([
  SPEECH_MANDATED,
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
  return Object.freeze(findings);
}

// ---------------------------------------------------------------------------------------------------------------
// The third population: every string a fact producer contributes.
// ---------------------------------------------------------------------------------------------------------------

/**
 * A STRING A FACT PRODUCER CONTRIBUTES IS THE PERSONA'S TOO, AND THIS IS THE POPULATION THAT SAID SO.
 *
 * <p>
 * THE DEFECT. `companion-arrival-fact.ts` minted the once-per-session "you have arrived, and the clock has ticked"
 * fact and then went on to instruct her: 「用你自己一贯开口的语气，说你想说的第一句话」 / "Open this morning in the voice you
 * always open with: say the first thing you want to say". The block's own account says why it looked reasonable - "it
 * states the two things only the Host knows, and then hands the turn to her" - and that is exactly the seam: stating
 * the fact is the fact's job, and handing her the turn became telling her to speak. Two earlier units cleared this rule
 * out of the conduct floor and out of the tool descriptions, and neither looked here, because a fact block is not a
 * rule and not a tool description. `design/input-authority.md` § three names the class: a behavioural command in the
 * context-assembly writer is a defect, "including when it arrives as a description of a fact".
 * </p>
 *
 * <p>
 * THE POPULATION IS DERIVED FROM THE PUMP, NOT LISTED HERE. `FACT_PRODUCER` (`event-pump.ts`) is the declared set of
 * everything that can put a fact on the pump, and `event-pump.fact-producer.test.ts` is the gate that keeps it equal to
 * the call sites. This reader starts from those call sites and widens by one idea: the text a fact carries is authored
 * where the fact is BUILT, not necessarily where it is enqueued. So the population is
 * </p>
 *
 * <ul>
 *  <li>every production module that calls a fact door (`enqueueFact`, `acceptHostMintedFact`, `announceHostFact`);</li>
 *  <li>every production module that spells a `contextProjection` property - the one field a fact's own prose lives in;</li>
 *  <li>every production module that READS one (`fact-brief.ts` renders it into the line the model reads,
 *    `event-pump.ts` forwards it into a batch payload), because a sentence added there reaches the model exactly as the
 *    arrival's did;</li>
 *  <li>and, to a fixed point, every production module that a `contextProjection` value resolves to, because a
 *    projection may be composed elsewhere (`contextProjection: projection` in
 *    `stardew-integration-launcher-body-program.internal.ts` names `projectGameSnapshotContext` in
 *    `snapshot-projection.ts`).</li>
 * </ul>
 *
 * <p>
 * What the population is NOT, and why: `identity-profile.ts`, `companion-prompt-assembly.ts` and the preset JSON are the
 * persona layer, which OWNS every sentence about when she speaks - this file's own `the persona still states when and
 * how much she speaks` reads them in the other direction. A mandate there is the rule working; a mandate here is the
 * rule leaking into a block of facts.
 * </p>
 *
 * <p>
 * THE UNIT IS ONE LITERAL, not one joined sentence: a fact module's literals are keys, identifiers and prose side by
 * side, and joining them into sentences (as the tool-description reader does) reports the line the joined blob started
 * on rather than the line the sentence is on. Each literal is one string the module hands the model, and it carries
 * its own line.
 * </p>
 *
 * <p>
 * THE CENSUS IT PRINTS, and what each number measures, because "0 violations" without a population says nothing. Read
 * 2026-11-22 of the PRE-FIX tree - the arrival paragraph restored from `7e82e53f^`, so this is the real history and not an
 * injection - and over the FINAL population: 11 declared producers · 3 modules spell a fact's own text
 * (`companion-arrival-fact.ts`, `native-notice-fact.ts`, and `host-service.ts`'s voice-interruption note) · 8 modules read
 * (those three, the materializer and the launcher that hand facts to the pump, the snapshot projection that composes the
 * launcher's, and `event-pump.ts` and `fact-brief.ts` that read a projection and render it) · 1004 literals, 188 of them
 * prose · of the prose, 184 facts, **2 form sentences and 2 speech mandates** - all four in `companion-arrival-fact.ts`,
 * at lines 163, 170 (the mandates) and 164, 171 (the form), and all four are FINDINGS: the mandate class and the form class
 * are both asserted. Read the same way AFTER the fix: 998 literals, 183 prose, 183 facts, 0 form, 0 mandates.
 * </p>
 *
 * <p>
 * THE OTHER SEVEN PRODUCERS CONTRIBUTE NO PROSE AT ALL, which is why the counts above are as small as they are, and the
 * reading is theirs to state: `takeStallFact`, `takeWorldStateStaleFact` and `takeNarrationWithoutWorkFact` carry a
 * payload of keys (the stall fact's own docblock: "No prose: the pump holds no presentation locale"),
 * `#worldStateRefreshRefusedFact` carries a reason code, `program-settlement-digest.ts` carries counts and node rows,
 * `transportLifecycle` carries the event, and the snapshot's text is the projection module's. A producer that starts
 * writing prose joins this population by speaking a `contextProjection`, and the falsifier below shows that a planted
 * module does.
 * </p>
 */

/** A call to one of the three doors a fact enters the pump by. The set is `event-pump.fact-producer.test.ts`'s. */
const FACT_DOOR_CALL = /\.(?:enqueueFact|acceptHostMintedFact|announceHostFact)\(/u;

/**
 * The other end of the same fact: a module that READS a projection. `fact-brief.ts` is where a fact's own text becomes the
 * line the model reads (`fact.contextProjection?.text`), and `event-pump.ts` forwards it into the payload a batch is
 * composed from - so both compose what a block says, and a sentence added there reaches the model exactly as the
 * arrival's did.
 */
const FACT_PROJECTION_READER = /\.contextProjection\b/u;

/** A production module's exported names, so a projection value can be followed to the module that composes it. */
const EXPORTED_SYMBOL = /^export (?:async )?(?:function|const|class) ([A-Za-z_$][\w$]*)/gmu;

/**
 * What a module does with a fact's `contextProjection`, read from the syntax rather than from the spelling.
 *
 * <p>
 * The distinction cannot be made by regex: `contextProjection: projection` in an object literal and
 * `{ contextProjection: _contextProjection, ...rest }` in a destructuring are the same eleven characters. Read through
 * the compiler, only the PROPERTY ASSIGNMENT is a module handing the model text - and only an object literal is a
 * module spelling it. A destructuring is how `event-pump.ts` strips the projection off a fact, and a reader that counted
 * it as authorship would report a producer writing prose it never wrote.
 * </p>
 */
function projectionReading(text: string): Readonly<{ spells: boolean; composes: readonly string[] }> {
  const source = ts.createSourceFile("fact-text.ts", text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const locals = new Map<string, string>();
  const projections: ts.PropertyAssignment[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined)
      locals.set(node.name.text, node.initializer.getText(source));
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "contextProjection") projections.push(node);
    ts.forEachChild(node, walk);
  };
  walk(source);
  let spells = false;
  const composes = new Set<string>();
  for (const projection of projections) {
    if (ts.isObjectLiteralExpression(projection.initializer)) {
      spells = true;
      continue;
    }
    // `Object.freeze({...})` and any other in-line composition are this module's own text too.
    if (projection.initializer.getText(source).includes("{")) {
      spells = true;
      continue;
    }
    const value = projection.initializer.getText(source);
    for (const match of value.matchAll(/\b([A-Za-z_$][\w$]*)\b/gu)) {
      const name = match[1] ?? "";
      composes.add(name);
      // One hop through a local `const projection = compose(...)`: the composer may live in another module.
      for (const local of (locals.get(name) ?? "").matchAll(/\b([A-Za-z_$][\w$]*)\b/gu)) composes.add(local[1] ?? "");
    }
  }
  return Object.freeze({ spells, composes: Object.freeze([...composes]) });
}

/**
 * FORM IS A DEFECT IN A FACT BLOCK TOO, and this is the reading that says so.
 *
 * <p>
 * A sentence about how the DELIVERY is shaped - "do not read the clock or the weather out as a status report" - is not a
 * fact about the world and not a rule about her voice: it is the floor's CHANNEL (`machine_fields_translated`: "Tool
 * results, receipts and status fields are written for machines ... say what they MEAN to a person instead of reading them
 * out") or the card's own 不报进度. `design/input-authority.md` § two gives the per-turn block one job - the world's current
 * state - so a form sentence there is a second location for a claim the channel owns, which is the class this whole file
 * exists for. The shipped arrival paragraph carried one, beside its mandate.
 * </p>
 *
 * <p>
 * IT IS A COARSE READING AND SAYS SO: a phrase list of the words a form sentence uses, not a structural test. The census
 * prints the population it was read over, so a zero is "nothing in these 59 prose literals", and a finding names the file
 * and the line, so the sentence can be read rather than inferred from a count.
 * </p>
 */
const FORM_SHAPES = /\bstatus report\b|\bmarkdown\b|\bbubble\b|播报|报进度|报备|念成|字数|长度|气泡/iu;

/** A string with a word in it, rather than a key or an identifier: what a reader would call prose. */
const PROSE = /[\u4e00-\u9fff]|\s/u;

/** The production tree every population above is read from. */
const HOST_SOURCE_DIRECTORY = "host/src";

/** Every production source under `host/src`, keyed by its repository-relative path. */
function productionSourceTexts(): ReadonlyMap<string, string> {
  const texts = new Map<string, string>();
  const root = join(REPOSITORY_ROOT, "host", "src");
  for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    const relative = entry.replaceAll("\\", "/");
    if (!relative.endsWith(".ts")) continue;
    if (relative.endsWith(".test.ts") || relative.endsWith(".test-support.ts")) continue;
    if (relative.includes("test-fixtures")) continue;
    texts.set(`${HOST_SOURCE_DIRECTORY}/${relative}`, readFileSync(join(root, entry), "utf8"));
  }
  return texts;
}

type FactTextReading = Readonly<{
  /** The modules read, and why each one is in the population. */
  population: readonly Readonly<{ file: string; roles: readonly string[] }>[];
  /** The modules that spell a fact's own text: the number the census reports as `contribute text`. */
  composed: readonly string[];
  strings: number;
  prose: number;
  fact: number;
  form: number;
  mandates: readonly ToolDescriptionFinding[];
  formFindings: readonly ToolDescriptionFinding[];
  blocked: string | null;
}>;

/**
 * Everything a fact producer contributes, read over the derived population. `sources` is injectable so the falsifier
 * below can hand it a tree that carries the defect.
 */
function readFactText(sources: ReadonlyMap<string, string> = productionSourceTexts()): FactTextReading {
  const exportsByName = new Map<string, string[]>();
  for (const [file, text] of sources)
    for (const match of text.matchAll(EXPORTED_SYMBOL)) {
      const owners = exportsByName.get(match[1] ?? "") ?? [];
      owners.push(file);
      exportsByName.set(match[1] ?? "", owners);
    }

  const roles = new Map<string, Set<string>>();
  const composedBy = new Map<string, readonly string[]>();
  const add = (file: string, role: string): void => {
    const held = roles.get(file) ?? new Set<string>();
    held.add(role);
    roles.set(file, held);
  };
  for (const [file, text] of sources) {
    if (FACT_DOOR_CALL.test(text)) add(file, "hands a fact to the pump");
    const projection = projectionReading(text);
    if (projection.spells) add(file, "spells a fact's own text");
    if (projection.composes.length > 0) add(file, "carries a projection composed elsewhere");
    if (FACT_PROJECTION_READER.test(text)) add(file, "composes a fact's text into the block");
    composedBy.set(file, projection.composes);
  }
  // A projection composed elsewhere names the module that spells it; follow those to a fixed point.
  for (let round = 0; round < 4; round += 1) {
    const known = [...roles.keys()];
    for (const file of known)
      for (const symbol of composedBy.get(file) ?? [])
        for (const owner of exportsByName.get(symbol) ?? [])
          if (!roles.has(owner)) add(owner, `composes ${file}'s projection`);
    if (roles.size === known.length) break;
  }

  const population = [...roles.keys()]
    .sort()
    .map((file) => Object.freeze({ file, roles: Object.freeze([...(roles.get(file) ?? [])].sort()) }));
  const composed = population
    .filter((entry) => entry.roles.includes("spells a fact's own text"))
    .map((entry) => entry.file);
  if (population.length === 0)
    return {
      population,
      composed,
      strings: 0,
      prose: 0,
      fact: 0,
      form: 0,
      mandates: [],
      formFindings: [],
      blocked: "zero_population",
    };
  if (composed.length === 0)
    return {
      population,
      composed,
      strings: 0,
      prose: 0,
      fact: 0,
      form: 0,
      mandates: [],
      formFindings: [],
      blocked: "no_module_spells_a_facts_text",
    };

  const mandates: ToolDescriptionFinding[] = [];
  const formFindings: ToolDescriptionFinding[] = [];
  let strings = 0;
  let proseCount = 0;
  for (const entry of population) {
    for (const literal of literalSegments(sources.get(entry.file) ?? "")) {
      strings += 1;
      // The conditions run over every literal; the census counts prose, so a key is not reported as a fact.
      const isProse = PROSE.test(literal.text);
      if (isProse) proseCount += 1;
      if (SPEECH_MANDATED.pattern.test(literal.text)) {
        mandates.push(
          Object.freeze({
            code: `fact_block_states_when_she_speaks:${entry.file}:${String(literal.line)}:${SPEECH_MANDATED.id}`,
            sentence: literal.text,
            protects: SPEECH_MANDATED.protects,
          }),
        );
        continue;
      }
      if (!isProse || !FORM_SHAPES.test(literal.text)) continue;
      formFindings.push(
        Object.freeze({
          code: `fact_block_shapes_the_delivery:${entry.file}:${String(literal.line)}:form`,
          sentence: literal.text,
          protects:
            "a sentence about how the delivery is shaped belongs to the floor's CHANNEL or to the preset; a fact block's one " +
            "job is the world's current state",
        }),
      );
    }
  }
  return {
    population,
    composed,
    strings,
    prose: proseCount,
    fact: proseCount - formFindings.length - mandates.length,
    form: formFindings.length,
    mandates: Object.freeze(mandates),
    formFindings: Object.freeze(formFindings),
    blocked: null,
  };
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
    clean(
      "One bubble holds 80 characters and cannot be retracted once it is shown, and the sound that opens it is spent " +
        "from that same count. Anything you say past the bubble's ceiling is deleted before your partner sees it: the tail " +
        "does not arrive as a second bubble, and it does not arrive later either.",
    ),
    [],
    "a delivery fact about the surface is not a finding - the text is the rule that left the floor on 2026-11-24, kept as " +
      "this reader's proof that what the floor may still say is not forced out by it",
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

/**
 * The third population: every string a fact producer contributes.
 *
 * The arrival fact is what made this reader exist, and the property is the one the first two populations hold: a block
 * of facts states facts, and a sentence that makes speaking the consequence of the event is the persona's sentence.
 */
test("no string a fact producer contributes tells her to speak", () => {
  const reading = readFactText();
  process.stdout.write(
    `\nfact_block_stance_gate: producers examined ${String(FACT_PRODUCERS.length)} (FACT_PRODUCERS) · contribute text ${String(
      reading.composed.length,
    )} · modules read ${String(reading.population.length)} · strings ${String(reading.strings)} · prose ${String(
      reading.prose,
    )} · fact ${String(reading.fact)} · form ${String(reading.form)} · speech mandate ${String(
      reading.mandates.length,
    )}\n${reading.population.map((entry) => `  ${entry.file} [${entry.roles.join("+")}]`).join("\n")}\n`,
  );
  assert.equal(
    reading.blocked,
    null,
    `blocked: the fact-text population could not be read (${String(reading.blocked)}), so "no mandate in a fact block" is a ` +
      "statement about nothing",
  );
  assert.deepEqual(
    reading.mandates.map((finding) => finding.code),
    [],
    "a fact block states the fact. A sentence that makes speaking the consequence of the event - as a command, in either " +
      "language, or as a description of the surface that leaves silence no room - belongs to the preset or to the floor's " +
      "CHANNEL, not here: delete it there and state it there",
  );
  assert.deepEqual(
    reading.formFindings.map((finding) => finding.code),
    [],
    "a fact block states the fact, and how the delivery is SHAPED is the floor's CHANNEL or the preset's sentence (" +
      "`machine_fields_translated` says what to do with a status field: say what it MEANS instead of reading it out). A " +
      "form rule here is a second location for a claim the channel owns, so delete it here",
  );
});

/**
 * THE FALSIFIER, both directions, on one tree.
 *
 * A reader that only agrees with itself is decoration, so the same reader is handed the paragraph that shipped, a
 * sentence nobody has written yet, and the sentences a fact block is supposed to carry. The shipped paragraph is
 * injected into the real tree rather than described, because a population derived from the tree could otherwise shrink
 * quietly and stay green.
 */
test("the fact-text reader names the paragraph that shipped, and passes the sentences a fact may state", () => {
  const sources = new Map(productionSourceTexts());
  sources.set(
    "host/src/planted-fact.ts",
    [
      "export const PLANTED = Object.freeze({",
      "  contextProjection: Object.freeze({",
      '    text: "用你自己一贯开口的语气，说你想说的第一句话：可以是你看到的、你在意的，或者你想去做的。",',
      "  }),",
      "});",
      "pump.enqueueFact(PLANTED, FACT_PRODUCER.companionArrival);",
    ].join("\n"),
  );
  assert.deepEqual(
    readFactText(sources).mandates.map((finding) => finding.code),
    ["fact_block_states_when_she_speaks:host/src/planted-fact.ts:3:speech_mandated"],
    "the shipped sentence, verbatim, in the language and the position it shipped in, must be named with its line",
  );

  // The other defect from the same paragraph: the form rule beside the mandate. It is a second class, so it gets its own
  // finding, and the sentence is the one that shipped.
  const formSources = new Map(productionSourceTexts());
  formSources.set(
    "host/src/planted-form.ts",
    [
      "export const PLANTED_FORM = Object.freeze({",
      "  contextProjection: Object.freeze({",
      '    text: "不要把时间和天气念成播报，也不要只说“我到了”。",',
      "  }),",
      "});",
      "pump.enqueueFact(PLANTED_FORM, FACT_PRODUCER.companionArrival);",
    ].join("\n"),
  );
  assert.deepEqual(
    readFactText(formSources).formFindings.map((finding) => finding.code),
    ["fact_block_shapes_the_delivery:host/src/planted-form.ts:3:form"],
    "how the delivery is shaped belongs to the floor's CHANNEL or to the preset; the form sentence that shipped beside " +
      "the mandate must be named with its line, or the census's `form` count is a number nothing reads",
  );

  const clean = new Map([
    [
      "host/src/planted-clean.ts",
      [
        "export const FACTS = Object.freeze({",
        "  contextProjection: Object.freeze({",
        '    text: "你刚到这座农场，第一次真的站在这里；世界已经走起来了：现在是春季 1 日 06:00，晴。",',
        "  }),",
        "});",
        "pump.enqueueFact(FACTS, FACT_PRODUCER.companionArrival);",
      ].join("\n"),
    ],
    [
      "host/src/planted-others.ts",
      [
        "export const NOTICE = 'The game\'s own notice: It\'s getting late...';",
        "export const VOICE = '上一句语音在播放中被玩家打断（玩家后来开口说话），玩家没有听到那句话的结尾。';",
        "export const DISPATCHED = '上面这些只是派出去了：还没结算，就等于一步都还没做成。';",
        "export const STALE = '（world_state_stale:5;352;900000（这块世界观察停在 5 轮之前，世界已经不是这样了））';",
        "pump.enqueueFact(NOTICE, FACT_PRODUCER.nativeNotice);",
      ].join("\n"),
    ],
  ]);
  const passing = readFactText(clean);
  assert.equal(passing.blocked, null);
  assert.deepEqual(
    passing.mandates.map((finding) => finding.sentence),
    [],
    "the fact itself, the game's own notice, the cut-off voice note, dispatched-is-not-done and the stale parenthetical " +
      "are statements: a reader that reds on them would delete the facts it exists to protect. THE STALE ONE HAD TO " +
      "CHANGE: it shipped ending `；先看一眼再动手`, which is an order, and citing it here as a statement is how the order " +
      "survived two gates — this reader's classes are speech and form and cannot name an action command, so the class " +
      "that owns it is the census's `fact_block_issues_an_instruction`, which reds on the shipped sentence. The note as " +
      "it now reads states the age and stops there",
  );
  assert.deepEqual(
    passing.formFindings.map((finding) => finding.sentence),
    [],
    "none of those five states how the delivery is shaped, and a form reading that reds on them would push the world's " +
      "own facts out of the block",
  );
  assert.ok(passing.prose > 0, "the clean tree must actually carry prose, or its silence proves nothing");
});

/** A sentence nobody has written yet: the class, not the instance the gate was built from. */
test("the mandated shapes are read in either language, and the surface description counts", () => {
  const mandated = [
    "your partner sees your bubble, so keep it short",
    "Speak to the player before you move.",
    "Speak again once the tools are done.",
    "你就站在这里，说一句话吧。",
    "用你一贯的口吻，讲两句。",
    "End your turn and speak to the player.",
  ];
  for (const sentence of mandated)
    assert.ok(
      SPEECH_MANDATED.pattern.test(sentence),
      `a mandate this gate cannot read is a mandate it will let through: ${sentence}`,
    );
  const facts = [
    "现在是春季 1 日 06:00，晴。",
    "The clock has ticked: it is 06:00 and clear.",
    "她说完了，然后走开了。",
    "看了一会儿，又把锄头放下了。",
  ];
  for (const sentence of facts)
    assert.equal(
      SPEECH_MANDATED.pattern.test(sentence),
      false,
      `a fact stated in the past tense is not a command to speak: ${sentence}`,
    );
});

/** Zero population and a doorless tree block the gate: neither may pass on nothing. */
test("the fact-text reader refuses to pass on a population that says nothing", () => {
  assert.equal(readFactText(new Map()).blocked, "zero_population");
  const doorsOnly = readFactText(
    new Map([["host/src/planted-door.ts", "pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);\n"]]),
  );
  assert.equal(
    doorsOnly.blocked,
    "no_module_spells_a_facts_text",
    "a tree whose facts carry no text of their own is a derivation that broke, not a population with nothing to say",
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
  const presets = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, document: JSON.parse(readFileSync(join(directory, name), "utf8")) as unknown }));
  // A surface declared by two presets leaves the run with no single answer to "which preset am I measuring", so the
  // invariant is one home per surface - stated as the declaring pairs, which name themselves when it breaks.
  const homes = new Map<string, string[]>();
  for (const preset of presets)
    for (const [marker] of JSON.stringify(preset.document).matchAll(/\([A-Za-z ]+ Surface\)/gu))
      homes.set(marker, [...(homes.get(marker) ?? []), preset.name]);
  assert.deepEqual(
    [...homes].filter(([, files]) => files.length > 1),
    [],
    "blocked: every surface must have exactly one home preset, and these are declared by more than one",
  );
  const gameSurfaces = presets.filter((preset) => JSON.stringify(preset.document).includes("(Game Surface)"));
  assert.ok(
    gameSurfaces.length > 0,
    `blocked: no preset declares itself the Game Surface's, so the rule deleted from the floor has no home: ${[...homes]
      .map(([marker, files]) => `${marker} in [${files.join(", ")}]`)
      .join("; ")}`,
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
