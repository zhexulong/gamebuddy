#!/usr/bin/env node
/**
 * A deadline ceiling is a DECLARATION read by action, never a pair of action ids compared in a `||`.
 *
 * WHY. Two Host files size the same number. `game-tools.ts` sets a request's absolute deadline from the watchdog the Mod
 * PUBLISHES for that action (`descriptor.watchdogMs`, clamped to the bridge's 600 s maximum); `protocol.ts` decided
 * whether to admit it with
 *
 *   `action === "navigate_to_destination" || action === "sleep" ? 600_000 : 60_000`
 *
 * so every action outside those two literals was capped at 60 s by the validator, whatever window the Mod admitted. The
 * pair agreed with the Mod's declaration on the day it was written - `action-deadline-windows.v1.json` publishes 104
 * windows at 60 s and exactly those two at 600 s - which is the whole problem: an action added tomorrow with a declared
 * five-minute window would have been refused `invalid_deadline` before the game saw it, and the only place that could
 * have said why was a `||` between two strings. Same class as the `actionable` short-circuit removed from the same
 * validator (a second implementation of a Mod admission rule) and as the `fish_here` incident measured 2026-11-10,
 * where a sender's own number disagreed with the receiver's window and the disagreement surfaced as a refusal naming
 * neither number.
 *
 * WHAT IT READS, and what that is worth.
 *
 *   the declaration  `EXECUTION_REQUEST_DEADLINE_WINDOWS` in `host/src/protocol.ts`: an object literal keyed by action id
 *                    whose values are the windows. Read through the syntax tree, so a comment mentioning the name is not
 *                    a declaration and a rename is a BLOCKED reading rather than a silent zero.
 *   the shape        every production Host source (`tools/lib/host-production-sources.mjs`, the mirror of
 *                    `host/tsconfig.json`), parsed with the shared tree-sitter seam. A file whose text names no action id
 *                    cannot contain a selector over action ids, so it is counted and not parsed - a PREFILTER, stated
 *                    here and printed, not a silent narrowing. In the files that are parsed, every node that selects a
 *                    value by comparing an action id is classified: a selector whose chosen value is a NUMBER is a
 *                    deadline ceiling by name (`deadline_ceiling_is_a_name_list:<path>:<line>`); one that chooses a
 *                    string selects a label or a reason code, not a wait, and is counted apart.
 *   the windows      `action-deadline-windows.v1.json`, the Mod's own export, is the population: every action it
 *                    publishes must be either declared here, or published `read_only` on the action surface, which is
 *                    what an action with no `execution_request` - and therefore no dispatch deadline - looks like.
 *
 * WHY A GATE AND NOT JUST A TEST. The test beside this change (`execution-request-deadline-window.test.ts`) proves the
 * validator admits the declared window and refuses an undeclared action, over the artifact's whole population. It cannot
 * stop the NEXT per-action number from being written as a name list somewhere else in the Host - and the name list is
 * the defect, not the two values. This gate's population is the filesystem plus the producer's artifact, so an action or
 * a file nobody has written yet is covered by existing.
 *
 * WHAT IT DOES NOT SEE, said rather than implied. A per-action number selected by a shape this gate does not classify - a
 * table built at runtime, a number returned by a helper that compares ids - is invisible to it. The shapes it reads are
 * the ones this tree has used to choose a per-action value: a ternary, a `switch`, an `if` chain, and an
 * `.includes`/`.has` membership test. A name list over a vocabulary other than the artifact's action ids is outside it
 * too: the deadline is per-ACTION, so those ids are the population that can go wrong here.
 *
 * VERDICT. Three populations, all derived, all printed:
 *
 *   `ceiling sites examined N · from a declaration D · from a name list L`        N = D + L, L must be 0
 *   `declared windows examined W · declared C · published read_only R · undeclared and unpublished U`   W = C + R + U
 *   `sources examined S · parsed P · per-action selectors M`
 *
 * Exit 0 when L = 0, U = 0, every published action is accounted for, and both populations are non-empty. Exit 1 with
 * one line per finding. Exit 2 (BLOCKED, never green) when the declaration, the artifact or the surface cannot be read,
 * when no source was parsed, or when the artifact publishes no window: "0 findings" over "0 examined" is a gate agreeing
 * with itself.
 *
 * USAGE
 *   node tools/check-deadline-ceiling-declaration.mjs
 *   node tools/check-deadline-ceiling-declaration.mjs --json
 *
 * red-proof: inject  the ceiling row back to `action === "navigate_to_destination" || action === "sleep" ? 600_000 :
 *                    60_000` -> `ceiling sites examined 1 · from a declaration 0 · from a name list 1` and
 *                    `deadline_ceiling_is_a_name_list:host/src/protocol.ts:<row>`, exit 1 (measured on this tree
 *                    2026-11-16; tools/check-deadline-ceiling-declaration.test.mjs drives the same reading over an
 *                    in-memory source so the falsifier does not need a second checkout).
 */

