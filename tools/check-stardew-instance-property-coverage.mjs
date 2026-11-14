#!/usr/bin/env node
/**
 * The observation verdict at the level where the drops happen: an engine type's instance PROPERTIES.
 *
 * WHY. `tools/check-stardew-observation-gap.mjs` arms `stardew-action-inventory-reconciliation.mjs --fail-on-ungranted`,
 * and its red reads `tier_b_unit_without_verdict: AboutMenu@160, AmbientLocationSounds@83, Background@102, …`. That is a
 * verdict per engine *unit* - a class, a file, a line - and a unit-level verdict cannot state the defect this report is
 * about: the bed in the player's house is `Furniture`, which is "covered", while `Furniture.furniture_type` never
 * reaches any row. Measured 2026-11-14 on this tree, that gate is red with hundreds of unit names and nobody reads it,
 * for the reason every count-without-a-member fails: `AboutMenu@160` names nothing a reader can act on.
 *
 * So this gate asks the question at the level of the property, and it derives the population from the ENGINE.
 *
 *   1. POPULATION. For each declared entity (`Furniture`, `Object`, `Chest`, `HoeDirt`, … - the types a live run
 *      actually touches), walk its engine base chain and collect the instance state the game stores per instance: a
 *      `Net*`-typed or `[XmlElement]`-declared member, which is what the engine itself persists and syncs, plus the
 *      members the engine switches on (a closed discriminator such as `furniture_type`, `treeType`, `grassType`).
 *      Derived from the decompiled source, never listed by hand, so a field the engine adds joins on its own.
 *
 *   2. VERDICT, for every property, in `tools/stardew-instance-property-verdicts.json`:
 *        published            a row carries it - the verdict NAMES the family and the field
 *        deliberately_absent  a reason and an EXPIRY, which is checked: the entry goes red the day a row carries a
 *                             field with that name, and red when the engine stops declaring the property
 *        not_measured         no verdict - a finding, never a pass
 *      `not_measured N > 0` fails the gate, and so does an empty population.
 *
 *   3. THE INSTANCE CASE, not only the type. A finding reads
 *        property_not_published:Furniture.furniture_type:the furniture at (12,7) has no row carrying furniture_type
 *      where the parenthesised case comes from run data supplied with `--snapshot` when the entity has a row family,
 *      and otherwise from the engine's own closed value set (`a Furniture whose furniture_type is 0 (Furniture.chair)`).
 *      A finding that says only `AboutMenu@160` is what this file exists to replace.
 *
 * THE PUBLISHED VERDICTS ARE CHECKED AGAINST THE WIRE, which is the half a hand-written table gets wrong: a verdict
 * naming a field the protocol does not carry is `verdict_field_not_on_the_wire`. The row field lists come from the
 * schema's own `$defs` and the Mod's `record Bridge<Row>(...)` through the reconciliation analyzer's two readers
 * (`publishedRowFields`, `modRowFields`), so the wire has ONE authority and this gate is not a second copy of it.
 *
 * WHY A GATE BESIDE THE OBSERVATION GAP, and not inside it: that gate's own verdict is a 20 s child-process chain
 * whose first step is already red at HEAD, so a section added after it would never run, and a section added before it
 * would nest two unrelated skip conditions in one exit status. This gate reads the tree directly (about 0.4 s),
 * measures a different population, and is independently actionable.
 *
 * NO PUBLICATION IS DECIDED HERE. The deliverable is the verdict table and this gate; publishing a dropped property is
 * a follow-on per finding.
 *
 *   node tools/check-stardew-instance-property-coverage.mjs                 # the verdict; exit 1 on a finding
 *   node tools/check-stardew-instance-property-coverage.mjs --json          # the whole reading
 *   node tools/check-stardew-instance-property-coverage.mjs --type Bush     # one entity's properties
 *   node tools/check-stardew-instance-property-coverage.mjs --snapshot <run-result.json>  # instance cases from run data
 *
 * red-proof: inject a property the table does not verdict (`Bush.inBloom` in a synthetic tree) -> `verdict_missing`
 *   names it; inject `published` naming a field no row carries -> `verdict_field_not_on_the_wire` names family, field
 *   and property; delete a `Net*` field the table still verdicts -> `verdict_for_absent_property`; make a row carry the
 *   field a `deliberately_absent` entry is excused by -> `absent_entry_expired`; drop the table -> `verdict_table_missing`
 *   (tools/check-stardew-observation-gap.test.mjs drives each of those against this file's own functions).
 */

export const gateDeclaration = {
  id: "check-stardew-instance-property-coverage",
  domain: "stardew",
  tier: "l1",
  kind: "totality",
};

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { publishedRowFields } from "../integrations/stardew/action-development/src/analysis/stardew-action-inventory-reconciliation.mjs";
import { STARDEW_DECOMPILE_ROOT_RELATIVE_PATH } from "./lib/stardew-decompile-root.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const VERDICT_TABLE_PATH = "tools/stardew-instance-property-verdicts.json";
export const VERDICT_TABLE_SCHEMA = "gamebuddy-stardew-instance-property-verdicts/v1";
export const OBSERVATION_SCHEMA_PATH = "protocol/bridge-v1.schema.json";
export const OBSERVATION_MODELS_PATH = "integrations/stardew/src/Core/Models";

