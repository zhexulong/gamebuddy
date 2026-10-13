/**
 * A prompt that names a tool the Agent cannot call is a lie in the product's own voice.
 *
 * The measured defect: `identity-profile.ts` told the companion its body language
 * goes through `express_emote` / `face_direction` - the Mod's own action ids -
 * while every Agent-visible tool carries the `stardew_` prefix
 * (`STARDEW_ACTION_TOOL_NAMES`, action-registry.ts, a closed projection of all 89
 * mounted actions). A companion that follows that instruction calls nothing, so
 * the gesture never happens, and the test that pinned the name was pinning the
 * falsehood. One lane repaired those two names and made *its own* test read
 * `STARDEW_ACTION_TOOL_NAMES`; the rule itself was still unheld, so the next
 * prompt that names a tool could name it wrongly again - and the rule now has a
 * second registration: `game-tools.ts`'s own descriptions send the Agent after
 * `clear_debris`, `answer_dialogue`, `deposit_silo_hay` and eleven more ids that
 * are not mounted names either.
 *
 * This gate holds the rule for every piece of prompt text the Agent reads, in
 * both directions:
 *
 *   1. every `stardew_*` token must be a name some production module actually
 *      declares as a tool (`name: "stardew_..."`), so a renamed, misspelled or
 *      invented tool name is a finding;
 *   2. no registry action id may appear as a *bare word*. The registry's keys are
 *      the Mod's ids (`express_emote`), its values the callable names
 *      (`stardew_express_emote`); a prompt naming the key sends the Agent after a
 *      tool that does not exist. This is the arm that would have caught the
 *      original defect instead of pinning it, and it is the arm that finds the
 *      fourteen live mentions above.
 *
 * Both directions are enumerated from the authorities - the registry's keys and
 * values, and every `name:` a Host module declares - so a tool added, renamed or
 * removed tomorrow is covered by today's rule. No tool-name list and no line
 * number lives in this file; findings are located by reading the source.
 *
 * What "prompt text" means here, and how each source is obtained without reading
 * comments or code:
 *  - the two companion system prompts come from their real builders
 *    (`buildChatCompanionSystemPrompt` / `buildGameCompanionSystemPrompt`) - the
 *    chat prompt and the companion-play conduct text. What is scanned is the text
 *    the model is handed, not a literal near it. The module's own comments discuss
 *    the unprefixed ids by name (they explain why they are wrong) and comments are
 *    not literals, so no comment is a finding;
 *  - `gameplay-task-subagent.ts` contributes the string literals of its
 *    `systemPrompt` array - its private worker prompt;
 *  - `game-tools.ts` contributes its tool `description` and `label` literals, the
 *    text a model reads, and never its `action:` / `name:` fields, which are
 *    code-level bindings to those same ids;
 *  - `stardew-action-remedy.ts` contributes the `guidance` sentences and the
 *    `action` names it tells the Agent to call when an action is refused.
 *
 * Both arms iterate the ONE list `promptTextSources()` returns, and that list is
 * exactly those sources - so no source can be strict under one arm and blind under
 * the other, and each finding names the file and line it was found on.
 *
 * What this cannot express honestly, and therefore does not claim: it resolves
 * names against the *Host's* declarations, not against a live Mod capability
 * snapshot, so a prompt naming a tool that is declared in a production module but
 * revoked in game is clean here - that is a policy or runtime fact, not a prompt
 * fact. It also reads `name:` declarations under host/src only.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  DEFAULT_IDENTITY_PROFILE,
  buildChatCompanionSystemPrompt,
  buildGameCompanionSystemPrompt,
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

/** One named property's prompt text chunks, at the line each begins on. */
export function literalEntries(file, propertyName) {
  const sourceFile = sourceOf(file);
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isPropertyAssignment(node) || !ts.isIdentifier(node.name) || node.name.text !== propertyName) return;
    const record = (literal) => {
      // A template literal with substitutions is one message: its literal chunks
      // are the text the model reads, so the text is scanned whole and a finding
      // is located by walking forward from where it begins.
      const text = ts.isTemplateExpression(literal)
        ? [literal.head.text, ...literal.templateSpans.map((span) => span.literal.text)].join("")
        : literal.text;
      const { line } = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile));
      found.push({ file: hostPath(file), line: line + 1, text });
    };
    const candidate = node.initializer;
    if (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate) || ts.isTemplateExpression(candidate)) {
      record(candidate);
      return;
    }
    walk(candidate, (inner) => {
      if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) || ts.isTemplateExpression(inner))
        record(inner);
    });
  });
  return found;
}

