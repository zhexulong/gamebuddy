#!/usr/bin/env node
/**
 * The gate for "a preset spells a `{{macro}}` this product cannot evaluate" - as a POPULATION question.
 *
 * WHY (design/architecture/tavern-preset-compatibility.md §4, §4.2)
 *
 *   A preset is imported as authored and rendered as-is. A macro the product does not implement therefore has
 *   exactly two possible fates: it is reported by name, or it disappears into an empty string and the player
 *   never learns the entry said something else. §4 rules out the second one: every `{{...}}` actually present
 *   must exist in `PRESET_MACROS`, and a present macro whose entry is not implemented must be reported as
 *   `macro_not_implemented:<name>`. §4.2's third row is a segment policy - `{{time}}` changes every turn, so in
 *   the stable `before` prefix it rewrites the cached bytes each turn - which is why the same gate accepts
 *   `--segment` and reports `macro_tail_only_in_segment:<name>:<segment>`.
 *
 * WHAT IS READ
 *
 *   The population is a preset JSON: every string in it, at any depth, scanned for `{{...}}` tokens. Both the
 *   table and the token grammar are the product's own (`host/src/tavern/preset-macros.ts`, imported rather than
 *   paraphrased), so this gate cannot drift from the evaluator: a name added to the table is covered the same
 *   run, and a name removed from it is reported here as unknown.
 *
 * Usage:
 *   node tools/check-preset-macros.mjs                          # the shipped fixture preset
 *   node tools/check-preset-macros.mjs --preset <path>          # a real preset JSON
 *   node tools/check-preset-macros.mjs --segment before         # also judge the segment policy
 *   node tools/check-preset-macros.mjs --json                   # the reading, machine-readable
 *
 * red-proof: appending `{{if lastUserMessage}}Remember the last thing said.{{/if}}` to the shipped fixture's
 *            Main Prompt content -> exit 1, `preset_macros examined 24 macros violations 2 names 15 status
 *            failed`, stderr naming `macro_not_implemented:if` and `macro_not_implemented:/if`. Fixture
 *            restored -> `preset_macros examined 22 macros violations 0 names 13 status passed`, exit 0.
 *
 * Also seen red once, each on a small `--preset` file: a macro the table does not carry ->
 * `macro_unknown:support_email`, exit 1; `{{time}}` with `--segment before` -> `macro_tail_only_in_segment:
 * time:before` beside `macro_not_implemented:time`, and the same preset with `--segment depth` reporting only
 * the latter; a preset with no `{{...}}` at all -> `preset_macros_none_found`, `status blocked`, exit 1.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The table and the token grammar, imported from the product's own module rather than restated here.
 *
 * Node reads the TypeScript source directly (the file is types-only plus plain functions), so the gate needs no
 * build step and cannot read a stale artifact of the table it is judging.
 */
const MACRO_MODULE = new URL("../host/src/tavern/preset-macros.ts", import.meta.url);

/** The three segments a preset entry can land in (§2.4): the stable prefix, the post-history tail, a depth slot. */
export const PRESET_SEGMENTS = Object.freeze(["before", "after", "depth"]);

/**
 * The preset this gate reads when no `--preset` is given.
 *
 * It exercises every macro v1 implements and no macro it does not, which is what makes "the shipped fixture is
 * green" a statement about the evaluator's real coverage instead of about an empty file.
 */