/** The Mod's C# sources, minus the suites, the build output and the fixture trees: the row builders live there. */
export const MOD_SOURCE_ROOT = "integrations/stardew";
const NOT_MOD_SOURCE = /(?:^|[/\\])(?:tests|obj|bin|fixtures|\.git)(?:[/\\]|$)/u;

/**
 * Every C# file the Mod's row builders may live in, as text: the models and the discovery code together.
 *
 * Read as one list because a published field's witness is the expression the BUILDER passes: the record says what a row
 * declares and the builder says what fills it, and a gate that read only the models would check the shape and never the
 * filling.
 */
export function modSources({
  root = resolve(ROOT, MOD_SOURCE_ROOT),
  read = (path) => readFileSync(path, "utf8"),
  walk = readdirSync,
} = {}) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of walk(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!NOT_MOD_SOURCE.test(absolute)) stack.push(absolute);
      } else if (entry.name.endsWith(".cs")) files.push(absolute);
    }
  }
  return files.sort().map((file) => read(file));
}

/** The three verdicts, and nothing else: a fourth spelling would be a fourth meaning. */
export const VERDICTS = Object.freeze(["published", "deliberately_absent", "not_measured"]);

/** Engine assemblies that also declare a `Tree`, a `Bush` and a `Crop`. A name is not a type identity. */
const NOT_ENGINE =
  /(?:^|[\\/])(?:Ionic(?:\.Zlib)?|Netcode|LWJGL|Force\.DeepCloner|Sickhead\.Engine\.Util)(?:[\\/]|\.)|\\(?:Tests|Minigames|Properties)\\/u;

const ENGINE_NAMESPACE = /^\s*namespace\s+(StardewValley[\w.]*)/mu;
const CLASS_DECLARATION =
  /^[ \t]*(?:public\s+|internal\s+|private\s+)?(?:sealed\s+|abstract\s+|static\s+|partial\s+)*class\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*(?::\s*([^{\r\n]+))?/mu;

const FIELD_DECLARATION =
  /^\s*(?:(?:public|protected|internal|private)\s+)?((?:(?:static|readonly|const|new|override|virtual|volatile|unsafe|extern)\s+)*)([A-Za-z_][\w.<>,[\]?\s]*?)\s+([A-Za-z_]\w*)\s*(?:=[^;]*)?;\s*$/u;
const PROPERTY_DECLARATION =
  /^\s*(?:(?:public|protected|internal|private)\s+)?((?:(?:static|new|override|virtual|abstract)\s+)*)([A-Za-z_][\w.<>,[\]?\s]*?)\s+([A-Za-z_]\w*)\s*\{\s*(?:get;\s*(?:(?:private|protected|internal)\s+)?set;|get;|set;)\s*\}\s*$/u;
const CONSTANT_DECLARATION =
  /^\s*(?:(?:public|protected|internal|private)\s+)?const\s+([A-Za-z_][\w.<>,[\]?\s]*?)\s+([A-Za-z_]\w*)\s*=\s*([^;]*);\s*$/u;

/** A member the engine persists or syncs. `[XmlElement]` is the save format; `Net*` is the multiplayer sync graph. */
const NETWORKED = /^Net[A-Z]/u;
const XML_STORAGE = "XmlElement";

const isModifierOnly = (modifiers) => /\b(?:static|const)\b/u.test(modifiers);

/** A source line with its string and comment noise removed, so a brace in a literal cannot move the depth. */
function uncommented(line) {
  return line.replace(/"(?:\\.|[^"\\])*"/gu, '""').replace(/\/\/.*$/u, "");
}

/**
 * The `{ ... }` a declaration opens, from its own `{`.
 *
 * The switch scrutinee and its `case` labels have to be read as a unit: a `case` in a nested `switch` is a label of
 * the inner one, and attributing it to the outer member would name an instance kind the engine never tests.
 */
function blockAfter(text, open, close = "}") {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  return text.slice(open);
}

/** Every member a type declares at its own body's top level, with the constants it names values with. */
export function typeBody(text) {
  const lines = text.split("\n");
  const members = [];
  const constants = new Map();
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = uncommented(lines[index]);
    if (depth === 1) {
      const constant = CONSTANT_DECLARATION.exec(line);
      if (constant !== null) constants.set(constant[2], constant[3].trim());
      else {
        const attribute = lines.slice(Math.max(0, index - 2), index).join(" ");
        const property = PROPERTY_DECLARATION.exec(line);
        const field = property === null ? FIELD_DECLARATION.exec(line) : null;
        if (property !== null)
          members.push({
            name: property[3],
            type: property[2].trim(),
            modifiers: property[1].trim(),
            stored: attribute.includes(XML_STORAGE),
          });
        else if (field !== null)
          members.push({
            name: field[3],
            type: field[2].trim(),
            modifiers: field[1].trim(),
            stored: attribute.includes(XML_STORAGE) || NETWORKED.test(field[2].trim()),
          });
      }
    }
    depth += (line.match(/\{/gu) ?? []).length - (line.match(/\}/gu) ?? []).length;
  }
  return { members, constants };
}

