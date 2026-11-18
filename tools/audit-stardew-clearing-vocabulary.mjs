// Gate: stardew_clearing_vocabulary/v1
//
// THE CLASS THIS NAMES: a word the world publishes for what stands on a tile, and no published action that answers to
// it. The measure is `round58`, and it is three lines of the run's own bytes:
//
//   turn 26  `no_row_matched_where:occupant_in_stone:none_tree_crop_object:decided=60`
//   turn 27  `no_published_action_clears:object:refused=11`
//   her plan `grass -> stone -> till`, and the Mod ran it serially (22 of 60 tiles tilled, 0 before their clutter)
//
// She filtered the strip for `stone`, matched nothing, and the tiles she could not work were published as `object` - a
// word no `Clears` declaration anywhere in the catalog names. `object` was not a kind she could act on; it was two
// different things (the engine's stone litter and its twig litter) wearing the name of a third (anything else in the
// objects layer), and the refusal that followed told her the catalogue had no answer without saying whether that was
// because nothing removes it or because nobody had written the declaration down.
//
// POPULATION, derived on every run: every word the tile classifier can publish
// (`integrations/stardew/TileOccupancy.cs` - a row's `occupantKind`, and the pass's `where: [{ occupant: ... }]`), read
// from the file that produces it:
//   * the word literals its kind positions return, and
//   * the `<Constants>.<Name>` references it returns instead, resolved from the C# that declares them,
// plus the resource-clump names `StardewBodyController.ClumpOccupant` publishes. The free-tile word
// (`FarmhandForEachHealing.NoOccupant`) is resolved too and is NOT a kind: the absence of an occupant is not something
// an action clears, and it is named here so it cannot be silently dropped from the census either.
//
// THE CROSSING, per published kind: at least one `Clears(...)` declaration in
// `integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs` names it, or the Mod declares the kind
// UNCLEARABLE with a reason (`TileOccupantKind.Unclearable`). Both answers are lawful; what is not lawful is a word the
// world publishes that neither answer mentions, because that is the word that reaches a planner as a tile it cannot
// work (`published_kind_no_action_clears:<kind>`).
//
// The other direction is checked as hard, because a declaration is also an answer the caller acts on:
//   * `cleared_kind_not_published:<kind>` - a `Clears` entry for a word the classifier never publishes is a clearer
//     nobody can aim;
//   * `unclearable_kind_not_published:<kind>` - a declaration about a word nothing carries;
//   * `declared_kind_both_ways:<kind>` - one word with two meanings;
//   * `unclearable_kind_without_reason:<kind>` - "not clearable" without why is the silence this gate replaces;
//   * `kind_declared_but_never_returned` / `kind_returned_but_undeclared` - the vocabulary file and the classifier's
//     own returns disagreeing.
//
// A population of zero is BLOCKED, never green: a scan that read no word has not measured a clean tree.
//
// Measured at this commit: `occupant types published 21 · cleared by >=1 action 16 · unclearable 5`.
//
// red-proof: history  the SAME gate code reading the sources at `0dce992a` -> `occupant types published 18 · cleared by >=1
//   action 15 · unclearable 0`, `published_kind_no_action_clears:object`, `:resource_clump`, `:terrain`,
//   `failed (3 finding(s))`, exit 1 - no `Clears` declaration answered `object`, `resource_clump` or `terrain`.

export const gateDeclaration = {
  id: "audit-stardew-clearing-vocabulary",
  domain: "stardew",
  tier: "l0",
  kind: "totality",
};

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { bracesFrom } from "./lib/gate-preamble.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SOURCES = Object.freeze({
  /** The classifier every reader of `occupantKind` / `where: [{ occupant: ... }]` goes through. */
  classifier: "integrations/stardew/TileOccupancy.cs",
  /** The one vocabulary declaration the classifier returns its words from. */
  vocabulary: "integrations/stardew/src/Core/TileOccupantKind.cs",
  /** The second publisher of the clump names, which the route refusal reads. */
  clumps: "integrations/stardew/StardewBodyController.cs",
  clumpMember: "ClumpOccupant",
  /** The action catalog, whose `Clears(...)` declarations are the clearing half of the crossing. */
  catalog: "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs",
  /** The free-tile word, resolved rather than restated. */
  noOccupant: "integrations/stardew/src/Core/Policy/FarmhandForEachHealing.cs",
});

