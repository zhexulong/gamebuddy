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
 *   `macro_not_implemented:<name>`.
 *
 *   §4.2's third row is a SEGMENT policy - `{{time}}` changes every turn, so in the stable `before` prefix it
 *   rewrites the cached bytes each turn - and it is a gate of its own: every macro whose `segmentPolicy` is
 *   `tail-only` must land in `after` or `depth`, and one that reaches `before` is reported as
 *   `macro_segment_violation:<name>:before`. Two ways to know the segment, and the reading says which was used:
 *     - `derived` - the preset's own `prompt_order` (`injection_position === 1` is `depth`, rows after the
 *       `chatHistory` cut are `after`). The placement comes from `host/src/tavern/preset-placement.ts`, the same
 *       reading the assembler imports, so the gate cannot name a segment the assembly does not use.
 *     - `declared` - `--segment before|after|depth`, for a file that IS one segment (a single prompt entry, not
 *       a whole preset). Every occurrence takes the declared segment.
 *   A document that carries no `prompt_order` declares no placement at all, so the segment judgement is
 *   `not_applicable` for it rather than green: a fragment is not a preset whose segments were checked.
 *
 * WHAT IS READ
 *
 *   The population is a preset JSON: every string in it, at any depth, scanned for `{{...}}` tokens. Both the
 *   table and the token grammar are the product's own (`host/src/tavern/preset-macros.ts`, imported rather than
 *   paraphrased), so this gate cannot drift from the evaluator: a name added to the table is covered the same
 *   run, and a name removed from it is reported here as unknown.
 *
 *   A shorthand - `{{.x}}`, `{{.x = value}}`, `{{$x}}` - carries the variable's own name instead of a macro
 *   word, so it is judged by the FAMILY entry that admits it, and the name this report carries is the family's:
 *   every name in `names` is therefore a declared table name, and `macro_unknown` stays reserved for a spelling
 *   no entry admits.
 *
 *   The tail-only set is derived from `PRESET_MACROS` (`segmentPolicy === "tail-only"`), never listed here, and
 *   a table that declares none of them BLOCKS: "no violation" and "no policy" must not read the same.
 *
 * Usage:
 *   node tools/check-preset-macros.mjs                          # the shipped fixture preset
 *   node tools/check-preset-macros.mjs --preset <path>          # a real preset JSON
 *   node tools/check-preset-macros.mjs --segment before         # judge a one-segment file as that segment
 *   node tools/check-preset-macros.mjs --json                   # the reading, machine-readable
 *
 * red-proof: inject  `{{if lastUserMessage}}Remember the last thing said.{{/if}}` appended to the shipped
 *                    fixture's Main Prompt content -> exit 1, `preset_macros examined 24 macros violations 2
 *                    names 15 status failed`, stderr naming `macro_not_implemented:if` and
 *                    `macro_not_implemented:/if`. Fixture restored -> `examined 22 macros violations 0 names 13
 *                    status passed`, exit 0.
 *
 * Also seen red once, each on a small `--preset` file: a macro the table does not carry ->
 * `macro_unknown:support_email`, exit 1; a preset with no `{{...}}` at all -> `preset_macros_none_found`,
 * `status blocked`, exit 1.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The table and the token grammar, imported from the product's own module rather than restated here.
 *
 * Node reads the TypeScript source directly (the file is types-only plus plain functions), so the gate needs no
 * build step and cannot read a stale artifact of the table it is judging.
 */
const MACRO_MODULE = new URL("../host/src/tavern/preset-macros.ts", import.meta.url);

/**
 * The placement reading - which segment each `prompt_order` row lands in. It is a separate module precisely so
 * that Node can load it (it has no relative imports), and it is the same one the assembler consumes.
 */
const PLACEMENT_MODULE = new URL("../host/src/tavern/preset-placement.ts", import.meta.url);

/** The three segments a preset entry can land in (§2.4): the stable prefix, the post-history tail, a depth slot. */
export const PRESET_SEGMENTS = Object.freeze(["before", "after", "depth"]);

/**
 * The preset this gate reads when no `--preset` is given.
 *
 * It exercises every macro v1 implements and no macro it does not, which is what makes "the shipped fixture is
 * green" a statement about the evaluator's real coverage instead of about an empty file. It is also a whole
 * preset rather than a fragment - the `chatHistory` cut and one entry after it - so the shipping run derives
 * placements instead of exercising only the macro judgement.
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
    { identifier: "chatHistory", name: "Chat History", marker: true, enabled: true, role: "system", content: "" },
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
        { identifier: "chatHistory", enabled: true },
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

/**
 * The same strings, each beside the entry - or top-level key - that carries it, in the same order.
 *
 * The segment question is asked per ENTRY ("which entry lands where"), so the owner has to survive the walk.
 * The order and the population are `presetStrings`' own; the gate's test asserts the two readings agree on the
 * shipped fixture, so a walk that starts dropping a field fails there rather than quietly shrinking the gate.
 */
export function presetStringsByOwner(preset) {
  const found = [];
  const walk = (value, owner) => {
    if (typeof value === "string") {
      found.push({ owner, text: value });
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) walk(child, owner);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) walk(child, owner);
    }
  };
  if (preset !== null && typeof preset === "object" && !Array.isArray(preset)) {
    for (const [key, value] of Object.entries(preset)) {
      if (key === "prompts" && Array.isArray(value)) {
        for (const prompt of value) walk(prompt, typeof prompt?.identifier === "string" ? prompt.identifier : key);
        continue;
      }
      walk(value, key);
    }
  } else walk(preset, "preset");
  return found;
}

/** The table module, or the reason it could not be read - which is `not_measured`, never a pass. */
async function loadMacroModule() {
  try {
    const module = await import(MACRO_MODULE.href);
    if (
      !Array.isArray(module.PRESET_MACROS) ||
      typeof module.presetMacroTokens !== "function" ||
      typeof module.presetMacroEntryFor !== "function"
    )
      return {
        error:
          "the module exported no PRESET_MACROS table, no presetMacroTokens reader and no presetMacroEntryFor resolver",
      };
    return { tokens: module.presetMacroTokens, resolve: module.presetMacroEntryFor, table: module.PRESET_MACROS };
  } catch (error) {
    return { error: `${error.message}` };
  }
}

/** The placement reading, or the reason this run cannot say which segment anything lands in. */
async function loadPlacementModule() {
  try {
    const module = await import(PLACEMENT_MODULE.href);
    if (typeof module.presetEntryPlacements !== "function" || typeof module.PRESET_SEGMENTS_ORDER_MISSING !== "string")
      return { error: "the module exported no presetEntryPlacements reading" };
    return { placements: module.presetEntryPlacements, orderMissing: module.PRESET_SEGMENTS_ORDER_MISSING };
  } catch (error) {
    return { error: `${error.message}` };
  }
}

/** One violation row, reported once per code however many spellings produced it. */
function violationReporter() {
  const violations = [];
  const reported = new Set();
  return {
    violations,
    report(kind, name, extra) {
      const code = extra === undefined ? `${kind}:${name}` : `${kind}:${name}:${extra}`;
      if (reported.has(code)) return;
      reported.add(code);
      violations.push({ kind, name, ...(extra === undefined ? {} : { segment: extra }), code });
    },
  };
}

/** Nothing measured blocks, a violation fails, everything else passes: the worst verdict of one judgement. */
function judgedStatus(examined, violations) {
  if (examined === 0) return "blocked";
  return violations.length === 0 ? "passed" : "failed";
}

/** The run's own verdict is the worst of its judgements; `not_applicable` is not a verdict. */
function overallStatus(...statuses) {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("blocked")) return "blocked";
  return "passed";
}

/** A meta-gate reading of one judgement: `not_applicable` is satisfied, and anything unmeasured blocks. */
function checkStatus(status) {
  if (status === "failed") return "failed";
  if (status === "passed" || status === "not_applicable") return "passed";
  return "blocked";
}

/**
 * The whole macro reading: every token in the preset, judged against the table, in source order.
 *
 * `examined` is the population, so a preset that carries no macro is visible as `examined 0` and blocks
 * instead of passing; `names` is the distinct set, which is what a player-facing panel lists.
 */
export async function auditPresetMacros({ preset = FIXTURE_PRESET } = {}) {
  const loaded = await loadMacroModule();
  if (loaded.error !== undefined)
    return {
      examined: 0,
      names: [],
      violations: [],
      status: "blocked",
      blocked: { code: "preset_macros_table_unreadable", detail: loaded.error },
    };

  const tokens = presetStrings(preset).flatMap((value) => loaded.tokens(value));
  const { violations, report } = violationReporter();
  const names = [];

  for (const token of tokens) {
    // A shorthand's token name IS the variable it carries, so it is governed by the family entry that admits it
    // and reported under that entry's name; a name no entry admits keeps its own spelling as the unknown name.
    const entry = loaded.resolve(token.name);
    const name = entry === undefined ? token.name : entry.name;
    if (!names.includes(name)) names.push(name);
    if (entry === undefined) report("macro_unknown", name);
    else if (!entry.implemented) report("macro_not_implemented", name);
  }

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

/**
 * §4.2's third row: does every `tail-only` macro stay out of the stable prefix?
 *
 * The population of the RULE is `table.filter(segmentPolicy === "tail-only")` - never a list written here - and
 * the population of this RUN is every `{{...}}` token carried by an entry that lands in a segment. `tailOnly`
 * is printed beside `examined` so a green run that happened to meet no tail-only macro reads as exactly that.
 *
 * `table` is the population input, defaulting to the product's own; the gate's falsifier hands it a table with
 * no tail-only entry to prove the block below is wired to the derivation and not to a remembered count.
 */
export async function auditPresetSegments({ preset = FIXTURE_PRESET, segment, table } = {}) {
  const blocked = (code, detail) => ({
    mode: null,
    examined: 0,
    tailOnly: 0,
    unplaced: 0,
    placements: {},
    violations: [],
    status: "blocked",
    blocked: { code, detail },
  });

  const macros = await loadMacroModule();
  if (macros.error !== undefined) return blocked("preset_macros_table_unreadable", macros.error);
  const policies = table ?? macros.table;
  const tailOnlyNames = policies.filter((entry) => entry.segmentPolicy === "tail-only").map((entry) => entry.name);
  if (tailOnlyNames.length === 0)
    return blocked(
      "preset_segment_policy_population_empty",
      "no PRESET_MACROS entry declares segmentPolicy `tail-only`, so the policy this judgement asserts has no population",
    );

  const mode = segment !== undefined ? "declared" : "derived";
  if (segment === undefined) {
    const segmentsByIdentifier = new Map();
    const placement = await loadPlacementModule();
    if (placement.error !== undefined) return blocked("preset_segments_module_unreadable", placement.error);
    let placements;
    try {
      placements = placement.placements(preset);
    } catch (error) {
      const reason = `${error.message}`;
      // A fragment (a single entry, not a whole preset) declares no placement at all. That is not a green
      // segment judgement and not a block either: there is no segment question to ask of it.
      if (reason === placement.orderMissing)
        return {
          mode: "not_applicable",
          examined: 0,
          tailOnly: 0,
          unplaced: 0,
          placements: {},
          violations: [],
          status: "not_applicable",
          reason: `${reason}: the document carries no prompt_order, so it declares no segment`,
        };
      return blocked("preset_segments_unreadable", reason);
    }
    const counts = { before: 0, after: 0, depth: 0, cut: 0, disabled: 0, unplaced: 0 };
    for (const entry of placements) {
      counts[entry.segment] += 1;
      const seen = segmentsByIdentifier.get(entry.identifier) ?? new Set();
      seen.add(entry.segment);
      segmentsByIdentifier.set(entry.identifier, seen);
    }
    if (counts.cut === 0)
      return blocked(
        "preset_segments_cut_point_missing",
        "no prompt_order row is the chatHistory cut, so no entry has a segment the assembler would build",
      );
    const { violations, report } = violationReporter();
    const judged = judgeSegments({ preset, macros, tailOnlyNames, segmentsByIdentifier, report });
    if (judged.examined === 0)
      return {
        ...blocked(
          "preset_segments_none_found",
          "the entries that land in a segment spell no `{{...}}` token, so the policy judged nothing",
        ),
        placements: counts,
      };
    return {
      mode,
      ...judged,
      placements: counts,
      violations,
      status: judgedStatus(judged.examined, violations),
    };
  }

  const { violations, report } = violationReporter();
  const judged = judgeSegments({ preset, macros, tailOnlyNames, declared: segment, report });
  return {
    mode,
    ...judged,
    placements: {},
    violations,
    status: judgedStatus(judged.examined, violations),
    ...(judged.examined === 0
      ? {
          blocked: {
            code: "preset_segments_none_found",
            detail: `the preset spells no \`{{...}}\` token, so the "${segment}" segment judged nothing`,
          },
        }
      : {}),
  };
}

