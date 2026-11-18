#!/usr/bin/env node
/**
 * The gate for "a hand-written Game Action tool schema wrote out a bound a shared constant already owns".
 *
 * WHY (measured 2026-11-16). The Game Action tool schemas are written inline in `host/src/game-tools.ts` - fifty
 * mount blocks plus the per-action arms of `buildCandidateToolSchema`. Their 296 members carried only 16 distinct
 * (name, expression) pairs, and 288 of them were one of six bounds spelled again: `x`/`y` 0..1000, the caller-identity
 * pair, `expectedTargetId`, `slot`, the item id and `chestId`. A statement copied forty-eight times is not a statement;
 * it is a coincidence waiting to drift, and it had drifted: the descriptor-derived mounts described `x`/`y` up to
 * 100000 while `tileRow` refused a value above 1000, so a schema-conformant call was refused before the bridge.
 *
 * THE FIX IS ONE DECLARATION PER DOMAIN, DERIVED FROM THE WIRE. `TILE_COORDINATE_SCHEMA` and `TOOL_SLOT_SCHEMA` are read
 * from `isTileCoordinate`/`isToolSlot` - the predicates `tileRow`/`slotRow` enforce - by probing them; `OPAQUE_ID_SCHEMA`
 * is read from `isOpaqueId`, which is the wire's own rule for `expectedTargetId`, `chestId`, `requestId` and
 * `idempotencyKey`; `CALLER_REQUEST_SCHEMA` is that same domain wrapped in `Type.Optional`; `ITEM_ID_SCHEMA` is the
 * 1..128 the wire's `boundedItemRow` rows enforce, which exists only in their call sites. This gate protects the fix.
 *
 * THE POPULATION is derived by parsing `host/src/game-tools.ts`, never from a list: every property of the object
 * literal that is a mounted tool's `parameters` schema (`makeGameActionTool({ ..., parameters: Type.Object({...}) })`),
 * and every `return Type.Object({...})` arm of `buildCandidateToolSchema`. A `Type.Object` nested inside a member's
 * expression is part of that member, not a schema of its own - the member is the unit - and the observation tools
 * mounted by `createStardewObservationTools` are outside the population by construction, because they are not Game
 * Action schemas and own their bounds as the selection limits (`SELECTION_COORDINATE_LIMIT` and friends). Both
 * exclusions are counted in the reading rather than left unsaid.
 *
 * A mount inside `for (const action of [...] as const)` is expanded, because the surface the model receives has one
 * schema per ACTION, not per block: two loop blocks mount seven tools between them.
 *
 * THE PROPERTY, one member at a time:
 *
 *   from a constant   the member's expression is the identifier of the shared constant that owns its name, and its
 *                     name is one the domain map assigns to that constant.
 *   action-local      the member's name is not a shared domain, or it is one of the overrides below: a bound that is
 *                     genuinely this action's own (the vocabulary the Mod published for it, the one item it places,
 *                     the anchor its descriptor pins). Each override carries its reason and EXPIRES: an override whose
 *                     (action, member) is no longer in the source fails the gate.
 *   restated          anything else - `hand_written_schema_restates_a_constant:<action>:<member>`. Either the name has
 *                     a shared constant and the member pasted the bound instead of naming it, or the member pasted the
 *                     text of a shared constant's own declaration under a different name.
 *
 * ZERO POPULATION BLOCKS. A scan that finds no schema member, or a source in which none of the five constants is
 * declared, has lost its reader - and "0 restated" from a scan that read nothing is a sentence that agrees with itself.
 *
 * Usage:
 *   node tools/check-hand-written-schema-constants.mjs               # exit 0 passed, 1 failed, 2 blocked
 *   node tools/check-hand-written-schema-constants.mjs --json        # the reading, machine-readable
 *   node tools/check-hand-written-schema-constants.mjs --root <dir>  # the gate's own fixture
 *
 * red-proof: history replay and injection. `tools/check-hand-written-schema-constants.test.mjs` reads the commit this
 *            gate was written against (`git show 9adf97b5:host/src/game-tools.ts`): the gate then printed `members
 *            examined 327 · from a constant 0 · action-local 13 · restated 314` and named `move_to_tile:x`,
 *            `chest_store:chestId` and `shared_constant_missing:TILE_COORDINATE_SCHEMA`. Injecting one pasted `x` into
 *            the current file, which is otherwise green, prints `hand_written_schema_restates_a_constant:move_to_tile:x`.
 *            The same test injects the constant's own expression under another member name, removes an action-local
 *            member so the exemption expires, and feeds a source with no schema so zero population blocks.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "host/src/game-tools.ts";
const MOUNT_FACTORY = "makeGameActionTool";
const DERIVED_BUILDER = "buildCandidateToolSchema";

/**
 * The member names a shared constant owns, and the constant that owns each. The identity pair is one domain with two
 * members, and `expectedTargetId`/`chestId` are the same `isOpaqueId` domain under two names - the wire validates all
 * four with one predicate, so they are one constant rather than four spellings of one fact.
 */