/** Comments are not code; a word quoted in a doc comment is not published. */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

/** `public const string Stone = "stone";` -> `{ Stone: "stone", ... }`. */
export function constantsIn(source) {
  const found = new Map();
  const pattern = /\bconst\s+string\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/gu;
  for (const match of stripComments(source).matchAll(pattern)) found.set(match[1], match[2]);
  return found;
}

/** `["a", "b"]` or `{ "a", "b" }` element list -> the string literals it names. */
export function literalsIn(source) {
  return [...stripComments(source).matchAll(/"([^"\\]*)"/gu)].map((match) => match[1]);
}

/** The brace-delimited initializer of a declared table (`Name = new[] { ... }`), or null. */
export function tableBody(source, name) {
  const code = stripComments(source);
  const declaration = new RegExp(`\\b${name}\\s*=`, "u").exec(code);
  if (declaration === null) return null;
  const open = code.indexOf("{", declaration.index);
  if (open < 0) return null;
  return bracesFrom(code, open);
}

/**
 * The body of one declaration, to its matching brace - the clump table's own arms live there.
 *
 * The DECLARATION is what is wanted, never the first call: `ClumpOccupant(...)` is read at two sites before the switch
 * that answers it, so a reader that takes the first `name(` reads a caller's body and finds no word in it.
 */
export function memberBody(source, name, declaration = `${name}(`) {
  const code = stripComments(source);
  const start = code.indexOf(declaration);
  if (start < 0) return null;
  const open = code.indexOf("{", start);
  if (open < 0) return null;
  return bracesFrom(code, open);
}

/**
 * The words a classifier source publishes, and where each was read.
 *
 * Two shapes, because the same authority has two honest spellings: a word literal in a kind position, and a
 * `<Vocabulary>.<Name>` reference resolved through the file that declares it. A word that cannot be resolved is not a
 * word: it is reported by name rather than dropped, because a vocabulary nobody can resolve is a vocabulary nobody can
 * check.
 */
export function publishedWords(source, { constants = new Map(), vocabularyName = "TileOccupantKind" } = {}) {
  // A word is a lowercase token in a string literal: `"stone"` is one, `"(O)2"` and a prose sentence are not.
  const code = stripComments(source);
  const words = new Map();
  const unresolved = [];
  for (const match of code.matchAll(/"([a-z][a-z0-9_]*)"/gu)) words.set(match[1], "literal");
  const reference = new RegExp(`\\b${vocabularyName}\\.([A-Za-z_][A-Za-z0-9_]*)`, "gu");
  for (const match of code.matchAll(reference)) {
    const name = match[1];
    if (!constants.has(name)) {
      unresolved.push(`${vocabularyName}.${name}`);
      continue;
    }
    words.set(constants.get(name), `constant:${name}`);
  }
  return { words, unresolved };
}