/**
 * Every token carried by a placed entry, judged against the declared policy, with the segment it landed in.
 *
 * `declared` attributes every occurrence to the one segment the caller named; otherwise the owner's own
 * placements decide, and an owner that no `prompt_order` row places (a top-level `name`, an entry no order
 * names) is `unplaced`: it reaches no segment, so no policy can be violated by it.
 */
function judgeSegments({ preset, macros, tailOnlyNames, segmentsByIdentifier, declared, report }) {
  let examined = 0;
  let tailOnly = 0;
  let unplaced = 0;
  for (const { owner, text } of presetStringsByOwner(preset)) {
    for (const token of macros.tokens(text)) {
      const entry = macros.resolve(token.name);
      const name = entry === undefined ? token.name : entry.name;
      const segments = declared === undefined ? [...(segmentsByIdentifier.get(owner) ?? ["unplaced"])] : [declared];
      if (segments.includes("unplaced")) {
        unplaced += 1;
        continue;
      }
      examined += 1;
      if (!tailOnlyNames.includes(name)) continue;
      tailOnly += 1;
      for (const landed of segments) if (landed === "before") report("macro_segment_violation", name, landed);
    }
  }
  return { examined, tailOnly, unplaced };
}

/** Both judgements over one document, with the worst verdict of the two as the run's own. */
export async function auditPreset({ preset = FIXTURE_PRESET, segment } = {}) {
  const macro = await auditPresetMacros({ preset });
  const segments = await auditPresetSegments({ preset, ...(segment === undefined ? {} : { segment }) });
  const status = overallStatus(macro.status, segments.status);
  const blocked = macro.blocked ?? segments.blocked;
  return {
    examined: macro.examined,
    names: macro.names,
    violations: [...macro.violations, ...segments.violations],
    status,
    ...(blocked === undefined ? {} : { blocked }),
    macroStatus: macro.status,
    macroViolations: macro.violations.length,
    macroBlocked: macro.blocked,
    segments,
  };
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

function segmentsLine(segments) {
  const placements = Object.entries(segments.placements)
    .map(([segment, count]) => `${segment}=${count}`)
    .join(" ");
  return (
    `preset_segments mode ${segments.mode} examined ${segments.examined} occurrences ` +
    `tail_only ${segments.tailOnly} unplaced ${segments.unplaced} ` +
    `placements ${placements.length === 0 ? "none" : placements} ` +
    `violations ${segments.violations.length} status ${segments.status}`
  );
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

  const audit = await auditPreset({ preset: read.preset, ...(segment === undefined ? {} : { segment }) });
  const reading = {
    gate: "preset-macros",
    source: read.source,
    segment: segment ?? null,
    examined: audit.examined,
    names: audit.names,
    violations: audit.violations,
    status: audit.status,
    ...(audit.blocked === undefined ? {} : { blocked: audit.blocked }),
    segments: audit.segments,
    // The meta-gate reads `checks[]`, not prose: this gate makes four judgements, and all of them have to be
    // visible as outcomes rather than inferred from the absence of violations. `population_is_non_empty` is the
    // G-A rule - nothing examined says nothing about coverage, so it is blocked rather than passed.
    checks: [
      { id: "population_is_non_empty", status: audit.examined > 0 ? "passed" : "blocked" },
      {
        id: "declared_table_covers_every_macro_in_the_preset",
        status: audit.macroStatus === "passed" ? "passed" : audit.macroStatus,
      },
      {
        id: "segment_policy_population_is_non_empty",
        status: audit.segments.blocked?.code === "preset_segment_policy_population_empty" ? "blocked" : "passed",
      },
      {
        id: "every_tail_only_macro_stays_out_of_the_stable_prefix",
        status: checkStatus(audit.segments.status),
      },
    ],
  };
  if (json) process.stdout.write(`${JSON.stringify(reading)}\n`);
  else {
    process.stdout.write(
      `preset_macros examined ${audit.examined} macros violations ${audit.macroViolations} ` +
        `names ${audit.names.length} status ${audit.macroStatus}\n`,
    );
    process.stdout.write(`${segmentsLine(audit.segments)}\n`);
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
  if (audit.macroBlocked !== undefined)
    process.stderr.write(
      `${audit.macroBlocked.code}: ${audit.macroBlocked.detail}; a run that examined nothing cannot pass\n`,
    );
  if (audit.segments.blocked !== undefined)
    process.stderr.write(
      `${audit.segments.blocked.code}: ${audit.segments.blocked.detail}; a run that judged nothing cannot pass\n`,
    );
  process.exitCode = audit.status === "passed" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