const DOMAINS = Object.freeze(
  new Map([
    ["x", "TILE_COORDINATE_SCHEMA"],
    ["y", "TILE_COORDINATE_SCHEMA"],
    ["slot", "TOOL_SLOT_SCHEMA"],
    ["requestId", "CALLER_REQUEST_SCHEMA"],
    ["idempotencyKey", "CALLER_REQUEST_SCHEMA"],
    ["expectedTargetId", "OPAQUE_ID_SCHEMA"],
    ["chestId", "OPAQUE_ID_SCHEMA"],
    ["expectedQualifiedItemId", "ITEM_ID_SCHEMA"],
  ]),
);

/**
 * The members that are genuinely their own action's, keyed `<action>:<member>`. Every entry is a bound that belongs to
 * one action and to no other, so it cannot be a shared constant; each one goes red the moment it stops being written,
 * which is the expiry that keeps this from becoming a list of excuses.
 */
const ACTION_LOCAL = Object.freeze(
  new Map([
    [
      "respond_level_up:choice",
      "the Mod's published LevelUpChoiceEnum, projected onto the descriptor; a closed set only that action has",
    ],
    [
      "respond_level_up:expectedSkill",
      "which skills `Farmer.newLevels` can name: 0..5 including luck, the bound `FarmhandExecutionAcceptance` re-checks",
    ],
    ["respond_level_up:expectedLevel", "the engine's level range 1..10 for the menu the action is holding"],
    [
      "navigate_to_destination:destination",
      "the typed label/ref destination selector the wire pins, which is this action's whole input",
    ],
    ["equip_tool:tool", "TOOL_SELECTOR_VALUES, the Mod's own tool vocabulary"],
    ["till_soil:charge", "declaredIntegerArgument reads the range the wire's own row pins for this action"],
    ["water_crop:charge", "declaredIntegerArgument, as for till_soil"],
    ["place_wood_fence:expectedQualifiedItemId", "the one item this action places, pinned by the Mod's handler"],
    ["place_crab_pot:expectedQualifiedItemId", "the one item this action places, pinned by the Mod's handler"],
    ["bait_crab_pot:expectedQualifiedItemId", "the one item this action places, pinned by the Mod's handler"],
    [
      "machine_load:expectedQualifiedItemId",
      "the machine's own accepted input, copied from loadInputQualifiedItemId on the same machineTargets row",
    ],
  ]),
);

const EXIT_STATUS = Object.freeze({ passed: 0, failed: 1, blocked: 2 });

function normalize(text) {
  return text.replace(/\s+/gu, " ").trim();
}

/** The action ids a schema arm answers, from the `actionId === "..."` comparisons in its own condition. */
function actionIdsOf(conditionText) {
  const ids = [...conditionText.matchAll(/actionId === "([a-z_]+)"/gu)].map((match) => match[1]);
  return ids.length === 0 ? null : ids;
}

/** An array literal, through the `as const` a loop's table is written with. */
function arrayLiteral(expression, typescript) {
  if (typescript.isAsExpression(expression) || typescript.isParenthesizedExpression(expression))
    return arrayLiteral(expression.expression, typescript);
  return typescript.isArrayLiteralExpression(expression) ? expression : null;
}