/**
 * The members this file switches on, with the labels its `case`s name.
 *
 * A scrutinee is accepted only when the last segment of the chain names a member THIS type family declares, so
 * `switch (itemId)` in `Furniture.cs` counts and `switch (Game1.GetSeasonForLocation(location))` does not.
 */
export function switchDomains(text, declaredNames) {
  const domains = new Map();
  for (const match of text.matchAll(/\bswitch\s*\(\s*([^{}()]+?)\s*\)|([A-Za-z_][\w.]*)\s+switch\b/gu)) {
    const raw = (match[1] ?? match[2])
      .trim()
      .replace(/^base\./u, "")
      .replace(/\.Value$/u, "");
    const member = raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1) : raw;
    if (!/^[A-Za-z_]\w*$/u.test(member) || !declaredNames.has(member)) continue;
    const labels = domains.get(member) ?? new Set();
    const open = text.indexOf("{", match.index + match[0].length - 1);
    if (open >= 0)
      for (const label of blockAfter(text, open).matchAll(/\bcase\s+(-?\d+|[A-Za-z_]\w*)\s*:/gu)) labels.add(label[1]);
    domains.set(member, labels);
  }
  const named = new Map();
  for (const [member, labels] of domains) named.set(member, [...labels]);
  return named;
}

/**
 * Every engine type the decompiled tree declares, by name, from its own declaration.
 *
 * The tree also holds Ionic's `Tree` and the crane game's `Bush`; a name alone is not a type identity, so a candidate
 * has to be a `StardewValley*` namespace declaration and outside the vendored assemblies, or it is not the engine's.
 */
export function engineTypes({ root, read = (path) => readFileSync(path, "utf8"), walk = readdirSync } = {}) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of walk(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.name.endsWith(".cs") && !NOT_ENGINE.test(absolute)) files.push(absolute);
    }
  }
  const types = new Map();
  for (const file of files.sort()) {
    const text = read(file);
    const namespace = ENGINE_NAMESPACE.exec(text)?.[1];
    if (namespace === undefined) continue;
    const declaration = CLASS_DECLARATION.exec(text);
    if (declaration === null || types.has(declaration[1])) continue;
    types.set(declaration[1], {
      name: declaration[1],
      namespace,
      file,
      bases: (declaration[2] ?? "")
        .split(",")
        .map((base) => base.trim().split(/[<\s]/u)[0])
        .filter((base) => base.length > 0),
      text,
    });
  }
  return types;
}

/** The base chain of one engine type, following only bases the engine itself declares (interfaces stop it). */
export function baseChain(types, name) {
  const chain = [];
  const seen = new Set();
  let cursor = types.get(name);
  while (cursor !== undefined && !seen.has(cursor.name)) {
    chain.push(cursor);
    seen.add(cursor.name);
    cursor = cursor.bases.map((base) => types.get(base)).find((base) => base !== undefined);
  }
  return chain;
}

/**
 * The instance-property population of the declared entities, derived from the engine.
 *
 * `properties` is deduplicated by `declaringType.member`, so `Object.quality` is one property whether a reader arrives
 * through `Object`, `Chest` or `Furniture`. The DECLARING type is the property's subject, not the root that reached it:
 * `Item.quality` is the item's field, and a row that carries it is an item row whatever entity a reader walked from.
 */
export function instanceProperties({ types, entities }) {
  const properties = new Map();
  const reachedTypes = new Set();
  const absent = [];
  for (const entity of entities) {
    if (!types.has(entity)) {
      absent.push(entity);
      continue;
    }
    const chain = baseChain(types, entity);
    for (const link of chain) {
      reachedTypes.add(link.name);
      const { members, constants } = typeBody(link.text);
      const names = new Set(members.map((member) => member.name));
      const domains = switchDomains(link.text, names);
      for (const member of members) {
        if (isModifierOnly(member.modifiers)) continue;
        const domain = domains.get(member.name);
        if (!member.stored && domain === undefined) continue;
        const key = `${link.name}.${member.name}`;
        if (!properties.has(key))
          properties.set(key, {
            key,
            entity: link.name,
            declaringType: link.name,
            member: member.name,
            declared: member.type,
            discriminator: domain === undefined ? null : domainValues(constants, domain),
          });
      }
    }
  }
  return { properties, reachedTypes, absent };
}

/**
 * A discriminator's closed value set, with the engine's own name for each value when it declares one.
 *
 * The decompiler inlines constants, so a `switch (furniture_type.Value)` reads `case 15:` and not `case bed:`. The name
 * is recovered from the type's own `const int bed = 15`, which is what lets a finding say "a bed" instead of "case 15".
 */
