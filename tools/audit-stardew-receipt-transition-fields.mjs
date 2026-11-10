// Gate: stardew_receipt_transition_field_provenance/v1
//
// A receipt field whose name claims a PHYSICAL TRANSITION must carry a value this execution READ, never a literal
// written beside it. Two live receipts were lying and both had the same shape:
//
//   till_soil      `string before = "none";` before the hoe swung - the tile was never read, so a swing on ground that
//                  already carried a `HoeDirt` would have published `before=none;after=HoeDirt`: a delta of zero
//                  reported as a success (farmhandexecutioncontroller.resourcetoolactions.cs).
//   pickup_item    `chunk_removed=true` as literal text, while the SAME evidence string is reused by a branch reached
//                  only when a chunk of this identity is still somewhere in the location (measured 2026-10-25:
//                  `inventory_before=8;inventory_after=9` with the debris still on the ground). The Host validator
//                  demanded the lie, so the Mod could not report what it observed
//                  (host/src/stardew-game-integration-adapter.ts `hasPickupItemCompletionEvidence`).
//
// THE POPULATION is derived from the receipt builders, not listed: every `farmhandexecutioncontroller*.cs` partial
// under `integrations/stardew` (the files that construct `LocalExecutionReceipt`s), and inside each one every
// `key=value` pair whose KEY is transition-shaped - `before`, `after`, `removed`, `delta`, or a `*_before` /
// `*_after` / `*_removed` / `*_delta` compound - in the literal text of an interpolated string. `health_before` and
// `stamina_after` are members for that reason; `native_auto_collect` and `held_object_empty` are not, because they
// state a mechanism rather than a before/after of the world.
//
// TWO SHAPES ARE FABRICATED, and each names the line that would have to change:
//
//   fabricated_delta:<file>:<line>:<field>   the value is literal text inside the evidence (`chunk_removed=true`)
//   fabricated_delta:<file>:<line>:<field>   the value is `{name}` but `name` is assigned a string or boolean literal
//                                            in the same file (`before={before}` beside `string before = "none";`)
//
// WHAT IT DOES NOT READ. A numeric literal assigned to a binding (`int points = -1;`) is not judged: a sentinel for
// "this path never ran" and a fabricated zero are the same characters, and a gate that guessed between them would
// report the wrong defect. A numeric literal written directly in the evidence IS judged, because there the number is
// the claim itself. Rejection receipts are NOT exempt: `removed=none` on a refusal is still a statement about the
// world, so it appears in the allow-list with the guard that entails it rather than being skipped unseen.
//
// THE ALLOW-LIST is one entry per `file|field|value`, each carrying the one-line reason the constant cannot be read
// from anywhere - today, without exception, an admission or branch guard of the same execution restating itself.
// Every entry EXPIRES: an allowance whose literal no longer occurs is `stale_allowance_entry`, so the list only
// shrinks, and a lane that replaces its restated constant with the read deletes its entry in the same commit.
//
// red-proof: inject  restoring the two fabricated literals this gate was written for (`before = "none"` in
//                    till_soil, `chunk_removed=true` in the pickup receipt) -> `fabricated_delta:<file>:<line>:<field>`
//                    on each exact line (tools/audit-stardew-receipt-transition-fields.test.mjs)
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const GATE = "stardew_receipt_transition_field_provenance/v1";

/** The Mod directory that holds the receipt builders. */
export const MOD_ROOT = "integrations/stardew";

/** The receipt builders: every execution-controller partial, by directory scan rather than by name. */
const RECEIPT_BUILDER = /^farmhandexecutioncontroller[a-z0-9.]*\.cs$/u;

/**
 * A field name that claims a before/after of the world. A compound qualifies by its TRAILING noun, so `health_before`
 * and `stamina_after` are members while `before_watered` (a state, not a transition timestamp) is not.
 */
export const TRANSITION_FIELD =
  /^(?:before|after|removed|delta|[a-z0-9]+(?:_[a-z0-9]+)*_(?:before|after|removed|delta))$/u;

/**
 * Literal transition values that cannot be read from anywhere, each with the guard that entails it.
 *
 * Every entry is a value the same execution has already established by a predicate it evaluated in the same block -
 * an admission refusal (`wearable_destination_slot_occupied`) or the action's own definitional premise
 * (`clear_hoedirt` on a tile that carries a `HoeDirt`). None of them reports a delta the game did not measure; the two
 * that did are fixed, and a fix deletes its entry because a stale allowance is red.
 */
