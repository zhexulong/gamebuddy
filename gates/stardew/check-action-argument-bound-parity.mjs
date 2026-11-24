#!/usr/bin/env node
/**
 * The bound a hand-written tool schema states for an action argument, held against the bound the Mod DECLARES for it.
 *
 * WHY (measured before this gate existed). The Host learned a whole-number argument's range by PROBING its own wire
 * predicate - doubling to the first refusal and bisecting back - and the probe answered `0..1000` for `x`/`y`. The
 * declaration said `-1..1000` for the two actions that address a warp SOURCE, because an edge exit warps from one tile
 * OUTSIDE the map (`FarmhandWarpCoordinateRange.MinimumSourceCoordinate`, and `Town`'s own `-1 53 BusStop`). `-1` is the
 * only tile such an exit names, so the probe's invented floor refused the one coordinate the action exists for. The
 * probe is gone and the bounds are published now, so that particular disagreement cannot exist at that seam - but
 * nothing stopped the NEXT hand-written schema constant from disagreeing with its declaration, because a constant in
 * `host/src` and a range in the Mod's generated surface are two authorities and no reading compared them.
 *
 * THE TWO POPULATIONS, both derived, neither listed:
 *
 *   DECLARED   `integrations/stardew/action-development/contracts/generated/action-surface.v1.json`: every action's
 *              `argumentSchema`, each `<action>.<argument>` that publishes a `minimum` or a `maximum`. This is the
 *              Mod's own acceptance range, carried across the language boundary.
 *   WRITTEN    `host/src/game-tools.ts` read as a syntax tree: every member of a schema the model can be shown -
 *              a `makeGameActionTool({ parameters: Type.Object({...}) })` mount (a `for (const action of [...] as const)`
 *              block expanded to one schema per action, because the model receives one schema per ACTION) and a
 *              `return Type.Object({...})` arm of `buildCandidateToolSchema` whose `actionId === "..."` condition names
 *              the actions it answers. A member contributes when its schema resolves to a whole-number range: an inline
 *              `Type.Integer({...})`, or a shared constant such as `TILE_COORDINATE_SCHEMA`, `TOOL_SLOT_SCHEMA` or
 *              `WARP_SOURCE_COORDINATE_SCHEMA`, whose numbers are the exported constants in
 *              `host/src/protocol-target-facts.ts` - the `TILE_COORDINATE_SCHEMA`-like table.
 *
 * THE RULE, member by member. A range is two facts, so each END is judged on its own:
 *
 *   `argument_bound_disagrees_with_its_declaration:<action>.<argument>:declared=<min>..<max>:written=<min>..<max>`
 *       the schema states an end the declaration also states, and the two numbers differ. This is the class the
 *       `0..1000`-versus-`-1..1000` defect belongs to, and it is FATAL in both directions: a floor above the
 *       declaration refuses a value the Mod accepts, and one below it offers a value the Mod refuses.
 *   `argument_bound_written_without_a_declaration:<action>.<argument>`
 *       the schema states an end no declaration backs - an import of the argument's range with nothing on the other
 *       side of it. This is the interesting one, because it is a second authority WHETHER OR NOT IT HAPPENS TO AGREE
 *       TODAY: the day the Mod publishes or moves that range, this number is the thing that will disagree.
 *   `argument_bound_unreadable:<action>.<argument>:<expression>`
 *       the member IS a whole-number schema and this gate cannot resolve its ends to numbers. A bound nothing can read
 *       is a bound no reviewer can check either, so it is a finding rather than a pass - and it is not hypothetical:
 *       before the fix the shared constants were `Type.Integer(intervalAcceptedBy(isTileCoordinate))`, derived by
 *       probing at run time, and this is the code that names that tree.
 *
 * A member that states no bound at all (`Type.Integer()`), a closed set (`enum` / `literalUnionSchema`), a string or an
 * opaque-id schema, and a member that READS the declaration (`declaredIntegerArgument("till_soil", "charge")`, which is
 * `EXECUTION_REQUEST_ARGUMENT_RULES`' own range and therefore no second authority) are outside this population. The
 * members that read the declaration, and the ones that state no bound, are counted on the report line so their absence
 * is a number rather than a silence.
 *
 * THE REPORT LINE, and why the counts are all there:
 *
 *   `arguments examined N · declared-only D · hand-written-only H · disagreeing X · agreed A · unreadable U · ...`
 *
 * `declared-only` is the descriptor-derived half and is REPORTED rather than refused: an action whose schema the Host
 * builds from the Mod's own descriptor states the declaration's number by construction, so it has no hand-written bound
 * to disagree and its absence from the written population is a fact about the mount, not a defect. `examined` is the
 * union of the two populations, and `A + D + H + X + U = N` - a population that stopped being read shows up as a number
 * that no longer adds up rather than as a smaller set that agrees with itself.
 *
 * WHY `host/src/protocol.ts` IS NOT A THIRD POPULATION: it declares no tool schema at all (`Type.Integer` does not
 * appear in it), and its per-argument ranges live in `integerRow(...)` calls inside `EXECUTION_REQUEST_ARGUMENT_RULES` -
 * the validator's own table, which the model never sees. A tool schema that wants one of those ranges READS it
 * (`declaredIntegerArgument`, counted above), so comparing that table here would compare the declaration with itself on
 * one side, and on the other would report the rows that state no ceiling on purpose (a bound the engine applies at
 * execution) as disagreements - a wire-contract question, not a tool-schema one.
 *
 * WHAT IT CANNOT SEE, stated because the narrowing is deliberate: a bound that is only correct for ONE FRAME of the
 * argument's life is out of scope - `resolvedAtExecution` values are settled by the body at execution, so a range that
 * moves between submit and dispatch is a question for the execution receipt and not for a static schema comparison.
 *
 * ZERO POPULATION BLOCKS (exit 2). A reading with no declared argument, no hand-written bound, or no schema site has
 * lost a side and prints exactly what a reading over two hundred arguments prints - so it is blocked with the reason
 * named, never green.
 *
 * USAGE:
 *   node gates/stardew/check-action-argument-bound-parity.mjs            # exit 0 passed, 1 failed, 2 blocked
 *   node gates/stardew/check-action-argument-bound-parity.mjs --rows     # every compared argument, both sides
 *   node gates/stardew/check-action-argument-bound-parity.mjs --json     # the reading, machine-readable
 *   node gates/stardew/check-action-argument-bound-parity.mjs --root DIR # read another tree (the falsifiers' fixture)
 *
 * red-proof: history `git show 8264f967^:host/src/game-tools.ts` with that commit's own
 *            `protocol-target-facts.ts` - the tree the fix replaced, where the shared constants were derived by probing
 *            `isTileCoordinate`/`isToolSlot` at run time - prints `argument_bound_unreadable:travel.x:TILE_COORDINATE_SCHEMA`
 *            and exit 1, so the floor that refused the edge exit is NAMED rather than passed
 *            (gates/stardew/check-action-argument-bound-parity.test.mjs)
 * red-proof: inject  `travel`'s and `enter_exit`'s `x`/`y` switched back to `TILE_COORDINATE_SCHEMA` in an otherwise
 *            green tree -> `argument_bound_disagrees_with_its_declaration:travel.x:declared=-1..1000:written=0..1000`
 *            and the same for `travel.y`, `enter_exit.x`, `enter_exit.y`, exit 1 - the exact round99 defect replayed
 *            (gates/stardew/check-action-argument-bound-parity.test.mjs)
 * red-proof: inject  `move_to_tile`'s `x` declared with no ceiling while the schema still states `maximum: 1000`, so the
 *            hand-written bound has no declaration behind it ->
 *            `argument_bound_written_without_a_declaration:move_to_tile.x`, exit 1
 *            (gates/stardew/check-action-argument-bound-parity.test.mjs)
 *
 * No game, no network, no model, no child process: it reads three files and parses two of them.
 */