function domainValues(constants, labels) {
  const byValue = new Map();
  for (const [name, value] of constants) if (!byValue.has(value)) byValue.set(value, name);
  return [...new Set(labels)].map((label) => ({ label, name: byValue.get(label) ?? null }));
}

/** Every declared engine type with per-instance state that the examined chains do not reach: the remainder's cost. */
export function remainder(types, examined) {
  const reached = new Set(examined.flatMap((entity) => baseChain(types, entity).map((link) => link.name)));
  const outside = [];
  let withState = 0;
  for (const [name, type] of types) {
    if (reached.has(name)) continue;
    outside.push(name);
    if (typeBody(type.text).members.some((member) => !isModifierOnly(member.modifiers) && member.stored))
      withState += 1;
  }
  return { types: outside.length, withState };
}

/**
 * The snapshot a run wrote, wherever the artifact keeps it.
 *
 * A run result carries one snapshot per day record under keys this gate cannot know in advance, and every one of them
 * is a row bundle. So the finder looks for the SHAPE (`warps`, `chests`, `tile`) rather than for a path: a locator that
 * needs a JSON pointer is a locator that breaks the first time an artifact nests one level deeper.
 */
export function findSnapshot(node, seen = new Set()) {
  if (node === null || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  if (
    !Array.isArray(node) &&
    Array.isArray(node.warps) &&
    Array.isArray(node.chests) &&
    typeof node.tile?.x === "number" &&
    typeof node.tile?.y === "number"
  )
    return node;
  for (const value of Object.values(node)) {
    const found = findSnapshot(value, seen);
    if (found !== null) return found;
  }
  return null;
}

/** One tile per row family, so a finding can name the instance a run actually had in hand. */
export function witnessTiles(snapshot) {
  const tiles = new Map();
  if (snapshot === null || typeof snapshot !== "object") return tiles;
  for (const [family, rows] of Object.entries(snapshot)) {
    if (!Array.isArray(rows)) continue;
    const row = rows.find((entry) => Number.isFinite(entry?.x) && Number.isFinite(entry?.y));
    if (row !== undefined) tiles.set(family, { x: row.x, y: row.y, targetId: row.targetId ?? null });
  }
  return tiles;
}

/** The row families each entity's instances appear in, as the verdict table declares them. */
export function entityFamilies(table) {
  return new Map((table?.entities ?? []).map((entry) => [entry?.entity, entry?.families ?? []]));
}

/** Top-level comma splitting of a parameter or argument list, so a generic's comma is not a separator. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if ("<([{".includes(character)) depth += 1;
    else if (">)]}".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The text between a pair of brackets from the opening one, counting only that bracket kind. */
function between(text, open, opening, closing) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === opening) depth += 1;
    else if (text[index] === closing) {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1);
}

/** The brace block containing `at`, walked backwards: the body of the method a construction sits in. */
function enclosingBlock(text, at) {
  let depth = 0;
  for (let index = at; index >= 0; index -= 1) {
    if (text[index] === "}") depth += 1;
    else if (text[index] === "{") {
      if (depth === 0) return between(text, index, "{", "}");
      depth -= 1;
    }
  }
  return "";
}

/**
 * The Mod's row records, read from the model files' own `record Bridge<Name>(...)` declarations.
 *
 * The records live in five files under `src/Core/Models` and not always under the schema's own name (`chests` rows
 * are `BridgeChestState`), so the reader takes every declaration and resolves a definition by exact name first and by
 * a UNIQUE prefix second. A prefix two declarations answer is a finding, never a pick: a gate that guesses which record
 * the wire means is a gate that will disagree with the compiler.
 */
export function modRecords(sources) {
  const records = new Map();
  for (const text of sources) {
    const code = text.replace(/\/\/.*$/gmu, "");
    for (const match of code.matchAll(/\brecord\s+(Bridge[A-Za-z_]\w*)\s*\(/gu)) {
      const open = code.indexOf("(", match.index + match[0].length - 1);
      const body = between(code, open, "(", ")");
      const parameters = splitTopLevel(body).map((parameter) =>
        parameter
          .replace(/\[[^\]]*\]/gu, "")
          .replace(/=[\s\S]*$/u, "")
          .trim(),
      );
      const names = parameters.map((parameter) => /([A-Za-z_]\w*)\s*$/u.exec(parameter)?.[1] ?? "");
      if (!records.has(match[1]))
        records.set(
          match[1],
          names.filter((name) => name.length > 0),
        );
    }
  }
  return records;
}

/**
 * The record a wire definition names.
 *
 * Exact name first. When the Mod's record is not named after the schema's definition - `chests` rows are
 * `BridgeChestState`, next to `BridgeChestItem` and `BridgeChestsSummary` - the record is the one whose DECLARED FIELDS
 * are the wire's fields, not the one whose name happens to start the same way: a prefix three declarations answer is a
 * guess, and a guess here would let a verdict name a field of a record the wire never sends.
 */