export const LITERAL_TRANSITION_ALLOWANCES = Object.freeze(
  [
    {
      file: "integrations/stardew/farmhandexecutioncontroller.actorstateactions.cs",
      field: "occupant_after",
      value: "none",
      reason:
        "the `wearable_target_changed` refusal for `removed is null`: the native seam returned nothing to take off, so there is no occupant after it",
    },
    {
      file: "integrations/stardew/farmhandexecutioncontroller.actorstateactions.cs",
      field: "removed",
      value: "none",
      reason:
        "the same `removed is null` refusal: nothing was removed, which is the branch's own condition and not an observation",
    },
    {
      file: "integrations/stardew/farmhandexecutioncontroller.actorstateactions.cs",
      field: "destination_before",
      value: "none",
      reason:
        "`wearable_destination_slot_occupied` refuses the request unless `player.Items[slot] is null`, so the destination was empty by admission",
    },
    {
      file: "integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs",
      field: "source_empty_before",
      value: "true",
      reason:
        "`crab_pot_target_unavailable` refuses the request when `farm.objects` holds the tile, so the placement ground was empty by admission",
    },
    {
      file: "integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs",
      field: "bait_before",
      value: "none",
      reason: "the request path admits a crab pot only while it carries no bait, so the pot was unbaited by admission",
    },
    {
      file: "integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs",
      field: "clump_removed",
      value: "true",
      reason:
        "the success half of a ternary on `cleared`; the literal restates the branch the postcondition already decided",
    },
    {
      file: "integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs",
      field: "clump_removed",
      value: "false",
      reason: "the failure half of the same ternary on `cleared`; the branch condition is the measurement",
    },
    {
      file: "integrations/stardew/farmhandexecutioncontroller.gatheringactions.cs",
      field: "chunk_removed",
      value: "true",
      reason:
        "`TrySettleMagnetCollectedItem` is reached only after `FindItemTarget` found no chunk of this identity anywhere in the location",
    },
    {
      file: "integrations/stardew/farmhandexecutioncontroller.machinesanimalsitemsactions.cs",
      field: "ready_before",
      value: "true",
      reason:
        "output can only be collected from a ready machine: the request path refuses an unready one, so it was ready before",
    },
    {
      file: "integrations/stardew/farmhandexecutioncontroller.machinesanimalsitemsactions.cs",
      field: "minutes_until_ready_before",
      value: "0",
      reason: "the same admission: an unready machine refuses the request, so zero minutes remained before collection",
    },
    {
      file: "integrations/stardew/farmhandexecutioncontroller.machinesanimalsitemsactions.cs",
      field: "quest_completed_after",
      value: "false",
      reason:
        "the `quest_quantity_mismatch` refusal runs before any item moves, so nothing could have completed the quest",
    },
    {
      file: "integrations/stardew/farmhandexecutioncontroller.nameentityactions.cs",
      field: "name_before",
      value: "none",
      reason: "the request path admits naming only for an unnamed entity, so it carried no name before by admission",
    },
    {
      file: "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs",
      field: "hoedirt_present_before",
      value: "true",
      reason:
        "`clear_hoedirt` is defined as clearing a `HoeDirt` and `dig_artifact_spot` refuses a tile that carries one, so both branches are admission premises",
    },
    {
      file: "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs",
      field: "crop_before",
      value: "false",
      reason:
        "the request path refuses a `clear_hoedirt` on a tile that carries a crop, so no crop was there by admission",
    },
  ].map(Object.freeze),
);

/** A quoted string literal, or a boolean literal: the two spellings of a state word a receipt publishes. */
const BINDING_LITERAL = /^(?:"[^"]*"|true|false)$/u;

/** `[type] name = <rhs>;` - the binding shape a fabricated `field={name}` is fed from. */
const BINDING_ASSIGNMENT = /^\s*(?:[A-Za-z_][A-Za-z0-9_.<>?[\]]*\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*([^;]+);\s*$/u;

/** Where a hole sat in the literal text, so `field={name}` can be followed to `name`'s own binding. */
const HOLE = "\u0000";

const isIdentifier = (expression) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(expression);

/**
 * The source with its comments blanked out, offset for offset.
 *
 * A comment spelling `before=none` is a sentence about the defect, not the defect; and a `//` inside a string literal
 * (a URL, a piece of evidence) is not a comment. Both directions matter, so strings and character literals are
 * skipped rather than parsed.
 */
export function stripComments(source) {
  const characters = [...source];
  const blank = (from, to) => {
    for (let index = from; index < to; index += 1) if (characters[index] !== "\n") characters[index] = " ";
  };
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      const stop = end < 0 ? source.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (character === '"' || character === "'") {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (source[cursor] === character) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      index = cursor;
      continue;
    }
    index += 1;
  }
  return characters.join("");
}