export const FIXTURE_PRESET = Object.freeze({
  name: "GameBuddy preset-macros fixture",
  description: "A minimal SillyTavern preset covering exactly the macros v1 implements.",
  temperature: 0.85,
  top_p: 1,
  prompts: [
    {
      identifier: "main",
      name: "Main Prompt",
      enabled: true,
      role: "system",
      content:
        "Write {{char}}'s next reply in this scene. {{char}} does not speak or act for {{user}}.\n{{description}}\n{{personality}}",
    },
    {
      identifier: "worldInfoBefore",
      name: "World Info (before)",
      marker: true,
      enabled: true,
      role: "system",
      content: "",
    },
    {
      identifier: "charDescription",
      name: "Character Description",
      marker: true,
      enabled: true,
      role: "system",
      content: "{{description}}{{newline}}{{personality}}",
    },
    { identifier: "scenario", name: "Scenario", enabled: true, role: "system", content: "Setting: {{scenario}}" },
    { identifier: "persona", name: "Persona", enabled: true, role: "system", content: "{{user}}: {{persona}}" },
    {
      identifier: "mood",
      name: "Mood",
      enabled: true,
      role: "system",
      content: "{{setvar::{{char}}_mood::even}}{{char}} begins {{getvar::{{char}}_mood}}.",
    },
    {
      identifier: "style",
      name: "Style",
      enabled: true,
      role: "system",
      content: "{{addvar::voice::plain}}{{addvar::voice:: and unhurried}}Voice: {{getvar::voice}}.",
    },
    {
      identifier: "variation",
      name: "Variation",
      enabled: true,
      role: "system",
      content: "Register: {{random::dry::warm::sharp}}. Diction: {{pick::terse::luxurious}}.",
    },
    {
      identifier: "trimmed",
      name: "Trimmed Tail",
      enabled: true,
      role: "system",
      content: "{{trim}}\n\nStay in scene.\n\n",
    },
  ],
  prompt_order: [
    {
      character_id: 100001,
      order: [
        { identifier: "main", enabled: true },
        { identifier: "worldInfoBefore", enabled: true },
        { identifier: "charDescription", enabled: true },
        { identifier: "scenario", enabled: true },
        { identifier: "persona", enabled: true },
        { identifier: "mood", enabled: true },
        { identifier: "style", enabled: true },
        { identifier: "variation", enabled: true },
        { identifier: "trimmed", enabled: true },
      ],
    },
  ],
});

/** Every string value in `preset`, at any depth: a macro can be written in any field a preset carries. */
export function presetStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(presetStrings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(presetStrings);
  return [];
}

/** The table module, or the reason it could not be read - which is `not_measured`, never a pass. */
async function loadMacroModule() {
  try {
    const module = await import(MACRO_MODULE.href);
    if (!Array.isArray(module.PRESET_MACROS) || typeof module.presetMacroTokens !== "function")
      return { error: "the module exported no PRESET_MACROS table and no presetMacroTokens reader" };
    return { table: module.PRESET_MACROS, tokens: module.presetMacroTokens };
  } catch (error) {
    return { error: `${error.message}` };
  }
}

/**
 * The whole reading: every token in the preset, judged against the table, in source order.
 *
 * `examined` is the population, so a preset that carries no macro is visible as `examined 0` and blocks
 * instead of passing; `names` is the distinct set, which is what a player-facing panel lists.
 */
export async function auditPresetMacros({ preset = FIXTURE_PRESET, segment } = {}) {
  const loaded = await loadMacroModule();
  if (loaded.error !== undefined)
    return {
      examined: 0,
      names: [],
      violations: [],
      status: "blocked",
      blocked: { code: "preset_macros_table_unreadable", detail: loaded.error },
    };

  const byName = new Map(loaded.table.map((entry) => [entry.name, entry]));
  const tokens = presetStrings(preset).flatMap((value) => loaded.tokens(value));
  const violations = [];
  const reported = new Set();
  const report = (kind, name, extra) => {
    const code = extra === undefined ? `${kind}:${name}` : `${kind}:${name}:${extra}`;
    if (reported.has(code)) return;
    reported.add(code);
    violations.push({ kind, name, ...(extra === undefined ? {} : { segment: extra }), code });
  };

  for (const token of tokens) {
    const entry = byName.get(token.name);
    if (entry === undefined) report("macro_unknown", token.name);
    else if (!entry.implemented) report("macro_not_implemented", token.name);
    // §4.2's third row: a per-turn macro is legal in the tail and at a depth slot, and refused in the stable
    // prefix the cache is built on. The segment is the one the caller passed, so the gate says which it read.
    if (entry !== undefined && entry.segmentPolicy === "tail-only" && segment === "before")
      report("macro_tail_only_in_segment", token.name, segment);
  }

  const names = [...new Set(tokens.map((token) => token.name))];
  if (tokens.length === 0)
    return {
      examined: 0,
      names,
      violations,
      status: "blocked",
      blocked: {
        code: "preset_macros_none_found",
        detail: "the preset carries no `{{...}}` token, so this run judged nothing",
      },
    };
  return { examined: tokens.length, names, violations, status: violations.length === 0 ? "passed" : "failed" };
}