export function recordFor(records, definition, fields = []) {
  const exact = `Bridge${definition[0].toUpperCase()}${definition.slice(1)}`;
  if (records.has(exact)) return { name: exact, fields: records.get(exact), finding: null };
  const wanted = new Set(fields.map((field) => field.toLowerCase()));
  const ranked = [...records]
    .filter(([name]) => name.startsWith(exact))
    .map(([name, declared]) => ({
      name,
      declared,
      overlap: declared.filter((field) => wanted.has(field.toLowerCase())).length,
    }))
    .sort((left, right) => right.overlap - left.overlap);
  if (ranked.length === 0) return { name: null, fields: null, finding: `declares no \`${exact}\` record` };
  if (ranked.length > 1 && ranked[0].overlap === ranked[1].overlap)
    return {
      name: null,
      fields: null,
      finding: `has ${ranked
        .filter((candidate) => candidate.overlap === ranked[0].overlap)
        .map((candidate) => candidate.name)
        .join(", ")} with the same overlap on the wire's fields`,
    };
  return { name: ranked[0].name, fields: ranked[0].declared, finding: null };
}

/**
 * Every expression a row builder passes for one field.
 *
 * A record's constructor is written three ways in the Mod (`new BridgeX(...)`, and the target-typed `BridgeX row = new(...)`)
 * and the argument for a field is either the parameter's position or an explicit `Field:` name. Both are read, because a
 * builder that names its arguments is the same claim as one that positions them.
 */
export function builderArguments({ sources, record, field }) {
  const argumentsFound = [];
  const position = record.fields.findIndex((name) => name.toLowerCase() === field.toLowerCase());
  if (position < 0) return argumentsFound;
  for (const text of sources) {
    const code = text.replace(/\/\/.*$/gmu, "");
    const constructions = [
      ...code.matchAll(new RegExp(`new\\s+${record.name}\\s*\\(`, "gu")),
      ...code.matchAll(new RegExp(`\\b${record.name}\\s+[A-Za-z_]\\w*\\s*=\\s*new\\s*\\(`, "gu")),
    ];
    for (const construction of constructions) {
      const open = construction.index + construction[0].lastIndexOf("(");
      const parts = splitTopLevel(between(code, open, "(", ")"));
      const named = parts.find((part) => new RegExp(`^\\s*${field}\\s*:`, "iu").test(part));
      const argument = named === undefined ? parts[position] : named.replace(/^\s*\w+\s*:/u, "");
      if (argument === undefined) continue;
      argumentsFound.push({ argument: argument.replace(/\s+/gu, " ").trim(), method: enclosingBlock(code, open) });
    }
  }
  return argumentsFound;
}

/**
 * The instance case a finding names, in the order the run data allows.
 *
 * A tile from a run is the strongest form (`the bush at (12,7)`); the engine's own closed value set is the second
 * (`a Tree whose treeType is 0 (Tree.oak)`); the property's own declaration is the last. All three name an instance;
 * none names a line number.
 */
export function instanceCase(property, { families = new Map(), tiles = new Map() } = {}) {
  for (const family of families.get(property.entity) ?? [])
    if (tiles.has(family)) return `the ${property.entity} at (${tiles.get(family).x},${tiles.get(family).y})`;
  const article = /^[AEIOU]/u.test(property.entity) ? "an" : "a";
  if (property.discriminator !== null) {
    const named = property.discriminator
      .filter((value) => value.name !== null)
      .sort((left, right) => Number(left.label) - Number(right.label));
    const chosen = named[0] ?? property.discriminator[0];
    const kind = property.discriminator.length;
    if (chosen !== undefined)
      return chosen.name === null
        ? `${article} ${property.entity} whose ${property.member} is ${chosen.label} (one of ${kind} closed values)`
        : `${article} ${property.entity} whose ${property.member} is ${chosen.name} (${property.declaringType}.${chosen.name} = ${chosen.label})`;
  }
  return `${article} ${property.entity} instance`;
}

/**
 * The verdict table judged against the derived population and against the wire.
 *
 * Every finding names the property, because a table that drifts silently is the defect this file replaces: a verdict
 * for a property the engine no longer declares is a row nobody can act on, and a `published` verdict naming a field no
 * row carries is the exact lie the second half of this gate exists to catch.
 */
