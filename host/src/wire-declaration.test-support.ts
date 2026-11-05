/**
 * The shared reader for the two DECLARATIONS of the bridge: the Mod's C# records and the Host's predicates.
 *
 * <p>
 * `declaration-agreement.test.ts` compares field NAMES; `protocol-target-facts-domain.test.ts` compares field
 * DOMAINS. Both must read the same two sources the same way, or the two gates can disagree about what a record
 * declares and neither reading is authority. This module is that one reader.
 * </p>
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One capture that participated in the match.
 *
 * `noUncheckedIndexedAccess` types every group as `string | undefined`, and these readers may not paper over that: a
 * group that did not participate would arrive as `undefined`, and a non-null assertion would instead compile as the
 * literal string `"undefined"` - a name nothing publishes, so a comparison would go quietly green over a parser that
 * matched nothing. The impossible case FAILS BY NAME instead of being asserted away.
 */
export function captured(match: readonly (string | undefined)[], index: number, what: string): string {
  const value = match[index];
  if (value === undefined) throw new Error(`${what}: capture group ${index} did not participate in the match`);
  return value;
}

export function repositoryRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository root not found from ${start}`);
    directory = parent;
  }
}

export const ROOT = repositoryRoot(dirname(fileURLToPath(import.meta.url)));

/**
 * Every `.cs` under the Mod's Models directory, concatenated.
 *
 * Not one file: `BridgeWearableTarget` and `WorldObjectTarget` live in their own files, and reading only
 * `BridgeProtocolModels.cs` reported both as "does not exist" - a parser with a narrower boundary than the thing it
 * describes, which is the defect class these gates exist to find.
 */
function modModelsSource(): string {
  const directory = join(ROOT, "integrations/stardew/src/Core/Models");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".cs"))
    .map((name) => readFileSync(join(directory, name), "utf8"))
    .join("\n");
}

export const MODELS = modModelsSource();
export const FACTS = readFileSync(join(ROOT, "host/src/protocol-target-facts.ts"), "utf8");
export const PROTOCOL = readFileSync(join(ROOT, "host/src/protocol.ts"), "utf8");
const ALL_TS = `${FACTS}\n${PROTOCOL}`;

/** One C# record parameter: its declared type and its name. */
export interface ModField {
  readonly type: string;
  readonly name: string;
}

/**
 * Split a parameter list on commas that are not inside `<>`, `[]`, or parentheses.
 *
 * ATTRIBUTES ARE STRIPPED FIRST. A record parameter may carry `[property: JsonIgnore(Condition = ...)]`, and the first
 * version of this parser read `Condition` out of that attribute and reported it as a field - which made a gate name two
 * real families with two invented disagreements. Reading C# with a regex is what produced that; stripping the bracket
 * group before splitting is the cheapest way to keep the regex honest about what it can see.
 */
export function splitTopLevel(body: string): readonly string[] {
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

/**
 * Strip C# comments from a declaration body before it is split.
 *
 * A parameter list carries `//` and `///` comments between its parameters - `BridgeSnapshot` explains a field in the
 * middle of its own declaration - and a splitter that reads them as parameters reports the prose as a field. The
 * name-only reading this replaces lost those tokens to its `null`/`string`/`int` filter by accident; naming the strip
 * is what makes the same body readable when the TYPE has to survive.
 */
function withoutComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** One record parameter, read as `<type> <name>`.
 *
 * The type is kept, not discarded: a numeric DOMAIN is a property of the declared type, and the name-only reading this
 * replaces could not tell `int Health` from `string Health`.
 */
function readParameter(parameter: string, record: string): ModField | null {
  const trimmed = parameter.trim();
  if (trimmed.length === 0) return null;
  const match = /^(.+?)\s+(\w+)\s*(?:=\s*[^,]*)?$/u.exec(trimmed);
  if (match === null)
    throw new Error(`\`${record}\`: a parameter this reader cannot split into type and name: "${trimmed}"`);
  return {
    type: captured(match, 1, `a \`${record}\` parameter type`).trim(),
    name: captured(match, 2, `a \`${record}\` parameter name`),
  };
}

