#!/usr/bin/env node
/**
 * The census of `{{macro}}` spellings in the PRESETS this checkout actually contains - as a POPULATION question.
 *
 * WHY (design/architecture/tavern-preset-compatibility.md §4.3, §191)
 *
 *   §4.3 rules that `{{if}}` is built after the comparisons and truthiness it stands on, and §191 leaves one door
 *   open: "若实测发现主流预设对它的依赖高于预期，需要提前到第一版". That sentence is a measurement, not an opinion,
 *   so this file makes the measurement instead of arguing the case. The same holds for the contrast macro
 *   `{{random}}`, which v1 DOES implement - a ratchet on decline-by-argument rather than on evidence.
 *
 * WHAT A PRESET IS (population)
 *
 *   A file is a preset when it parses as JSON and its top level is an object carrying a `prompts` array. That is
 *   SillyTavern's own preset shape (`default/content/presets/openai/Default.json` in the mounted checkout), and it is
 *   the SHAPE that decides membership: no file is named here, so a preset added anywhere under a root is in the next
 *   run's population.
 *
 *   Roots: `ref/` (the docs/library mount), `tools/fixtures/`, `host/src/`. They are the roots this checkout has;
 *   a repository-wide walk on 2026-11-09 found the same single preset file under `ref/`, so these three reproduce the
 *   wider scan instead of narrowing it.
 *
 *   Transient directories are not walked (`node_modules`, `.git`, `dist`, `build`, `out`, `coverage`, `.tmp`,
 *   `.live-runs`, `scratch`): a run's own artifacts and another lane's scratch file would make two runs of the same
 *   census disagree, and a population that moves without the tree moving is not a population.
 *
 *   The product's own shipped fixture preset is an inline literal in `tools/check-preset-macros.mjs`, not a JSON
 *   file, so it is outside this population on purpose: it is the gate's own fixture, authored by us, and counting it
 *   would be counting our own writing as evidence about real presets.
 *
 * WHAT IS COUNTED
 *
 *   An occurrence is an `{{name` opening in one of the fields a preset renders: every `prompts[].content`, plus the
 *   top-level `main` and `jailbreak` strings. Matching is case-insensitive (§7.1: case is insignificant), and the
 *   NAME is the opening's leading identifier run - so `{{if x}}` is `if`, `{{random::a::b}}` is `random`, `{{/if}}` is
 *   `/if`, and the `{{#if}}` spelling A4 §7.2 also accepts is `if` (the `#` is a spelling marker, not part of the
 *   name).
 *
 *   Openings rather than paired tokens on purpose: SillyTavern nests macros (`{{if {{getvar::flag}}}}`), and a
 *   pairing scan loses the OUTER name of every nested token - the name whose frequency is the question. A token
 *   without a closing `}}` still names its macro, so it is still counted.
 *
 *   A variable shorthand - `{{.mood}}`, `{{.mood = calm}}`, `{{$gold}}` - carries the variable's own identifier where
 *   a named macro carries its word. It is counted under the FAMILY entry that admits it (`.varName` / `$varName`),
 *   derived from `entry.family` in `PRESET_MACROS` rather than restated here, because those are the names the table
 *   declares and therefore the only names `blocked_but_used` can be keyed by.
 *
 *   A name no entry carries is printed as `not_declared:`, kept out of the ranked population's judgements: it is a
 *   spelling the product would report as `macro_unknown`, not a macro this census can call on the table's behalf.
 *
 * red-proof: fixture  `--root tools/fixtures` (88 JSON documents read, 86 rejected by the shape and none carrying a
 *   top-level `prompts` array) -> `preset_macro_frequency_no_presets` and `preset_macro_frequency: blocked`, exit 2
 *
 * VERDICT
 *
 *   A census reports; it does not pass a policy. So the only failing verdict is the one that would agree with itself:
 *   zero presets BLOCKS as `preset_macro_frequency_no_presets`, because "no preset uses `{{if}}`" and "no preset was
 *   read" must not print the same. With a non-empty population the run exits 0 and prints the table; which macro the
 *   numbers support is the reader's call, made on the printed counts.
 *
 *   The blocked cases exit 2, not 1: 2 is this repository's code for "I could not measure this"
 *   (`tools/lib/blocked-input-report.mjs`), and it is what tells a reader the difference between a census that read
 *   nothing and one that found something. An unreadable `PRESET_MACROS` table exits 2 for the same reason - it is the
 *   population's own prerequisite.
 *
 * CONTROL
 *
 *   `--any-json` removes the shape filter and takes every parseable JSON object under the same roots, so the population
 *   it prints beside the same occurrence counts is the filter's own doing rather than an assumption about the tree.
 *
 * Usage:
 *   node tools/audit-preset-macro-frequency.mjs                     # the three roots this checkout has
 *   node tools/audit-preset-macro-frequency.mjs --root <dir>        # REPLACES them (repeatable), so one directory can
 *                                                                   # be censused on its own and a zero population is
 *                                                                   # reachable without editing this file
 *   node tools/audit-preset-macro-frequency.mjs --any-json          # negative control: no shape filter
 *   node tools/audit-preset-macro-frequency.mjs --json              # the reading, machine-readable
 *
 * red-proof (2026-11-09, this tree):
 *   default shape   -> `examined 1 preset file(s), 4 macro occurrences` (1087 json document(s) read, 1033 rejected by
 *   the shape). Removing the filter moves the same roots from 1 file to 1012:
 *   `--any-json`    -> `examined 1012 preset file(s), 4 macro occurrences`.
 *   A root with no preset at all - `--root tools/fixtures` - blocks rather than passing:
 *   `examined 0 preset file(s), 0 macro occurrences` and `preset_macro_frequency_no_presets`, exit 1.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The roots this checkout has. A root that is absent is reported, never silently skipped into a pass. */