function lineOffsets(source) {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") offsets.push(index + 1);
  return offsets;
}

function lineOf(offsets, offset) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/**
 * Every transition-shaped `key=value` pair in the literal text of an interpolated string, with the line it sits on.
 *
 * `holes` holds the expression of each `{...}` in the value, in order, so `before={before}` resolves to `before`.
 */
export function extractTransitionFields(source) {
  const code = stripComments(source);
  const offsets = lineOffsets(code);
  const fields = [];
  for (let index = 0; index < code.length; index += 1) {
    const prefix = interpolationPrefix(code, index);
    if (prefix === 0) continue;
    const { segments, end } = readInterpolatedString(code, index, prefix);
    for (const segment of segments) {
      const equals = segment.text.indexOf("=");
      if (equals <= 0) continue;
      const key = segment.text.slice(0, equals).trim();
      if (!TRANSITION_FIELD.test(key)) continue;
      fields.push({
        key,
        value: segment.text.slice(equals + 1),
        holes: segment.holes,
        line: lineOf(offsets, segment.start),
      });
    }
    index = end - 1;
  }
  return fields;
}

/** The prefix length of an interpolated string opening at `index`, or 0 when no string opens there. */
function interpolationPrefix(code, index) {
  if (code[index] === "$" && code[index + 1] === '"') return 2;
  if (code[index] === "$" && code[index + 1] === "@" && code[index + 2] === '"') return 3;
  if (code[index] === "@" && code[index + 1] === "$" && code[index + 2] === '"') return 3;
  return 0;
}

/**
 * One interpolated string, read from its opening quote: its `;`-separated segments with every `{...}` replaced by a
 * HOLE, and the offset just past the closing quote. `$@"` / `@$"` are verbatim, so a backslash is a character there.
 */
function readInterpolatedString(code, start, prefix) {
  const verbatim = code[start] === "@";
  const segments = [];
  let cursor = start + prefix;
  let segmentStart = cursor;
  let text = "";
  let holes = [];
  const flush = () => {
    segments.push({ start: segmentStart, text, holes });
    text = "";
    holes = [];
  };
  while (cursor < code.length) {
    const character = code[cursor];
    const next = code[cursor + 1];
    if (!verbatim && character === "\\") {
      text += next ?? "";
      cursor += 2;
      continue;
    }
    if (character === '"' && next === '"') {
      text += '"';
      cursor += 2;
      continue;
    }
    if (character === '"') break;
    // `{{` and `}}` are the escaped braces of a literal, not a hole and not its close.
    if ((character === "{" && next === "{") || (character === "}" && next === "}")) {
      text += character;
      cursor += 2;
      continue;
    }
    if (character === "{") {
      const holeStart = cursor;
      cursor = endOfHole(code, holeStart);
      holes.push(code.slice(holeStart + 1, cursor).trim());
      text += HOLE;
      cursor += 1;
      continue;
    }
    if (character === ";") {
      flush();
      segmentStart = cursor + 1;
      cursor += 1;
      continue;
    }
    text += character;
    cursor += 1;
  }
  flush();
  return { segments, end: cursor + 1 };
}