/** Top-level comma-separated arguments of one call, so a nested `SelfWalked(...)` stays one argument. */
export function topLevelArguments(source) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(" || character === "{" || character === "[") depth += 1;
    else if (character === ")" || character === "}" || character === "]") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail.length > 0) parts.push(tail);
  return parts;
}

/**
 * The wrapper's own occupants position, read from the ONE declaration that defines it.
 *
 * <p>
 * `(descriptor, tool, destructive, refusalDetail, params occupants)` was this reader's hard-coded assumption until the prose
 * field left the wrapper. Two arguments later the same defect would come back - and it failed in the worst direction: zero
 * declarations parsed, which surfaced as fifteen `published_kind_no_action_clears` findings about the CATALOGUE while the
 * parser was the thing that was wrong. So the position is taken from the declaration's own parameter list, once, and the
 * arity cannot drift again.
 * </p>
 *
 * @returns `{ position, declarationStart, declarationEnd }`, with `position` -1 when the wrapper cannot be read at all.
 */
export function wrapperShape(catalogSource) {
  const code = stripComments(catalogSource);
  const declaration = /\bFarmhandActionDescriptor\s+Clears\s*\(/u.exec(code);
  if (declaration === null) return { position: -1, declarationStart: -1, declarationEnd: -1 };
  const open = declaration.index + declaration[0].length - 1;
  let depth = 0;
  for (let cursor = open; cursor < code.length; cursor += 1) {
    if (code[cursor] === "(") depth += 1;
    else if (code[cursor] === ")") {
      depth -= 1;
      if (depth !== 0) continue;
      const parameters = topLevelArguments(code.slice(open + 1, cursor));
      const position = parameters.findIndex((parameter) => /\bparams\s+/u.test(parameter));
      return { position, declarationStart: declaration.index, declarationEnd: cursor };
    }
  }
  return { position: -1, declarationStart: declaration.index, declarationEnd: -1 };
}

/**
 * What one read of the catalog found: every occupant word a `Clears(...)` declaration names, HOW MANY declaration blocks
 * were examined, and the position the occupant words were read from.
 *
 * <p>
 * The counts travel with the words because a reader that parsed nothing must not be able to report on what the catalogue
 * contains. The TOOL is the one argument deliberately skipped - `"axe"` in that position is the price of a swing, not an
 * occupant - and it is skipped by POSITION taken from the wrapper's declaration, never from a number written here.
 * </p>
 */
export function clearingDeclarations(catalogSource, constants = new Map()) {
  const code = stripComments(catalogSource);
  const arrays = stringArrayDeclarations(code);
  const { position, declarationStart, declarationEnd } = wrapperShape(code);
  const cleared = new Map();
  let blocks = 0;
  if (position >= 0) {
    for (let index = 0; ; ) {
      const call = nextCallArguments(code, "Clears(", index);
      if (call === null) break;
      index = call.next;
      // The wrapper's own declaration is not a declaration BLOCK: its "arguments" are parameter names, and counting it
      // would let an unreadable catalog still report one block examined.
      if (call.start >= declarationStart && call.start <= declarationEnd) continue;
      blocks += 1;
      for (const argument of call.arguments.slice(position))
        for (const word of wordsOfArgument(argument, arrays, constants)) if (!cleared.has(word)) cleared.set(word, []);
    }
  }
  return { cleared, blocks, position };
}

/**
 * Every occupant a `Clears(...)` declaration names, in catalog order.
 *
 * The read itself is <see cref="clearingDeclarations"/>: this is the word map alone, for the callers that only need the
 * crossing.
 */
export function clearedKinds(catalogSource, constants = new Map()) {
  return clearingDeclarations(catalogSource, constants).cleared;
}

/** `readonly string[] Name = { "a", "b" };` -> the literals each name holds. */
function stringArrayDeclarations(code) {
  const arrays = new Map();
  for (const match of code.matchAll(/readonly\s+string\[\]\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{([\s\S]*?)\}/gu))
    arrays.set(
      match[1],
      [...match[2].matchAll(/"([^"]*)"/gu)].map((literal) => literal[1]),
    );
  return arrays;
}

/** The top-level arguments of the next `<marker>...` call at or after `<paramref name="from"/>`, where it began and ended. */
function nextCallArguments(code, marker, from) {
  const start = code.indexOf(marker, from);
  if (start < 0) return null;
  const open = start + marker.length - 1;
  let depth = 0;
  for (let cursor = open; cursor < code.length; cursor += 1) {
    if (code[cursor] === "(") depth += 1;
    else if (code[cursor] === ")") {
      depth -= 1;
      if (depth === 0) return { start, arguments: topLevelArguments(code.slice(open + 1, cursor)), next: cursor + 1 };
    }
  }
  return null;
}

/**
 * The occupant words one declaration argument names: a literal, a `<Vocabulary>.<Name>` constant, or the name of a
 * string array declared in the same file. Anything else names nothing and is skipped rather than guessed at.
 */
function wordsOfArgument(argument, arrays, constants) {
  const literal = /^"([^"]*)"$/u.exec(argument);
  if (literal !== null) return [literal[1]];
  // The catalog's occupants are written in the vocabulary's own constants (`TileOccupantKind.Twig`), so an entry is
  // resolved through the file that declares it rather than restated as a literal here.
  const reference = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/u.exec(argument);
  if (reference !== null && constants.has(reference[2])) return [constants.get(reference[2])];
  return arrays.get(argument) ?? [];
}

/**
 * The declared-unclearable table: `(Kind, "reason")` entries of `TileOccupantKind.Unclearable`.
 *
 * A reason is prose and is kept whole; an entry with no reason is reported, because "not clearable" without why is the
 * silence this gate exists to replace.
 */
