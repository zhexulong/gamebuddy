/**
 * A prompt that names a tool the Agent cannot call is a lie in the product's own voice.
 *
 * The measured defect: `identity-profile.ts` told the companion its body language
 * goes through `express_emote` / `face_direction` - the Mod's own action ids -
 * while every Agent-visible tool carried the `stardew_` prefix
 * (`STARDEW_ACTION_TOOL_NAMES`, action-registry.ts). A companion that follows that
 * instruction calls nothing, so the gesture never happens, and the test that pinned
 * the name was pinning the falsehood. One lane repaired those two names and made
 * *its own* test read `STARDEW_ACTION_TOOL_NAMES`; the rule itself was still unheld,
 * so the next prompt that names a tool could name it wrongly again - and the rule
 * now has a second registration: `game-tools.ts`'s own descriptions sent the Agent
 * after `clear_debris`, `answer_dialogue`, `deposit_silo_hay` and eleven more ids
 * that are not mounted names either.
 *
 * That repair was measured wrong one revision later (c1214b97, 2026-11-12): the live
 * Game materializer declares `planActionSurface`, and `runtime-core.internal.ts` then
 * drops every tool the adapter publishes as an action - so `stardew_express_emote` is
 * a name the Agent is never handed either. Body language is a step in the plan that
 * `stardew_plan_work` submits, c1214b97 rewrote the conduct to say exactly that, and
 * the ids came back unprefixed because that is what the plan builder takes. This arm
 * read them as the original defect and reported the corrected sentence, which is what
 * makes the mounted set - not the registry's own values - its authority.
 *
 * This gate holds the rule for every piece of prompt text the Agent reads, in both
 * directions:
 *
 *   1. every `stardew_*` token must be a name a Game session actually MOUNTS, so a renamed,
 *      misspelled, invented or dropped tool name is a finding. The authority is the mounted
 *      set, not the Host's declarations: `stardew_express_emote` is declared by the module
 *      that builds the flat per-action tools and a plan surface hands it over to nobody - the
 *      sentence that named it cost a run 68 tool calls and not one emote;
 *   2. a bare registry action id (`express_emote`, `advance_day`) is a finding unless
 *      the SAME LINE names the mounted tool that carries it: the per-action tool
 *      `stardew_<id>` when that name is mounted, or `stardew_plan_work` when the id is
 *      in the plan builder's own vocabulary. A line that names neither leaves the id
 *      standing there as if it were a tool, which is the original defect; a line that
 *      names the plan builder is the route a plan surface actually mounts.
 *
 * That exemption is a STRUCTURAL APPROXIMATION of the sentence, not a reading of it, and
 * arm 1 is one too: neither can tell DESCRIPTION from INSTRUCTION. Arm 2 asks whether the
 * line names a carrier, so it cannot tell "names the carrier while describing the
 * vocabulary" ("express_emote raises an overhead emote balloon", beside
 * `stardew_plan_work`) from "names the carrier while telling her to call the bare id" - and
 * a line that names the carrier AND an unmounted `stardew_<id>` is arm 1's, not arm 2's, so
 * it is reported by name there. What arm 2 does check is that the carrier exists, not
 * that a string matched: an id whose `stardew_<id>` is unmounted, on a line that names that
 * unmounted name, is a finding, and so is an id the plan builder does not admit even when
 * its line names `stardew_plan_work` (both are fixtures in `prompt-tool.4`).
 *
 * Both directions are enumerated from the authorities - the registry's keys and values,
 * the mounted Game set, the plan builder's vocabulary derived from the Mod's emitted
 * surface, and every `name:` a Host module declares - so a tool added, renamed or
 * removed tomorrow is covered by today's rule. Findings are located by reading the
 * source, never by a line number written here.
 *
 * What "prompt text" means here, and how each source is obtained without reading
 * comments or code:
 *  - the two companion system prompts come from their real builders
 *    (`buildChatCompanionSystemPrompt` / `buildGameCompanionSystemPrompt`) - the
 *    chat prompt and the companion-play conduct text. What is scanned is the text
 *    the model is handed, not a literal near it. The module's own comments discuss
 *    the unprefixed ids by name (they explain why they are there) and comments are
 *    not literals, so no comment is a finding;
 *  - `gameplay-task-subagent.ts` contributes the string literals of its
 *    `systemPrompt` array - its private worker prompt;
 *  - `game-tools.ts` contributes the `description` and `label` of the tools a Game session
 *    MOUNTS, and of no other tool: a flat per-action tool's description travels with that
 *    tool, so a plan surface hands neither over and scanning it would report text nobody
 *    was given. The declaration's own `name:` decides which side it lands on (resolved
 *    through the registry for a `STARDEW_ACTION_TOOL_NAMES.*` projection), the excluded
 *    side is printed as a count, and a declaration whose name is computed is reported
 *    rather than sorted;
 *  - `stardew-action-remedy.ts` contributes the `guidance` sentences appended to a refusal
 *    the Agent reads. Its `action` field is a binding carried in the tool result's
 *    `details`, not text the model reads, so `stardew-action-remedy.test.ts` holds that
 *    field - and every route a sentence names - against the mounted set and the plan
 *    vocabulary.
 *
 * Both arms iterate the ONE list `promptTextSources()` returns, and that list is
 * exactly those sources - so no source can be strict under one arm and blind under
 * the other, and each finding names the file and line it was found on.
 *
 * What this cannot express honestly, and therefore does not claim: a name revoked in the
 * game at runtime is a policy fact, not a prompt fact - the mounted set is a recording, so
 * the gate reads the surface a session was measured with, not the one in front of a
 * particular player. Arm 1 also reads `name:` declarations only to decide which tool owns
 * a description; nothing here judges what a sentence MEANS.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { planActionsFromRegistrations } from "../../host/src/body-program-script.ts";
import { buildGameCompanionSystemPrompt } from "../../host/src/game-surface-prompt-floor.ts";
import {
  ADVERTISED,
  MOUNTED_GAME_SURFACE_TOOL_NAMES,
} from "../../host/src/game-surface-prompt-floor.test-support.ts";
import {
  DEFAULT_IDENTITY_PROFILE,
  buildChatCompanionSystemPrompt,
} from "../../host/src/identity-profile.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOST = join(REPO, "host", "src");
const ACTION_REGISTRY = join(HOST, "action-registry.ts");

/** A token the Agent would read as a tool name. */
const TOOL_TOKEN = /stardew_[a-z0-9_]+/gu;

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function sourceOf(file) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** A host-relative path, for a finding a reader can open. */
function hostPath(file) {
  return file.replace(/\\/gu, "/").split("/host/").pop().replace(/^/, "host/");
}