/** Reads the preset to judge: the fixture, or the JSON file the caller named. */
function readPreset(presetPath) {
  if (presetPath === undefined) return { preset: FIXTURE_PRESET, source: "shipped fixture" };
  try {
    return { preset: JSON.parse(readFileSync(presetPath, "utf8")), source: presetPath };
  } catch (error) {
    return { error: `${presetPath}: ${error.message}` };
  }
}

function argumentOf(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && typeof argv[index + 1] === "string" ? argv[index + 1] : undefined;
}

async function main(argv) {
  const json = argv.includes("--json");
  const segment = argumentOf(argv, "--segment");
  const namedPreset = argumentOf(argv, "--preset");
  const presetPath = namedPreset === undefined ? undefined : resolve(namedPreset);

  if (segment !== undefined && !PRESET_SEGMENTS.includes(segment)) {
    process.stderr.write(`preset_macros_segment_invalid:${segment} - expected one of ${PRESET_SEGMENTS.join("|")}\n`);
    process.exitCode = 1;
    return;
  }
  const read = readPreset(presetPath);
  if (read.error !== undefined) {
    process.stderr.write(`preset_macros_preset_unreadable:${read.error}\n`);
    process.exitCode = 1;
    return;
  }

  const audit = await auditPresetMacros({
    preset: read.preset,
    ...(segment === undefined ? {} : { segment }),
  });
  const reading = {
    gate: "preset-macros",
    source: read.source,
    segment: segment ?? null,
    ...audit,
    // The meta-gate reads `checks[]`, not prose: this gate makes two judgements, and both have to be visible as
    // outcomes rather than inferred from the absence of violations. `population_is_non_empty` is the G-A rule -
    // a preset with no macros examined says nothing about coverage, so it is blocked rather than passed.
    checks: [
      { id: "population_is_non_empty", status: audit.examined > 0 ? "passed" : "blocked" },
      {
        id: "declared_table_covers_every_macro_in_the_preset",
        status: audit.violations.length === 0 ? "passed" : "failed",
      },
    ],
  };
  if (json) process.stdout.write(`${JSON.stringify(reading)}\n`);
  else {
    process.stdout.write(
      `preset_macros examined ${audit.examined} macros violations ${audit.violations.length} ` +
        `names ${audit.names.length} status ${audit.status}\n`,
    );
    process.stdout.write(`${JSON.stringify(reading)}\n`);
  }
  for (const violation of audit.violations) {
    process.stderr.write(
      violation.kind === "macro_unknown"
        ? `${violation.code} - the preset spells a macro PRESET_MACROS does not carry; the player would see it verbatim\n`
        : violation.kind === "macro_not_implemented"
          ? `${violation.code} - in the table and not implemented, so the entry cannot render as authored\n`
          : `${violation.code} - a per-turn macro in the stable prefix rewrites the cached bytes every turn\n`,
    );
  }
  if (audit.blocked !== undefined)
    process.stderr.write(`${audit.blocked.code}: ${audit.blocked.detail}; a run that examined nothing cannot pass\n`);
  process.exitCode = audit.status === "passed" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