export const gateDeclaration = {
  id: "check-deadline-ceiling-declaration",
  domain: "stardew",
  tier: "l0",
  kind: "contract",
};

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { isProductionSource, listSources } from "../../tools/lib/host-production-sources.mjs";
import { parseJavaScript } from "../../tools/lib/javascript-ast.mjs";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

const _TOOLS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = repositoryRoot(import.meta.url);
const CONTRACTS = "integrations/stardew/action-development/contracts/generated";
const WINDOWS_ARTIFACT = `${CONTRACTS}/action-deadline-windows.v1.json`;
const SURFACE_ARTIFACT = `${CONTRACTS}/action-surface.v1.json`;
const HOST_DECLARATION = "host/src/protocol.ts";

/**
 * The declaration this gate requires the Host's ceiling to come from.
 *
 * Named rather than discovered on purpose: a scan that accepted ANY object literal keyed by actions would accept the
 * Host's own copy of the argument rules as the deadline declaration. The name is the seam between this gate and the
 * Host, and renaming it shows up here as a named BLOCKED reading instead of as a smaller population.
 */
export const DECLARATION_NAME = "EXECUTION_REQUEST_DEADLINE_WINDOWS";

/** The artifact's schema id, so a file with the right name and another shape is a blocked reading. */
const WINDOWS_SCHEMA = "gamebuddy-action-deadline-windows/v1";

export const EXIT = Object.freeze({ clean: 0, findings: 1, blocked: 2 });

function blocked(code, detail) {
  const error = new Error(detail === undefined ? code : `${code}:${detail}`);
  error.code = code;
  return error;
}

function readJson(root, relativePath) {
  try {
    return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
  } catch (error) {
    throw blocked(`deadline_gate_input_unreadable:${relativePath}`, String(error?.message ?? error).slice(0, 160));
  }
}

/** The action ids the Mod's own export publishes, in catalog order: the population every check below is drawn from. */
export function publishedWindows(artifact) {
  if (artifact?.schema !== WINDOWS_SCHEMA)
    throw blocked("deadline_windows_schema_unexpected", String(artifact?.schema ?? "absent"));
  const windows = new Map();
  for (const window of Array.isArray(artifact.windows) ? artifact.windows : [])
    if (typeof window?.actionId === "string" && Number.isSafeInteger(window?.admittedMs) && window.admittedMs > 0)
      windows.set(window.actionId, window.admittedMs);
  if (windows.size === 0) throw blocked("deadline_windows_population_empty", "the artifact publishes no window");
  return windows;
}

/** `read_only` / `experimental` / …, per action id, from the generated action surface. */
export function publishedKinds(surface) {
  const kinds = new Map();
  for (const action of Array.isArray(surface?.actions) ? surface.actions : [])
    if (typeof action?.actionId === "string") kinds.set(action.actionId, action.kind);
  return kinds;
}