export function judgeVerdicts({
  population,
  table,
  rows,
  records,
  builders = [],
  witnesses = { families: new Map(), tiles: new Map() },
}) {
  const findings = [];
  const counts = { published: 0, deliberately_absent: 0, not_measured: 0 };
  const declaredEntities = entityFamilies(table);
  const verdicts = new Map();
  for (const entry of table?.verdicts ?? []) {
    if (typeof entry?.property !== "string" || entry.property.length === 0) {
      findings.push({
        code: "verdict_entry_invalid",
        property: String(entry?.property ?? "unknown"),
        detail: "a verdict entry needs `property` (EngineType.member) and one of " + VERDICTS.join(", "),
      });
      continue;
    }
    if (verdicts.has(entry.property)) {
      findings.push({
        code: "verdict_duplicate",
        property: entry.property,
        detail: `declared twice (${verdicts.get(entry.property).verdict} and ${entry.verdict}); one property has one verdict`,
      });
      continue;
    }
    verdicts.set(entry.property, entry);
  }
  for (const property of population.values()) {
    const entry = verdicts.get(property.key);
    if (entry === undefined) {
      findings.push({
        code: "verdict_missing",
        property: property.key,
        detail: `no verdict for ${property.key} (${property.declared}); declare published, deliberately_absent or not_measured in ${VERDICT_TABLE_PATH}`,
      });
      continue;
    }
    if (!VERDICTS.includes(entry.verdict)) {
      findings.push({
        code: "verdict_invalid",
        property: property.key,
        detail: `\`${String(entry.verdict)}\` is not one of ${VERDICTS.join(", ")}`,
      });
      continue;
    }
    counts[entry.verdict] += 1;
    if (entry.verdict === "published") {
      const row = typeof entry.field === "string" ? rows.get(String(entry.field).split(".")[0]) : undefined;
      const [family, name] = typeof entry.field === "string" ? String(entry.field).split(".") : [null, null];
      if (row === undefined || name === undefined) {
        findings.push({
          code: "verdict_field_not_on_the_wire",
          property: property.key,
          detail: `published as \`${String(entry.field)}\`, and no snapshot family carries a row by that name`,
        });
        continue;
      }
      const families = declaredEntities.get(property.entity) ?? [];
      if (!families.includes(family))
        findings.push({
          code: "verdict_field_outside_entity_rows",
          property: property.key,
          detail: `published as \`${entry.field}\`, but ${property.entity} declares no \`${family}\` row - a field on another entity's row is not this property's row`,
        });
      if (!row.fields.includes(name)) {
        findings.push({
          code: "verdict_field_not_on_the_wire",
          property: property.key,
          detail: `published as \`${entry.field}\`, and ${OBSERVATION_SCHEMA_PATH} gives \`${family}\` rows [${row.fields.join(", ")}]`,
        });
        continue;
      }
      const record = recordFor(records, row.definition, row.fields);
      if (record.fields === null)
        findings.push({
          code: "verdict_field_not_on_the_mod_record",
          property: property.key,
          detail: `published as \`${entry.field}\`, and ${OBSERVATION_MODELS_PATH} ${record.finding}`,
        });
      else if (!record.fields.some((declared) => declared.toLowerCase() === name.toLowerCase()))
        findings.push({
          code: "verdict_field_not_on_the_mod_record",
          property: property.key,
          detail: `published as \`${entry.field}\`, and \`${record.name}\` declares [${record.fields.join(", ")}]`,
        });
      const witness = typeof entry.witness === "string" ? entry.witness.trim() : "";
      if (witness.length === 0)
        findings.push({
          code: "verdict_field_without_witness",
          property: property.key,
          detail: `published as \`${entry.field}\` with no \`witness\`; name the expression the builder passes for that field, so a reader can find it`,
        });
      else if (record.fields !== null) {
        const argumentsFound = builderArguments({ sources: builders, record, field: name });
        if (!argumentsFound.some((found) => found.argument.includes(witness) || found.method.includes(witness)))
          findings.push({
            code: "verdict_field_without_witness",
            property: property.key,
            detail: `published as \`${entry.field}\` witnessed by \`${witness}\`, and no \`${record.name}\` construction passes it there or reads it in the method that builds the row (${argumentsFound.length === 0 ? "no construction found" : [...new Set(argumentsFound.map((found) => found.argument))].slice(0, 3).join(" | ")})`,
          });
      }
      continue;
    }
    if (entry.verdict === "deliberately_absent") {
      if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
        findings.push({
          code: "absent_entry_unexplained",
          property: property.key,
          detail: "deliberately_absent with no reason; an absence with no argument is a silent drop",
        });
        continue;
      }
      const expiry =
        typeof entry.expires === "string" ? /^row_field:([A-Za-z]\w*)\.([A-Za-z]\w*)$/u.exec(entry.expires) : null;
      if (expiry === null) {
        findings.push({
          code: "absent_entry_without_expiry",
          property: property.key,
          detail: `\`${String(entry.expires)}\` is not an expiry this gate checks; declare \`row_field:<family>.<field>\` - the fact whose arrival ends the absence`,
        });
        continue;
      }
      const now = rows.get(expiry[1]);
      if (now !== undefined && now.fields.includes(expiry[2]))
        findings.push({
          code: "absent_entry_expired",
          property: property.key,
          detail: `excused until \`${entry.expires}\`, and \`${expiry[1]}\` rows now carry \`${expiry[2]}\` - the absence is over, verdict it again`,
        });
      continue;
    }
    findings.push({
      code: "property_not_published",
      property: property.key,
      detail: `${instanceCase(property, witnesses)} has no row carrying ${property.member}`,
    });
  }
  for (const [property] of verdicts)
    if (!population.has(property))
      findings.push({
        code: "verdict_for_absent_property",
        property,
        detail: `${VERDICT_TABLE_PATH} verdicts \`${property}\`, and the engine declares no such instance property in the examined chains - the entry has expired`,
      });
  return { findings, counts };
}