export const gateDeclaration = {
  id: "check-action-argument-bound-parity",
  domain: "stardew",
  tier: "l0",
  kind: "contract",
};

// source-invariant: the model-facing tool schema's whole-number range and the range the Mod publishes for the same
//   action argument are one fact stated twice, and no compiler holds the pair - the TypeScript schema is built at run
//   time from a constant, and the declaration is a generated JSON artifact in the other language.
// source-expiry: when the Host builds a descriptor-derived tool schema for EVERY published action, so no hand-written
//   member survives, this reading has no population left and retires with
//   `argument_bound_hand_written_population_not_measured`

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const GATE = "stardew_action_argument_bound_parity/v1";

export const SURFACE_PATH = "integrations/stardew/action-development/contracts/generated/action-surface.v1.json";
export const GAME_TOOLS_PATH = "host/src/game-tools.ts";
export const TARGET_FACTS_PATH = "host/src/protocol-target-facts.ts";

/** The one hand-written member shape that RESTSATES the declaration rather than adding to it. */
const DECLARATION_READER = "declaredIntegerArgument";

/** The two ends of every range, so neither can be forgotten on one side. */
const ENDS = Object.freeze(["minimum", "maximum"]);

const EXIT = Object.freeze({ passed: 0, failed: 1, blocked: 2 });

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(root, relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

/**
 * The whole-number range the published declaration states for every action argument, keyed `<action>.<argument>`.
 *
 * An argument that publishes a length instead is absent rather than zero: `minLength`/`maxLength` are a different fact
 * from a tile's range, and folding them together would compare a string's length with a coordinate.
 */
export function declaredArgumentBounds(surface) {
  if (surface?.schema !== "gamebuddy-action-descriptors/v1" || !Array.isArray(surface.actions))
    throw new Error("the published surface is not a `gamebuddy-action-descriptors/v1` document with `actions`");
  const bounds = new Map();
  for (const action of surface.actions)
    for (const [argument, schema] of Object.entries(action.argumentSchema ?? {})) {
      const ends = {};
      for (const end of ENDS) if (typeof schema[end] === "number") ends[end] = schema[end];
      if (Object.keys(ends).length === 0) continue;
      bounds.set(`${action.actionId}.${argument}`, Object.freeze(ends));
    }
  return bounds;
}

/** A numeric literal, a negated numeric literal, or a parenthesised one; `null` for anything computed. */
function literalNumber(node, typescript) {
  if (node === undefined) return null;
  if (typescript.isNumericLiteral(node)) return Number(node.text);
  if (typescript.isParenthesizedExpression(node) || typescript.isAsExpression(node))
    return literalNumber(node.expression, typescript);
  if (typescript.isPrefixUnaryExpression(node) && node.operator === typescript.SyntaxKind.MinusToken) {
    const inner = literalNumber(node.operand, typescript);
    return inner === null ? null : -inner;
  }
  return null;
}

/** Every top-level `const NAME = <number>;` a file declares - the numbers beneath a schema constant. */
function numericConstants(file, typescript) {
  const numbers = new Map();
  for (const statement of file.statements) {
    if (!typescript.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!typescript.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
      const value = literalNumber(declaration.initializer, typescript);
      if (value !== null) numbers.set(declaration.name.text, value);
    }
  }
  return numbers;
}

/** The property of an object literal named `name`, or `undefined` when the literal does not state it. */
function propertyOf(object, name, file, typescript) {
  for (const property of object.properties) {
    if (!typescript.isPropertyAssignment(property)) continue;
    if (property.name.getText(file).replace(/^"|"$/gu, "") !== name) continue;
    return property.initializer;
  }
  return undefined;
}

/** A number this reader can resolve: a literal, or an identifier one of the two files declares as a literal. */
function resolveNumber(node, numbers, typescript) {
  const literal = literalNumber(node, typescript);
  if (literal !== null) return literal;
  if (typescript.isIdentifier(node)) {
    const value = numbers.get(node.text);
    if (value !== undefined) return value;
  }
  return null;
}

/**
 * One `Type.Integer(...)` call, read as the range it states.
 *
 * Three answers, and the middle one is why this is not a nullable number: `{}` when the call states no end this reader
 * has to resolve (`Type.Integer()` - an argument the schema deliberately leaves unbounded, which the descriptor-derived
 * fallback builds), `{...ends}` when it states ends that resolve, and `null` when it IS a whole-number schema whose ends
 * are not numbers a reader can see (`Type.Integer(intervalAcceptedBy(isTileCoordinate))`).
 */
function integerSchemaEnds(call, file, numbers, typescript) {
  const argument = call.arguments[0];
  if (argument === undefined) return {};
  if (!typescript.isObjectLiteralExpression(argument)) return null;
  const ends = {};
  for (const end of ENDS) {
    const node = propertyOf(argument, end, file, typescript);
    if (node === undefined) continue;
    const value = resolveNumber(node, numbers, typescript);
    if (value === null) return null;
    ends[end] = value;
  }
  return ends;
}

/**
 * Every whole-number schema constant a file declares, wherever it is written.
 *
 * Function-local ones are included on purpose: before the fix `TOOL_SLOT_SCHEMA` was declared inside the mount function
 * and built by probing, and a reader that only looked at top-level declarations would have called those members
 * unbounded instead of naming them unreadable.
 */
function integerSchemaConstants(file, typescript) {
  const constants = new Map();
  const visit = (node) => {
    if (
      typescript.isVariableDeclaration(node) &&
      typescript.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      typescript.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(file) === "Type.Integer"
    )
      constants.set(node.name.text, node.initializer);
    typescript.forEachChild(node, visit);
  };
  visit(file);
  return constants;
}

/** The schema inside a `Type.Optional(...)`, a parenthesis or an `as` cast. */
function innermostSchema(node, file, typescript) {
  let current = node;
  for (;;) {
    if (typescript.isParenthesizedExpression(current) || typescript.isAsExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      typescript.isCallExpression(current) &&
      current.expression.getText(file) === "Type.Optional" &&
      current.arguments[0] !== undefined
    ) {
      current = current.arguments[0];
      continue;
    }
    return current;
  }
}

/**
 * The actions a `makeGameActionTool` call serves: the loop it sits in, or the `action` it names.
 *
 * A loop block mounts one tool per ACTION, so the block's members describe every action in its table. `null` is a call
 * this reader cannot attribute, which the caller reports rather than guesses at.
 */
function mountActions(call, file, typescript) {
  for (let cursor = call.parent; cursor !== undefined; cursor = cursor.parent) {
    if (!typescript.isForOfStatement(cursor)) continue;
    let table = cursor.expression;
    if (typescript.isAsExpression(table) || typescript.isParenthesizedExpression(table)) table = table.expression;
    if (!typescript.isArrayLiteralExpression(table)) continue;
    return table.elements.map((element) => element.getText(file).replace(/^"|"$/gu, ""));
  }
  const object = call.arguments[0];
  if (object === undefined || !typescript.isObjectLiteralExpression(object)) return null;
  const action = propertyOf(object, "action", file, typescript);
  if (action === undefined) return null;
  if (typescript.isStringLiteral(action)) return [action.text];
  if (typescript.isIdentifier(action)) return [action.text];
  return null;
}

/** The action ids a `buildCandidateToolSchema` arm answers, from its own `actionId === "..."` comparisons. */
export function armActions(condition) {
  const ids = [...condition.matchAll(/actionId === "([a-z0-9_]+)"/gu)].map((match) => match[1]);
  return ids.length === 0 ? null : ids;
}

/**
 * The actions one `Type.Object` schema describes, and which shape selected them, or `null` for a schema that is neither.
 *
 * A `Type.Object` nested inside a member's own expression is that member's content, not a schema of its own, and both
 * shapes are how `host/src/game-tools.ts` mounts tools: a `makeGameActionTool` call's `parameters`, and a
 * `return Type.Object(...)` arm of `buildCandidateToolSchema` selected by an action condition.
 */
function siteOf(node, file, typescript, builder) {
  const parent = node.parent;
  if (parent !== undefined && typescript.isPropertyAssignment(parent) && parent.name.getText(file) === "parameters") {
    const call = parent.parent?.parent;
    if (!typescript.isCallExpression(call) || call.expression.getText(file) !== "makeGameActionTool") return null;
    const actions = mountActions(call, file, typescript);
    return actions === null ? null : { kind: "mount", actions };
  }
  for (let cursor = node.parent; cursor !== undefined && cursor !== builder; cursor = cursor.parent)
    if (typescript.isIfStatement(cursor)) {
      const actions = armActions(cursor.expression.getText(file));
      return actions === null ? null : { kind: "arm", actions };
    }
  return null;
}

/** The members one hand-written schema object literal states, in declaration order. */
function membersOf(literal, file, typescript) {
  return literal.properties
    .filter((property) => typescript.isPropertyAssignment(property))
    .map((property) => ({
      name: property.name.getText(file).replace(/^"|"$/gu, ""),
      expression: property.initializer.getText(file).replace(/\s+/gu, " ").trim(),
      node: property.initializer,
    }));
}

/**
 * Every hand-written schema site: which actions it describes, and the members it states.
 *
 * The population is derived by walking the file, never from a list, so a mount added tomorrow is examined without an
 * edit here.
 */
export function schemaSites(file, typescript) {
  const builder = file.statements.find(
    (statement) =>
      typescript.isFunctionDeclaration(statement) && statement.name?.getText(file) === "buildCandidateToolSchema",
  );
  const sites = [];
  const visit = (node) => {
    const isSchema = typescript.isCallExpression(node) && node.expression.getText(file) === "Type.Object";
    const literal = isSchema ? node.arguments[0] : undefined;
    if (literal !== undefined && typescript.isObjectLiteralExpression(literal)) {
      const site = siteOf(node, file, typescript, builder);
      if (site !== null) sites.push({ ...site, members: membersOf(literal, file, typescript) });
    }
    typescript.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}

/**
 * What one member's schema expression says about a whole-number range.
 *
 * Four answers, because the three that are not a range are three different facts: `not-a-range` (a closed set, a string,
 * an opaque id), `borrowed` (the member reads the declaration's own row), `unreadable` (a whole-number schema whose ends
 * are not numbers a reader can see) and `ends`. The caller splits `ends` again: an empty one is `Type.Integer()`, which
 * states no end at all.
 */
function memberReading(member, { typescript, file, constants, numbers }) {
  const node = innermostSchema(member.node, file, typescript);
  if (typescript.isIdentifier(node)) {
    const declaration = constants.get(node.text);
    if (declaration === undefined) return { kind: "not-a-range" };
    return endsOf(declaration);
  }
  if (!typescript.isCallExpression(node)) return { kind: "not-a-range" };
  const callee = node.expression.getText(file);
  if (callee === DECLARATION_READER) return { kind: "borrowed" };
  if (callee !== "Type.Integer") return { kind: "not-a-range" };
  return endsOf(node);

  function endsOf(call) {
    const ends = integerSchemaEnds(call, file, numbers, typescript);
    return ends === null ? { kind: "unreadable" } : { kind: "ends", ends };
  }
}

/**
 * The whole-number bounds the hand-written schemas state, keyed `<action>.<argument>`, with what could not be read.
 *
 * A member answered by more than one site keeps the FIRST statement: two sites for one action argument are two
 * spellings of one fact, and each is read on its own so neither can hide behind the other.
 */
export function writtenArgumentBounds({ tools, facts }) {
  const typescript = createRequire(path.join(repositoryRoot, "host", "package.json"))("typescript");
  const toolsFile = typescript.createSourceFile(
    GAME_TOOLS_PATH,
    tools,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  const factsFile = typescript.createSourceFile(
    TARGET_FACTS_PATH,
    facts,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  const numbers = new Map([...numericConstants(factsFile, typescript), ...numericConstants(toolsFile, typescript)]);
  const constants = integerSchemaConstants(toolsFile, typescript);
  const unparsed = [...toolsFile.parseDiagnostics, ...factsFile.parseDiagnostics].map((diagnostic) =>
    String(diagnostic.messageText),
  );
  const context = { typescript, file: toolsFile, constants, numbers };

  const sites = schemaSites(toolsFile, typescript);
  const bounds = new Map();
  const unreadable = [];
  let borrowed = 0;
  let unbounded = 0;
  for (const site of sites)
    for (const action of site.actions)
      for (const member of site.members) {
        const reading = memberReading(member, context);
        if (reading.kind === "not-a-range") continue;
        if (reading.kind === "borrowed") {
          borrowed += 1;
          continue;
        }
        const key = `${action}.${member.name}`;
        if (reading.kind === "unreadable") {
          unreadable.push({ action, argument: member.name, expression: member.expression });
          continue;
        }
        if (Object.keys(reading.ends).length === 0) {
          unbounded += 1;
          continue;
        }
        if (!bounds.has(key)) bounds.set(key, Object.freeze({ ...reading.ends, expression: member.expression }));
      }
  return { bounds, unreadable, borrowed, unbounded, sites: sites.length, unparsed };
}

/** One range as the report spells it, with an end nobody stated written as `none` rather than as zero. */
function formatEnds(ends) {
  return ENDS.map((end) => (ends?.[end] === undefined ? "none" : String(ends[end]))).join("..");
}

/**
 * One written argument against its declaration: agreement, a disagreement, or a bound with nothing behind it.
 *
 * The second code carries no range because the range is exactly what is missing: the note names which END of the schema
 * has no declaration, and the finding itself is the argument.
 */
function judgeWritten({ key, writtenEnds, declaredEnds }) {
  const undeclared = (note) => ({
    outcome: "undeclared",
    finding: {
      code: "argument_bound_written_without_a_declaration",
      argument: key,
      id: `argument_bound_written_without_a_declaration:${key}`,
      ...(note === undefined ? {} : { note }),
    },
  });
  if (declaredEnds === undefined) return undeclared();
  const undeclaredEnd = ENDS.find((end) => writtenEnds[end] !== undefined && declaredEnds[end] === undefined);
  if (undeclaredEnd !== undefined)
    return undeclared(
      `the schema states ${undeclaredEnd} ${String(writtenEnds[undeclaredEnd])} and the declaration states no ${undeclaredEnd}`,
    );
  if (ENDS.every((end) => writtenEnds[end] === undefined || declaredEnds[end] === writtenEnds[end]))
    return { outcome: "agree" };
  return {
    outcome: "disagree",
    finding: {
      code: "argument_bound_disagrees_with_its_declaration",
      argument: key,
      id:
        `argument_bound_disagrees_with_its_declaration:${key}` +
        `:declared=${formatEnds(declaredEnds)}:written=${formatEnds(writtenEnds)}`,
    },
  };
}

/**
 * The whole reading: both populations, both codes, and the counts that make the four buckets add up to the examined set.
 */
export function checkArgumentBoundParity({
  root = repositoryRoot,
  surface = JSON.parse(read(root, SURFACE_PATH)),
  tools = read(root, GAME_TOOLS_PATH),
  facts = read(root, TARGET_FACTS_PATH),
} = {}) {
  const declared = declaredArgumentBounds(surface);
  const {
    bounds: written,
    unreadable,
    borrowed,
    unbounded,
    sites,
    unparsed,
  } = writtenArgumentBounds({
    tools,
    facts,
  });

  const findings = unparsed.map((diagnostic) => ({
    code: "argument_bound_source_unparsed",
    argument: GAME_TOOLS_PATH,
    id: `argument_bound_source_unparsed:${GAME_TOOLS_PATH}:${diagnostic}`,
  }));
  const rows = [];
  const unreadableMembers = new Set(unreadable.map((member) => `${member.action}.${member.argument}`));
  // An argument whose hand-written bound could not be READ is not "declared-only": it has a statement, and code 3 is
  // what judges it. Counting it in both places would report one argument twice and make the buckets stop adding up.
  const declaredOnlyMembers = [...declared.keys()].filter((key) => !(written.has(key) || unreadableMembers.has(key)));
  let agreed = 0;
  let handWrittenOnly = 0;
  let disagreeing = 0;

  for (const [key, writtenEnds] of written) {
    const declaredEnds = declared.get(key);
    rows.push({
      argument: key,
      declared: formatEnds(declaredEnds),
      written: formatEnds(writtenEnds),
      expression: writtenEnds.expression,
    });
    const { outcome, finding } = judgeWritten({ key, writtenEnds, declaredEnds });
    if (finding !== undefined) findings.push(finding);
    if (outcome === "agree") agreed += 1;
    else if (outcome === "undeclared") handWrittenOnly += 1;
    else disagreeing += 1;
  }
  for (const member of unreadable)
    findings.push({
      code: "argument_bound_unreadable",
      argument: `${member.action}.${member.argument}`,
      id: `argument_bound_unreadable:${member.action}.${member.argument}:${member.expression}`,
    });

  const examined = new Set([...declared.keys(), ...written.keys(), ...unreadableMembers]).size;
  return Object.freeze({
    schema: GATE,
    status: statusOf({ examined, declared: declared.size, written: written.size, sites, findings }),
    examined,
    agreed,
    declaredOnly: declaredOnlyMembers.length,
    handWrittenOnly,
    disagreeing,
    unreadable: unreadable.length,
    borrowed,
    unbounded,
    sites,
    findings: Object.freeze(findings),
    rows: Object.freeze(rows),
    declaredOnlyMembers: Object.freeze(declaredOnlyMembers),
  });
}

/**
 * The verdict: a reading that lost one of its two sides measured NOTHING, so it is BLOCKED rather than passed.
 *
 * A source that does not parse is a finding (`argument_bound_source_unparsed`), not a block: the files are there, and
 * saying "I could not parse them" in the same bucket as "I found no schema" would hide which of the two happened.
 */
export function statusOf({ examined, declared, written, sites, findings }) {
  if (examined === 0 || declared === 0 || written === 0 || sites === 0) return "blocked";
  return findings.length > 0 ? "failed" : "passed";
}

function main(argv) {
  const rootAt = argv.indexOf("--root");
  const root = rootAt === -1 ? repositoryRoot : path.resolve(argv[rootAt + 1] ?? ".");
  const report = checkArgumentBoundParity({ root });
  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(report)}\n`);
  else {
    if (argv.includes("--rows"))
      for (const row of report.rows)
        process.stdout.write(
          `  ${row.argument} declared=${row.declared} written=${row.written} from ${row.expression}\n`,
        );
    process.stdout.write(
      `arguments examined ${report.examined} · declared-only ${report.declaredOnly}` +
        ` · hand-written-only ${report.handWrittenOnly} · disagreeing ${report.disagreeing}` +
        ` · agreed ${report.agreed} · unreadable ${report.unreadable}` +
        ` · sites ${report.sites} · reading the declaration ${report.borrowed} · states no bound ${report.unbounded}\n`,
    );
    for (const entry of report.declaredOnlyMembers)
      process.stdout.write(
        `  declared-only ${entry}: the Mod publishes this argument's range and no hand-written schema states it\n`,
      );
    for (const finding of report.findings)
      process.stdout.write(`  ${finding.id}${finding.note === undefined ? "" : ` (${finding.note})`}\n`);
    if (report.status === "blocked")
      process.stdout.write(
        "argument_bound_hand_written_population_not_measured: one of the two populations is empty, so a green " +
          "verdict would agree with itself\n",
      );
    if (report.status === "passed") process.stdout.write("  every hand-written bound is the one the Mod declares\n");
    if (report.status === "failed") process.stdout.write(`  ${report.findings.length} finding(s)\n`);
  }
  return EXIT[report.status];
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