/** The prompt texts the Agent reads, each located where it lives. */
export function promptTextSources() {
  const subagent = join(HOST, "gameplay-task-subagent.ts");
  const tools = join(HOST, "game-tools.ts");
  const remedy = join(HOST, "stardew-action-remedy.ts");
  return [
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
    ...literalEntries(tools, "description"),
    ...literalEntries(tools, "label"),
    ...literalEntries(remedy, "guidance"),
    ...literalEntries(remedy, "action"),
  ];
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

/** `stardew_*` tokens in one prompt text that no production module declares. */
export function unresolvedToolNames(text, authority = declaredToolNames()) {
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

/** A tool name in prompt text that no Host module declares, as a finding. */
export function unresolvedFindings(entries = promptTextSources(), authority = declaredToolNames()) {
  const findings = [];
  for (const entry of entries)
    for (const match of entry.text.matchAll(TOOL_TOKEN))
      if (!authority.has(match[0]))
        findings.push(`${at(entry, match.index)}: prompt names ${match[0]}, which no Host module declares as a tool`);
  return findings;
}

/** A Mod action id used where the mounted name belongs, as a finding. */
export function bareActionFindings(entries = promptTextSources(), ids = registryActionIds()) {
  const findings = [];
  for (const entry of entries)
    for (const id of ids) {
      const match = new RegExp(`(?<![A-Za-z0-9_])${id}(?![A-Za-z0-9_])`, "u").exec(entry.text);
      if (match !== null)
        findings.push(`${at(entry, match.index)}: prompt names the Mod action id ${id}; the mounted tool is stardew_${id}`);
    }
  return findings;
}

test("prompt-tool.1: every tool name in prompt text resolves in the Host's own declarations", (t) => {
  const authority = declaredToolNames();
  const entries = promptTextSources();
  const named = entries.reduce((total, entry) => total + [...entry.text.matchAll(TOOL_TOKEN)].length, 0);
  const failures = unresolvedFindings(entries, authority);
  t.diagnostic(
    `prompt-tool.1: ${entries.length} prompt text(s) from ${[...new Set(entries.map((entry) => entry.file))].join(", ")}; ${named} tool mention(s), ${authority.size} declared tool name(s), ${failures.length} unresolved`,
  );
  assert.ok(named > 0, "a scan that finds no tool mention at all must not read as a pass");
  assert.deepEqual(failures, [], "a prompt naming a tool the Agent cannot call sends the instruction nowhere");
});

test("prompt-tool.2: no prompt sends the Agent after a Mod action id instead of the mounted name", (t) => {
  const failures = bareActionFindings();
  t.diagnostic(`prompt-tool.2: ${registryActionIds().length} registry action id(s) checked, ${failures.length} bare`);
  assert.deepEqual(failures, [], "the registry's keys are the Mod's ids; only its values are callable");
});

test("prompt-tool.3: the registry projection is the mounted set, not a second list", (t) => {
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
    `prompt-tool.3: ${registry.length} mounted action name(s) read from STARDEW_ACTION_TOOL_NAMES; ${registry.slice(0, 3).join(", ")}, ...`,
  );
});

test("prompt-tool.4 (mutation): a renamed tool and a bare action id are both located findings", (t) => {
  const authority = declaredToolNames();
  const planted = [
    {
      file: "host/src/planted-prompt.ts",
      line: 12,
      text: "Show a feeling through the game: use stardew_express_emotions, and walk there with move_to_tile.",
    },
    {
      file: "host/src/planted-prompt.ts",
      line: 20,
      text: "The mounted names are stardew_express_emote and stardew_move_to_tile.",
    },
  ];
  assert.deepEqual(unresolvedFindings([planted[0]], authority), [
    "host/src/planted-prompt.ts:12: prompt names stardew_express_emotions, which no Host module declares as a tool",
  ]);
  assert.deepEqual(bareActionFindings([planted[0]], registryActionIds()), [
    "host/src/planted-prompt.ts:12: prompt names the Mod action id move_to_tile; the mounted tool is stardew_move_to_tile",
  ]);
  assert.deepEqual(bareActionFindings([planted[1]], registryActionIds()), [], "the mounted names are clean");
  assert.deepEqual(unresolvedFindings([planted[1]], authority), [], "a correctly prefixed name is clean");
  t.diagnostic("prompt-tool.4: the planted rename and the planted bare id are reported with their location; the correct names are not");
});