/** The verdict table read from disk, or the reason it cannot be read. */
export function readVerdictTable({ read = (path) => readFileSync(path, "utf8") } = {}) {
  let text;
  try {
    text = read(resolve(ROOT, VERDICT_TABLE_PATH));
  } catch {
    return { table: null, reason: `${VERDICT_TABLE_PATH} is not readable` };
  }
  let table;
  try {
    table = JSON.parse(text);
  } catch {
    return { table: null, reason: `${VERDICT_TABLE_PATH} is not JSON` };
  }
  if (table?.schema !== VERDICT_TABLE_SCHEMA)
    return {
      table: null,
      reason: `${VERDICT_TABLE_PATH} declares \`${String(table?.schema)}\`, not ${VERDICT_TABLE_SCHEMA}`,
    };
  if (!Array.isArray(table.entities) || table.entities.length === 0)
    return { table: null, reason: `${VERDICT_TABLE_PATH} declares no entity, so there is no population` };
  if (!Array.isArray(table.verdicts)) return { table: null, reason: `${VERDICT_TABLE_PATH} declares no verdict list` };
  return { table, reason: null };
}

/** The row fields the wire publishes, per definition, and the records the Mod declares them with. */
export function wireRows({ schema, models }) {
  const rows = publishedRowFields(schema);
  const records = modRecords(models);
  return { rows, records };
}

/**
 * The whole reading: derived population, declared verdicts, and the findings that make each verdict checkable.
 *
 * Pure over its inputs, so the falsifier suite can hand it a synthetic engine tree, a synthetic wire and a synthetic
 * table instead of editing the real ones.
 */
export function measure({ types, table, schema, models, builders = [], snapshot = null }) {
  const declared = entityFamilies(table);
  const roots = (table?.entities ?? []).filter((entry) => entry?.root === true).map((entry) => entry.entity);
  const derived = instanceProperties({ types, entities: roots });
  const { rows, records } = wireRows({ schema, models });
  const witnesses = { families: declared, tiles: witnessTiles(snapshot) };
  const judged = judgeVerdicts({ population: derived.properties, table, rows, records, builders, witnesses });
  const undeclared = [...derived.reachedTypes].filter((type) => !declared.has(type)).sort();
  return {
    typesExamined: roots.filter((name) => types.has(name)).length,
    basesExamined: [...derived.reachedTypes].filter((type) => !roots.includes(type)).length,
    properties: derived.properties,
    absentEntities: derived.absent,
    undeclaredTypes: undeclared,
    discriminators: [...derived.properties.values()].filter((property) => property.discriminator !== null).length,
    remainder: remainder(
      types,
      roots.filter((name) => types.has(name)),
    ),
    counts: judged.counts,
    findings: judged.findings,
    witnesses,
  };
}

/** The checks the self-verification report carries, in the order a reader needs them. */
export function buildChecks(reading) {
  const has = (code) => reading.findings.filter((finding) => finding.code === code).length;
  return [
    {
      id: "population_derived",
      status: reading.properties.size > 0 ? "passed" : "blocked",
      detail: `${reading.properties.size} instance properties over ${reading.typesExamined} engine types`,
    },
    {
      id: "chain_types_declared",
      status: reading.undeclaredTypes.length === 0 ? "passed" : "failed",
      detail: `${reading.undeclaredTypes.length} engine base type(s) the table does not describe: ${reading.undeclaredTypes.join(", ") || "none"}`,
    },
    {
      id: "verdicts_declared",
      status:
        has("verdict_missing") + has("verdict_invalid") + has("verdict_duplicate") + has("verdict_entry_invalid") === 0
          ? "passed"
          : "failed",
      detail: `${has("verdict_missing")} missing, ${has("verdict_duplicate")} duplicated, ${has("verdict_invalid") + has("verdict_entry_invalid")} invalid`,
    },
    {
      id: "published_verdicts_on_the_wire",
      status:
        has("verdict_field_not_on_the_wire") +
          has("verdict_field_not_on_the_mod_record") +
          has("verdict_field_outside_entity_rows") +
          has("verdict_field_without_witness") ===
        0
          ? "passed"
          : "failed",
      detail: `${has("verdict_field_not_on_the_wire")} field(s) no row carries, ${has("verdict_field_not_on_the_mod_record")} absent from the Mod record, ${has("verdict_field_without_witness")} without a builder witness, ${has("verdict_field_outside_entity_rows")} on another entity's row`,
    },
    {
      id: "absent_verdicts_expire",
      status:
        has("absent_entry_unexplained") + has("absent_entry_without_expiry") + has("absent_entry_expired") === 0
          ? "passed"
          : "failed",
      detail: `${has("absent_entry_unexplained")} unexplained, ${has("absent_entry_without_expiry")} without a checked expiry, ${has("absent_entry_expired")} expired`,
    },
    {
      id: "verdicts_refer_to_live_properties",
      status: has("verdict_for_absent_property") === 0 ? "passed" : "failed",
      detail: `${has("verdict_for_absent_property")} verdict(s) for a property the engine no longer declares`,
    },
    {
      id: "no_unmeasured_property",
      status: reading.counts.not_measured === 0 ? "passed" : "failed",
      detail: `${reading.counts.not_measured} propert(y|ies) with no verdict`,
    },
  ];
}