/**
 * The registry projection, read from its own declaration: `STARDEW_ACTION_TOOL_NAMES`
 * is `{ <mod action id>: "<mounted tool name>" }`, so its keys are the ids and its
 * values the callable names. Read through the TypeScript parser rather than by
 * importing the module, so the gate measures the declaration.
 */
export function registryProjection(file = ACTION_REGISTRY) {
  const sourceFile = sourceOf(file);
  let found = null;
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== "STARDEW_ACTION_TOOL_NAMES")
      return;
    let initializer = node.initializer;
    while (
      ts.isSatisfiesExpression(initializer) ||
      ts.isAsExpression(initializer) ||
      ts.isParenthesizedExpression(initializer)
    )
      initializer = initializer.expression;
    if (!ts.isObjectLiteralExpression(initializer)) return;
    const ids = [];
    const names = [];
    for (const property of initializer.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)) continue;
      ids.push(property.name.getText(sourceFile));
      names.push(property.initializer.text);
    }
    found = { ids, names };
  });
  if (found === null || found.names.length === 0)
    throw new Error(`could not read STARDEW_ACTION_TOOL_NAMES from ${file}`);
  return found;
}

/**
 * The prompt text of one property assignment, as ONE entry at the line it begins on.
 *
 * A concatenation and a template literal with substitutions are each one message: the model reads the
 * joined string, so the pieces are joined before either arm looks at them. Splitting them would judge
 * half a sentence - "submit 'dismiss_modal'" in the fragment that follows the one naming the tool that
 * carries it - and report a route the sentence does state.
 */
