#!/usr/bin/env node
/**
 * An action the companion can INTEND is an action every surface on the way to the game accepts.
 *
 * WHY. Five instances in two days, one shape: the layer that let the companion say a thing and the layer that refused
 * it disagreed, and each was found by a human noticing rather than by a check.
 *
 *   charge        the wire required `charge` on `till_soil`; the tool schema did not offer it, so a schema-conformant
 *                 call was refused `invalid_args` before the bridge, and the plan example printed the same call.
 *   sweep_scythe  the catalog carried the action, the completion contract named it and the wire validated it, and no
 *                 tool mounted it - a registered, advertised capability with nothing recording that it was absent.
 *   for_each      the grammar accepted `family`/`query` and the Mod answered `for_each_source_unavailable:<kind>`.
 *   express_emote the prompt named `stardew_express_emote` and no surface mounted it.
 *   refusalDetail the Mod put a field on `partially_succeeded` and the Host refused `invalid_body_program_result`.
 *
 * Two of those pairs have a gate now (tool schema vs wire, plan example vs wire, both in
 * `host/src/game-tools-argument-contract.test.ts`). The matrix as a whole did not, so this gate is that matrix: one
 * (action, argument) cell, every surface that must carry it, and the surface that does not named by name.
 *
 * THE POPULATION IS THE ACTION CATALOG, CROSSED WITH THE SURFACES IT MUST CROSS. The catalog
 * (`action-surface.v1.json`) is the Mod's published descriptor surface and states each action's `lifecycle`, `kind` and
 * `argumentSchema`; every other surface is read from its OWN authority, never from a hand list here:
 *
 *   catalog       the descriptor requirements: `actions[].argumentSchema` and `actions[].kind`/`lifecycle`.
 *   wire          the Host's request validator: the `exactArgs([...])` row of each key in `EXECUTION_REQUEST_ARGUMENT_RULES`
 *                 (`host/src/protocol.ts`), followed through a shared frozen row list (`REMOVES_PLACED_OBJECT`) and
 *                 through `textOnlyRow`, because three actions reference a list by name and two delegate to a helper. The
 *                 whole-number ranges the same rows pin are `executionRequestIntegerBounds`, which the tool schema reads
 *                 rather than restating (`declaredIntegerArgument`).
 *   plan-grammar  `body-program-script.ts`: which actions a script may name at all, from the grammar's own published
 *                 admission rule (`PLAN_ACTION_LIFECYCLES` and `PLAN_ARGUMENT_TYPES`, applied in
 *                 `planActionsFromRegistrations`). Its per-action argument vocabulary is `declaredArgumentsOf(registration)`
 *                 - the same descriptor the catalog projects - so this gate reads THAT DEPENDENCY and blocks if the
 *                 grammar stops deriving from the descriptor, or adds a `continue` beside its two declared filters;
 *                 inventing a second copy of the names here would be the drift the gate exists to catch.
 *   tool-schema   `game-tools.ts`: the parameters each mounted Game Action tool declares, either inline
 *                 (`parameters: Type.Object({...})`) or from the descriptor (`buildCandidateToolSchema`), whose per-action
 *                 arms are read here and whose fallback is `declaredArgumentNames(descriptor)`. The caller-identity fields
 *                 (`requestId`, `idempotencyKey`) are the ones `callerRequestIds` reads - a declaration, not a list.
 *   tool-args     the same mounts, one layer further: the keys `toArgs` actually forwards to the wire, or
 *                 `declaredArguments(descriptor, params)`. A schema that declares an argument the projector drops is an
 *                 intent the tool accepts and silently discards, which is instance `charge`'s second half.
 *   mod           the Mod's reader: `BridgeProtocol.ExecutionArgumentProperties(action)`, the `switch` that
 *                 `TryDeserializeExecutionRequest` requires to match the frame's `args` exactly. Read from source, no
 *                 build; `Array.Empty<string>()` is its statement that an action carries no argument at all.
 *
 * THE PROPERTY, per (action, argument): if any surface that carries the action admits an argument, every surface that
 * carries it must admit it, or the one that does not is named -
 *
 *   surface_refuses_what_another_accepts:<action>:<argument>:<refusingSurface>:<admittingSurface>
 *
 * one line per refusing surface, so an argument two surfaces drop is two lines and not one. The admitting surface named is
 * the first in alphabetical order, which is a spelling of "this is not a complaint about the other one".
 *
 * THE LIFECYCLE RULE, per (action, surface): an action absent from a surface is `surface_silently_omits_action:<action>:
 * <surface>` unless a declaration says why. Two declarations exist and both are read, never restated:
 *   - `kind: "read_only"` - the wire, the Mod's execution reader and the Game Action tools all take EXECUTION actions;
 *     a read-only action (`observe_scene`, `inspect_world_map`, `find_destination`) is not one.
 *   - the grammar's own lifecycle and argument-type sets - `experimental` is not nameable in a plan, and neither is an
 *     action carrying an argument type the grammar's value contracts do not cover.
 * That is precisely the `sweep_scythe` shape: `experimental`, present in three surfaces and absent from a fourth with
 * nothing recording the intent. A lifecycle is NOT a declaration for the tool surfaces - staging an experimental action is
 * an explicit mount (`isModDescriptorComplete`) and an omission is what this gate exists to name.
 *
 * ZERO POPULATION IS BLOCKED, NEVER GREEN. `actions examined 0`, any surface that read nothing, and any reader that could
 * not resolve an action's argument set are all `blocked` (exit 2) with the authority named, and the run prints how many
 * actions came from EACH authority - so a shrinking catalog cannot look like a clean matrix.
 *
/**
 * WHAT THIS GATE DOES NOT COVER, said out loud so a green run is not read as covering it.
 *
 * The family it is built for has five instances and this matrix is one answer to it, not the whole family:
 *   - VALUE-level constraints. This compares which arguments a surface admits, never the enum or the range it admits them
 *     in. Those have one authority each and are already read from it: the tool schema takes its whole-number ranges from
 *     `executionRequestIntegerBounds` (`declaredIntegerArgument`), asserted by
 *     `host/src/game-tools-argument-contract.test.ts`.
 *   - The JSON wire schema's action enum (`protocol/bridge-v1.schema.json`), which is where `sweep_scythe` was missing
 *     from the fourth place. `tools/check-stardew-action-promotion.mjs` owns it (`missing_schema_execution_action`);
 *     reading it again here would be a second spelling of one fact.
 *   - `for_each` sources and `where` tests: the grammar's loop document against the Mod's expansion
 *     (`for_each_source_unavailable:<kind>`) is not a per-action argument, so no surface in this matrix carries it.
 *   - Frame fields (`partially_succeeded` + `refusalDetail`): `tools/check-cross-language-wire-parity.mjs` and
 *     `tools/check-refusal-detail-state-parity.mjs` own those, by frame.
 * `express_emote` IS covered, and was one of the five: it is an action with an `emote` argument, its mount is conditional
 * on `isModDescriptorComplete`, and a mount that silently stops happening is `surface_silently_omits_action`.
 *
 * VERDICT. `actions examined N · surfaces S · pairs checked P`, then the population per authority, then the omission
 * declarations it used, then one line per finding. Exit 0 agree, 1 drift, 2 blocked.
 *
 * USAGE
 *   node tools/check-action-surface-parity.mjs            # the matrix; exit 1 on drift, 2 when blocked
 *   node tools/check-action-surface-parity.mjs --json     # the whole report
 *   node tools/check-action-surface-parity.mjs --root DIR # read another checkout (the falsifier's own tree)
 *
 * red-proof: history  the pre-0d4ce1b2 tree, where the tool schema and the projector omitted `charge` on `till_soil` and
 *   `water_crop` while the wire required it -> `surface_refuses_what_another_accepts:till_soil:charge:tool-schema:wire`
 *   (tools/check-action-surface-parity.test.mjs)
 * red-proof: history  the pre-8c53105e tree, where the catalog carried `sweep_scythe` and no tool mounted it ->
 *   `surface_silently_omits_action:sweep_scythe:tool-schema` (tools/check-action-surface-parity.test.mjs)
 * red-proof: inject  an argument deleted from a mount's `toArgs`, a key deleted from the wire declaration, an arm
 *   deleted from the Mod's switch, a `continue` added beside the grammar's two declared filters, a `toArgs` this reader
 *   cannot enumerate, and an empty source tree -> `surface_refuses_what_another_accepts:<action>:<argument>:tool-args:*`,
 *   `surface_silently_omits_action:<action>:wire|mod`,
 *   `plan_grammar_vocabulary_not_descriptor_derived:undeclared_skip:*`, `tool_args_unreadable:<action>`,
 *   `action_surface_population_empty` (tools/check-action-surface-parity.test.mjs)
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PATHS = Object.freeze({
  catalog: "integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
  wire: "host/src/protocol.ts",
  planGrammar: "host/src/body-program-script.ts",
  toolSchema: "host/src/game-tools.ts",
  mod: "integrations/stardew/src/Core/Protocol/BridgeProtocol.cs",
});

/** The surfaces, in the order findings name them. Every one is read from its own declaration, never from a table here. */
export const SURFACE_IDS = Object.freeze(["catalog", "mod", "plan-grammar", "tool-args", "tool-schema", "wire"]);