function main(argv) {
  const decompileRoot = argv.includes("--decompile-root")
    ? resolve(argv[argv.indexOf("--decompile-root") + 1])
    : resolve(ROOT, STARDEW_DECOMPILE_ROOT_RELATIVE_PATH);
  const reading = readVerdictTable();
  if (reading.table === null) {
    process.stdout.write(`instance_property_coverage_skipped: ${reading.reason}\n`);
    process.stdout.write(
      `${JSON.stringify({ gate: "stardew_instance_property_coverage/v1", status: "blocked", population: 0, checks: [{ id: "verdict_table_readable", status: "blocked", detail: reading.reason }] })}\n`,
    );
    return 0;
  }
  if (!existsSync(decompileRoot)) {
    process.stdout.write(`instance_property_coverage_skipped: needs ${STARDEW_DECOMPILE_ROOT_RELATIVE_PATH}\n`);
    process.stdout.write(
      `${JSON.stringify({ gate: "stardew_instance_property_coverage/v1", status: "not_measured", population: 0, checks: [{ id: "decompiled_engine_present", status: "not_measured", detail: `${STARDEW_DECOMPILE_ROOT_RELATIVE_PATH} is absent, so no property population can be derived` }] })}\n`,
    );
    return 0;
  }
  const snapshotArgument = argv.includes("--snapshot") ? resolve(argv[argv.indexOf("--snapshot") + 1]) : null;
  const snapshot = snapshotArgument === null ? null : findSnapshot(JSON.parse(readFileSync(snapshotArgument, "utf8")));
  const builders = modSources();
  const measured = measure({
    types: engineTypes({ root: decompileRoot }),
    table: reading.table,
    schema: JSON.parse(readFileSync(resolve(ROOT, OBSERVATION_SCHEMA_PATH), "utf8")),
    models: builders.filter((text) => /\brecord\s+Bridge[A-Z]/u.test(text)),
    builders,
    snapshot,
  });
  const only = argv.includes("--type") ? argv[argv.indexOf("--type") + 1] : null;
  const findings =
    only === null
      ? measured.findings
      : measured.findings.filter((finding) => measured.properties.get(finding.property)?.entity === only);

  if (argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          gate: "stardew_instance_property_coverage/v1",
          typesExamined: measured.typesExamined,
          basesExamined: measured.basesExamined,
          properties: [...measured.properties.values()].map((property) => ({ ...property })),
          discriminators: measured.discriminators,
          remainder: measured.remainder,
          counts: measured.counts,
          findings,
          absentEntities: measured.absentEntities,
        },
        null,
        2,
      )}\n`,
    );
    return findings.length === 0 ? 0 : 1;
  }

  process.stdout.write(
    `engine types examined ${measured.typesExamined} (+${measured.basesExamined} engine bases) · instance properties ${measured.properties.size} · discriminators ${measured.discriminators}` +
      ` · remainder ${measured.remainder.types} engine types (${measured.remainder.withState} with per-instance state) outside these chains\n`,
  );
  if (measured.absentEntities.length > 0)
    process.stdout.write(
      `entity_not_in_engine: ${measured.absentEntities.join(", ")} - declared in ${VERDICT_TABLE_PATH} and this decompiled tree declares no such class\n`,
    );
  if (measured.undeclaredTypes.length > 0)
    process.stdout.write(
      `chain_type_undeclared: ${measured.undeclaredTypes.join(", ")} - reached through a declared entity and described by no row-family list\n`,
    );
  process.stdout.write(
    `properties examined ${measured.properties.size} · published ${measured.counts.published} · deliberately absent ${measured.counts.deliberately_absent} · not measured ${measured.counts.not_measured}\n`,
  );
  for (const finding of findings) process.stdout.write(`${finding.code}:${finding.property}:${finding.detail}\n`);
  const checks = buildChecks({ ...measured, findings });
  const status = measured.properties.size === 0 ? "blocked" : findings.length === 0 ? "passed" : "failed";
  process.stdout.write(
    `${JSON.stringify({ gate: "stardew_instance_property_coverage/v1", status, population: measured.properties.size, checks })}\n`,
  );
  return status === "passed" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