function textOf(property, sourceFile, file) {
  const parts = [];
  const record = (literal) => {
    if (ts.isTemplateExpression(literal)) {
      parts.push(literal.head.text);
      for (const span of literal.templateSpans) parts.push(span.literal.text);
      return;
    }
    parts.push(literal.text);
  };
  const candidate = property.initializer;
  if (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate) || ts.isTemplateExpression(candidate)) {
    record(candidate);
  } else {
    walk(candidate, (inner) => {
      if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) || ts.isTemplateExpression(inner))
        record(inner);
    });
  }
  if (parts.length === 0) return null;
  const { line } = sourceFile.getLineAndCharacterOfPosition(property.initializer.getStart(sourceFile));
  return { file: hostPath(file), line: line + 1, text: parts.join("") };
}

/** One named property's prompt text, at the line it begins on. */
export function literalEntries(file, propertyName) {
  const sourceFile = sourceOf(file);
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isPropertyAssignment(node) || !ts.isIdentifier(node.name) || node.name.text !== propertyName) return;
    const entry = textOf(node, sourceFile, file);
    if (entry !== null) found.push(entry);
  });
  return found;
}

/**
 * The tool name one object literal declares, or `null` when the literal declares no name at all.
 *
 * `unresolved` means the name is computed (a loop variable, a helper's parameter), so the gate cannot
 * tell whether that tool is handed to the Agent - a population it cannot read is reported, not
 * assumed either way. A `STARDEW_ACTION_TOOL_NAMES.*` projection resolves through the registry, which
 * is how every flat per-action tool declares itself.
 */
function declaredToolName(objectLiteral, sourceFile, nameOfId) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== "name") continue;
    const value = property.initializer;
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return { name: value.text };
    if (ts.isPropertyAccessExpression(value) && value.expression.getText(sourceFile) === "STARDEW_ACTION_TOOL_NAMES")
      return { name: nameOfId.get(value.name.text) ?? null };
    return { unresolved: value.getText(sourceFile) };
  }
  return null;
}

/**
 * The `description` and `label` text of the tools a Game session MOUNTS, read from the file that
 * builds them.
 *
 * A flat per-action tool's description is text the model reads only while that tool is in the
 * request, and `planActionSurface` drops every one of them - so scanning those descriptions is the
 * same error as reading a name the product stopped using: it reports text nobody was ever handed.
 * The declaration's own name decides it, and the two sets it is separated into are returned so the
 * gate can print what it examined instead of only what it found.
 */
export function mountedToolTexts(file, mounted = mountedGameToolNames()) {
  const sourceFile = sourceOf(file);
  const projection = registryProjection();
  const nameOfId = new Map(projection.ids.map((id, index) => [id, projection.names[index]]));
  const entries = [];
  const dropped = [];
  const unresolved = [];
  walk(sourceFile, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const declaration = declaredToolName(node, sourceFile, nameOfId);
    if (declaration === null) return;
    const texts = [];
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
      if (property.name.text !== "description" && property.name.text !== "label") continue;
      const entry = textOf(property, sourceFile, file);
      if (entry !== null) texts.push(entry);
    }
    if (declaration.unresolved !== undefined) {
      unresolved.push({ name: declaration.unresolved, texts });
      return;
    }
    if (declaration.name !== null && mounted.has(declaration.name)) entries.push(...texts);
    else dropped.push({ name: declaration.name, texts });
  });
  return { entries, dropped, unresolved };
}

