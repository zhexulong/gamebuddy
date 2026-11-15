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
// Measured at this commit: `kinds published 21 · cleared by >=1 action 16 · unclearable 5`.
//
// red-proof (run, not quoted): the SAME gate code reading the sources as they were at `0dce992a` -
//   `kinds published 18 · cleared by >=1 action 15 · unclearable 0`, `published_kind_no_action_clears:object`,
//   `:resource_clump`, `:terrain`, `failed (3 finding(s))`, exit 1. The classifier still answered `stone` for `(O)2`
//   alone and `object` for everything else, and no `Clears` declaration answered that word.

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
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(open, index + 1);
    }
  }
  return null;
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
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(open, index + 1);
    }
  }
  return null;
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
 * Every occupant a `Clears(...)` declaration names, in catalog order.
 *
 * The argument list is the wrapper's own: `(descriptor, tool, destructive, refusalDetail, params occupants)`. The TOOL
 * is deliberately skipped - `"axe"` in that position is the price of a swing, not an occupant - which is the one place
 * this reader has to know the wrapper's shape, and the reason the wrapper is one function in the catalog.
 */
export function clearedKinds(catalogSource, constants = new Map()) {
  const code = stripComments(catalogSource);
  const arrays = new Map();
  for (const match of code.matchAll(/readonly\s+string\[\]\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{([\s\S]*?)\}/gu))
    arrays.set(
      match[1],
      [...match[2].matchAll(/"([^"]*)"/gu)].map((literal) => literal[1]),
    );

  const cleared = new Map();
  let index = 0;
  for (;;) {
    const call = code.indexOf("Clears(", index);
    if (call < 0) break;
    const open = call + "Clears".length;
    let depth = 0;
    let close = -1;
    for (let cursor = open; cursor < code.length; cursor += 1) {
      if (code[cursor] === "(") depth += 1;
      else if (code[cursor] === ")") {
        depth -= 1;
        if (depth === 0) {
          close = cursor;
          break;
        }
      }
    }
    if (close < 0) break;
    const args = topLevelArguments(code.slice(open + 1, close));
    for (const argument of args.slice(4)) {
      const literal = /^"([^"]*)"$/u.exec(argument);
      if (literal !== null) {
        if (!cleared.has(literal[1])) cleared.set(literal[1], []);
        continue;
      }
      // The catalog's occupants are written in the vocabulary's own constants (`TileOccupantKind.Twig`), so an entry is
      // resolved through the file that declares it rather than restated as a literal here.
      const reference = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/u.exec(argument);
      if (reference !== null && constants.has(reference[2])) {
        const word = constants.get(reference[2]);
        if (!cleared.has(word)) cleared.set(word, []);
        continue;
      }
      if (arrays.has(argument)) for (const word of arrays.get(argument)) if (!cleared.has(word)) cleared.set(word, []);
    }
    index = close + 1;
  }
  return cleared;
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
  const findings = [];
  // The free-tile word is excluded from the kind population by CONTRACT (`NoOccupant`), and its absence is its own
  // blocked reading: a census that silently counted `none` as a kind would demand an action that removes nothing.
  const publishedList = [...published.keys()].filter((kind) => kind !== freeTile && kind !== "none").sort();
  const clearedList = [...cleared.keys()].sort();
  const unclearableList = [...(unclearable?.keys() ?? [])].sort();

  if (publishedList.length === 0) findings.push("stardew_clearing_vocabulary_unmeasured:no published kind was read");
  if (freeTile === undefined) findings.push("free_tile_word_unresolved:FarmhandForEachHealing.NoOccupant");

  for (const kind of publishedList)
    if (!cleared.has(kind) && !(unclearable?.has(kind) ?? false))
      findings.push(`published_kind_no_action_clears:${kind}`);
  for (const kind of clearedList) if (!published.has(kind)) findings.push(`cleared_kind_not_published:${kind}`);
  for (const kind of unclearableList) {
    if (!published.has(kind)) findings.push(`unclearable_kind_not_published:${kind}`);
    if ((unclearable.get(kind) ?? "").trim().length === 0) findings.push(`unclearable_kind_without_reason:${kind}`);
    if (cleared.has(kind)) findings.push(`declared_kind_both_ways:${kind}`);
  }
  if (declared !== null) {
    for (const kind of declared) if (!published.has(kind)) findings.push(`kind_declared_but_never_returned:${kind}`);
    for (const kind of publishedList)
      if (!declared.includes(kind)) findings.push(`kind_returned_but_undeclared:${kind}`);
  }

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

export function checkStardewClearingVocabulary({
  read = (relative) => readFileSync(path.join(repositoryRoot, relative), "utf8"),
} = {}) {
  const classifier = read(SOURCES.classifier);
  let vocabulary = "";
  try {
    vocabulary = read(SOURCES.vocabulary);
  } catch {
    vocabulary = "";
  }
  const constants = vocabulary === "" ? new Map() : constantsIn(vocabulary);

  const noOccupantConstants = constantsIn(read(SOURCES.noOccupant));
  const freeTile = noOccupantConstants.get("NoOccupant");
  // The free-tile word is one fact with two spellings by design (`NoOccupant` in the row contract,
  // `TileOccupantKind.None` in the vocabulary that aliases it), so the alias is resolved from the declaration rather
  // than restated here.
  if (freeTile !== undefined && !constants.has("None")) constants.set("None", freeTile);

  const published = publishedWords(classifier, { constants });

  const clumpBody = memberBody(read(SOURCES.clumps), SOURCES.clumpMember, `string ClumpOccupant(int`);
  const clumpWords =
    clumpBody === null ? { words: new Map(), unresolved: [] } : publishedWords(clumpBody, { constants });
  for (const [kind, from] of clumpWords.words) if (!published.words.has(kind)) published.words.set(kind, from);

  const cleared = clearedKinds(read(SOURCES.catalog), constants);
  const unclearable = vocabulary === "" ? null : unclearableKinds(vocabulary, constants);
  const declared = vocabulary === "" ? null : declaredKinds(vocabulary, constants);

  const result = judge({ published: published.words, cleared, unclearable, freeTile, declared });
  result.unresolved = [...published.unresolved, ...clumpWords.unresolved];
  if (result.unresolved.length > 0) {
    result.findings.push(...result.unresolved.map((name) => `kind_word_unresolved:${name}`));
    result.verdict = "failed";
  }
  result.freeTile = freeTile ?? "unresolved";
  return result;
}

export function report(result, write = (line) => process.stdout.write(`${line}\n`)) {
  write(
    `stardew_clearing_vocabulary: kinds published ${result.counts.published} · ` +
      `cleared by >=1 action ${result.published.filter((kind) => result.cleared.includes(kind)).length} · ` +
      `unclearable ${result.counts.unclearable}`,
  );
  write(`free-tile word (not a kind): ${result.freeTile}`);
  write(`cleared: ${result.cleared.join(", ")}`);
  write(`unclearable: ${result.unclearable.join(", ")}`);
  for (const finding of result.findings) write(finding);
  write(`stardew_clearing_vocabulary: ${result.verdict} (${result.findings.length} finding(s))`);
  return result.verdict === "passed" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = report(checkStardewClearingVocabulary());
