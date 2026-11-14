import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * WHEN SHE SPEAKS IS THE PRESET'S RULE, AND THE GAME SURFACE'S OWN INPUT SAYS NOTHING ABOUT IT.
 *
 * <p>
 * The defect this gate exists for was an implicit state machine split across two layers that never met:
 * `body-program-script.ts` ended the plan tool's description with "…so end your turn and speak to the player", and
 * `game-surface-prompt-floor.ts` told her to "say one thing per reply and stop when it has been said". Together they
 * read as WAKE UP - SAY ONE THING - STOP, whether or not there was a thing to say. Measured on a Game run: 120 turns
 * opened, 86 of them `observation:nothing_pending`, and a bubble rule to satisfy on every one of them.
 * </p>
 *
 * <p>
 * The authority order is the one the persona already has: THE PRESET is the file that owns her voice AND every rule
 * about when or how much she speaks (`assets/tavern/presets/*.json`, assembled into the Game request by
 * `runtime-core.internal.ts` `withPresetMain` and the catalog's tail block). The prompt floor owns what may never be
 * said and what the surface does; a tool description owns how to call the tool. None of the three may command her to
 * speak, to stop, or how much one reply carries - those are the preset's sentences, and this gate is what keeps them
 * there.
 * </p>
 *
 * <p>
 * WHY THE POPULATION IS A SOURCE SCAN AND NOT THE ASSEMBLED PROMPT. The finding has to name `file:line`, because the
 * sentence has to be found and deleted, and assembled text has no lines. So each source is read as the string literals
 * its code hands to the model: comment lines are skipped (the floor's own doc quotes the rules it deleted), `label:`
 * fields are skipped (a label names a tool for the UI), and every remaining literal is joined into one text per file,
 * split into sentence units, and mapped back to the line its first character came from. A file whose literals cannot
 * be read leaves the gate BLOCKED rather than green - a mis-parsed floor that passes is worse than no gate.
 * </p>
 *
 * <p>
 * THE PRESET SIDE IS COUNTED, because a deletion is only a move if the owner states the rule that was deleted. The
 * presets are authored in Chinese, so the stance vocabulary has a CJK half beside the English one; a preset rewrite
 * that leaves no readable stance sentence blocks the gate by name instead of passing on zero.
 * </p>
 *
 * <p>
 * The detectors are CONCEPTS, not today's sentences: a quantity of speech (`one utterance`, `one remark per reply`), a
 * stop bound on a speech act (`say ... and stop`, `stop when it has been said`), the turn's end followed by speech
 * (`end your turn and speak to the player`), a silence licence (`work quietly until you are done`), and the Chinese
 * forms the presets themselves use (`说清就停`, `保持安静`, `单条 … 字`). Each names the property it protects, so the
 * failure says what to do with the sentence rather than which string matched.
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

/**
 * The Game surface's own instruction sources: the prompt floor, the conduct rules spliced into it, and the modules whose
 * string literals become the tool descriptions the model is handed.
 *
 * The shared framework and the persona block in `identity-profile.ts` are NOT here on purpose: they are the persona
 * layer - the preset's own side of this split - and the persona block is where a rule about her voice belongs.
 */
const INPUT_SOURCES = Object.freeze([
  Object.freeze({ file: "host/src/game-surface-prompt-floor.ts", layer: "prompt floor" }),
  Object.freeze({ file: "host/src/games/stardew/prompt/stardew-game-conduct.ts", layer: "conduct rules" }),
  Object.freeze({ file: "host/src/body-program-script.ts", layer: "tool descriptions" }),
  Object.freeze({ file: "host/src/game-tools.ts", layer: "tool descriptions" }),
]);

/** The preset layer: the owner of every stance rule, read as a directory so a new preset joins without an edit here. */
const PRESET_DIRECTORY = "assets/tavern/presets";

/**
 * Every concept the gate can go red on: the finding code names the property, so a failure says which rule was broken.
 *
 * A speech act is the subject; the bound is what makes the sentence a rule about WHEN or HOW MUCH rather than about
 * what may be said. A content rule ("never read machine ids out loud", "answer your partner's words first") has no
 * bound and is left to the floor, which is where it belongs.
 */
const STANCE_DETECTORS = Object.freeze([
  Object.freeze({
    id: "speech_stop_bound",
    protects: "a stop bound on a speech act ('say ... and stop', 'stop when it has been said') is the preset's",
    pattern:
      /\b(?:say|speak|talk|tell|reply|answer|deliver)\b[^.!?]{0,60}\b(?:and|then)\s+stop\b|\bstop when it has been said\b/iu,
  }),
  Object.freeze({
    id: "turn_end_then_speak",
    protects: "the turn's end is a tool fact; ordering speech with it is the preset's",
    pattern:
      /\bend (?:your|the) turn\b[^.!?]{0,40}\b(?:and\s+)?(?:speak|say|talk|tell)\b|\bspeak to (?:the|your) player\b/iu,
  }),
  Object.freeze({
    id: "silence_licence",
    protects: "whether silence is allowed while she works is the preset's, not the floor's",
    pattern:
      /\b(?:stay|keep|work|remain)\s+(?:silent|quiet(?:ly)?)\b|\bsilence\b[^.!?]{0,40}\b(?:is|while|means|better)\b|\bdo not speak\b|\bno need to speak\b/iu,
  }),
  Object.freeze({
    id: "utterances_per_reply",
    protects:
      "a quota per reply ('one thing per reply', 'one utterance per reply') is the preset's rule about how much she says",
    pattern: /\b(?:utterance|thing|line|remark|thought|sentence)s?\s+per\s+(?:reply|turn|message)\b/iu,
  }),
  Object.freeze({
    id: "preset_say_and_stop",
    protects: "the Chinese form the presets use for 'say it and stop' - the sentence the floor may not restate",
    pattern: /说清就停|说一句就停|说完就(?:停|收)|一句[^。]{0,12}收住/u,
  }),
  Object.freeze({
    id: "preset_quiet_while_working",
    protects: "the Chinese form for staying quiet during a stretch of work",
    pattern: /保持安静|安静专注|专注干活|无需报备|别废话/u,
  }),
  Object.freeze({
    id: "preset_length_cap",
    protects: "the Chinese form of the per-reply length the preset owns",
    pattern: /(?:单条|每条|一句)[^。]{0,20}\d+\s*[~～-]\s*\d+\s*字|短小精悍/u,
  }),
]);

/** The detectors that read the presets: a stance sentence must be readable in the owner, or the gate is blocked. */
const PRESET_DETECTOR_IDS = Object.freeze(["preset_say_and_stop", "preset_quiet_while_working", "preset_length_cap"]);

const QUOTED_LITERAL = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/gu;
const SENTENCE = /[^.!?。！？]+[.!?。！？]*/gu;
const COMMENT_LINE = /^(?:\*|\/\/|\/\*|\*\/)/u;

type LiteralSegment = Readonly<{ text: string; line: number }>;
type Unit = Readonly<{ sentence: string; line: number }>;
type Finding = Readonly<{ code: string; file: string; line: number; sentence: string; protects: string }>;
type Reading = Readonly<{
  examined: readonly Readonly<{ file: string; literals: number }>[];
  presetStance: number;
  presetFiles: readonly Readonly<{ file: string; sentences: number }>[];
  findings: readonly Finding[];
}>;

/**
 * The string literals one source hands the model, each with the line it starts on.
 *
 * Comment lines are skipped because the floor's own doc quotes the rules it deleted - a history of a rule is not the
 * rule. `label:` lines are skipped because a label names a tool ("Say one line to the lobby"): the description is the
 * instruction, the label is the name.
 */
function literalSegments(source: string): readonly LiteralSegment[] {
  const segments: LiteralSegment[] = [];
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

/**
 * One text per source, split into sentences, each carrying the line its first character came from.
 *
 * The literals are joined with a space and split AFTER joining, so a sentence a description assembles out of two
 * literals is still one unit; the offset of each literal is kept for the map back to a line.
 */
function sentenceUnits(segments: readonly LiteralSegment[]): readonly Unit[] {
  const starts: number[] = [];
  let length = 0;
  for (const segment of segments) {
    starts.push(length);
    length += segment.text.length + 1;
  }
  const text = segments.map((segment) => segment.text).join(" ");
  const units: Unit[] = [];
  for (const match of text.matchAll(SENTENCE)) {
    const piece = match[0];
    const sentence = piece.trim();
    if (sentence.length === 0) continue;
    const at = (match.index ?? 0) + (piece.length - piece.trimStart().length);
    units.push(Object.freeze({ sentence, line: lineAt(segments, starts, at) }));
  }
  return units;
}

function lineAt(segments: readonly LiteralSegment[], starts: readonly number[], at: number): number {
  let line = segments[0]?.line ?? 0;
  for (let index = 0; index < segments.length; index += 1) {
    if ((starts[index] ?? 0) > at) break;
    line = segments[index]?.line ?? line;
  }
  return line;
}

/** Every stance concept a sentence states, by detector id. Empty is the property the gate wants outside the preset. */
function stanceConcepts(sentence: string): readonly string[] {
  return STANCE_DETECTORS.filter((detector) => detector.pattern.test(sentence)).map((detector) => detector.id);
}

function readSource(relativePath: string): string {
  const path = join(REPOSITORY_ROOT, relativePath);
  if (!existsSync(path)) throw new Error(`conversational_stance_source_absent:${relativePath}`);
  return readFileSync(path, "utf8");
}

/** The preset layer's own stance sentences: the evidence that the owner states what the input sources may not. */
function presetStance(): Readonly<{ count: number; files: readonly Readonly<{ file: string; sentences: number }>[] }> {
  const directory = join(REPOSITORY_ROOT, PRESET_DIRECTORY);
  if (!existsSync(directory)) throw new Error(`conversational_stance_preset_directory_absent:${PRESET_DIRECTORY}`);
  const files: { file: string; sentences: number }[] = [];
  let count = 0;
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json")) continue;
    const document = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
      prompts?: readonly { content?: unknown }[];
    };
    let sentences = 0;
    for (const prompt of document.prompts ?? []) {
      if (typeof prompt.content !== "string") continue;
      for (const match of prompt.content.matchAll(SENTENCE)) {
        const sentence = match[0].trim();
        if (sentence.length === 0) continue;
        if (stanceConcepts(sentence).some((id) => PRESET_DETECTOR_IDS.includes(id))) sentences += 1;
      }
    }
    count += sentences;
    files.push(Object.freeze({ file: `${PRESET_DIRECTORY}/${name}`, sentences }));
  }
  return Object.freeze({ count, files: Object.freeze(files) });
}

function readTree(): Reading {
  const examined: { file: string; literals: number }[] = [];
  const findings: Finding[] = [];
  for (const source of INPUT_SOURCES) {
    const segments = literalSegments(readSource(source.file));
    examined.push(Object.freeze({ file: source.file, literals: segments.length }));
    for (const unit of sentenceUnits(segments)) {
      for (const id of stanceConcepts(unit.sentence)) {
        const detector = STANCE_DETECTORS.find((candidate) => candidate.id === id);
        if (detector === undefined || PRESET_DETECTOR_IDS.includes(id)) continue;
        findings.push(
          Object.freeze({
            code: `conversational_stance_outside_the_preset:${source.file}:${String(unit.line)}`,
            file: source.file,
            line: unit.line,
            sentence: unit.sentence,
            protects: detector.protects,
          }),
        );
      }
    }
  }
  const preset = presetStance();
  return Object.freeze({
    examined: Object.freeze(examined),
    presetStance: preset.count,
    presetFiles: preset.files,
    findings: Object.freeze(findings),
  });
}

function report(reading: Reading): string {
  const lines = [
    `input sources examined ${String(reading.examined.length)} · stance sentences in the preset ${String(reading.presetStance)} · outside ${String(reading.findings.length)}`,
    `sources: ${reading.examined.map((source) => `${source.file} (${String(source.literals)} literals)`).join(", ")}`,
    `presets: ${reading.presetFiles.map((preset) => `${preset.file} (${String(preset.sentences)})`).join(", ")}`,
    ...reading.findings.map((finding) => `${finding.code} :: ${finding.sentence} :: ${finding.protects}`),
  ];
  return lines.join("\n");
}

test("no sentence about when or how much she speaks survives outside the preset", () => {
  const reading = readTree();
  process.stdout.write(`\nconversational_stance_gate:${report(reading)}\n`);
  assert.ok(
    reading.examined.length > 0,
    "blocked: the gate examined no input source, so 'no stance sentence outside the preset' is a statement about nothing",
  );
  assert.ok(
    reading.presetStance > 0,
    "blocked: no preset states a stance sentence this gate can read, so the owner of 'when she speaks' is silent and a deletion would be a loss rather than a move",
  );
  assert.deepEqual(
    reading.findings.map((finding) => finding.code),
    [],
    "a sentence that tells her when or how much to speak is the preset's to state: move it there, or reword the input source to say what it may say (what the surface does, or what may never be said)",
  );
});

/**
 * The falsifier: the gate's verdict must be able to be RED, on the sentences it was written for and on one nobody wrote
 * yet. A detector that only ever reports zero agrees with itself.
 */
test("the detectors turn red on the two sentences that proved the defect, and on a new one", () => {
  const flagged = (sentence: string): readonly string[] => stanceConcepts(sentence);
  assert.notDeepEqual(
    flagged(
      "One bubble holds about 80 characters and cannot be retracted once it is shown, so say one thing per reply and stop when it has been said.",
    ),
    [],
    "the floor's stance clause is the sentence the run measured: it must be a finding",
  );
  assert.notDeepEqual(
    flagged(
      "The call returns as soon as the plan is accepted: do NOT poll it - each step's receipt arrives later as a new message, so end your turn and speak to the player.",
    ),
    [],
    "the plan tool's 'speak after every plan' is a finding",
  );
  assert.notDeepEqual(
    flagged("Give your partner one remark per reply and nothing more."),
    [],
    "a sentence nobody has written yet - the class, not the instance",
  );
  assert.notDeepEqual(flagged("During a stretch of work, stay quiet and let the body do the talking."), []);
  assert.notDeepEqual(
    flagged("说清就停：一句家常话收住。"),
    [],
    "the preset's own Chinese form is readable by the same reader",
  );
});

/**
 * The other half of a lexicon: a gate that flags what it must not flag is unusable, so the sentences that are NOT its
 * business are pinned here - the surface's own delivery unit, and a rule about what may be said.
 */
test("what the floor may still say is not a finding", () => {
  assert.deepEqual(
    stanceConcepts("One bubble holds about 80 characters and cannot be retracted once it is shown."),
    [],
    "the bubble's size is what the surface does - a channel fact, not a rule about when she speaks",
  );
  assert.deepEqual(
    stanceConcepts("A brief remark goes a long way, and the surface carries one per reply."),
    [],
    "what the delivery carries is stated as the surface's own behaviour",
  );
  assert.deepEqual(
    stanceConcepts('Say what you notice, feel or wonder about the situation ("这花开得正好").'),
    [],
    "what may be said is the floor's business",
  );
  assert.deepEqual(
    stanceConcepts(
      "Show a feeling through the game, not through text: `stardew_express_emote` raises an emote balloon.",
    ),
    [],
    "a channel rule about body language is not a rule about talking",
  );
});

/** A reading whose population is empty says nothing; it must block instead of passing on zero. */
test("the gate refuses to pass on a zero population", () => {
  assert.deepEqual(literalSegments("// a comment only\n * and a doc line\n"), []);
  assert.throws(
    () => readSource("host/src/this-module-does-not-exist.ts"),
    /conversational_stance_source_absent/u,
    "a missing source is blocked by name rather than dropped from the population",
  );
  const preset = presetStance();
  assert.ok(
    preset.files.length > 0,
    "the preset directory is the population of the owner's side; an empty directory blocks the gate",
  );
  assert.ok(
    preset.count > 0,
    "the owner states at least one stance sentence in words this gate reads, or 'the preset owns when she speaks' is not evidenced",
  );
});