/** The actions a mount block serves: the loop it sits in, or the `action`/`name` it names. */
function mountActions(call, typescript, sourceFile) {
  for (let cursor = call.parent; cursor !== undefined; cursor = cursor.parent) {
    if (!typescript.isForOfStatement(cursor)) continue;
    const table = arrayLiteral(cursor.expression, typescript);
    if (table !== null) return table.elements.map((element) => element.getText(sourceFile).replace(/^"|"$/gu, ""));
  }
  const object = call.arguments[0];
  if (object === undefined || !typescript.isObjectLiteralExpression(object)) return null;
  let looped;
  for (const property of object.properties) {
    if (!typescript.isPropertyAssignment(property)) continue;
    const name = property.name.getText(sourceFile);
    if (name === "name") looped = property.initializer.getText(sourceFile);
    if (name !== "action") continue;
    const initializer = property.initializer;
    if (typescript.isStringLiteral(initializer)) return [initializer.text];
    if (typescript.isIdentifier(initializer)) return [initializer.text];
  }
  if (looped === undefined) return null;
  const named = /STARDEW_ACTION_TOOL_NAMES\.([a-z_]+)/u.exec(looped);
  return [named === null ? looped : named[1]];
}

/** The parsed population: every member of every hand-written Game Action schema, one entry per action. */
function schemaSites(sourceFile, typescript) {
  const sites = [];
  const builder = sourceFile.statements.find(
    (statement) =>
      typescript.isFunctionDeclaration(statement) && statement.name?.getText(sourceFile) === DERIVED_BUILDER,
  );
  const visit = (node) => {
    if (typescript.isCallExpression(node) && node.expression.getText(sourceFile) === "Type.Object") {
      const first = node.arguments[0];
      if (first !== undefined && typescript.isObjectLiteralExpression(first)) {
        const site = siteOf(node, first, typescript, sourceFile, builder);
        if (site !== null) sites.push(site);
      }
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

function siteOf(node, literal, typescript, sourceFile, builder) {
  const members = literal.properties
    .filter((property) => typescript.isPropertyAssignment(property))
    .map((property) => ({
      name: property.name.getText(sourceFile).replace(/^"|"$/gu, ""),
      expression: normalize(property.initializer.getText(sourceFile)),
      line: sourceFile.getLineAndCharacterOfPosition(property.getStart(sourceFile)).line + 1,
    }));
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  // A mount's own `parameters`. A `Type.Object` nested inside a member's expression is that member's content.
  const parent = node.parent;
  if (
    parent !== undefined &&
    typescript.isPropertyAssignment(parent) &&
    parent.name.getText(sourceFile) === "parameters"
  ) {
    const holder = parent.parent;
    const call = holder?.parent;
    if (
      typescript.isCallExpression(call) &&
      call.expression.getText(sourceFile) === MOUNT_FACTORY &&
      holder === call.arguments[0]
    ) {
      const actions = mountActions(call, typescript, sourceFile);
      return actions === null ? null : { kind: "mount", actions, line, members };
    }
  }
  // A `buildCandidateToolSchema` arm: its action ids are the condition that selects it.
  let cursor = node.parent;
  while (cursor !== undefined && cursor !== builder) {
    if (typescript.isIfStatement(cursor)) {
      const actions = actionIdsOf(cursor.expression.getText(sourceFile));
      if (actions !== null) return { kind: "arm", actions, line, members };
      return null;
    }
    cursor = cursor.parent;
  }
  return null;
}

/** The five shared constants the source declares, by name. */
function sharedConstants(sourceFile, typescript) {
  const constants = new Map();
  for (const statement of sourceFile.statements) {
    if (!typescript.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!typescript.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
      const initializer = normalize(declaration.initializer.getText(sourceFile));
      if (!initializer.startsWith("Type.")) continue;
      constants.set(declaration.name.text, initializer);
    }
  }
  return constants;
}

export function auditHandWrittenSchemaConstants({ root = REPOSITORY_ROOT, source = SOURCE } = {}) {
  const typescript = createRequire(join(REPOSITORY_ROOT, "host", "package.json"))("typescript");
  const file = join(root, source);
  const text = readFileSync(file, "utf8");
  const sourceFile = typescript.createSourceFile(
    file,
    text,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  const unparsed = (sourceFile.parseDiagnostics ?? []).map((diagnostic) => String(diagnostic.messageText));
  const sites = schemaSites(sourceFile, typescript);
  const constants = sharedConstants(sourceFile, typescript);
  const observed = new Map();
  let fromConstant = 0;
  let actionLocal = 0;
  const findings = [];
  const restated = [];
  const localMembers = [];
  let examined = 0;
  for (const site of sites) {
    for (const action of site.actions) {
      for (const member of site.members) {
        examined += 1;
        if (!observed.has(`${action}:${member.name}`)) observed.set(`${action}:${member.name}`, { action, ...member });
        const override = ACTION_LOCAL.get(`${action}:${member.name}`);
        if (override !== undefined) {
          actionLocal += 1;
          localMembers.push({ action, member: member.name, expression: member.expression, reason: override });
          continue;
        }
        const owner = DOMAINS.get(member.name);
        if (owner !== undefined) {
          if (member.expression === owner) {
            fromConstant += 1;
            continue;
          }
          restated.push({ action, member: member.name, line: member.line, expression: member.expression, owner });
          findings.push(`hand_written_schema_restates_a_constant:${action}:${member.name}`);
          continue;
        }
        const duplicated = [...constants].find(([, expression]) => expression === member.expression);
        if (duplicated !== undefined) {
          restated.push({
            action,
            member: member.name,
            line: member.line,
            expression: member.expression,
            owner: duplicated[0],
          });
          findings.push(`hand_written_schema_restates_a_constant:${action}:${member.name}`);
          continue;
        }
        actionLocal += 1;
        localMembers.push({ action, member: member.name, expression: member.expression, reason: null });
      }
    }
  }
  const declared = [...DOMAINS.values()];
  const missing = [...new Set(declared)].filter((name) => !constants.has(name));
  const used = new Set(
    sites
      .flatMap((site) => site.members.map((member) => member.expression))
      .filter((expression) => constants.has(expression)),
  );
  const unused = [...new Set(declared)].filter((name) => constants.has(name) && !used.has(name));
  const staleOverrides = [...ACTION_LOCAL.keys()].filter((key) => !observed.has(key));
  const unobservedDomains = [...DOMAINS.keys()].filter(
    (name) => ![...observed.values()].some((member) => member.name === name),
  );
  for (const name of missing) findings.push(`shared_constant_missing:${name}`);
  for (const name of unused) findings.push(`shared_constant_unused:${name}`);
  for (const key of staleOverrides) findings.push(`action_local_override_no_longer_written:${key}`);
  for (const name of unobservedDomains) findings.push(`shared_domain_member_never_written:${name}`);
  return {
    file: source,
    sites: sites.length,
    actions: new Set(sites.flatMap((site) => site.actions)).size,
    examined,
    fromConstant,
    actionLocal,
    restated: restated.length,
    observations: sites.filter((site) => site.kind === "mount").length,
    constants: [...constants.keys()],
    findings,
    detail: restated,
    localMembers,
    missing,
    unused,
    staleOverrides,
    unobservedDomains,
    unparsed,
  };
}

/** The verdict: a scan that read no schema member measured nothing, and is blocked rather than green. */
export function statusOf(reading) {
  if (reading.unparsed.length > 0) return "failed";
  if (reading.sites === 0 || reading.examined === 0) return "blocked";
  return reading.findings.length > 0 ? "failed" : "passed";
}

function main(argv) {
  const rootAt = argv.indexOf("--root");
  const root = rootAt === -1 ? REPOSITORY_ROOT : resolve(argv[rootAt + 1] ?? ".");
  const json = argv.includes("--json");
  const reading = auditHandWrittenSchemaConstants({ root });
  const status = statusOf(reading);
  const report = {
    gate: "hand-written-schema-constants",
    status,
    examined: reading.examined,
    fromConstant: reading.fromConstant,
    actionLocal: reading.actionLocal,
    restated: reading.restated,
    sites: reading.sites,
    actions: reading.actions,
    constants: reading.constants,
    findings: reading.findings,
    detail: reading.detail,
    unparsed: reading.unparsed,
  };
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else {
    process.stdout.write(
      `members examined ${report.examined} · from a constant ${report.fromConstant}` +
        ` · action-local ${report.actionLocal} · restated ${report.restated}` +
        ` · sites ${report.sites} · actions ${report.actions}\n`,
    );
    for (const entry of reading.localMembers)
      process.stdout.write(
        `  action-local ${entry.action}:${entry.member}${entry.reason === null ? "" : ` (${entry.reason})`}\n`,
      );
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  for (const finding of reading.findings) process.stderr.write(`${finding}\n`);
  if (status === "blocked")
    process.stderr.write(
      "hand_written_schema_constants: nothing was examined - the source declares no hand-written action schema - " +
        "so a green verdict would agree with itself\n",
    );
  process.exitCode = EXIT_STATUS[status];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