/**
 * Every piece of prompt text the Agent is HANDED on the mounted Game surface, plus the two
 * populations the gate excluded so it can print them.
 *
 * What is not here, and why: a tool declaration whose name is not mounted contributes nothing,
 * because its description travels with the tool (`mountedToolTexts`), and the remedy's `action`
 * field is a binding carried in a tool result's `details`, not text the model reads -
 * `stardew-action-remedy.test.ts` holds that field against the same two authorities.
 */
export function promptTextReading(mounted = mountedGameToolNames()) {
  const subagent = join(HOST, "gameplay-task-subagent.ts");
  const tools = join(HOST, "game-tools.ts");
  const remedy = join(HOST, "stardew-action-remedy.ts");
  const toolTexts = mountedToolTexts(tools, mounted);
  return {
    entries: [
      {
        file: "host/src/identity-profile.ts",
        line: null,
        text: buildChatCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE),
      },
      {
        file: "host/src/identity-profile.ts",
        line: null,
        text: buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE),
      },
      ...literalEntries(subagent, "systemPrompt"),
      ...toolTexts.entries,
      ...literalEntries(remedy, "guidance"),
    ],
    droppedToolTexts: toolTexts.dropped,
    unresolvedToolNames: toolTexts.unresolved,
  };
}

/** The prompt texts the Agent reads, each located where it lives. */
export function promptTextSources(mounted = mountedGameToolNames()) {
  return promptTextReading(mounted).entries;
}

/** Where a prompt entry lives, as `file:line` when it is a literal. */
export function at(entry, offset = 0) {
  if (entry.line === null) return entry.file;
  const moved = entry.text.slice(0, offset).split("\n").length - 1;
  return `${entry.file}:${entry.line + moved}`;
}

/** Non-test production modules under host/src. */
export function hostProductionModules(directory = HOST) {
  const out = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (["test-fixtures", "test-support", "node_modules"].includes(name)) continue;
      out.push(...hostProductionModules(path));
      continue;
    }
    if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
    if (name.includes(".test.") || name.includes(".test-support")) continue;
    out.push(path);
  }
  return out;
}

/**
 * Every tool name the Host declares, plus the registry's own projection: the
 * `name: "stardew_..."` property literals of every production module and the
 * values of `STARDEW_ACTION_TOOL_NAMES`. This is the authority a prompt name
 * resolves against; it is derived, so no list here can go stale.
 */
export function declaredToolNames(modules = hostProductionModules()) {
  const names = new Set(registryProjection().names);
  for (const file of modules) {
    walk(sourceOf(file), (node) => {
      if (!ts.isPropertyAssignment(node) || !ts.isIdentifier(node.name) || node.name.text !== "name") return;
      if (ts.isStringLiteral(node.initializer) && node.initializer.text.startsWith("stardew_")) names.add(node.initializer.text);
    });
  }
  return names;
}

/** The registry's Mod-side ids: what the Agent must never be told to call. */
export function registryActionIds() {
  return registryProjection().ids;
}

/** `stardew_*` tokens in one prompt text that the mounted Game surface does not hand the Agent. */
export function unresolvedToolNames(text, authority = mountedGameToolNames()) {
  return [...text.matchAll(TOOL_TOKEN)].map((match) => match[0]).filter((name) => !authority.has(name));
}

/**
 * Registry action ids that appear as a bare word in one prompt text. The
 * lookbehind and lookahead keep a correctly prefixed mention
 * (`stardew_express_emote`) and a longer identifier (`express_emote_count`) from
 * being reported.
 */
export function bareActionIds(text, ids = registryActionIds()) {
  return ids.filter((id) => new RegExp(`(?<![A-Za-z0-9_])${id}(?![A-Za-z0-9_])`, "u").test(text));
}

