import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { GAME_SURFACE_CONDUCT_RULES } from "./game-surface-prompt-floor.js";
import * as stardewConduct from "./games/stardew/prompt/stardew-game-conduct.js";
import { buildCompanionDeskGuidance } from "./magic-context-companion-guidance.js";
import { GAME_SESSION_INSPECTION_DESCRIPTION } from "./tool-surface.js";

/**
 * GATE `input_claim_stated_twice`: one instruction, one writer.
 *
 * <p>
 * THE DEFECT. The model input is assembled from six layers that grew independently - the shared floor, the Game floor,
 * the per-game conduct, the preset's post-history tail, the per-turn fact blocks and the tool descriptions - and each of
 * them acquired sentences that belong to another. The cost is not length: a claim written twice teaches the model that
 * the second copy is a separate rule, and when one copy is later corrected the other keeps the old behaviour alive. The
 * stance gate (`conversational-stance-gate.test.ts`) fixed this class one claim at a time - "when she speaks" - and it
 * had to be rewritten twice before it watched the rules instead of the phrasings.
 * </p>
 *
 * <p>
 * THE OWNERSHIP RULE this gate assumes, and the reason a claim is DELETED from the layer that does not own it rather
 * than reworded there:
 * </p>
 *
 * <ul>
 *   <li>card / worldbook - the authored character and lore;</li>
 *   <li>preset - the persona: tone, and every rule about when, whether or how much to speak;</li>
 *   <li>floor + conduct - what the blocks mean, what counts as an action, what the surface does, what may never be said;</li>
 *   <li>per-turn blocks - the world, and the machine's own report of it;</li>
 *   <li>tool descriptions - how to call the tool, never what to feel or when to speak.</li>
 * </ul>
 *
 * <p>
 * THE PROPERTY. Two sentences written by two different writers are the same claim when they are in the same language and
 *   (a) their normalised content words overlap by Dice >= 0.45 (the same sentence, reworded), or
 *   (b) they share at least three content words that occur in at most four claims of this corpus (the same distinctive
 *       subject named twice - "customer service", "one item back whole").
 * Normalisation strips markup, quote marks, punctuation and case, drops function words, and stems English plurals and
 * endings; CJK is compared as character bigrams. A pair that matches is a collision unless `RECORDED` names it, and
 * every record has to say why the two writers are not one claim stated twice.
 * </p>
 *
 * <p>
 * WHAT THIS GATE CANNOT SEE, stated so nobody mistakes green for clean: a paraphrase that keeps no distinctive word
 * ("say the first thing you want to say" vs "开口说你想说的第一句") is below both thresholds, and a claim repeated in a
 * third language is invisible to a same-language comparison. The tables in the change that added this gate carry those
 * pairs by hand; this gate holds the ones a machine can re-measure on every run.
 * </p>
 *
 * <p>
 * THE POPULATION is derived, never listed by hand: the floor's rules come from `GAME_SURFACE_CONDUCT_RULES`, the
 * Stardew module's from `STARDEW_GAME_CONDUCT_CLASSES` joined to the module's own exports (a class row naming no export
 * throws instead of shrinking the population), the desk protocol from the function that renders it, the inspection
 * description from the constant that is mounted, and every other writer is scanned out of its source file - every string
 * literal, attributed to the declaration that holds it. The personas and worldbooks are read from the files the Game
 * session mounts. Zero population is blocked, and the counts are printed on every run.
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

/** One sentence one writer writes, with the writer named the way a failure names it. */
type Claim = Readonly<{ writer: string; text: string; language: "en" | "zh"; tokens: readonly string[] }>;

/** One unit of text a writer owns: a rule's text, a constant, an asset entry. */
type Unit = Readonly<{ writer: string; text: string }>;

/** English function words. A content word is what is left. */
const FUNCTION_WORDS = new Set(
  `a an the and or but if when while of to in on at by for with from into over under about as is are was were be been
   being it its this that these those there here you your yours yourself we our us i me my he she they them their his her
   do does did done doing not no never always must can could should would may might will shall have has had so than then
   too very just only also even more most less least all any some every each other another same such what which who whom
   whose where why how one two three four five out up down off again further once about both few`
    .split(/\s+/)
    .filter((word) => word.length > 0),
);