export const PRESET_ROOTS = Object.freeze(["ref", "tools/fixtures", "host/src", "assets"]);

/** Transient output: a run's artifacts and another lane's scratch must not move a census of the tree. */
export const SKIPPED_DIRECTORIES = Object.freeze([
  "node_modules",
  ".git",
  "dist",
  "dist-test",
  "build",
  "out",
  "coverage",
  ".tmp",
  ".live-runs",
  "scratch",
]);

/** The shape filter, or its removal. `any-json` exists as the control that proves the filter decides the population. */
export const PRESET_SHAPES = Object.freeze(["prompts", "any-json"]);

/** The table module, imported rather than paraphrased, so a name added to it is covered the same run. */
const MACRO_MODULE = new URL("../host/src/tavern/preset-macros.ts", import.meta.url);

/** Every `.json` file under one root, as `{ path, text }`, with the transient directories left out. */
export function jsonDocumentsUnder(root, { list = readdirSync, read = readFileSync } = {}) {
  const documents = [];
  const absolute = path.isAbsolute(root) ? root : path.join(repositoryRoot, root);
  const walk = (directory, prefix) => {
    let entries;
    try {
      entries = list(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.includes(entry.name)) continue;
        walk(path.join(directory, entry.name), child);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".json")) continue;
      documents.push({ path: child, text: read(path.join(directory, entry.name)) });
    }
  };
  walk(absolute, root);
  return documents;
}

/** Every JSON document under every root, in root order, beside the roots that are absent from this checkout. */
export function jsonDocuments({ roots = PRESET_ROOTS, list = readdirSync, read = readFileSync } = {}) {
  const documents = [];
  const rootsAbsent = [];
  for (const root of roots) {
    const found = jsonDocumentsUnder(root, { list, read });
    if (found.length === 0 && !isDirectory(root, list)) rootsAbsent.push(root);
    documents.push(...found);
  }
  return { documents, rootsAbsent };
}