/**
 * A tool name in prompt text that a Game session does not mount, as a finding.
 *
 * The authority is the MOUNTED set, not the declared names: `stardew_express_emote` is declared by
 * the module that builds the flat tools and a plan surface never hands it over, which is the defect
 * that cost a run 68 tool calls. Naming the plan carrier on the same line does not bless a name that
 * does not exist - the legal case is the bare id inside that carrier's vocabulary, which is arm 2.
 */
export function unresolvedFindings(entries = promptTextSources(), authority = mountedGameToolNames()) {
  const findings = [];
  for (const entry of entries)
    for (const match of entry.text.matchAll(TOOL_TOKEN))
      if (!authority.has(match[0]))
        findings.push(`prompt_names_unmounted_tool:${match[0]}:${at(entry, match.index)}`);
  return findings;
}

/**
 * The tool names a live Game session mounts, read from the recorded materialized
 * session's own `agent.state.tools` (held fresh by `game-surface-prompt-floor.test.ts`).
 * Not `STARDEW_ACTION_TOOL_NAMES`: a plan surface drops every tool the adapter
 * publishes as an action, so that projection is a list the Agent is never handed.
 */
export function mountedGameToolNames() {
  return new Set(MOUNTED_GAME_SURFACE_TOOL_NAMES);
}

/**
 * The tool whose description carries the plan vocabulary. Named here because the
 * prompt must name it at the id; `prompt-tool.2` refuses to pass if the mounted set
 * does not contain it, so a surface that stopped mounting the plan builder fails by
 * that name instead of silently reporting every plan step as a bare id.
 */
const PLAN_BUILDER_TOOL = "stardew_plan_work";

/**
 * The action ids the plan builder admits, through the product's own plan admission
 * over the Mod's emitted surface. The registry also carries ids the plan form does
 * not admit, and those have no route at all on a plan surface.
 */
export function planBuilderVocabulary() {
  return new Set(planActionsFromRegistrations(ADVERTISED).map((action) => action.actionId));
}

/**
 * One bare action id on one line, as a finding unless the line names the mounted
 * tool that carries it. Returns null when the line establishes the route.
 */
function bareActionFinding(actionId, line, mounted, vocabulary) {
  const registry = registryProjection();
  const perActionTool = registry.names[registry.ids.indexOf(actionId)];
  if (mounted.has(perActionTool))
    return `prompt names the Mod action id ${actionId}; the mounted tool is ${perActionTool}`;
  if (!mounted.has(PLAN_BUILDER_TOOL))
    return `prompt names the Mod action id ${actionId}, and ${PLAN_BUILDER_TOOL} is not mounted, so no tool carries that id`;
  if (!vocabulary.has(actionId))
    return `prompt names the Mod action id ${actionId}, which no mounted tool carries: ${PLAN_BUILDER_TOOL} admits no such step`;
  if (!line.includes(PLAN_BUILDER_TOOL))
    return `prompt names the Mod action id ${actionId} on a line that does not name ${PLAN_BUILDER_TOOL}, so the Agent goes looking for a tool by that name`;
  return null;
}

/** A bare action id that the line it appears on gives no mounted route to, as a finding. */
export function bareActionFindings(entries = promptTextSources(), mounted = mountedGameToolNames()) {
  const vocabulary = planBuilderVocabulary();
  const registry = registryProjection();
  const findings = [];
  for (const entry of entries) {
    let offset = 0;
    for (const line of entry.text.split("\n")) {
      for (const actionId of bareActionIds(line, registry.ids)) {
        const finding = bareActionFinding(actionId, line, mounted, vocabulary);
        if (finding !== null) findings.push(`${at(entry, offset)}: ${finding}`);
      }
      offset += line.length + 1;
    }
  }
  return findings;
}