export function unclearableKinds(vocabularySource, constants = constantsIn(vocabularySource)) {
  const body = tableBody(vocabularySource, "Unclearable");
  if (body === null) return null;
  // A reason may be written as adjacent literals joined with `+` for line length; the sentence is one fact, so the
  // pieces are joined before it is read.
  const joined = body.replace(/"\s*\+\s*"/gu, "");
  const declared = new Map();
  for (const match of joined.matchAll(/\(\s*(?:"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/gu)) {
    const word = match[1] ?? constants.get(match[2]);
    if (word === undefined) continue;
    declared.set(word, match[3].trim());
  }
  return declared;
}

/** The `Published` list, when the vocabulary file declares one. */
export function declaredKinds(vocabularySource, constants = constantsIn(vocabularySource)) {
  const body = tableBody(vocabularySource, "Published");
  if (body === null) return null;
  const words = [];
  for (const word of body.matchAll(/"([^"]*)"/gu)) words.push(word[1]);
  for (const match of body.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/gu))
    if (constants.has(match[1]) && !words.includes(constants.get(match[1]))) words.push(constants.get(match[1]));
  return words.length === 0 ? null : words;
}

/**
 * The verdict, as a pure function of the three populations.
 *
 * `none` is admitted by name and only by name: the free-tile word is the absence of an occupant, so a checker that
 * demanded a clearer for it would demand an action that removes nothing.
 */
export function judge({ published, cleared, unclearable, freeTile, declared }) {
  // The free-tile word is excluded from the kind population by CONTRACT (`NoOccupant`), and its absence is its own
  // blocked reading: a census that silently counted `none` as a kind would demand an action that removes nothing.
  const publishedList = [...published.keys()].filter((kind) => kind !== freeTile && kind !== "none").sort();
  const clearedList = [...cleared.keys()].sort();
  const unclearableList = [...(unclearable?.keys() ?? [])].sort();

  const findings = [
    ...unmeasuredFindings(publishedList, freeTile),
    ...publishedFindings(publishedList, cleared, unclearable),
    ...clearedFindings(clearedList, published),
    ...unclearableFindings(unclearableList, published, cleared, unclearable),
    ...declarationFindings(declared, publishedList, published),
  ];

  return {
    verdict: findings.length === 0 ? "passed" : "failed",
    findings,
    published: publishedList,
    cleared: clearedList,
    unclearable: unclearableList,
    notCleared: publishedList.filter((kind) => !cleared.has(kind)),
    counts: { published: publishedList.length, cleared: clearedList.length, unclearable: unclearableList.length },
  };
}

/** A census that read nothing, or a free-tile word nobody can resolve, is a blocked reading and not a clean tree. */
function unmeasuredFindings(publishedList, freeTile) {
  const findings = [];
  if (publishedList.length === 0) findings.push("stardew_clearing_vocabulary_unmeasured:no published kind was read");
  if (freeTile === undefined) findings.push("free_tile_word_unresolved:FarmhandForEachHealing.NoOccupant");
  return findings;
}

/** The defect `round58` measured: a word the world publishes that neither a declaration nor an exemption answers. */
function publishedFindings(publishedList, cleared, unclearable) {
  return publishedList
    .filter((kind) => !(cleared.has(kind) || (unclearable?.has(kind) ?? false)))
    .map((kind) => `published_kind_no_action_clears:${kind}`);
}

/** A clearer nobody can aim: a declaration for a word the classifier never publishes. */
function clearedFindings(clearedList, published) {
  return clearedList.filter((kind) => !published.has(kind)).map((kind) => `cleared_kind_not_published:${kind}`);
}

/** "Not clearable" is an answer only with a reason, and never at the same time as a clearer. */
function unclearableFindings(unclearableList, published, cleared, unclearable) {
  const findings = [];
  for (const kind of unclearableList) {
    if (!published.has(kind)) findings.push(`unclearable_kind_not_published:${kind}`);
    if ((unclearable.get(kind) ?? "").trim().length === 0) findings.push(`unclearable_kind_without_reason:${kind}`);
    if (cleared.has(kind)) findings.push(`declared_kind_both_ways:${kind}`);
  }
  return findings;
}

/** The vocabulary file and the classifier's own returns disagreeing, in both directions. */
function declarationFindings(declared, publishedList, published) {
  if (declared === null) return [];
  return [
    ...declared.filter((kind) => !published.has(kind)).map((kind) => `kind_declared_but_never_returned:${kind}`),
    ...publishedList.filter((kind) => !declared.includes(kind)).map((kind) => `kind_returned_but_undeclared:${kind}`),
  ];
}

export function checkStardewClearingVocabulary({
  read = (relative) => readFileSync(path.join(repositoryRoot, relative), "utf8"),
} = {}) {
  const { vocabulary, constants, freeTile } = vocabularyOf(read);
  const published = publishedWords(read(SOURCES.classifier), { constants });
  const clumpWords = clumpWordsOf(read(SOURCES.clumps), constants);
  for (const [kind, from] of clumpWords.words) if (!published.words.has(kind)) published.words.set(kind, from);

  const clearing = clearingDeclarations(read(SOURCES.catalog), constants);
  const cleared = clearing.cleared;
  const unclearable = vocabulary === "" ? null : unclearableKinds(vocabulary, constants);
  const declared = vocabulary === "" ? null : declaredKinds(vocabulary, constants);

  const result = judge({ published: published.words, cleared, unclearable, freeTile, declared });
  result.blocks = clearing.blocks;
  result.occupantsPosition = clearing.position;
  result.freeTile = freeTile ?? "unresolved";
  // ZERO POPULATION IS BLOCKED, NOT FIFTEEN FINDINGS. A parse that read no declaration has not measured the catalogue, and
  // reporting that as `published_kind_no_action_clears:<kind>` for every kind sends the next reader to the catalogue's
  // content when the reader itself is what broke. This is the shape that let one arity change look like fifteen defects.
  if (clearing.blocks === 0 || cleared.size === 0) {
    result.verdict = "blocked";
    result.findings = [
      `clearing_declarations_unparsed:blocks=${clearing.blocks};declarations=${cleared.size};position=${clearing.position}`,
    ];
    return result;
  }
  result.unresolved = [...published.unresolved, ...clumpWords.unresolved];
  if (result.unresolved.length > 0) {
    result.findings.push(...result.unresolved.map((name) => `kind_word_unresolved:${name}`));
    result.verdict = "failed";
  }
  return result;
}

/**
 * The vocabulary declaration, the constants it names, and the free-tile word - resolved ONCE, because every reader below
 * resolves names through it and a second resolution could answer a different word.
 *
 * A tree with no declaration file is not blocked: the classifier's own literals are the population there, which is how the
 * baseline revision is read.
 */
function vocabularyOf(read) {
  let vocabulary = "";
  try {
    vocabulary = read(SOURCES.vocabulary);
  } catch {
    vocabulary = "";
  }
  const constants = vocabulary === "" ? new Map() : constantsIn(vocabulary);
  const freeTile = constantsIn(read(SOURCES.noOccupant)).get("NoOccupant");
  // The free-tile word is one fact with two spellings by design (`NoOccupant` in the row contract,
  // `TileOccupantKind.None` in the vocabulary that aliases it), so the alias is resolved from the declaration rather
  // than restated here.
  if (freeTile !== undefined && !constants.has("None")) constants.set("None", freeTile);
  return { vocabulary, constants, freeTile };
}

/** The resource-clump names, read from the one function that publishes them. */
function clumpWordsOf(source, constants) {
  const body = memberBody(source, SOURCES.clumpMember, `string ClumpOccupant(int`);
  return body === null ? { words: new Map(), unresolved: [] } : publishedWords(body, { constants });
}

export function report(result, write = (line) => process.stdout.write(`${line}\n`)) {
  write(
    `stardew_clearing_vocabulary: occupant types published ${result.counts.published} · ` +
      `cleared by >=1 action ${result.published.filter((kind) => result.cleared.includes(kind)).length} · ` +
      `unclearable ${result.counts.unclearable}`,
  );
  write(`free-tile word (not a kind): ${result.freeTile}`);
  write(`cleared: ${result.cleared.join(", ")}`);
  write(`unclearable: ${result.unclearable.join(", ")}`);
  write(
    `stardew_clearing_vocabulary: blocks examined ${result.blocks} · declarations parsed ${result.cleared.length} · ` +
      `position ${result.occupantsPosition}`,
  );
  for (const finding of result.findings) write(finding);
  write(`stardew_clearing_vocabulary: ${result.verdict} (${result.findings.length} finding(s))`);
  return result.verdict === "passed" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = report(checkStardewClearingVocabulary());