/** `record` name -> its declared fields, from one-line and multi-line record declarations alike. */
export function modRecords(): Map<string, readonly ModField[]> {
  const records = new Map<string, readonly ModField[]>();
  // The parameter list ends at a `)` followed by the record's own `;` OR by a body `{`. Anchoring on `);` alone read
  // `BridgeScope` - whose declaration is followed by an `IsValid` body - as one enormous parameter, because the first
  // `);` after it is inside that body. It is not a snapshot family, so the name-only gate never noticed; a DOMAIN gate
  // would have attributed its fields to the wrong record.
  for (const record of MODELS.matchAll(/public sealed record (Bridge\w+)\(([\s\S]*?)\)\s*(?:;|\{)/g)) {
    const name = captured(record, 1, "a Bridge record name");
    const body = withoutComments(captured(record, 2, `the \`${name}\` record body`));
    const fields = splitTopLevel(body)
      .map((parameter) => readParameter(parameter, name))
      .filter((field): field is ModField => field !== null);
    if (fields.length === 0) throw new Error(`\`${name}\`: no field was read from a record that declares one`);
    records.set(name, fields);
  }
  return records;
}

/** family field name -> the record type it publishes. From `BridgeSnapshot`'s own declaration. */
export function modFamilies(): Map<string, string> {
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

/** One Host validator: the keys it names, and the body those keys are checked in. */
export interface HostValidator {
  readonly keys: readonly string[];
  readonly body: string;
}

/** predicate function name -> its key list (null when it names none). */
export function hostValidators(): Map<string, HostValidator | null> {
  const validators = new Map<string, HostValidator | null>();
  for (const match of ALL_TS.matchAll(/function (is\w+)\([^)]*\): boolean \{([\s\S]*?)\n\}/g)) {
    const name = captured(match, 1, "a Host snapshot validator name");
    const body = captured(match, 2, `the \`${name}\` validator body`);
    // Three helpers, and all three are honest field lists: `hasExactKeys` demands exact equality, `hasOnlyKeys` allows a
    // key to be absent (an optional field) but never an unlisted one, and `hasExactKeysOrOptional` takes the required set
    // and then names the keys it tolerates. The SECOND bracket is part of that naming: a key a row may omit is still a key
    // the validator names, and reading only the required list reported every optional member as a wire break the other way
    // (`harvestWhereabouts.nearestX: the Mod publishes it and the validator does not name it`).
    const keys = /has(?:Exact|Only)Keys(?:OrOptional)?\(\s*\w+\s*,\s*\[([\s\S]*?)\](?:\s*,\s*\[([\s\S]*?)\])?/u.exec(
      body,
    );
    if (keys === null) {
      validators.set(name, null);
      continue;
    }
    const named = `${captured(keys, 1, `the \`${name}\` key list`)} ${keys[2] ?? ""}`;
    validators.set(name, {
      body,
      keys: [...named.matchAll(/"([^"]+)"/g)].map((entry) => captured(entry, 1, `a \`${name}\` key`)),
    });
  }
  return validators;
}

/** Every key the Host's snapshot validator admits at all, from `SNAPSHOT_KEYS`. */
export function hostSnapshotKeys(): Set<string> {
  const declaration = PROTOCOL.indexOf("const SNAPSHOT_KEYS");
  if (declaration < 0) throw new Error("SNAPSHOT_KEYS is not declared in protocol.ts: this gate reads it by name");
  const end = PROTOCOL.indexOf("]", declaration);
  if (end < 0) throw new Error("SNAPSHOT_KEYS has no closing bracket: the declaration is not the shape this reads");
  const block = PROTOCOL.slice(declaration, end);
  const keys = new Set<string>();
  for (const match of block.matchAll(/"([^"]+)"/g)) keys.add(captured(match, 1, "a SNAPSHOT_KEYS entry"));
  return keys;
}

/** `field` -> the `accepts:` predicate name, from the Host's own family table. */
export function hostFamilyRules(): Map<string, string> {
  const rules = new Map<string, string>();
  for (const match of PROTOCOL.matchAll(/\{ field: "(\w+)", maxItems: \d+, accepts: (\w+) \}/g))
    rules.set(
      captured(match, 1, "a snapshot family field"),
      captured(match, 2, `the \`accepts\` predicate of \`${captured(match, 1, "a snapshot family field")}\``),
    );
  return rules;
}

export const lowerFirst = (value: string): string => `${value.charAt(0).toLowerCase()}${value.slice(1)}`;

/**
 * The validator the Host actually applies to a family, read from `SNAPSHOT_FAMILY_RULES`.
 *
 * Not derived from the family name, and not guessed by field overlap. Both attempts before this one were wrong:
 * `WorldObjectTargets` publishes a record whose name does not follow the family, `BridgeSoilTile` has two fields that both
 * appear inside `isForageTargetFact` so overlap matched a tile to a forage validator, and `warps`/`doorTargets` share one
 * `isWarp` predicate that is not named `is*Fact` at all. The Host already declares the answer next to each field -
 * `accepts: isWarp` - so read that.
 */
export function validatorFor(
  family: string,
  rules: ReadonlyMap<string, string>,
  predicates: ReadonlyMap<string, HostValidator | null>,
): Readonly<{ missing: string }> | Readonly<{ name: string; validator: HostValidator }> {
  const rule = rules.get(family);
  if (rule === undefined) return { missing: `the Host declares no rule for ${family}, so it is never validated` };
  const predicate = predicates.get(rule);
  if (predicate === undefined)
    return {
      missing: `the Host's rule for ${family} accepts \`${rule}\`, which is not defined in protocol-target-facts.ts`,
    };
  if (predicate === null)
    return { missing: `\`${rule}\` (${family}) names no key list, so its field set is not checkable` };
  return { name: rule, validator: predicate };
}