export const EXIT = Object.freeze({ passed: 0, failed: 1, blocked: 2 });

export const CODES = Object.freeze({
  refuses: "surface_refuses_what_another_accepts",
  omits: "surface_silently_omits_action",
});

// ---------------------------------------------------------------------------
// Reading primitives: strings and comments are inert, so a description that
// quotes an argument name cannot be mistaken for a declaration of one.
// ---------------------------------------------------------------------------

/**
 * The index just past the string or comment starting at `index`, or `index + 1` when none starts there.
 *
 * Every structural reader below walks through this, because these files carry MODEL-FACING PROSE - tool descriptions
 * naming `expectedTargetId`, reason codes naming `charge` - and a reader that counted braces or keys inside a template
 * literal would report a declaration the file does not make.
 */
function inertEnd(text, index) {
  const char = text[index];
  if (char === '"' || char === "'" || char === "`") {
    let cursor = index + 1;
    while (cursor < text.length && text[cursor] !== char) cursor += text[cursor] === "\\" ? 2 : 1;
    return Math.min(cursor + 1, text.length);
  }
  if (char === "/" && text[index + 1] === "/") {
    const end = text.indexOf("\n", index);
    return end < 0 ? text.length : end;
  }
  if (char === "/" && text[index + 1] === "*") {
    const end = text.indexOf("*/", index + 2);
    return end < 0 ? text.length : end + 2;
  }
  return index + 1;
}