function isDirectory(root, list) {
  try {
    list(path.isAbsolute(root) ? root : path.join(repositoryRoot, root), { withFileTypes: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The documents the shape accepts, and the count the shape rejected.
 *
 * `examined` is the POPULATION - what the census below reports on - and `rejected` is the number the shape filter
 * removed, so a filter that stopped working would show up as a population that grew, not as a silent pass.
 */
export function presetPopulation(documents, { shape = "prompts" } = {}) {
  const presets = [];
  let unparsed = 0;
  let rejected = 0;
  for (const document of documents) {
    let parsed;
    try {
      parsed = JSON.parse(document.text);
    } catch {
      unparsed += 1;
      continue;
    }
    const isPreset =
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (shape === "any-json" || Array.isArray(parsed.prompts));
    if (!isPreset) rejected += 1;
    else presets.push({ path: document.path, document: parsed });
  }
  return Object.freeze({ examined: presets.length, presets: Object.freeze(presets), rejected, unparsed });
}

const MACRO_OPENING = /\{\{\s*([A-Za-z0-9_$./#-]+)/gu;

/**
 * Macro occurrences by table name, from the fields a preset renders.
 *
 * `{{#if}}` is the same macro as `{{if}}` spelled with a marker A4 §7.2 accepts, so the marker is dropped before the
 * name is read; a shorthand is keyed by its family entry, which is the name `PRESET_MACROS` declares.
 */
export function macroCounts(document, familyBySigil) {
  const fields = [];
  if (Array.isArray(document.prompts)) {
    for (const prompt of document.prompts) {
      if (prompt !== null && typeof prompt === "object" && typeof prompt.content === "string")
        fields.push(prompt.content);
    }
  }
  for (const key of ["main", "jailbreak"]) {
    if (typeof document[key] === "string") fields.push(document[key]);
  }
  const counts = new Map();
  for (const field of fields) {
    for (const match of field.matchAll(MACRO_OPENING)) {
      const name = macroName(match[1], familyBySigil);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

/** The table name one opening belongs to: spelled name, then shorthand sigil, then family. */
export function macroName(opening, familyBySigil) {
  const spelled = opening.toLowerCase();
  if (spelled.startsWith("#")) return spelled.slice(1);
  const family = familyBySigil.get(spelled[0]);
  return family === undefined ? spelled : family;
}

/**
 * Sigil -> the table name that namespace is reported under, derived from the table rather than restated here.
 *
 * One sigil can carry two entries - `.varName` reads the namespace and `.varName = value` writes it - so a shorthand
 * occurrence is keyed by the namespace, not by the form its body happens to take: the census counts openings and never
 * reads an `=` that a nested token could also spell. Both `.` entries are implemented today, so keying them together
 * hides nothing; the limit is stated because a table that split their status would key those occurrences by the read
 * form and would have to report the write form separately.
 */
export function familyNamesBySigil(table) {
  const bySigil = new Map();
  for (const entry of table) {
    if (entry.family === undefined) continue;
    if (bySigil.has(entry.family.sigil)) continue;
    bySigil.set(entry.family.sigil, entry.name.toLowerCase());
  }
  return bySigil;
}

/**
 * The census: one row per macro name, ranked by occurrences and then by name so the table is stable across runs.
 *
 * `blockedButUsed` is keyed on `entry.implemented === false` in the table itself - not on a list kept here - which is
 * what lets it answer "which declared-unimplemented macro do real presets reach for" for a name added tomorrow.
 */
export function macroCensus(presets, { table, familyBySigil = familyNamesBySigil(table) } = {}) {
  const occurrencesByName = new Map();
  const filesByName = new Map();
  let occurrences = 0;
  for (const preset of presets) {
    for (const [name, count] of macroCounts(preset.document, familyBySigil)) {
      occurrences += count;
      occurrencesByName.set(name, (occurrencesByName.get(name) ?? 0) + count);
      if (!filesByName.has(name)) filesByName.set(name, new Set());
      filesByName.get(name).add(preset.path);
    }
  }
  const names = [...occurrencesByName.entries()]
    .map(([name, count]) => ({ name, occurrences: count, files: filesByName.get(name).size }))
    .sort((left, right) => right.occurrences - left.occurrences || left.name.localeCompare(right.name));

  const declared = new Map(table.map((entry) => [entry.name.toLowerCase(), entry]));
  const named = names.map((row) => ({ ...row, name: declared.get(row.name)?.name ?? row.name }));
  return Object.freeze({
    examined: presets.length,
    occurrences,
    names: Object.freeze(named),
    blockedButUsed: Object.freeze(named.filter((row) => declared.get(row.name.toLowerCase())?.implemented === false)),
    notDeclared: Object.freeze(named.filter((row) => declared.get(row.name.toLowerCase()) === undefined)),
    declaredUnimplementedExamined: table.filter((entry) => entry.implemented === false).length,
  });
}

/** One reading: the census beside the roots, shape and document counts it was taken from. */
export function censusReading(
  presets,
  { table, shape = "prompts", roots = [], rootsAbsent = [], documents, rejected = 0, unparsed = 0 } = {},
) {
  return Object.freeze({
    shape,
    roots: Object.freeze([...roots]),
    rootsAbsent: Object.freeze([...rootsAbsent]),
    documents: documents ?? presets.length,
    rejected,
    unparsed,
    ...macroCensus(presets, { table }),
  });
}

/** The whole reading, from roots to table. */
export async function presetMacroFrequency({ roots = PRESET_ROOTS, shape = "prompts", table } = {}) {
  if (!PRESET_SHAPES.includes(shape)) return { error: `preset_macro_frequency_unknown_shape:${shape}` };
  const loaded = table === undefined ? await loadMacroTable() : { table };
  if (loaded.error !== undefined) return { error: loaded.error };
  const walked = jsonDocuments({ roots });
  const population = presetPopulation(walked.documents, { shape });
  return censusReading(population.presets, {
    table: loaded.table,
    shape,
    roots,
    rootsAbsent: walked.rootsAbsent,
    documents: walked.documents.length,
    rejected: population.rejected,
    unparsed: population.unparsed,
  });
}

/** The table module, or the reason it could not be read - which is `not_measured`, never a census. */
async function loadMacroTable() {
  try {
    const module = await import(MACRO_MODULE.href);
    if (!Array.isArray(module.PRESET_MACROS)) return { error: "the module exported no PRESET_MACROS table" };
    return { table: module.PRESET_MACROS };
  } catch (error) {
    return { error: `preset_macro_frequency_table_unreadable:${error.message}` };
  }
}

const TABLE_ROWS_SHOWN = 40;

/** The printed reading: one machine line, the ranked table, and the declared-unimplemented line. */
export function formatCensus(result) {
  if (result.error !== undefined) return Object.freeze([result.error, "preset_macro_frequency: blocked"]);
  const lines = [];
  lines.push(
    `examined ${result.examined} preset file(s), ${result.occurrences} macro occurrences` +
      (result.shape === "any-json" ? " (control: no shape filter)" : ""),
  );
  lines.push(
    `preset_macro_frequency_population: roots ${result.roots.join(", ")}; shape ${
      result.shape === "any-json" ? "any JSON document" : "top-level prompts[]"
    }; ${result.documents} json document(s) read, ${result.rejected} rejected by the shape, ${
      result.unparsed
    } unparseable`,
  );
  if (result.rootsAbsent.length > 0) lines.push(`preset_macro_frequency_root_absent: ${result.rootsAbsent.join(", ")}`);
  lines.push("name -> occurrences -> files");
  for (const row of result.names.slice(0, TABLE_ROWS_SHOWN))
    lines.push(`${row.name} -> ${row.occurrences} -> ${row.files}`);
  if (result.names.length > TABLE_ROWS_SHOWN)
    lines.push(`name -> shown ${TABLE_ROWS_SHOWN} of ${result.names.length} -> narrow with --root`);
  if (result.blockedButUsed.length === 0)
    lines.push(
      `blocked_but_used: <none> - 0 of ${result.declaredUnimplementedExamined} declared-unimplemented macro(s) occur in ` +
        `the ${result.examined} preset file(s)`,
    );
  for (const row of result.blockedButUsed)
    lines.push(`blocked_but_used: ${row.name} ${row.occurrences} in ${row.files}`);
  for (const row of result.notDeclared)
    lines.push(
      `not_declared: ${row.name} ${row.occurrences} in ${row.files} - no PRESET_MACROS entry carries this name`,
    );
  if (result.examined === 0) {
    lines.push(
      "preset_macro_frequency_no_presets: no JSON document under these roots has a top-level `prompts` array, so the " +
        "census read nothing - an empty population is not a clean preset corpus",
    );
    lines.push("preset_macro_frequency: blocked");
    return Object.freeze(lines);
  }
  lines.push(`preset_macro_frequency: passed (${result.examined} preset file(s) read)`);
  return Object.freeze(lines);
}

/** Prints the reading and answers with the exit code: 2 (blocked) when nothing could be read, otherwise 0. */
export function verdict(result) {
  if (result.error !== undefined) return 2;
  return result.examined === 0 ? 2 : 0;
}

/** Prints the reading and answers with the exit code the reading earned. */
export function report(result) {
  const lines = formatCensus(result);
  process.stdout.write(`${lines.join("\n")}\n`);
  return verdict(result);
}

/** One `--root` argument per call, replacing the checkout's own roots when given; an unknown argument fails. */
function parseArguments(argv) {
  const options = { roots: [], shape: "prompts", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      const root = argv[index + 1];
      if (root === undefined) return { error: "preset_macro_frequency_argument:--root needs a directory" };
      options.roots.push(root.replace(/[\\/]+$/u, ""));
      index += 1;
      continue;
    }
    if (argument === "--any-json") {
      options.shape = "any-json";
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    return { error: `preset_macro_frequency_argument:${argument}` };
  }
  if (options.roots.length === 0) options.roots = [...PRESET_ROOTS];
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (options.error !== undefined) {
    process.stderr.write(`${options.error}\n`);
    process.exitCode = 1;
  } else {
    const result = await presetMacroFrequency({ roots: options.roots, shape: options.shape });
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = options.json ? verdict(result) : report(result);
  }
}