test("prompt-tool.1: every tool name the Agent is handed is one a Game session mounts", (t) => {
  const mounted = mountedGameToolNames();
  assert.ok(
    mounted.size > 0,
    "blocked: the recorded mounted Game tool set is empty, so every name would pass for the wrong reason",
  );
  const reading = promptTextReading(mounted);
  const named = reading.entries.reduce((total, entry) => total + [...entry.text.matchAll(TOOL_TOKEN)].length, 0);
  // A tool whose name is computed cannot be placed on either side of the mounted question, so a
  // declaration the gate cannot read is reported instead of silently joining one population.
  const unreadable = reading.unresolvedToolNames
    .filter((declaration) => declaration.texts.some((text) => /stardew_[a-z0-9_]+/u.test(text.text)))
    .map((declaration) => `prompt_text_population_unresolved:${declaration.name}`);
  t.diagnostic(
    `prompt-tool.1: ${reading.entries.length} prompt text(s) examined · ${mounted.size} mounted · ${reading.droppedToolTexts.length} dropped for an unmounted tool · ${named} tool mention(s); ${unreadable.length} unreadable declaration(s)`,
  );
  assert.deepEqual(unreadable, [], "a tool declaration whose name cannot be resolved is a population this gate cannot read");
  assert.ok(named > 0, "a scan that finds no tool mention at all must not read as a pass");
  assert.deepEqual(
    unresolvedFindings(reading.entries, mounted),
    [],
    "a prompt naming a tool no Game session mounts sends the instruction nowhere",
  );
});

test("prompt-tool.2: a bare Mod action id is a finding unless its line names the mounted tool that carries it", (t) => {
  const mounted = mountedGameToolNames();
  assert.ok(mounted.size > 0, "blocked: the recorded mounted Game tool set is empty, so every bare id would pass");
  assert.ok(
    mounted.has(PLAN_BUILDER_TOOL),
    `blocked: ${PLAN_BUILDER_TOOL} is not in the mounted set, so no bare action id has a route and this arm reads the wrong surface`,
  );
  const vocabulary = planBuilderVocabulary();
  assert.ok(
    vocabulary.size > 0,
    `blocked: ${PLAN_BUILDER_TOOL} admits no action, so a plan-step id could never be carried`,
  );
  const failures = bareActionFindings();
  t.diagnostic(
    `prompt-tool.2: ${registryActionIds().length} registry action id(s) held against ${mounted.size} mounted name(s) and ${vocabulary.size} plan-builder method(s); ${failures.length} bare`,
  );
  assert.deepEqual(failures, [], "a bare action id the line gives no mounted route to sends the instruction nowhere");
});

test("prompt-tool.3: the registry's keys and values are declared, and only its values are callable names", (t) => {
  const authority = declaredToolNames();
  const registry = registryProjection().names;
  assert.ok(registry.length > 0, "the registry projection must be readable from action-registry.ts");
  assert.ok(
    registry.every((name) => name.startsWith("stardew_")),
    "every registry value must be a mounted tool name, not an action id",
  );
  assert.ok(
    registry.every((name) => authority.has(name)),
    "every registry value must be a declared tool name",
  );
  assert.ok(
    registryProjection().ids.every((id) => !authority.has(id)),
    "a Mod action id must not also be a declared tool name, or the two directions would agree on the wrong name",
  );
  t.diagnostic(
    `prompt-tool.3: ${registry.length} per-action name(s) read from STARDEW_ACTION_TOOL_NAMES; ${registry.slice(0, 3).join(", ")}, ...`,
  );
});