const CJK = /[\u3400-\u9fff]/;
const INSTRUCTION = /\byou\b|\byour\b|\byourself\b|\byou're\b|never|do not|don't|must|always|不要|别|不准|你/u;

/** The stem this gate compares on. Long enough to keep "says" and "said" apart from unrelated words, short enough to join them. */
function stem(word: string): string {
  if (word.length <= 4) return word;
  for (const suffix of ["ing", "ed", "es", "s"])
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length);
  return word;
}

function wordsOf(sentence: string): readonly string[] {
  return sentence
    .toLowerCase()
    .replace(/[`*_>#"“”‘’()[\]{}<>]/gu, " ")
    .split(/[^a-z0-9\u3400-\u9fff]+/u)
    .filter((word) => word.length > 1 && !FUNCTION_WORDS.has(word) && !/^\d+$/u.test(word))
    .map(stem);
}

function bigramsOf(sentence: string): readonly string[] {
  const characters = [...sentence.toLowerCase()].filter((character) => CJK.test(character)).join("");
  const bigrams: string[] = [];
  for (let index = 0; index + 1 < characters.length; index++) bigrams.push(characters.slice(index, index + 2));
  return bigrams;
}

function languageOf(sentence: string): "en" | "zh" {
  const cjkChars = [...sentence].filter((character) => CJK.test(character)).length;
  const latinWords = sentence
    .replace(/[^A-Za-z ]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean).length;
  return cjkChars > latinWords ? "zh" : "en";
}

function sentencesOf(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?;])\s+|(?<=[。！？；])/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Every instruction this text states, as claims. A sentence that names no second person and no prohibition is not one. */
function claimsOf(writer: string, text: string): readonly Claim[] {
  const claims: Claim[] = [];
  for (const sentence of sentencesOf(text)) {
    if (!INSTRUCTION.test(sentence)) continue;
    const language = languageOf(sentence);
    const tokens = [...new Set([...(language === "zh" ? bigramsOf(sentence) : wordsOf(sentence))])];
    if (tokens.length < 6) continue;
    claims.push(Object.freeze({ writer, text: sentence, language, tokens: Object.freeze(tokens) }));
  }
  return claims;
}

/** Where a string literal sits: the declarations that hold it, outermost first, so a rule's text names its rule. */
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

/**
 * Every string literal a source file hands the model, attributed to its declaration.
 *
 * `reason` and `detail` properties are skipped: they are the classification argument a reviewer reads, never text the
 * model receives, and a rule that restates itself in its own reason is not two writers stating one claim.
 */
function literalsOf(file: string): readonly Unit[] {
  const path = join(REPOSITORY_ROOT, file);
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ESNext, true);
  const units: Unit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const holder = node.parent;
      const isArgument =
        holder !== undefined &&
        ts.isPropertyAssignment(holder) &&
        ts.isIdentifier(holder.name) &&
        (holder.name.text === "reason" || holder.name.text === "detail");
      const text = node.text;
      const prose =
        text.trim().split(/\s+/u).length >= 5 || [...text].filter((character) => CJK.test(character)).length >= 10;
      if (!isArgument && text.length >= 20 && prose)
        units.push(Object.freeze({ writer: `${file.replace(/^host\/src\//u, "")}:${declarationPath(node)}`, text }));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return units;
}

/** Every string an authored asset states, attributed to the entry that holds it. */
function assetUnits(file: string): readonly Unit[] {
  const units: Unit[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      const prose =
        value.trim().split(/\s+/u).length >= 5 || [...value].filter((character) => CJK.test(character)).length >= 10;
      if (value.length >= 20 && prose) units.push(Object.freeze({ writer: `${file}:${path}`, text: value }));
      return;
    }
    if (Array.isArray(value)) for (const item of value) walk(item, path);
    else if (value !== null && typeof value === "object")
      for (const [key, child] of Object.entries(value)) walk(child, path === "" ? key : `${path}.${key}`);
  };
  walk(JSON.parse(readFileSync(join(REPOSITORY_ROOT, file), "utf8")), "");
  return units;
}

/** The Stardew module's own rules, joined to the class table that names them - the same join `tools/check-game-surface-conduct-classes.mjs` makes. */
function stardewUnits(): readonly Unit[] {
  const exports: Readonly<Record<string, unknown>> = stardewConduct;
  return stardewConduct.STARDEW_GAME_CONDUCT_CLASSES.map((row) => {
    const text = exports[row.id.toUpperCase()];
    if (typeof text !== "string" || text.trim().length === 0)
      throw new Error(
        `conduct_rule_text_unreadable:${row.id}: the class table classifies a rule this module does not export, so the ` +
          "population this gate examines would be smaller than the floor without saying so",
      );
    return Object.freeze({ writer: `games/stardew/prompt/stardew-game-conduct.ts:${row.id.toUpperCase()}`, text });
  });
}

/** The writers of model input this gate examines, derived from the declarations each layer owns. */
function population(): readonly Unit[] {
  const units: Unit[] = [];
  for (const [id, rule] of Object.entries(GAME_SURFACE_CONDUCT_RULES))
    units.push(Object.freeze({ writer: `game-surface-prompt-floor.ts:${id}`, text: rule.text }));
  units.push(...stardewUnits());
  units.push(
    Object.freeze({
      writer: "magic-context-companion-guidance.ts:DESK_GUIDANCE_EN",
      text: buildCompanionDeskGuidance("en"),
    }),
    Object.freeze({
      writer: "magic-context-companion-guidance.ts:DESK_GUIDANCE_ZH",
      text: buildCompanionDeskGuidance("zh-CN"),
    }),
    Object.freeze({
      writer: "tool-surface.ts:GAME_SESSION_INSPECTION_DESCRIPTION",
      text: GAME_SESSION_INSPECTION_DESCRIPTION,
    }),
  );
  for (const file of [
    "host/src/identity-profile.ts",
    "host/src/fact-brief.ts",
    "host/src/companion-arrival-fact.ts",
    "host/src/native-notice-fact.ts",
    "host/src/host-service.ts",
    "host/src/tavern/preset-tail-block.ts",
    "host/src/stardew-integration-launcher-body-program.internal.ts",
  ])
    units.push(...literalsOf(file));
  for (const file of [
    "assets/tavern/presets/amber-game.json",
    "assets/tavern/presets/amber-chat.json",
    "assets/tavern/presets/worldbook-game.json",
    "assets/tavern/presets/worldbook-chat.json",
  ])
    units.push(...assetUnits(file));
  return units;
}

/** One claim stated by two writers, named the way a failure names it. */
type Collision = Readonly<{
  code: string;
  slug: string;
  firstWriter: string;
  secondWriter: string;
  first: Claim;
  second: Claim;
  dice: number;
  shared: readonly string[];
}>;

/** The slug a failure code carries: the claim's own first distinctive words, so a reader knows which sentence to open. */
function slugOf(claim: Claim): string {
  const words = claim.text
    .toLowerCase()
    .replace(/[`*_>#"“”‘’()[\]{}<>:;,.]/gu, " ")
    .split(/[^a-z0-9\u3400-\u9fff]+/u)
    .filter((word) => word.length > 1 && !FUNCTION_WORDS.has(word))
    .slice(0, 4);
  return words.length > 0 ? words.join("-") : "claim";
}

const DICE_FLOOR = 0.45;
const DISTINCTIVE_WORD_FLOOR = 3;
const DISTINCTIVE_WORD_CEILING = 4;

/** The pair's two writer names in one order, so a failure code reads the same however the claims were found. */
function sortedWriters(left: string, right: string): readonly [string, string] {
  return left < right ? [left, right] : [right, left];
}

/** Every pair of claims from two writers that state the same claim. */
function collisionsOf(claims: readonly Claim[]): readonly Collision[] {
  const occurrences = new Map<string, number>();
  for (const claim of claims)
    for (const token of claim.tokens) occurrences.set(token, (occurrences.get(token) ?? 0) + 1);

  const collisions: Collision[] = [];
  for (const left of claims)
    for (const right of claims) {
      if (left.writer === right.writer) continue;
      if (left.language !== right.language) continue;
      if (left.text === right.text) continue;
      const [firstWriter, secondWriter] = sortedWriters(left.writer, right.writer);
      // One direction only: the pair is measured once, from the writer the failure code names first.
      if (firstWriter !== left.writer) continue;
      const rightTokens = new Set(right.tokens);
      const shared = left.tokens.filter((token) => rightTokens.has(token));
      if (shared.length < 2) continue;
      const dice = (2 * shared.length) / (left.tokens.length + right.tokens.length);
      const distinctive = shared.filter((token) => (occurrences.get(token) ?? 0) <= DISTINCTIVE_WORD_CEILING);
      if (dice < DICE_FLOOR && distinctive.length < DISTINCTIVE_WORD_FLOOR) continue;
      const named = left;
      const slug = slugOf(named);
      const collision = Object.freeze({
        code: `input_claim_stated_twice:${slug}:${firstWriter}:${secondWriter}`,
        slug,
        firstWriter,
        secondWriter,
        first: left,
        second: right,
        dice,
        shared: Object.freeze(shared),
      });
      // One pair is one finding however many sentences the two writers share: the ledger answers the PAIR.
      if (!collisions.some((existing) => existing.code === collision.code)) collisions.push(collision);
    }
  return collisions;
}

/**
 * The pairs this tree has already answered, and the answer.
 *
 * A RECORD IS NOT AN EXEMPTION. It says why two writers that share this vocabulary are not one claim stated twice, and
 * the second test below fails when a record no longer matches anything - so a record whose claim was finally deleted,
 * or whose sentence was reworded, has to leave this table instead of standing guard over nothing.
 */
const RECORDED: readonly Readonly<{
  slug: string;
  first: string;
  second: string;
  kind: "projection" | "distinct" | "pending";
  why: string;
  /** For `pending`: the file that owns the deletion, named so the next reader can hand it over. */
  owner?: string;
  /** For `pending`: what stops the deletion today, named by file and line. */
  blockedBy?: string;
}>[] = Object.freeze([
  Object.freeze({
    slug: "speak-voice-lines-above",
    first: "identity-profile.ts:CARD_VOICE_BOUND",
    second: "identity-profile.ts:PLAYER_ADDITION_BOUND",
    kind: "projection",
    why:
      "one bound per authored insertion point: CARD_VOICE_BOUND closes the card's directive and PLAYER_ADDITION_BOUND closes " +
      "the player's own addition, so the second is a projection of the first onto a second insertion point. The two blocks " +
      "are edited by two different people at two different times, and a block without its own closing line leaves that " +
      "insertion point holding the last word of the prompt.",
  }),
  Object.freeze({
    slug: "write-bracketed-stage-direction",
    first: "game-surface-prompt-floor.ts:body_language_is_native",
    second: "identity-profile.ts:CHAT_SURFACE_DIVERGENCE",
    kind: "distinct",
    why:
      "the same construct with two opposite behaviours: the Chat renderer paints the asterisk beat as the action beat and a " +
      "leading parenthesis as the prosody badge, and the Game bubble drops both, so the gesture happens nowhere. Deleting " +
      "either sentence deletes a fact about a surface, not a duplicate.",
  }),
  Object.freeze({
    slug: "write-bracketed-stage-direction",
    first: "game-surface-prompt-floor.ts:body_language_is_native",
    second: "identity-profile.ts:CHAT_SURFACE_ACTION_FORM",
    kind: "distinct",
    why:
      "the Game floor forbids writing a bracketed stage direction at all, while CHAT_SURFACE_ACTION_FORM hands the frequency " +
      "of that same beat to her voice. One is a ban on the Game surface, the other a permission on the Chat surface.",
  }),
  Object.freeze({
    slug: "often-reach-whether-reach",
    first: "identity-profile.ts:CHAT_SURFACE_ACTION_FORM",
    second: "identity-profile.ts:CHAT_SURFACE_DIVERGENCE",
    kind: "distinct",
    why:
      "CHAT_SURFACE_DIVERGENCE says what the surface DRAWS and CHAT_SURFACE_ACTION_FORM says who decides how often; they " +
      "share their subject and state different things about it. The second is also the Chat surface's skip signature for " +
      "the Magic Context block, so it is read as an identity and not only as prose.",
  }),
  Object.freeze({
    slug: "first-line-names-revision",
    first: "game-surface-prompt-floor.ts:fact_batch_blocks",
    second: "games/stardew/prompt/stardew-game-conduct.ts:CONTENT_IDS_IN_WORDS",
    kind: "distinct",
    why:
      "the shared words are line, names, already and fact: one sentence is about the world block's first line naming its " +
      "revision, the other about the fact line naming a held tool. Different referents behind the same four words.",
  }),
  Object.freeze({
    slug: "用你自己一贯开口的语气-说你想说的第一句话-可以是你看到的-你在意的",
    first: "companion-arrival-fact.ts:arrivalText",
    second: "magic-context-companion-guidance.ts:DESK_GUIDANCE_ZH",
    kind: "distinct",
    why:
      "the arrival fact hands the turn to her first words on the morning she arrives; the desk guidance says how a reply is " +
      "numbered and what a marking is. They share the second person, not a claim.",
  }),
  Object.freeze({
    slug: "你正在和自小一起长大的发小-user-同屏联机开黑打-星露谷物语",
    first: "assets/tavern/presets/amber-game.json:prompts.content",
    second: "magic-context-companion-guidance.ts:DESK_GUIDANCE_ZH",
    kind: "distinct",
    why:
      "the preset says who she is playing with and in what game; the desk guidance says what her context is. The shared " +
      "words are 一起 and 星露谷, the game both are about.",
  }),
]);

/**
 * The ledger a review can find by code, keyed the way a failure names it.
 *
 * `kind` is the ANSWER: `projection` - one writer renders the other (a language, a surface, an insertion point), so the
 * claim is stated once per reader and neither copy can be deleted; `distinct` - the two share vocabulary and state
 * different things, named in `why`.
 */
function recordedFor(collision: Collision): (typeof RECORDED)[number] | undefined {
  return RECORDED.find(
    (record) =>
      record.slug === collision.slug &&
      record.first === collision.firstWriter &&
      record.second === collision.secondWriter,
  );
}

function unrecorded(collisions: readonly Collision[]): readonly Collision[] {
  return collisions.filter((collision) => recordedFor(collision) === undefined);
}

const CLAIMS = population().flatMap((unit) => claimsOf(unit.writer, unit.text));
const COLLISIONS = collisionsOf(CLAIMS);

test("no instruction is stated twice across the writers of model input", () => {
  const writers = new Set(CLAIMS.map((claim) => claim.writer));
  process.stdout.write(
    `\ninput_claim_gate: writers examined ${String(writers.size)} · claims extracted ${String(CLAIMS.length)} · ` +
      `stated twice ${String(COLLISIONS.length)} · recorded ${String(COLLISIONS.length - unrecorded(COLLISIONS).length)}\n`,
  );
  for (const collision of COLLISIONS) {
    const record = recordedFor(collision);
    if (record !== undefined) continue;
    process.stdout.write(
      `  UNRECORDED ${collision.code}\n    A: ${collision.first.text.slice(0, 160)}\n    B: ${collision.second.text.slice(0, 160)}\n    shared: ${collision.shared.join(", ")}\n`,
    );
  }
  for (const record of RECORDED)
    if (record.kind === "pending")
      process.stdout.write(
        `  PENDING ${record.slug}\n    owner: ${String(record.owner)}\n    blocked by: ${String(record.blockedBy)}\n`,
      );
  assert.ok(
    writers.size >= 10,
    `input_claim_gate_population_too_small:${String(writers.size)}: the population is the writers, not a list of pairs`,
  );
  assert.ok(
    CLAIMS.length >= 40,
    `input_claim_gate_claims_too_few:${String(CLAIMS.length)}: a corpus this thin would agree with itself`,
  );
  assert.deepEqual(
    unrecorded(COLLISIONS).map((collision) => collision.code),
    [],
    "two writers state one claim: delete it from the layer that does not own it, or record why the two are not one claim",
  );
});

test("the ledger only holds pairs this tree still contains", () => {
  const stale = RECORDED.filter(
    (record) =>
      !COLLISIONS.some(
        (collision) =>
          collision.slug === record.slug &&
          collision.firstWriter === record.first &&
          collision.secondWriter === record.second,
      ),
  );
  assert.deepEqual(
    stale.map((record) => `input_claim_record_stale:${record.slug}:${record.first}:${record.second}`),
    [],
    "a record that matches no collision is an exemption over nothing: delete it with the claim it described",
  );
});

test("a record names its mechanism, not its review", () => {
  // The supervision ruling this test encodes: a ledger entry that says "reviewed - distinct" is the allow-list every
  // other gate in this tree was written to delete, and it outlives its reason without anyone noticing. A projection has
  // to name what renders what; a pending has to name its owner and what blocks it.
  const PROJECTION_MECHANISM =
    /projection|render|per (language|surface|reader|insertion)|insertion point|derived from/iu;
  const findings: string[] = [];
  for (const record of RECORDED) {
    if (record.why.trim().split(/\s+/u).length < 12)
      findings.push(
        `input_claim_record_unargued:${record.slug}:${record.first}:${record.second}: the reason is a phrase`,
      );
    if (record.kind === "projection" && !PROJECTION_MECHANISM.test(record.why))
      findings.push(
        `input_claim_projection_unnamed:${record.slug}:${record.first}:${record.second}: say what renders what`,
      );
    if (record.kind === "pending" && (record.owner === undefined || record.blockedBy === undefined))
      findings.push(
        `input_claim_pending_unnamed:${record.slug}:${record.first}:${record.second}: name the owner and the block`,
      );
  }
  assert.deepEqual(
    findings,
    [],
    "every record states the mechanism, and a pending names who owns the deletion and why it is blocked",
  );
});

test("the reader turns red on one claim written twice, and green on a projection", () => {
  const duplicated = [
    ...claimsOf(
      "floor.ts:greeting",
      "Never greet the player with a customer-service line: you are a person in this world.",
    ),
    ...claimsOf(
      "tool.ts:greeting",
      "Never greet the player with a customer-service line: you are a person in this world, not staff.",
    ),
  ];
  assert.equal(duplicated.length, 2, "the synthetic pair has to read as two claims, or the falsifier proves nothing");
  const found = collisionsOf(duplicated);
  assert.equal(found.length, 1, "the same sentence in two writers must be one collision");
  const [onlyFound] = found;
  assert.ok(onlyFound !== undefined);
  assert.match(
    onlyFound.code,
    /^input_claim_stated_twice:greet-player-customer-service:floor.ts:greeting:tool.ts:greeting$/u,
  );

  const projection = [
    ...claimsOf("card.json:voice", "Speak in your own voice and never narrate the player's reactions for them."),
    ...claimsOf("preset.json:voice", "Speak in your own voice - never narrate the player's reactions."),
  ];
  assert.ok(
    collisionsOf(projection).length > 0,
    "a projection still has to be DETECTED; the record is what answers it, not the reader",
  );
  assert.deepEqual(
    unrecorded(collisionsOf(projection)),
    collisionsOf(projection),
    "an unrecorded projection is still a collision",
  );

  const differentLanguages = [
    ...claimsOf("floor.ts:a", "Never read the clock out as a status report."),
    ...claimsOf("preset.json:b", "不要把时间和天气念成播报。"),
  ];
  assert.deepEqual(
    collisionsOf(differentLanguages),
    [],
    "a same-language comparison cannot claim two languages state one claim",
  );
});

test("a corpus with no claims is blocked, not passed", () => {
  assert.deepEqual(claimsOf("quiet.ts:nothing", "the"), []);
  assert.deepEqual(
    collisionsOf([]),
    [],
    "an empty population agrees with itself; the population assertion above is what blocks it",
  );
});