/** The source without its comments; string literals are kept, because a declaration sometimes IS a literal. */
export function stripComments(source) {
  let out = "";
  for (let index = 0; index < source.length; ) {
    const end = inertEnd(source, index);
    out += end > index + 1 && source[index] === "/" ? "" : source.slice(index, end);
    index = end;
  }
  return out;
}

/** Index of the bracket closing the one at `openIndex`, or -1. Brackets inside strings and comments do not count. */
export function balancedEnd(text, openIndex) {
  const close = { "(": ")", "[": "]", "{": "}" }[text[openIndex]];
  if (close === undefined) return -1;
  const open = text[openIndex];
  let depth = 0;
  for (let index = openIndex; index < text.length; ) {
    const end = inertEnd(text, index);
    if (end > index + 1) {
      index = end;
      continue;
    }
    if (text[index] === open) depth += 1;
    else if (text[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

/** `text` split on `separator` at nesting depth 0. */
export function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; ) {
    const end = inertEnd(text, index);
    if (end > index + 1) {
      index = end;
      continue;
    }
    const char = text[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * The keys of an object literal BODY (the text between its braces), or null when a member is not a plain
 * `name: ...` / `name(...)`.
 *
 * Null rather than a partial list: a spread (`...shared`) contributes keys this reader cannot see, and reporting the
 * visible subset as the whole set is exactly the silent shortfall the gate exists to name.
 */
export function objectLiteralKeys(body) {
  const keys = [];
  for (const part of splitTopLevel(body, ",")) {
    if (part.trim().length === 0) continue;
    const match = /^\s*([A-Za-z_$][\w$]*)\s*[:(]/u.exec(part);
    if (match === null) return null;
    keys.push(match[1]);
  }
  return keys;
}

/**
 * The string members of `const <name> ... = Object.freeze([...])`, or null.
 *
 * Anchored on `Object.freeze(` rather than on `const <name>`, because the declaration's TYPE annotation comes first and
 * `readonly string[]` carries a `[` of its own - a reader that took the first array literal would report the annotation.
 */
export function frozenStringArray(source, name) {
  const match = new RegExp(`${name}\\b[^=]*=\\s*Object\\.freeze\\(\\[`, "u").exec(source);
  if (match === null) return null;
  const open = match.index + match[0].length - 1;
  const close = balancedEnd(source, open);
  if (close < 0) return null;
  return [...source.slice(open + 1, close).matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

/** The body of `function <name>(...) { ... }`, or null. */
function functionBody(source, name) {
  const at = source.indexOf(`function ${name}(`);
  if (at < 0) return null;
  const open = source.indexOf("{", at);
  const close = open < 0 ? -1 : balancedEnd(source, open);
  return close < 0 ? null : source.slice(open, close + 1);
}

// ---------------------------------------------------------------------------
// Surface readers, one per authority
// ---------------------------------------------------------------------------

/**
 * The catalog: the Mod's published descriptor surface, and the population every other surface is crossed with.
 *
 * A member without an `actionId`, without a string `kind`, or whose `argumentSchema` is not an object is a problem rather
 * than a silent skip - a catalog this reader cannot read in full cannot be the denominator of a matrix.
 */
export function readCatalogSurface(catalog) {
  const problems = [];
  const actions = new Map();
  const listed = Array.isArray(catalog?.actions) ? catalog.actions : null;
  if (listed === null) return { actions, problems: ["catalog_actions_unreadable"] };
  for (const entry of listed) {
    if (typeof entry?.actionId !== "string" || typeof entry?.kind !== "string") {
      problems.push(`catalog_action_malformed:${JSON.stringify(entry?.actionId)}`);
      continue;
    }
    const schema = entry.argumentSchema;
    if (schema === undefined || typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      problems.push(`catalog_argument_schema_unreadable:${entry.actionId}`);
      continue;
    }
    actions.set(entry.actionId, {
      arguments: new Set(Object.keys(schema)),
      types: new Map(Object.entries(schema).map(([name, argument]) => [name, argument?.type])),
      kind: entry.kind,
      lifecycle: typeof entry.lifecycle === "string" ? entry.lifecycle : "unstated",
    });
  }
  return { actions, problems };
}

/**
 * The Host's request validator: the argument key set each action's rows pin.
 *
 * The pinned set is the `exactArgs` row - the one whose `argumentNames` the type declares "so a gate that compares the
 * Host's demand against the Mod's published `argumentSchema` reads a key list". Three actions reference a shared frozen
 * list by name (`remove_placed_item: REMOVES_PLACED_OBJECT`) and two delegate to `textOnlyRow`, and both are followed
 * here rather than left as an empty set: reading them as "this action takes no arguments" would report five actions as
 * agreeing with an argument list they do not have.
 */
export function readWireSurface(source) {
  const text = stripComments(source);
  const problems = [];
  const actions = new Map();
  const at = text.indexOf("export const EXECUTION_REQUEST_ARGUMENT_RULES = Object.freeze({");
  if (at < 0) return { actions, problems: ["wire_declaration_not_found"] };
  const end = text.indexOf("\n} satisfies Record<", at);
  if (end < 0) return { actions, problems: ["wire_declaration_unterminated"] };
  const body = text.slice(at, end);
  const keys = [...body.matchAll(/^ {2}([a-z0-9_]+): /gmu)];
  if (keys.length === 0) return { actions, problems: ["wire_declaration_empty"] };
  for (const [index, key] of keys.entries()) {
    const chunk = body.slice(key.index, index + 1 < keys.length ? keys[index + 1].index : body.length);
    const pinned = pinnedWireArguments(text, chunk);
    if (pinned === null) {
      problems.push(`wire_argument_key_set_unreadable:${key[1]}`);
      continue;
    }
    actions.set(key[1], new Set(pinned));
  }
  return { actions, problems, ranges: [...body.matchAll(/integerRow\(\s*"([^"]+)"/gu)].map((match) => match[1]) };
}

/** The argument names one action's row list pins, through the shared list or the helper it may name. */
function pinnedWireArguments(source, chunk) {
  const inline = /exactArgs\(\s*\[([^\]]*)\]/u.exec(chunk);
  if (inline !== null) return [...inline[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  const shared = /^ {2}[a-z0-9_]+:\s*([A-Z][A-Z0-9_]*),/mu.exec(chunk);
  if (shared !== null) {
    const declaration = new RegExp(`const ${shared[1]}[^=]*=\\s*(?:Object\\.freeze\\()?\\[`, "u").exec(source);
    if (declaration === null) return null;
    const open = declaration.index + declaration[0].length - 1;
    const close = balancedEnd(source, open);
    const list = close < 0 ? null : /exactArgs\(\s*\[([^\]]*)\]/u.exec(source.slice(open, close));
    return list === null ? null : [...list[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  }
  if (/textOnlyRow\(\s*\d+\s*\)/u.test(chunk)) {
    const helper = functionBody(source, "textOnlyRow");
    const keys = helper === null ? null : /hasExactKeys\(reading\.args,\s*\[([^\]]*)\]/u.exec(helper);
    return keys === null ? null : [...keys[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  }
  return null;
}

/**
 * The Mod's reader: `ExecutionArgumentProperties`, the switch `TryDeserializeExecutionRequest` passes the action to.
 *
 * An action absent from the switch falls to `_ => null` and the Mod refuses the whole frame, so absence here is a
 * surface that refuses an action the Host validates - the `sweep_scythe` shape one layer further down. `Array.Empty` is
 * the Mod's own spelling of "this action carries no argument", which is a set and not a gap.
 */
export function readModSurface(source) {
  const text = stripComments(source);
  const problems = [];
  const actions = new Map();
  const at = text.indexOf("public static string[]? ExecutionArgumentProperties(string? action) => action switch");
  if (at < 0) return { actions, problems: ["mod_argument_properties_not_found"] };
  const end = text.indexOf("\n    };", at);
  if (end < 0) return { actions, problems: ["mod_argument_properties_unterminated"] };
  const body = text.slice(at, end);
  if (!/_\s*=>\s*null/u.test(body)) problems.push("mod_argument_properties_default_arm_unreadable");
  const arms = /((?:"[a-z0-9_]+"(?:\s+or\s+)?)+)\s*=>\s*(?:new\[\]\s*\{([^}]*)\}|Array\.Empty<string>\(\))/gu;
  for (const arm of body.matchAll(arms)) {
    const names = [...(arm[2] ?? "").matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
    for (const id of [...arm[1].matchAll(/"([a-z0-9_]+)"/gu)].map((match) => match[1])) actions.set(id, new Set(names));
  }
  if (actions.size === 0) problems.push("mod_argument_properties_empty");
  return { actions, problems };
}

/**
 * The plan grammar: which actions a script may name, and the vocabulary it derives for each.
 *
 * TWO FACTS, both declarations: the admission sets the grammar publishes (`PLAN_ACTION_LIFECYCLES`,
 * `PLAN_ARGUMENT_TYPES`) and the derivation its vocabulary comes from. The second is read as a dependency - the grammar
 * must still build each action's arguments out of `declaredArgumentsOf(registration)` - because a grammar that started
 * carrying its own copy of the names would make this gate's reading of it wrong in the one direction that matters, and a
 * blocked run is the only honest answer to that.
 */
export function readPlanGrammarSurface(source, catalog) {
  const text = stripComments(source);
  const problems = [];
  const lifecycles = frozenStringArray(text, "PLAN_ACTION_LIFECYCLES");
  const argumentTypes = frozenStringArray(text, "PLAN_ARGUMENT_TYPES");
  if (lifecycles === null || lifecycles.length === 0) problems.push("plan_grammar_lifecycles_unreadable");
  if (argumentTypes === null || argumentTypes.length === 0) problems.push("plan_grammar_argument_types_unreadable");
  const builder = functionBody(text, "planActionsFromRegistrations");
  for (const required of [
    "declaredArgumentsOf(registration)",
    "PLAN_ARGUMENT_TYPES.includes(",
    "PLAN_ACTION_LIFECYCLES.includes(",
  ])
    if (builder === null || !builder.includes(required))
      problems.push(`plan_grammar_vocabulary_not_descriptor_derived:${required}`);
  // The two filters are the WHOLE admission rule, so the loop may not skip a registration for any other reason: an extra
  // `continue` is a hand-written vocabulary this reader cannot enumerate, and the honest answer to that is blocked rather
  // than a matrix that silently stopped covering the actions it drops.
  for (const line of undeclaredSkips(builder)) problems.push(`plan_grammar_vocabulary_not_descriptor_derived:${line}`);
  const admitted = new Map();
  const omittedForLifecycle = [];
  const omittedForArgumentType = [];
  for (const [actionId, entry] of catalog.actions) {
    if (entry.kind !== "execution") continue;
    if (lifecycles === null || !lifecycles.includes(entry.lifecycle)) {
      omittedForLifecycle.push(actionId);
      continue;
    }
    if (argumentTypes === null || ![...entry.types.values()].every((type) => argumentTypes.includes(type))) {
      omittedForArgumentType.push(actionId);
      continue;
    }
    admitted.set(actionId, entry.arguments);
  }
  return { actions: admitted, problems, lifecycles, argumentTypes, omittedForLifecycle, omittedForArgumentType };
}

/**
 * The `continue` statements in `planActionsFromRegistrations` that are not one of its two declared filters.
 *
 * Line-scoped on purpose: a guard the formatter split over four lines is reported rather than guessed at, because the
 * failure this protects against is a reader believing it enumerated a vocabulary it did not.
 */
function undeclaredSkips(builder) {
  if (builder === null) return [];
  const at = builder.indexOf("for (const registration of registrations) {");
  const open = at < 0 ? -1 : builder.indexOf("{", at);
  const close = open < 0 ? -1 : balancedEnd(builder, open);
  if (close < 0) return [];
  return splitTopLevel(builder.slice(open + 1, close), "\n")
    .filter((line) => /\bcontinue;/u.test(line))
    .filter((line) => !/PLAN_ACTION_LIFECYCLES\.includes\(|PLAN_ARGUMENT_TYPES\.includes\(/u.test(line))
    .map((line) => `undeclared_skip:${line.trim()}`);
}

/**
 * The tool surface, read one layer at a time: what each mounted tool's `parameters` DECLARE, and what its `toArgs`
 * FORWARDS. They are separate because they fail separately - a declared argument the projector drops is accepted from the
 * model and thrown away, and a forwarded argument no parameter declares can never be filled.
 *
 * Mounts arrive in two shapes and both are read: an inline `parameters: Type.Object({...})`, and a schema built from the
 * descriptor (`buildCandidateToolSchema`), whose per-action arms are override constraints and whose fallback is the
 * descriptor's own argument list. The caller-identity fields are the ones `callerRequestIds` reads.
 */
export function readToolSurface(source, catalog) {
  const text = stripComments(source);
  const problems = [];
  const identity = callerIdentityFields(text);
  const arms = schemaArmKeys(text);
  const loops = loopActionIds(text);
  const describesDescriptor = (text.match(/declaredArgumentNames\(descriptor\)/gu) ?? []).length > 0;
  if (!describesDescriptor) problems.push("tool_schema_descriptor_fallback_unreadable");
  if (loops.length === 0) problems.push("tool_schema_loop_mounts_unreadable");
  const declaredByAction = new Map();
  const forwardedByAction = new Map();
  for (const mount of text.matchAll(/makeGameActionTool\(\{/gu)) {
    const open = mount.index + mount[0].length - 1;
    const close = balancedEnd(text, open);
    if (close < 0) {
      problems.push("tool_mount_unterminated");
      continue;
    }
    const block = text.slice(open + 1, close);
    const literal = /\baction:\s*"([a-z0-9_]+)"/u.exec(block)?.[1];
    const enclosing = loops.find((loop) => loop.start < mount.index && mount.index < loop.end);
    const ids = literal === undefined ? (enclosing?.ids ?? []) : [literal];
    if (ids.length === 0) {
      problems.push(`tool_mount_action_unreadable:${block.slice(0, 60).replace(/\s+/gu, " ")}`);
      continue;
    }
    const parameters = declaredToolParameters(block, arms, catalog, identity);
    const forwarded = forwardedToolArguments(block, catalog);
    for (const id of ids) {
      if (parameters === null) problems.push(`tool_schema_parameters_unreadable:${id}`);
      else if (declaredByAction.has(id)) problems.push(`tool_mounted_twice:${id}`);
      else declaredByAction.set(id, parameters);
      if (forwarded === null) problems.push(`tool_args_unreadable:${id}`);
      else forwardedByAction.set(id, forwarded);
    }
  }
  if (declaredByAction.size === 0) problems.push("tool_schema_mounts_empty");
  return { actions: declaredByAction, forwarded: forwardedByAction, problems, identity };
}

/**
 * The caller-identity fields: the names `callerRequestIds` reads off the params.
 *
 * Read from the member's BODY rather than a list written here, because the two names are a fact about the tool layer and
 * a third identity field would otherwise silently become an action argument in this matrix. The region runs to the next
 * member declaration, so a signature that annotates its return type (this one does) cannot truncate the reading at the
 * type literal's closing brace.
 */
function callerIdentityFields(text) {
  const at = text.indexOf("function callerRequestIds(");
  if (at < 0) return [];
  const next = /\n(?:function |\/\*\*|const [A-Z_]+)/u.exec(text.slice(at + 1));
  const region = text.slice(at, next === null ? text.length : at + 1 + next.index);
  return [...new Set([...region.matchAll(/record\.([A-Za-z_$][\w$]*)/gu)].map((match) => match[1]))];
}

/**
 * `for (const action of [...] as const) { ... }` -> the ids each loop body mounts, as regions.
 *
 * A mount inside a loop names its action with a variable (`action: action,`), so the id is the loop header's list - which
 * is the only place it is written down. Each entry carries the region it covers, because a mount's id must come from the
 * loop it is INSIDE rather than from the nearest one above it.
 */
function loopActionIds(text) {
  const loops = [];
  for (const loop of text.matchAll(/for \(const action of \[([^\]]*)\] as const\) \{/gu)) {
    const open = loop.index + loop[0].length - 1;
    const close = balancedEnd(text, open);
    if (close < 0) continue;
    loops.push({ start: open, end: close, ids: [...loop[1].matchAll(/"([a-z0-9_]+)"/gu)].map((match) => match[1]) });
  }
  return loops;
}

/** `buildCandidateToolSchema`'s per-action override arms: action id -> the key set its `Type.Object` returns. */
function schemaArmKeys(text) {
  const goals = new Map();
  const body = functionBody(text, "buildCandidateToolSchema");
  if (body === null) return goals;
  for (const arm of body.matchAll(/if \(([^)]*actionId === "[a-z0-9_]+"[^)]*)\) \{/gu)) {
    const open = arm.index + arm[0].length - 1;
    const close = balancedEnd(body, open);
    if (close < 0) continue;
    const block = body.slice(open + 1, close);
    const keys = lastObjectLiteralKeys(block);
    if (keys === null) continue;
    for (const id of [...arm[1].matchAll(/actionId === "([a-z0-9_]+)"/gu)].map((match) => match[1]))
      goals.set(id, new Set(keys));
  }
  return goals;
}

/** The keys of the LAST `Type.Object({...})` in a block: the value an arm returns, past any enum it built first. */
function lastObjectLiteralKeys(block) {
  let keys = null;
  for (const match of block.matchAll(/Type\.Object\(\s*\{/gu)) {
    const open = match.index + match[0].length - 1;
    const close = balancedEnd(block, open);
    if (close < 0) continue;
    keys = objectLiteralKeys(block.slice(open + 1, close));
    if (keys === null) return null;
  }
  return keys;
}

/** What one mount's `parameters` DECLARES, minus the caller-identity fields, or null when the reading is incomplete. */
function declaredToolParameters(block, arms, catalog, identity) {
  const inline = /\bparameters:\s*Type\.Object\(\s*\{/u.exec(block);
  if (inline !== null) {
    const open = inline.index + inline[0].length - 1;
    const close = balancedEnd(block, open);
    if (close < 0) return null;
    const keys = objectLiteralKeys(block.slice(open + 1, close));
    return keys === null ? null : new Set(keys.filter((name) => !identity.includes(name)));
  }
  const identifier = /\bparameters:\s*([A-Za-z_$][\w$]*)/u.exec(block);
  if (identifier === null) return null;
  const actionId = /\baction:\s*"([a-z0-9_]+)"/u.exec(block)?.[1];
  if (actionId === undefined) return null;
  if (arms.has(actionId)) return new Set([...arms.get(actionId)].filter((name) => !identity.includes(name)));
  const entry = catalog.actions.get(actionId);
  if (entry === undefined) return null;
  return new Set([...entry.arguments].filter((name) => !identity.includes(name)));
}

/** What one mount's `toArgs` FORWARDS, or null when it is not a shape this reader can enumerate. */
function forwardedToolArguments(block, catalog) {
  const at = block.indexOf("toArgs:");
  if (at < 0) return null;
  const rest = block.slice(at);
  if (/=>\s*declaredArguments\(/u.test(rest)) {
    const actionId = /\baction:\s*"([a-z0-9_]+)"/u.exec(block)?.[1];
    const entry = actionId === undefined ? undefined : catalog.actions.get(actionId);
    return entry === undefined ? null : new Set(entry.arguments);
  }
  const arrow = /=>\s*\(\s*\{/u.exec(rest);
  if (arrow === null) return null;
  const open = arrow.index + arrow[0].length - 1;
  const close = balancedEnd(rest, open);
  if (close < 0) return null;
  const keys = objectLiteralKeys(rest.slice(open + 1, close));
  return keys === null ? null : new Set(keys);
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/** What a surface's own declaration says about an action it does not carry, or null when it says nothing. */
function omissionDeclaration(surfaceId, catalogEntry, grammar) {
  if (catalogEntry.kind !== "execution") return "read_only";
  if (surfaceId !== "plan-grammar") return null;
  if (!grammar.lifecycles.includes(catalogEntry.lifecycle)) return "plan-grammar-lifecycle";
  if (![...catalogEntry.types.values()].every((type) => grammar.argumentTypes.includes(type)))
    return "plan-grammar-argument-type";
  return null;
}

/**
 * One action's row of the matrix: the surfaces that carry it, and for every argument the union names, the surfaces that
 * refuse it while another admits it.
 *
 * Returned rather than pushed into a caller's arrays, so the accumulation in `compareSurfaces` stays a loop over rows and
 * this function stays one reading per cell.
 */
function compareAction(actionId, catalogEntry, carried, grammarSurface) {
  const findings = [];
  const declared = [];
  const present = [];
  for (const surfaceId of SURFACE_IDS) {
    const actions = carried.get(surfaceId);
    if (actions.has(actionId)) {
      present.push({ surfaceId, arguments: actions.get(actionId) });
      continue;
    }
    const declaration = omissionDeclaration(surfaceId, catalogEntry, grammarSurface);
    if (declaration === null) findings.push(`${CODES.omits}:${actionId}:${surfaceId}`);
    else declared.push(declaration);
  }
  const arguments_ = [...new Set(present.flatMap((surface) => [...surface.arguments]))].sort();
  for (const argument of arguments_) {
    const admitting = present.filter((surface) => surface.arguments.has(argument));
    if (admitting.length === 0) continue;
    const admittingSurface = admitting.map((surface) => surface.surfaceId).sort()[0];
    for (const surface of present.filter((candidate) => !candidate.arguments.has(argument)))
      findings.push(`${CODES.refuses}:${actionId}:${argument}:${surface.surfaceId}:${admittingSurface}`);
  }
  return { findings, declared, pairs: arguments_.length };
}

/** The verdict, worst first: a surface this gate could not read is blocked even when other surfaces also disagree. */
function verdictOf({ findings, problems, blocks }) {
  if (blocks.length > 0 || problems.length > 0) return "blocked";
  return findings.length > 0 ? "failed" : "passed";
}

/**
 * The matrix, over the sources it is given.
 *
 * `sources` is the five files' text plus the parsed catalog, so the falsifier injects a violation into a real declaration
 * instead of rewriting the reader. `examined` is the number of actions any surface names, `pairs` is the number of
 * (action, argument) cells those actions contribute - the two numbers a zero can hide behind.
 */
export function checkActionSurfaceParity({ catalog, wire, planGrammar, toolSchema, mod }) {
  const problems = [];
  const blocks = [];
  const catalogSurface = readCatalogSurface(catalog);
  const wireSurface = readWireSurface(wire ?? "");
  const modSurface = readModSurface(mod ?? "");
  const grammarSurface = readPlanGrammarSurface(planGrammar ?? "", catalogSurface);
  const toolSurface = readToolSurface(toolSchema ?? "", catalogSurface);
  for (const [id, surface] of [
    ["catalog", catalogSurface],
    ["wire", wireSurface],
    ["mod", modSurface],
    ["plan-grammar", grammarSurface],
    ["tool-schema", toolSurface],
    ["tool-args", { actions: toolSurface.forwarded, problems: [] }],
  ]) {
    problems.push(...surface.problems.map((problem) => (problem.includes(":") ? problem : `${problem}:${id}`)));
  }
  const carried = new Map([
    ["catalog", new Map([...catalogSurface.actions].map(([actionId, entry]) => [actionId, entry.arguments]))],
    ["mod", modSurface.actions],
    ["plan-grammar", grammarSurface.actions],
    ["tool-args", toolSurface.forwarded],
    ["tool-schema", toolSurface.actions],
    ["wire", wireSurface.actions],
  ]);
  const populations = Object.fromEntries(SURFACE_IDS.map((id) => [id, carried.get(id).size]));
  for (const id of SURFACE_IDS) if (carried.get(id).size === 0) blocks.push(`action_surface_population_empty:${id}`);

  const actionIds = [...new Set([...carried.values()].flatMap((actions) => [...actions.keys()]))].sort();
  if (actionIds.length === 0) blocks.push("action_surface_population_empty");
  for (const [surfaceId, actions] of carried)
    for (const actionId of actions.keys())
      if (!catalogSurface.actions.has(actionId)) blocks.push(`action_not_in_catalog:${actionId}:${surfaceId}`);

  const findings = [];
  const declarations = new Map();
  let pairs = 0;
  for (const actionId of actionIds) {
    const catalogEntry = catalogSurface.actions.get(actionId);
    if (catalogEntry === undefined) continue;
    const row = compareAction(actionId, catalogEntry, carried, grammarSurface);
    findings.push(...row.findings);
    pairs += row.pairs;
    for (const declaration of row.declared) declarations.set(declaration, (declarations.get(declaration) ?? 0) + 1);
  }
  findings.sort();
  return Object.freeze({
    status: verdictOf({ findings, problems, blocks }),
    examined: actionIds.length,
    surfaces: SURFACE_IDS.length,
    pairs,
    populations,
    declarations: Object.fromEntries(declarations),
    grammar: {
      lifecycles: grammarSurface.lifecycles,
      argumentTypes: grammarSurface.argumentTypes,
      omittedForLifecycle: grammarSurface.omittedForLifecycle,
      omittedForArgumentType: grammarSurface.omittedForArgumentType,
    },
    findings,
    blocked: [...problems, ...blocks],
  });
}

/** Read one checkout's five authorities and run the matrix over them. */
export function readActionSurfaceParity({ root = REPOSITORY_ROOT } = {}) {
  const sources = {};
  const blocked = [];
  for (const [key, path] of [
    ["wire", PATHS.wire],
    ["planGrammar", PATHS.planGrammar],
    ["toolSchema", PATHS.toolSchema],
    ["mod", PATHS.mod],
  ]) {
    try {
      sources[key] = readFileSync(resolve(root, path), "utf8");
    } catch {
      blocked.push(`action_surface_source_missing:${path}`);
      sources[key] = "";
    }
  }
  try {
    sources.catalog = JSON.parse(readFileSync(resolve(root, PATHS.catalog), "utf8"));
  } catch {
    blocked.push(`action_surface_source_missing:${PATHS.catalog}`);
    sources.catalog = { actions: null };
  }
  const report = checkActionSurfaceParity(sources);
  return {
    ...report,
    blocked: [...blocked, ...report.blocked],
    status: blocked.length > 0 ? "blocked" : report.status,
  };
}

/** Every authority's population, then the declarations the lifecycle rule used, as the lines a reader reconciles. */
export function describeReport(report) {
  const lines = [
    `actions examined ${report.examined} · surfaces ${report.surfaces} · pairs checked ${report.pairs}`,
    `population per authority: ${SURFACE_IDS.map((id) => `${id} ${report.populations[id]}`).join(" · ")}`,
    `omission declarations: ${
      Object.keys(report.declarations).length === 0
        ? "none used"
        : Object.entries(report.declarations)
            .map(([name, count]) => `${name} ${count}`)
            .join(" · ")
    }`,
    `plan grammar admission: lifecycles ${report.grammar.lifecycles.join("/")} (omits ${
      report.grammar.omittedForLifecycle.length
    }) · argument types ${report.grammar.argumentTypes.join("/")} (omits ${report.grammar.omittedForArgumentType.length})`,
  ];
  for (const entry of report.blocked) lines.push(`blocked: ${entry}`);
  for (const entry of report.findings) lines.push(entry);
  lines.push(`action surface parity ${report.status}`);
  return lines;
}

function main() {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex < 0 ? REPOSITORY_ROOT : resolve(process.argv[rootIndex + 1] ?? REPOSITORY_ROOT);
  const report = readActionSurfaceParity({ root });
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ gate: "action_surface_parity/v1", ...report }, null, 2)}\n`);
  } else {
    for (const line of describeReport(report)) process.stdout.write(`${line}\n`);
  }
  process.exitCode = EXIT[report.status];
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href
)
  main();