test("prompt-tool.4 (mutation): a renamed tool, an unmounted name, a bare id, a plan step and an unadmitted id each read as their own shape", (t) => {
  const mounted = mountedGameToolNames();
  const notAdmitted = registryActionIds().find((actionId) => !planBuilderVocabulary().has(actionId));
  assert.ok(notAdmitted !== undefined, `blocked: no registry id is outside ${PLAN_BUILDER_TOOL}'s vocabulary, so an unadmitted step cannot be planted`);
  const planted = {
    renamed: {
      file: "host/src/planted-prompt.ts",
      line: 12,
      text: "Show a feeling through the game: use stardew_express_emotions.",
    },
    // The sentence that shipped and cost a run its body language: both names are declared by the
    // module that builds the flat tools, and a plan surface hands neither over.
    unmountedNames: {
      file: "host/src/planted-prompt.ts",
      line: 15,
      text: "Body language goes through the native actions stardew_express_emote and stardew_face_direction.",
    },
    bareAlone: { file: "host/src/planted-prompt.ts", line: 18, text: "Show a feeling with express_emote." },
    planStep: {
      file: "host/src/planted-prompt.ts",
      line: 24,
      text: "Body language is an action in the plan you submit with stardew_plan_work: express_emote raises an overhead emote balloon.",
    },
    unmountedNameBesideTheCarrier: {
      file: "host/src/planted-prompt.ts",
      line: 30,
      text: "Use stardew_express_emote, or submit it in the plan with stardew_plan_work: express_emote.",
    },
    unadmittedBesideTheCarrier: {
      file: "host/src/planted-prompt.ts",
      line: 36,
      text: `Body language is an action in the plan you submit with stardew_plan_work: ${notAdmitted} raises something.`,
    },
    mountedNames: {
      file: "host/src/planted-prompt.ts",
      line: 42,
      text: "The mounted names are stardew_plan_work and stardew_observe.",
    },
  };
  assert.deepEqual(unresolvedFindings([planted.renamed], mounted), [
    "prompt_names_unmounted_tool:stardew_express_emotions:host/src/planted-prompt.ts:12",
  ]);
  assert.deepEqual(unresolvedFindings([planted.unmountedNames], mounted), [
    "prompt_names_unmounted_tool:stardew_express_emote:host/src/planted-prompt.ts:15",
    "prompt_names_unmounted_tool:stardew_face_direction:host/src/planted-prompt.ts:15",
  ]);
  assert.deepEqual(
    unresolvedFindings([planted.unmountedNameBesideTheCarrier], mounted),
    ["prompt_names_unmounted_tool:stardew_express_emote:host/src/planted-prompt.ts:30"],
    "naming the carrier does not bless a name the surface does not hand over",
  );
  assert.deepEqual(
    bareActionFindings([planted.unmountedNameBesideTheCarrier], mounted),
    [],
    "the bare id IS reachable there, so only the unmounted name is a finding",
  );
  assert.deepEqual(bareActionFindings([planted.bareAlone], mounted), [
    "host/src/planted-prompt.ts:18: prompt names the Mod action id express_emote on a line that does not name stardew_plan_work, so the Agent goes looking for a tool by that name",
  ]);
  assert.deepEqual(
    bareActionFindings([planted.planStep], mounted),
    [],
    "the shipped shape - the id beside the plan tool that carries it - is clean",
  );
  assert.deepEqual(unresolvedFindings([planted.planStep], mounted), [], "the plan tool is mounted, so the line is clean");
  assert.deepEqual(bareActionFindings([planted.unadmittedBesideTheCarrier], mounted), [
    `host/src/planted-prompt.ts:36: prompt names the Mod action id ${notAdmitted}, which no mounted tool carries: ${PLAN_BUILDER_TOOL} admits no such step`,
  ]);
  assert.deepEqual(
    bareActionFindings([planted.bareAlone], new Set(["stardew_express_emote"])),
    ["host/src/planted-prompt.ts:18: prompt names the Mod action id express_emote; the mounted tool is stardew_express_emote"],
    "where the flat tool is mounted, the prefixed name is the only callable spelling",
  );
  assert.deepEqual(unresolvedFindings([planted.bareAlone], new Set(["stardew_express_emote"])), [], "no name is named there");
  assert.deepEqual(unresolvedFindings([planted.mountedNames], mounted), [], "a mounted name is clean");
  assert.deepEqual(bareActionFindings([planted.mountedNames], mounted), [], "a mounted name carries no bare id");
  t.diagnostic(
    "prompt-tool.4: the planted rename, the unmounted name, the bare id, the plan step and the unadmitted id each read as their own shape",
  );
});
