import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * EVERY FIELD THE MOD PUBLISHES MUST BE A FIELD THE HOST READS - AND VICE VERSA.
 *
 * <p>
 * `snapshot-loopback.test.ts` proves the Host accepts a real sample, but only for the families a headless world can
 * construct (7 of 79). This gate closes the rest by comparing the two DECLARATIONS, which exist for every family:
 * </p>
 *
 * <pre>
 *   Mod    public sealed record BridgeXxxTarget(string TargetId, string Location, int X, ...)
 *   Host   function isXxxTargetFact(value): hasExactKeys(value, ["targetId", "location", "x", ...])
 * </pre>
 *
 * <p>
 * A field on one side and not the other is a wire break in one direction or the other: the Mod publishes what the Host
 * rejects (`invalid_snapshot`, the bridge closes on the first real farm) or the Host demands what the Mod never sends
 * (every snapshot refused). Both are what this repository spent a week discovering one live run at a time.
 * </p>
 *
 * <p>
 * Population is derived on BOTH sides - the C# `BridgeSnapshot` declaration names the families and their record types, and
 * the TypeScript is read for its key lists - so a family added to either side is covered without editing this file. A
 * family the C# side declares but the Host has no validator for is reported too: silence is not acceptance.
 * </p>
 */

/**
 * One capture that participated in the match.
 *
 * `noUncheckedIndexedAccess` types every group as `string | undefined`, and this gate may not paper over that: a group
 * that did not participate would arrive as `undefined`, and a non-null assertion would instead compile as the literal
 * string `"undefined"` - a name nothing publishes, so a comparison would go quietly green over a parser that matched
 * nothing. The impossible case FAILS BY NAME instead of being asserted away.
 */
function captured(match: readonly (string | undefined)[], index: number, what: string): string {
  const value = match[index];
  if (value === undefined) throw new Error(`${what}: capture group ${index} did not participate in the match`);
  return value;
}

function repoRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository root not found from ${start}`);
    directory = parent;
  }
}

const ROOT = repoRoot(dirname(fileURLToPath(import.meta.url)));
/**
 * Every `.cs` under the Mod's Models directory, concatenated.
 *
 * Not one file: `BridgeWearableTarget` and `WorldObjectTarget` live in their own files, and reading only
 * `BridgeProtocolModels.cs` reported both as "does not exist" - a parser with a narrower boundary than the thing it
 * describes, which is the defect class this gate exists to find.
 */
function modModelsSource() {
  const directory = join(ROOT, "integrations/stardew/src/Core/Models");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".cs"))
    .map((name) => readFileSync(join(directory, name), "utf8"))
    .join("\n");
}

const MODELS = modModelsSource();
const FACTS = readFileSync(join(ROOT, "host/src/protocol-target-facts.ts"), "utf8");
const PROTOCOL = readFileSync(join(ROOT, "host/src/protocol.ts"), "utf8");
const ALL_TS = `${FACTS}\n${PROTOCOL}`;

/** `record` name -> its declared fields, from one-line and multi-line record declarations alike. */
function modRecords(): Map<string, readonly string[]> {
  const records = new Map<string, readonly string[]>();
  const pattern = /public sealed record (Bridge\w+)\(([\s\S]*?)\);/g;
  for (const record of MODELS.matchAll(pattern)) {
    const name = captured(record, 1, "a Bridge record name");
    const body = captured(record, 2, `the \`${name}\` record body`);
    const fields = [...body.matchAll(/(?:[A-Za-z_][\w<>,?.\s\[\]]*?)\s+(\w+)\s*(?=,|$)/g)]
      .map((match) => captured(match, 1, `a \`${name}\` field`))
      .filter((field) => field !== "null" && field !== "string" && field !== "int");
    // A parameter may span a line; the capture above is per-parameter because the body splits on top-level commas.
    const parameters = splitTopLevel(body);
    const named = parameters
      .map((parameter) => /(\w+)\s*(?:=\s*[^,]*)?$/.exec(parameter.trim()))
      .filter((match) => match !== null)
      .map((match) => captured(match, 1, `a \`${name}\` parameter name`));
    records.set(name, named.length > 0 ? named : fields);
  }
  return records;
}

/**
 * Split a parameter list on commas that are not inside `<>`, `[]`, or parentheses.
 *
 * ATTRIBUTES ARE STRIPPED FIRST. A record parameter may carry `[property: JsonIgnore(Condition = ...)]`, and the first
 * version of this parser read `Condition` out of that attribute and reported it as a field - which made the gate name two
 * real families with two invented disagreements. Reading C# with a regex is what produced that; stripping the bracket
 * group before splitting is the cheapest way to keep the regex honest about what it can see.
 */