/** The offset of the `}` closing the hole that opens at `open`; nesting inside the expression is counted. */
function endOfHole(code, open) {
  let cursor = open;
  let depth = 0;
  while (cursor < code.length) {
    if (code[cursor] === "{") depth += 1;
    else if (code[cursor] === "}") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  return cursor;
}

/** `fabricated` for a value that is literal text, or for `{name}` whose binding is itself a literal. */
export function classifyTransitionField(field, bindingLiterals) {
  if (!field.value.includes(HOLE)) return field.value === "" ? "computed" : "fabricated";
  const expressions = field.holes;
  const named = expressions.find((expression) => isIdentifier(expression));
  if (field.value === HOLE && named !== undefined && bindingLiterals.has(named)) return "fabricated_binding";
  return "computed";
}

/** Every `name = <string or boolean literal>;` binding in the file, keyed by the name being bound. */
export function extractBindingLiterals(source) {
  const bindings = new Map();
  const lines = stripComments(source).split("\n");
  lines.forEach((line, index) => {
    const match = BINDING_ASSIGNMENT.exec(line);
    if (match === null) return;
    const [, name, right] = match;
    const value = right.trim();
    if (!BINDING_LITERAL.test(value)) return;
    if (!bindings.has(name)) bindings.set(name, []);
    bindings.get(name).push({ line: index + 1, value: value.replace(/^"|"$/gu, "") });
  });
  return bindings;
}

export function receiptBuilderFiles(root = repositoryRoot) {
  return readdirSync(path.join(root, MOD_ROOT))
    .filter((name) => RECEIPT_BUILDER.test(name))
    .map((name) => `${MOD_ROOT}/${name}`)
    .sort();
}

function allowanceKey(file, field, value) {
  return `${file}|${field}|${value}`;
}

/**
 * @param {{ root?: string, overrides?: Record<string, string> }} options
 */
export function checkStardewReceiptTransitionProvenance({ root = repositoryRoot, overrides = {} } = {}) {
  const files = receiptBuilderFiles(root);
  const allowances = new Map(
    LITERAL_TRANSITION_ALLOWANCES.map((entry) => [allowanceKey(entry.file, entry.field, entry.value), entry]),
  );
  const applied = new Map();
  const violations = [];
  let examined = 0;
  let computed = 0;
  let literal = 0;

  const report_ = (code, file, line, field, value, detail) =>
    violations.push({ code, file, line, field, value, detail: `${code}:${file}:${line}:${field} ${detail}` });

  for (const file of files) {
    const source = overrides[file] ?? readFileSync(path.join(root, file), "utf8");
    const bindingLiterals = extractBindingLiterals(source);
    for (const field of extractTransitionFields(source)) {
      examined += 1;
      const shape = classifyTransitionField(field, bindingLiterals);
      if (shape === "computed") {
        computed += 1;
        continue;
      }
      literal += 1;
      const value = shape === "fabricated_binding" ? bindingLiterals.get(field.holes[0])[0].value : field.value;
      const line = shape === "fabricated_binding" ? bindingLiterals.get(field.holes[0])[0].line : field.line;
      const key = allowanceKey(file, field.key, value);
      const allowance = allowances.get(key);
      if (allowance !== undefined) {
        applied.set(key, (applied.get(key) ?? 0) + 1);
        continue;
      }
      report_(
        "fabricated_delta",
        file,
        line,
        field.key,
        value,
        shape === "fabricated_binding"
          ? `is interpolated as {${field.holes[0]}} but bound to the literal \`${value}\`, so no read stands behind it`
          : `is written as the literal \`${value}\` in the receipt evidence instead of a value this execution read`,
      );
    }
  }

  for (const [key, allowance] of allowances) {
    // An allowance for a file this run did not examine is not stale - it is unmeasured, which is exactly what the gate
    // refuses to call green. Only a literal that is gone from a file that WAS read has expired.
    if (!files.includes(allowance.file)) continue;
    if (applied.has(key)) continue;
    report_(
      "stale_allowance_entry",
      allowance.file,
      0,
      allowance.field,
      allowance.value,
      `no longer occurs, so its reason ("${allowance.reason}") has expired: delete the entry`,
    );
  }

  if (files.length === 0)
    report_("gate_measured_nothing", MOD_ROOT, 0, "<population>", "", "found no receipt builder to examine");
  else if (examined === 0)
    report_("gate_measured_nothing", MOD_ROOT, 0, "<population>", "", "found receipt builders but no transition field");

  // One finding per (file, line, field): the same fabricated binding can feed several receipt fields, and two
  // identical lines in the report read as two defects.
  const unique = new Map(violations.map((violation) => [violation.detail, violation]));
  const reported = [...unique.values()];
  reported.sort((left, right) => left.detail.localeCompare(right.detail));
  return Object.freeze({
    gate: GATE,
    status: reported.length === 0 ? "passed" : "blocked",
    mode: "receipt_builders",
    population: examined,
    files: files.length,
    computed,
    literal,
    allowed: literal - reported.filter((violation) => violation.code === "fabricated_delta").length,
    allowances: Object.freeze({
      total: allowances.size,
      applied: applied.size,
      stale: reported.filter((violation) => violation.code === "stale_allowance_entry").length,
    }),
    violations: Object.freeze(reported),
  });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkStardewReceiptTransitionProvenance();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `receipt_transition_fields examined=${report.population} files=${report.files} computed=${report.computed} ` +
      `literal=${report.literal} allowances=${report.allowances.applied}/${report.allowances.total} ` +
      `status=${report.status}\n`,
  );
  // The machine report, last: one line, so the shared judge (`tools/lib/assert-non-vacuous.mjs`) can read the
  // population beside the verdict instead of trusting the exit status alone.
  process.stdout.write(
    `${JSON.stringify({
      gate: report.gate,
      status: report.status,
      mode: report.mode,
      population: report.population,
      files: report.files,
      computed: report.computed,
      literal: report.literal,
      allowances: report.allowances,
      violations: report.violations.map((violation) => violation.detail),
    })}\n`,
  );
  process.exitCode = report.status === "passed" ? 0 : 1;
}