/** The object literal assigned to `name`: `const NAME … = Object.freeze({ … })`. */
function findAssignedObject(node, name) {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (
      (current.type === "lexical_declaration" || current.type === "variable_declaration") &&
      current.text.slice(0, 160).includes(name)
    ) {
      const objects = current.descendantsOfType("object");
      if (objects.length > 0) return objects[0];
    }
    for (let index = 0; index < current.childCount; index += 1) {
      const child = current.child(index);
      if (child !== null) stack.push(child);
    }
  }
  return undefined;
}

/**
 * `EXECUTION_REQUEST_DEADLINE_WINDOWS` as `actionId -> window`, read out of the syntax tree.
 *
 * Only object-literal properties whose key is an action id and whose value is a whole number are read. A value that is a
 * call, an identifier or an expression is not a declaration this gate can compare, and is reported rather than skipped:
 * otherwise a table that stopped being a table would read as a smaller population.
 */
export function declaredWindows(tree) {
  const declaration = findAssignedObject(tree.rootNode, DECLARATION_NAME);
  if (declaration === undefined)
    throw blocked(
      "deadline_declaration_not_found",
      `${DECLARATION_NAME} is not an object literal in the Host declaration`,
    );
  const windows = new Map();
  const problems = [];
  for (let index = 0; index < declaration.namedChildCount; index += 1) {
    const pair = declaration.namedChild(index);
    if (pair === null || pair.type !== "pair") continue;
    const key = pair.childForFieldName("key");
    const value = pair.childForFieldName("value");
    if (key === null) continue;
    const actionId = key.text.replace(/^["']|["']$/gu, "");
    const literal = Number((value?.text ?? "").replaceAll("_", ""));
    if (value === null || !Number.isSafeInteger(literal) || literal <= 0) {
      problems.push(
        `${actionId}: the declared value is not a whole number of milliseconds (${value?.text ?? "absent"})`,
      );
      continue;
    }
    if (windows.has(actionId)) problems.push(`${actionId}: declared twice`);
    windows.set(actionId, literal);
  }
  if (windows.size === 0 && problems.length === 0)
    throw blocked("deadline_declaration_empty", `${DECLARATION_NAME} carries no action`);
  return { windows, problems, line: declaration.startPosition.row + 1 };
}

/**
 * Every per-action selector in one parsed source, classified.
 *
 * A selector is a node that reads an action id and chooses a value from it. `chosen` is the value-producing text of that
 * node - the two branches of a ternary, the statements a `switch` case or an `if` consequence runs - and `yieldsWindow`
 * answers whether it is a NUMBER of milliseconds: a bare numeric literal or a `Math.min`/`Math.max` of one. That
 * distinction is what keeps the rule narrow: `local-stardew-bridge.ts` chooses a scene-kind STRING from an action id, and
 * a `game-tools.ts` branch that builds a tool schema from one contains digits in a dozen places without choosing a wait.
 */
export function perActionSelectors(tree, actionIds) {
  const literals = (text) =>
    [...String(text).matchAll(/["']([a-z][a-z0-9_]*)["']/gu)]
      .map((match) => match[1])
      .filter((literal) => actionIds.has(literal));
  const numericValue = (node) => {
    if (node === null) return false;
    const text = node.text.trim();
    if (/^-?\d[\d_]*(?:\.\d+)?$/u.test(text)) return true;
    return /^Math\.(?:min|max)$/u.test(node.child(0)?.text ?? "");
  };
  const returnsAWindow = (node) => {
    if (node === null) return false;
    for (const statement of node.type === "return_statement" ? [node] : node.descendantsOfType("return_statement"))
      if (numericValue(statement.child(1))) return true;
    for (const assignment of node.type === "return_statement" ? [] : node.descendantsOfType("assignment_expression"))
      if (numericValue(assignment.child(2))) return true;
    return false;
  };
  const selectors = [];
  const stack = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    let condition = null;
    let chosen = null;
    if (node.type === "ternary_expression") {
      condition = node.child(0);
      chosen = [node.child(2), node.child(4)].some(numericValue);
    } else if (node.type === "switch_statement") {
      condition = node.child(1);
      chosen = returnsAWindow(node.child(4));
    } else if (node.type === "if_statement") {
      condition = node.child(1);
      chosen = returnsAWindow(node.child(2));
    } else if (node.type === "call_expression") {
      const fn = node.child(0);
      if (fn !== null && /\.(?:includes|has)$/u.test(fn.text)) {
        condition = node.child(2)?.child(0) ?? null;
        chosen = returnsAWindow(node.parent);
      }
    }
    const ids = condition === null ? [] : literals(condition.text);
    if (ids.length > 0)
      selectors.push({
        row: node.startPosition.row + 1,
        ids,
        yieldsWindow: chosen === true,
        text: node.text.replace(/\s+/gu, " ").slice(0, 120),
      });
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child !== null) stack.push(child);
    }
  }
  return selectors;
}

/**
 * The verdict over the three populations, as data, so the falsifier drives the SAME reading rather than a second copy
 * of it. `selectors` carries the site (`path:line`) each selector was found at.
 */
export function judge({ actionIds, declaration, selectors, sources, kinds }) {
  const findings = [];
  const nameList = selectors.filter((selector) => selector.yieldsWindow);
  for (const selector of nameList)
    findings.push(`deadline_ceiling_is_a_name_list:${selector.site}:${selector.row}:${selector.text}`);
  for (const problem of declaration.problems) findings.push(`deadline_window_malformed:${problem}`);

  let declared = 0;
  let readOnly = 0;
  for (const [actionId, admittedMs] of actionIds) {
    const window = declaration.windows.get(actionId);
    if (window !== undefined) {
      declared += 1;
      if (window !== admittedMs)
        findings.push(`deadline_window_disagrees:${actionId}:the Mod declares ${admittedMs} ms, the Host ${window}`);
      continue;
    }
    if (kinds.get(actionId) === "read_only") {
      readOnly += 1;
      continue;
    }
    findings.push(`deadline_window_not_declared:${actionId}:the Mod publishes a window and the Host declares none`);
  }
  for (const actionId of declaration.windows.keys())
    if (!actionIds.has(actionId))
      findings.push(`deadline_window_not_published:${actionId}:declared here, not published by the Mod`);

  /** Why this run measured nothing, or `undefined` when it measured something. Stated, never inferred. */
  const blockedReading = blockedReason({ sources, selectors, declared });
  return {
    status: statusOf(blockedReading, findings),
    blockedReading,
    findings,
    sites: {
      examined: declaration.windows.size + nameList.length,
      fromDeclaration: declaration.windows.size,
      fromNameList: nameList.length,
    },
    windows: { examined: actionIds.size, declared, readOnly, undeclared: actionIds.size - declared - readOnly },
    sources,
    selectors: selectors.length,
  };
}

/** Every production Host source, parsed only when its text names an action id (a selector needs one to name). */
async function readHostSources(root, actionIds) {
  const hostSourceRoot = join(root, "host", "src");
  const selectors = [];
  let sources = 0;
  let parsed = 0;
  let declarationTree;
  for (const file of listSources(hostSourceRoot)) {
    const relativePath = relative(hostSourceRoot, file).split(sep).join("/");
    if (!isProductionSource(relativePath)) continue;
    sources += 1;
    const source = readFileSync(file, "utf8");
    const site = `host/src/${relativePath}`;
    const namesAnAction = [...actionIds.keys()].some((actionId) => source.includes(actionId));
    if (!namesAnAction) continue;
    parsed += 1;
    const tree = await parseJavaScript(source, file);
    if (site === HOST_DECLARATION) declarationTree = tree;
    for (const selector of perActionSelectors(tree, actionIds)) selectors.push({ ...selector, site });
  }
  if (declarationTree === undefined)
    throw blocked("deadline_declaration_source_not_read", `${HOST_DECLARATION} does not name an action id`);
  return { sources, parsed, selectors, declarationTree };
}

/**
 * The three readings that are not a verdict, named apart from zero findings: a run over no source, and a run that found
 * neither of the two things it looks for. Both are `blocked` (exit 2), because "0 findings" over "0 examined" is a gate
 * agreeing with itself.
 */
function blockedReason({ sources, selectors, declared }) {
  if (sources === 0) return "no Host production source was parsed";
  if (selectors.length === 0 && declared === 0) return "neither a per-action selector nor a declared window was found";
  return undefined;
}

/** The exit status of each verdict: `passed` is the only one a caller can treat as a reading. */
function exitFor(status) {
  if (status === "blocked") return EXIT.blocked;
  return status === "passed" ? EXIT.clean : EXIT.findings;
}

/** The one line a human reads last, and the JSON report the census reads under it. */
function verdictLine(status, findings) {
  if (status === "passed") return "deadline_ceiling_declaration: passed";
  if (status === "failed") return `deadline_ceiling_declaration: failed - ${findings.length} finding(s)`;
  return "deadline_ceiling_declaration: blocked - the reading measured nothing";
}

/** `passed` when nothing was found, `failed` when something was, `blocked` when nothing was measured. */
function statusOf(blockedReading, findings) {
  if (blockedReading !== undefined) return "blocked";
  return findings.length === 0 ? "passed" : "failed";
}

async function main(argv) {
  const artifact = readJson(REPOSITORY_ROOT, WINDOWS_ARTIFACT);
  const surface = readJson(REPOSITORY_ROOT, SURFACE_ARTIFACT);
  const actionIds = publishedWindows(artifact);
  const kinds = publishedKinds(surface);
  if (kinds.size === 0) throw blocked("action_surface_population_empty", "the generated surface publishes no action");
  const { sources, parsed, selectors, declarationTree } = await readHostSources(REPOSITORY_ROOT, actionIds);
  const declaration = declaredWindows(declarationTree);

  const verdict = judge({ actionIds, declaration, selectors, sources, kinds });
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ gate: "check-deadline-ceiling-declaration", ...verdict }, null, 2)}\n`);
    return exitFor(verdict.status);
  }
  process.stdout.write(
    `ceiling sites examined ${verdict.sites.examined} · from a declaration ${verdict.sites.fromDeclaration} · from a name list ${verdict.sites.fromNameList}\n`,
  );
  process.stdout.write(
    `declared windows examined ${verdict.windows.examined} · declared ${verdict.windows.declared} · published read_only ${verdict.windows.readOnly} · undeclared and unpublished ${verdict.windows.undeclared}\n`,
  );
  process.stdout.write(`sources examined ${sources} · parsed ${parsed} · per-action selectors ${verdict.selectors}\n`);
  for (const finding of verdict.findings) process.stdout.write(`${finding}\n`);
  if (verdict.blockedReading !== undefined)
    process.stdout.write(`deadline_ceiling_declaration_blocked:${verdict.blockedReading}\n`);
  process.stdout.write(`${verdictLine(verdict.status, verdict.findings)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      gate: "check-deadline-ceiling-declaration",
      status: verdict.status,
      examined: verdict.sites.examined,
      ...(verdict.blockedReading === undefined ? {} : { blocked: verdict.blockedReading }),
    })}\n`,
  );
  return exitFor(verdict.status);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.log(`${error.code ?? "deadline_ceiling_declaration_failed"}: ${error.message}`);
      console.log(
        JSON.stringify({
          gate: "check-deadline-ceiling-declaration",
          status: "blocked",
          blocked: String(error?.message),
        }),
      );
      process.exitCode = EXIT.blocked;
    },
  );