function splitTopLevel(body: string): readonly string[] {
  const withoutAttributes = body.replace(/\[[^\]]*\]/g, " ");
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of withoutAttributes) {
    if ("<[(".includes(character)) depth += 1;
    else if (">])".includes(character)) depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

/** family field name -> the record type it publishes. From `BridgeSnapshot`'s own declaration. */
function modFamilies(): Map<string, string> {
  const declaration = MODELS.indexOf("public sealed record BridgeSnapshot(");
  assert.ok(declaration >= 0, "BridgeSnapshot must be findable by its declaration");
  // The declaration's own text is what tells the parser where its parameter list ends, so an unreadable end is a
  // parser failure named here rather than a slice that silently starts from 0.
  const declaredAt = MODELS.indexOf("\n)", declaration);
  if (declaredAt < 0)
    throw new Error("BridgeSnapshot's declaration has no end: the C# source is not the shape this reads");
  const parameters = splitTopLevel(
    MODELS.slice(declaration + "public sealed record BridgeSnapshot(".length, declaredAt),
  );
  const families = new Map<string, string>();
  for (const parameter of parameters) {
    const match = /IReadOnlyList<Bridge(\w+)>\?\s+(\w+)/.exec(parameter);
    if (match !== null)
      families.set(
        captured(match, 2, "a BridgeSnapshot family name"),
        `Bridge${captured(match, 1, "a BridgeSnapshot family type")}`,
      );
  }
  return families;
}

/** predicate function name -> its key list (null when it names none). */
function hostValidators(): Map<string, readonly string[] | null> {
  const validators = new Map<string, readonly string[] | null>();
  for (const match of ALL_TS.matchAll(/function (is\w+)\([^)]*\): boolean \{([\s\S]*?)\n\}/g)) {
    const name = captured(match, 1, "a Host snapshot validator name");
    const body = captured(match, 2, `the \`${name}\` validator body`);
    // Two helpers, and both are honest field lists: `hasExactKeys` demands exact equality, `hasOnlyKeys` allows a key
    // to be absent (an optional field) but never an unlisted one. Either way the list IS the published field set.
    const keys = /has(?:Exact|Only)Keys\(\s*\w+\s*,\s*\[([\s\S]*?)\]/.exec(body);
    if (keys === null) {
      validators.set(name, null);
      continue;
    }
    validators.set(
      name,
      [...captured(keys, 1, `the \`${name}\` key list`).matchAll(/"([^"]+)"/g)].map((entry) =>
        captured(entry, 1, `a \`${name}\` key`),
      ),
    );
  }
  return validators;
}

/**
 * The validator for a family, or a named failure.
 *
 * The record type is NOT derivable from the family name (`WorldObjectTargets` publishes a record that is not
 * `BridgeWorldObjectTarget`), so candidates are matched by FIELD OVERLAP against the record the snapshot declares.
 * Matching by name produced four invented disagreements on the first run, which is the same trap as reading C# with a
 * regex and believing the first match.
 */
/**
 * The validator the Host actually applies to a family, read from `SNAPSHOT_FAMILY_RULES`.
 *
 * Not derived from the family name, and not guessed by field overlap. Both attempts before this one were wrong:
 * `WorldObjectTargets` publishes a record whose name does not follow the family, `BridgeSoilTile` has two fields that both
 * appear inside `isForageTargetFact` so overlap matched a tile to a forage validator, and `warps`/`doorTargets` share one
 * `isWarp` predicate that is not named `is*Fact` at all. The Host already declares the answer next to each field -
 * `accepts: isWarp` - so read that.
 */
function validatorFor(
  family: string,
  rules: ReadonlyMap<string, string>,
  predicates: ReadonlyMap<string, readonly string[] | null>,
): Readonly<{ missing: string }> | Readonly<{ name: string; keys: readonly string[] }> {
  const rule = rules.get(family);
  if (rule === undefined) return { missing: `the Host declares no rule for ${family}, so it is never validated` };
  const predicate = predicates.get(rule);
  if (predicate === undefined)
    return {
      missing: `the Host\'s rule for ${family} accepts \`${rule}\`, which is not defined in protocol-target-facts.ts`,
    };
  if (predicate === null)
    return { missing: `\`${rule}\` (${family}) names no key list, so its field set is not checkable` };
  return { name: rule, keys: predicate };
}

/** Every key the Host's snapshot validator admits at all, from `SNAPSHOT_KEYS`. */
function hostSnapshotKeys(): Set<string> {
  const declaration = PROTOCOL.indexOf("const SNAPSHOT_KEYS");
  if (declaration < 0) throw new Error("SNAPSHOT_KEYS is not declared in protocol.ts: this gate reads it by name");
  const end = PROTOCOL.indexOf("]", declaration);
  if (end < 0) throw new Error("SNAPSHOT_KEYS has no closing bracket: the declaration is not the shape this reads");
  const block = PROTOCOL.slice(declaration, end);
  const keys = new Set<string>();
  for (const match of block.matchAll(/"([^"]+)"/g)) keys.add(captured(match, 1, "a SNAPSHOT_KEYS entry"));
  return keys;
}
/** `field` -> the `accepts:` predicate name, from the Host\'s own family table. */
function hostFamilyRules(): Map<string, string> {
  const rules = new Map<string, string>();
  for (const match of PROTOCOL.matchAll(/\{ field: "(\w+)", maxItems: \d+, accepts: (\w+) \}/g))
    rules.set(
      captured(match, 1, "a snapshot family field"),
      captured(match, 2, `the \`accepts\` predicate of \`${captured(match, 1, "a snapshot family field")}\``),
    );
  return rules;
}

const lowerFirst = (value: string): string => `${value.charAt(0).toLowerCase()}${value.slice(1)}`;

test("every field the Mod publishes is a field the Host validates", () => {
  const records = modRecords();
  const families = modFamilies();
  const validators = hostValidators();
  const rules = hostFamilyRules();
  const snapshotKeys = hostSnapshotKeys();

  assert.ok(records.size > 50, `the Mod's records must have been parsed (found ${records.size})`);
  assert.ok(families.size > 50, `BridgeSnapshot must declare its families (found ${families.size})`);
  assert.ok(validators.size > 50, `the Host's validators must have been parsed (found ${validators.size})`);

  const disagreements = [];
  const withoutValidator = [];
  for (const [family, recordName] of families) {
    const fields = records.get(recordName);
    if (fields === undefined) {
      disagreements.push(`${family}: publishes ${recordName}, which does not exist in BridgeProtocolModels.cs`);
      continue;
    }
    const wireName = lowerFirst(family);
    const matched = validatorFor(wireName, rules, validators);
    if ("missing" in matched) {
      // A key in SNAPSHOT_KEYS with no array rule is a scalar or object validated on its own, not a family whose rows
      // are checked one by one. The Host still guarantees it is a key it knows; that is the guarantee available here,
      // and saying so is more honest than reporting drift this gate cannot see into.
      if (snapshotKeys.has(wireName)) continue;
      withoutValidator.push(`${family}: ${matched.missing}`);
      continue;
    }
    const validator = matched.name;
    const keys = matched.keys;
    const published = new Set(fields.map(lowerFirst));
    const validated = new Set(keys);
    // A validator may name an OPTIONAL key the record omits: `BridgeDoor` has no `accessible`, and `isWarp` (shared with
    // `warps`) accepts one because the Mod omits a null member on the wire. This list is deliberately one entry long - a
    // second entry needs its own reason here, because "the validator is looser than the record" is otherwise exactly the
    // drift this gate reports.
    const OPTIONAL_ON_THE_WIRE = new Map([
      ["accessible", "a null measurement is omitted, so absence means not measured"],
    ]);
    for (const field of published)
      if (!validated.has(field))
        disagreements.push(`${family}.${field}: the Mod publishes it and \`${validator}\` does not name it`);
    for (const key of validated)
      if (!published.has(key) && !OPTIONAL_ON_THE_WIRE.has(key))
        disagreements.push(`${family}.${key}: \`${validator}\` demands it and the Mod does not publish it`);
  }

  assert.deepEqual(
    disagreements,
    [],
    `a field on one side only is a wire break in one direction: the Mod sends what the Host rejects, or the Host demands\n` +
      `what the Mod never sends.\n${disagreements.join("\n")}`,
  );
  assert.deepEqual(
    withoutValidator,
    [],
    `a family with no Host validator is accepted unexamined, which is not the same as accepted correctly:\n` +
      withoutValidator.join("\n"),
  );
});

test("the comparison is not vacuous: a known family and its field are found", () => {
  // A parser that matched nothing would report perfect agreement with everything. `treeChopSourceTargets` is the family
  // whose `health` field this repository got wrong in both directions, so it must be present on both sides.
  const families = modFamilies();
  assert.equal(families.get("TreeChopSourceTargets"), "BridgeTreeChopSourceTarget");
  const fields = modRecords().get("BridgeTreeChopSourceTarget");
  assert.ok(Array.isArray(fields), "BridgeTreeChopSourceTarget must be parsed");
  assert.ok(fields.includes("Health"), `its fields must be read; parsed [${fields.join(", ")}]`);
  const keys = hostValidators().get("isTreeChopSourceTargetFact");
  assert.ok(Array.isArray(keys), "isTreeChopSourceTargetFact must be parsed");
  assert.ok(keys.includes("health"), `its keys must be read; parsed [${keys.join(", ")}]`);
});
