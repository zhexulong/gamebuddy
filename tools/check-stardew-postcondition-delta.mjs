#!/usr/bin/env node
/**
 * Gate: a write action's postcondition must be a READING, not a declaration.
 *
 * WHY. `tools/check-stardew-action-promotion.mjs` refuses a write action whose surface postcondition is still the
 * generic `native_action_postcondition`, and it refuses a placeholder that names no engine fact. That is compliance
 * with a JSON table: it cannot tell whether anything is ever MEASURED. A descriptor row may say `furniture_rotated`
 * while the receipt prints whatever the handler felt like, and the promotion gate stays green because the row is
 * specific.
 *
 * THE DECLARATION is the generated action surface: a write action declares a named postcondition (`furniture_rotated`)
 * or the generic `native_action_postcondition`. The generic name declares NO member, so those actions are outside this
 * gate's population and stay the promotion gate's recorded debt - the count is printed, never silently skipped.
 *
 * THE PHYSICAL SIDE is the receipt the execution path actually emits, and the tree enforces it in two places. This
 * gate reads both, because neither covers the surface alone:
 *
 *   1. THE MOD's succeeded evidence, on the handler the dispatch table routes the action to plus the `Execute*` bodies
 *      it delegates to. The convention is `<member>_before` / `<member>_after` - the same member measured on both
 *      sides of the native call - with the `after` side read off the object graph rather than repeated from a
 *      constant:
 *
 *        integrations/stardew/farmhandexecutioncontroller.colorobjectactions.cs
 *          Color after = chest.playerChoiceColor.Value;                              <- read after the native call
 *          $"...color_before={FormatColor(before)};color_after={FormatColor(after)}"  <- both readings on the receipt
 *
 *      The same evidence also carries an ASSERTION shape, `expected` / `actual`, which every warp, ride and facing
 *      action uses; dropping it would report the strongest evidence in the tree as absent.
 *
 * red-proof: inject the gate's own `--self-verification` mode removes the `_after` reading from the real recolour handler
 * (`RequestLocalColorPlacedObject`) at run time and demands this gate name it -> `postcondition_delta_half`, printed in
 * the run's `self_verification` block (tools/check-stardew-postcondition-delta.mjs --self-verification)
 * red-proof: fixture the tree as it stands carries four `postcondition_delta_absent` debts (`answer_dialogue`,
 * `respond_level_up`, `sleep`, `send_multiplayer_chat`) whose declared postcondition is an EVENT, not an engine member,
 * so the gate records them with reasons rather than passing them (tools/stardew-postcondition-delta-baseline.json)
 *
 *   2. THE HOST's completion-evidence contract (`host/src/stardew-game-integration-adapter.ts`): a per-action `case`
 *      that the receipt must satisfy before the Host will call the action complete, either through a named predicate
 *      or an inline key list. That contract names the exact keys, so it is the receipt SCHEMA for those actions - and
 *      it is production code, not a test.
 *
 * An action satisfies the gate when at least one of the two names a complete reading. Neither is a declaration: both
 * are read out of the code that assembles or refuses the receipt.
 *
 * THREE FINDINGS THIS GATE MAKES, and the reviewer's gap is the second:
 *   - `postcondition_delta_absent:<action>:declared=<name>:handler=<where>` - the action declares what changed and no
 *     layer names a reading of it. This is the declaration-without-compliance shape.
 *   - `postcondition_delta_half:<action>:<member>_before has no <member>_after` - the author thought about the member,
 *     wrote what the world was, and never wrote what it became.
 *   - `postcondition_delta_not_measured:<action>:<member>_after=<expr>:<why>` - a slot whose after side is a constant
 *     or a local assigned from nothing, so it would print the same value whatever the world did.
 *
 * MEMBER-vs-DECLARATION DRIFT is measured and printed with names: for every action with a delta, the pair keys are
 * compared against the declared postcondition's words, and `raft_launched` witnessed by `stamina` is reported as
 * `member disjoint`. It is not blocking yet because naming the member a postcondition MEANS is per-action Mod work
 * (the descriptor carries a name and nothing else); this gate records the size of that debt on every run instead of
 * pretending it has none.
 *
 * RED PROOFS (tools/check-stardew-postcondition-delta.test.mjs): deleting `color_after` from the real handler names
 * `postcondition_delta_half:color_placed_object:color`; moving `Color after` to a copy taken before the native call
 * names `postcondition_delta_not_measured:color_placed_object:color`; dropping the key from the Host's contract names
 * the same half on the Host side.
 *
 * REFUSES TO PASS ON ZERO: no write action declaring a postcondition means the surface or the dispatch table moved and
 * this gate measured nothing - `not_measured`, exit 2.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  bodyAfterParameters,
  matchingBracket,
  readModSources,
  withoutComments,
} from "../integrations/stardew/action-development/src/analysis/stardew-mod-csharp-source.mjs";
import { handlerDispatch } from "../integrations/stardew/action-development/src/analysis/stardew-action-inventory-reconciliation.mjs";

const ROOT = resolve(import.meta.dirname, "..");

export const POSTCONDITION_DELTA = Object.freeze({
  surface: "integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
  hostContract: "host/src/stardew-game-integration-adapter.ts",
  baseline: "tools/stardew-postcondition-delta-baseline.json",
  baselineSchema: "gamebuddy-stardew-postcondition-delta-baseline/v1",
  genericName: "native_action_postcondition",
  unavailablePrefix: "postcondition_delta_unavailable",
});

/** Longest shared prefix worth comparing, and the shortest word that can name a fact on its own (`hay`, `color`). */
const SHARED_WORD_PREFIX = 5;
const SHORTEST_FACT_WORD = 4;

// ---------------------------------------------------------------------------
// The Mod side: which bodies an action's execution runs through, and what they put on the receipt
// ---------------------------------------------------------------------------

/**
 * One handler body plus the `Execute*` bodies it delegates to - the unit the Mod's own observation-gap reader calls
 * "the body that touches the world" (`handlerFieldReads` reads the same two hops).
 *
 * The text keeps string literals, because the evidence IS a string: the shared reader's `codeOnly` blanks every key
 * this gate exists to read, and using it here is how a probe reported 0 of 100 delta pairs on a tree carrying 33.
 */
export function handlerBodies({ files, request }) {
  if (typeof request !== "string") return null;
  const locate = (name) => {
    const pattern = new RegExp(`\\b${name}\\s*(?:<[^<>]{0,80}>)?\\s*\\(`, "gu");
    for (const file of files) {
      for (const match of file.text.matchAll(pattern)) {
        const open = file.text.indexOf("(", match.index + match[0].length - 1);
        const close = matchingBracket(file.text, open);
        if (close < 0) continue;
        const body = bodyAfterParameters(file.text, close);
        if (body !== null) return { body, path: file.path };
      }
    }
    return null;
  };
  const entry = locate(request);
  if (entry === null) return null;
  const bodies = [{ ...entry, name: request, text: entry.body }];
  // TRANSITIVE delegation, not one hop: a two-step is ordinary. `ExecuteOpenGeode` opens the menu and hands the smash to
  // the body that reads the pack, so a one-hop walk never saw `geode_owned_after` and reported `open_geode`'s
  // `geode_owned_before` as half a delta while its handler measured the whole pair.
  const visited = new Set([request]);
  let pending = [entry.body];
  while (pending.length > 0) {
    const next = [];
    for (const text of pending) {
      for (const name of new Set([...text.matchAll(/\b(Execute\w+)\s*\(/gu)].map((match) => match[1]))) {
        if (visited.has(name)) continue;
        visited.add(name);
        const inner = locate(name);
        if (inner === null) continue;
        bodies.push({ ...inner, name, text: inner.body });
        next.push(inner.body);
      }
    }
    pending = next;
  }
  return bodies;
}

/**
 * Every reading a handler puts on its receipt, in the two shapes the Mod uses.
 *
 * Only `KEY={expr}` slots count: a key with no interpolation carries no reading, and counting it would let a prose
 * sentence satisfy the gate. The `{expr}` is kept because the after side's shape is the difference between "we
 * measured it" and "we repeated a constant".
 */
export function evidenceDeltaSlots(text) {
  const slots = new Map();
  for (const match of text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)_(before|after)=\{([^{}]*)\}/gu)) {
    const entry = slots.get(match[1]) ?? { before: null, after: null };
    entry[match[2]] = match[3].trim();
    slots.set(match[1], entry);
  }
  const assertions = new Map();
  for (const match of text.matchAll(/(?:([A-Za-z_][A-Za-z0-9_]*)_)?(expected|actual)=\{([^{}]*)\}/gu)) {
    const prefix = match[1] ?? "";
    const entry = assertions.get(prefix) ?? { expected: null, actual: null };
    entry[match[2]] = match[3].trim();
    assertions.set(prefix, entry);
  }
  const keys = [...slots.keys()].sort();
  return {
    slots,
    assertions,
    pairs: keys.filter((key) => slots.get(key).before !== null && slots.get(key).after !== null),
    // A `_before` with no `_after` is the half this gate exists to name. The reverse - an `_after` alone, e.g.
    // `mutex_locked_after` - is a state observation whose precondition admission already had to establish, not half of
    // a delta, so it is not reported.
    halves: keys.filter((key) => slots.get(key).before !== null && slots.get(key).after === null),
  };
}

/** The member an assertion's `actual` slot names: the last `.member` it reads, else the whole expression. */
export function assertionMember(expression) {
  const trimmed = expression.trim();
  const last = [...trimmed.matchAll(/\.\s*([A-Za-z_][A-Za-z0-9_]*)/gu)].at(-1);
  return last === undefined ? trimmed : last[1];
}

/**
 * Does an `after` slot come from the object graph, or from a constant?
 *
 * `{piece.currentRotation.Value}` reads it at the point of printing. `{FormatColor(after)}` prints a formatter's
 * argument, so the argument is what has to be followed: `after` is a reading only when the handler assigned it from a
 * member expression or a measuring call (`after = chest.playerChoiceColor.Value`, `countAfter = CountItems(...)`).
 *
 * Two shapes are refused whatever they are assigned from: a literal, and anything rooted in a `before` identifier - the
 * before side is measured by definition, and printing it as the after value would make the delta a tautology.
 *
 * Returns `{ live, because }` so the finding can say WHY, instead of asserting a boolean the reader has to trust.
 */
export function resolveAfterReading(expression, text, depth = 0) {
  const trimmed = stripOuterParens(expression.trim());
  if (trimmed.length === 0) return { live: false, because: "empty slot" };
  if (depth > 3) return { live: false, because: `nested too deep to follow: ${trimmed}` };
  if (/^(?:true|false|-?\d+(?:\.\d+)?|"[^"]*")$/u.test(trimmed)) return { live: false, because: "a literal" };
  // A ternary prints one of its branches; the condition is not the reading.
  const branch = ternaryBranch(trimmed);
  if (branch !== null) return resolveAfterReading(branch, text, depth + 1);
  // A guard (`fishTypeAfter ?? "none"`) prints its value side; the fallback is not the reading.
  const guard = splitTopLevelGuard(trimmed);
  if (guard !== null) return resolveAfterReading(guard, text, depth + 1);
  // A dereference or an index reads the object graph at the point of printing.
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*(?:\.|\?\.|\[)/u.test(trimmed))
    return { live: true, because: `read in place: ${trimmed}` };
  // A call prints its arguments: follow them, because the formatter is not the reading.
  const call = /^[A-Za-z_][A-Za-z0-9_.]*\s*\(/u.exec(trimmed);
  if (call !== null) {
    const open = call[0].length - 1;
    const close = matchingBracket(trimmed, open);
    if (close < 0) return { live: false, because: `${trimmed} has unbalanced parentheses` };
    const args = splitTopLevelArguments(trimmed.slice(open + 1, close));
    if (args.length === 0) return { live: false, because: `${trimmed} passes no value` };
    return resolveAfterReading(args[0], text, depth + 1);
  }
  const root = /^([A-Za-z_][A-Za-z0-9_]*)$/u.exec(trimmed)?.[1] ?? null;
  if (root === null) return { live: false, because: `${trimmed} names no value the handler produced` };
  if (/before/iu.test(root)) return { live: false, because: `${root} is the before reading` };
  // `TryReadWearableBodySlot(player, slot, out Item? occupantAfter)` writes its result INTO the local: the engine's
  // slot was read again after the call, and the out argument is where that value landed.
  const outParameter = new RegExp(`\\bout\\s+[A-Za-z_][\\w?<>.,\\[\\]]*\\s+${root}\\b`, "u").exec(text);
  if (outParameter !== null) return { live: true, because: `${root} is filled by ${outParameter[0]}` };
  const assigned = new RegExp(`(?:^|[;{}\\s])${root}\\s*=[^=]([^;]*);`, "u").exec(text);
  if (assigned === null) return { live: false, because: `${root} is never assigned in the handler` };
  const right = assigned[1].trim();
  if (/[A-Za-z_][A-Za-z0-9_]*\s*(?:\.|\?\.|\[|\()/u.test(right)) return { live: true, because: `${root} = ${right}` };
  return { live: false, because: `${root} is assigned from ${right}, which reads no member` };
}

function stripOuterParens(value) {
  let trimmed = value;
  while (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    let depth = 0;
    let closesAtEnd = true;
    for (const [index, character] of [...trimmed].entries()) {
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0 && index < trimmed.length - 1) {
          closesAtEnd = false;
          break;
        }
      }
    }
    if (!closesAtEnd) return trimmed;
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** The branch of a top-level ternary (`cond ? a : b`), or null when there is none. */
function ternaryBranch(value) {
  let depth = 0;
  let question = -1;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth -= 1;
    else if (depth === 0 && character === "?" && value[index + 1] === "?") {
      index += 1;
    } else if (depth === 0 && character === "?") question = index;
    else if (depth === 0 && character === ":" && question >= 0) return value.slice(question + 1, index).trim();
  }
  return null;
}

/** The top-level comma-separated arguments of a call's argument list. */
function splitTopLevelArguments(value) {
  const args = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth -= 1;
    else if (depth === 0 && character === ",") {
      args.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last.length > 0) args.push(last);
  return args;
}

/** The value side of a top-level `??` / ternary, or null when the expression carries no guard. */
function splitTopLevelGuard(value) {
  let depth = 0;
  for (let index = 0; index < value.length - 1; index += 1) {
    const character = value[index];
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth -= 1;
    else if (depth === 0 && character === "?" && value[index + 1] === "?") return value.slice(0, index).trim();
    else if (depth === 0 && character === "?" && value[index + 1] !== ".") return value.slice(0, index).trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// The Host side: the completion-evidence contract, which is the receipt schema for its actions
// ---------------------------------------------------------------------------

/**
 * Every `case "<actionId>":` in the Host adapter that gates completion on evidence KEYS, with the keys it requires.
 *
 * The keys are the quoted lowercase words inside the case's array literals, whether the case spells them inline, names
 * them in a predicate's `expectedKeys`, or passes them to `exactEvidence`. One reading, because a second parser for
 * the same contract is the drift this repository keeps paying for.
 *
 * Comments are stripped first, and that is not cosmetic: `shop_purchase`'s evidence literal is described in a comment
 * ABOVE its check, and a gate that counted prose would score that action green off a sentence nobody wrote code for.
 */
export function readHostCompletionContracts(text) {
  const code = stripLineComments(text);
  const contracts = new Map();
  const findings = [];
  const cases = [...code.matchAll(/case "([a-z0-9_]+)":/gu)];
  const defaults = [...code.matchAll(/^\s*default:/gmu)].map((match) => match.index);
  for (const [index, match] of cases.entries()) {
    const actionId = match[1];
    // A case ends where the next case or the switch's `default` begins. Without the second bound the LAST case in
    // the switch runs to end-of-file and collects every other predicate's keys - measured: `shop_purchase` inherited
    // five halves from `hasMineElevatorFloorCompletionEvidence`.
    const nextCase = index + 1 < cases.length ? cases[index + 1].index : code.length;
    const nextDefault = defaults.find((offset) => offset > match.index) ?? code.length;
    const block = code.slice(match.index, Math.min(nextCase, nextDefault));
    if (!/CompletionEvidence|exactEvidence/u.test(block)) continue;
    const keys = new Set();
    const collect = (source) => {
      for (const array of source.matchAll(/\[([^[\]]*)\]/gu))
        for (const value of array[1].matchAll(/"([a-z][a-z0-9_]*)"/gu)) keys.add(value[1]);
    };
    collect(block);
    const named = /has([A-Za-z]+)CompletionEvidence/u.exec(block);
    let predicate = null;
    if (named !== null) {
      predicate = `has${named[1]}CompletionEvidence`;
      const body = functionBody(code, predicate);
      if (body === null) findings.push(`postcondition_delta_host_predicate_not_located:${actionId}:${predicate}`);
      else collect(body);
    }
    contracts.set(actionId, { actionId, predicate, keys: [...keys].sort() });
  }
  // A completion contract nothing calls is a contract no execution path enforces: `hasCookRecipeCompletionEvidence`
  // was declared and reachable from no `case`, so `cook_recipe` was exempted from the Host's receipt check by
  // accident. The dispatcher itself is named rather than counted, because it is the switch's own entry point.
  for (const declaration of code.matchAll(/function (has[A-Za-z]+CompletionEvidence)\s*\(/gu)) {
    const name = declaration[1];
    if (HOST_CONTRACT_ENTRY_POINTS.has(name)) continue;
    const callers = [...code.matchAll(new RegExp("\\b" + name + "\\s*\\(", "gu"))].length;
    if (callers > 1) continue;
    findings.push(`postcondition_delta_host_predicate_unwired:${name}`);
  }
  return { contracts, findings };
}

/** The dispatcher itself, which contains the switch rather than being one of its cases. */
const HOST_CONTRACT_ENTRY_POINTS = new Set(["hasStardewCompletionEvidence"]);

/** Line-leading `//` comments and `/* ... *\/` blocks removed; a key named only in prose is not a key. */
function stripLineComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
}

/** The body of `function <name>(...)` in `text`, by brace balance, or null. TypeScript may put a return type
 * between the parameter list and the body, so a `;` or `=>` there means this was a declaration of something else. */
function functionBody(text, name) {
  const at = text.indexOf(`function ${name}(`);
  if (at < 0) return null;
  const close = matchingBracket(text, text.indexOf("(", at));
  if (close < 0) return null;
  const open = text.indexOf("{", close);
  if (open < 0) return null;
  const between = text.slice(close + 1, open);
  if (between.includes(";") || between.includes("=>")) return null;
  const end = matchingBracket(text, open);
  return end < 0 ? null : text.slice(open, end + 1);
}

/**
 * The physical readings a Host contract names: complete `<member>_before`/`<member>_after` pairs, `expected`+`actual`
 * assertions, and the halves (a `_before` the contract demands and never checks the other side of).
 */
export function hostContractReadings(contract) {
  const keys = new Set(contract.keys);
  const pairs = contract.keys.filter(
    (key) => key.endsWith("_before") && keys.has(`${key.slice(0, -"_before".length)}_after`),
  );
  const halves = contract.keys.filter(
    (key) => key.endsWith("_before") && !keys.has(`${key.slice(0, -"_before".length)}_after`),
  );
  const assertions = keys.has("expected") && keys.has("actual") ? ["expected/actual"] : [];
  return {
    pairs: pairs.map((key) => key.slice(0, -"_before".length)),
    halves: halves.map((key) => key.slice(0, -"_before".length)),
    assertions,
  };
}

// ---------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------

const WORD_SPLIT = /[^a-z0-9]+/u;

function words(value) {
  return String(value)
    .toLowerCase()
    .split(WORD_SPLIT)
    .filter((word) => word.length > 1);
}

function sharesAWord(left, right) {
  const rightWords = words(right);
  for (const word of words(left))
    for (const candidate of rightWords) {
      const shorter = word.length <= candidate.length ? word : candidate;
      const longer = shorter === word ? candidate : word;
      if (shorter.length >= SHORTEST_FACT_WORD && longer.includes(shorter)) return true;
      let shared = 0;
      while (shared < word.length && shared < candidate.length && word[shared] === candidate[shared]) shared += 1;
      if (shared >= Math.min(SHARED_WORD_PREFIX, word.length, candidate.length)) return true;
    }
  return false;
}

/** The recorded debt, read the way the promotion gate reads its own: an unreadable record is a PROBLEM, never empty. */
export function readPostconditionDeltaBaseline(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { entries: [], reason: null, problem: "postcondition_delta_baseline_malformed" };
  }
  if (parsed?.schema !== POSTCONDITION_DELTA.baselineSchema)
    return { entries: [], reason: null, problem: "postcondition_delta_baseline_schema_mismatch" };
  const listed = Array.isArray(parsed.entries) ? parsed.entries.filter((entry) => typeof entry === "string") : null;
  if (listed === null) return { entries: [], reason: null, problem: "postcondition_delta_baseline_malformed" };
  const entries = [...new Set(listed)];
  if (entries.length !== listed.length)
    return { entries, reason: null, problem: "postcondition_delta_baseline_duplicates" };
  const reason = typeof parsed.reason === "string" ? parsed.reason : "";
  if (reason.trim().length < 40) return { entries, reason, problem: "postcondition_delta_baseline_unreasoned" };
  return { entries, reason };
}

function emptyResult(findings) {
  return {
    findings,
    checked: 0,
    totalWrite: 0,
    declaredCount: 0,
    undeclared: 0,
    withDelta: [],
    unavailable: [],
    absent: [],
    debt: [],
    contextHalves: [],
    undeclaredMember: [],
  };
}

/**
 * The check, pure over `surface`, `handlers`, `contracts` and `baseline`, so the falsifier suite injects a deleted
 * evidence key or a relocated read instead of editing the Mod or the Host.
 *
 * `handlers` maps actionId -> `{ request, bodies }` with each body `{ name, path, text }`; `contracts` is the
 * `Map<actionId, contract>` from `readHostCompletionContracts`.
 */
export function findPostconditionDeltas({ surface, handlers, contracts, baseline = { entries: [] } }) {
  const findings = [];
  const actions = Array.isArray(surface?.actions) ? surface.actions : null;
  if (actions === null) return emptyResult(["action_surface_unreadable"]);
  if (baseline?.problem !== undefined) findings.push(baseline.problem);
  const declared = actions.filter(
    (action) =>
      action?.effect === "write" &&
      typeof action.actionId === "string" &&
      typeof action.postcondition?.name === "string" &&
      action.postcondition.name.length > 0 &&
      action.postcondition.name !== POSTCONDITION_DELTA.genericName,
  );
  const totalWrite = actions.filter((action) => action?.effect === "write").length;
  const recorded = new Set(baseline?.entries ?? []);
  const withDelta = [];
  const unavailable = [];
  const undeclaredMember = [];
  const contextHalves = [];
  const absent = [];
  const debt = [];
  const debtByAction = new Map();
  let checked = 0;
  for (const action of declared) {
    checked += 1;
    const declaredName = action.postcondition.name;
    const entry = handlers?.get?.(action.actionId) ?? null;
    const contract = contracts?.get?.(action.actionId) ?? null;
    const text = entry === null ? "" : entry.bodies.map((body) => body.text).join("\n");
    const where =
      entry === null
        ? contract === null
          ? null
          : `${POSTCONDITION_DELTA.hostContract}:${action.actionId}`
        : entry.bodies.map((body) => `${body.path}:${body.name}`).join(",");
    if (where === null) {
      findings.push(`postcondition_delta_unbacked:${action.actionId}:declared=${declaredName}`);
      continue;
    }
    // A recorded action's findings are DEBT: printed with the same words, counted separately, never a failure. The
    // entry expires the moment the action carries a reading (`stale_postcondition_delta_debt`), so it can only shrink.
    const raise = (finding) => {
      if (!recorded.has(action.actionId)) {
        findings.push(finding);
        return;
      }
      debt.push(finding);
      debtByAction.set(action.actionId, (debtByAction.get(action.actionId) ?? 0) + 1);
    };
    const slots = evidenceDeltaSlots(text);
    const reasons = [...text.matchAll(/postcondition_delta_unavailable:([^;{}"\\]*)/gu)]
      .map((match) => match[1].trim())
      .filter((value) => value.length > 0);
    const modReadings = [
      ...slots.pairs.map((key) => ({
        source: "mod",
        key,
        display: `${key}_before/${key}_after`,
        words: key,
        after: slots.slots.get(key).after,
        ...resolveAfterReading(slots.slots.get(key).after, text),
      })),
      ...[...slots.assertions.entries()]
        .filter(([, slot]) => slot.expected !== null && slot.actual !== null)
        .map(([prefix, slot]) => ({
          source: "mod",
          key: prefix === "" ? assertionMember(slot.actual) : prefix,
          display: `${prefix === "" ? "" : `${prefix}_`}expected/actual`,
          words: `${prefix} ${slot.actual}`,
          after: slot.actual,
          ...resolveAfterReading(slot.actual, text),
        })),
    ].sort((left, right) => left.key.localeCompare(right.key));
    const hostReadings = contractReadingsOf(contract);
    const live = modReadings.filter((reading) => reading.live);
    const dead = modReadings.filter((reading) => !reading.live);
    const disjoint = live.filter((reading) => !sharesAWord(reading.words, declaredName));
    if (live.length > 0 && disjoint.length === live.length)
      undeclaredMember.push(
        `${action.actionId}:declared=${declaredName}:carries=${live.map((reading) => reading.display).join("+")}`,
      );
    // The halves, from both layers: a `_before` with nothing on the other side is a reading of the world that the
    // action never claims to have changed. Reported when the member touches the DECLARED postcondition
    // (`chest_capacity` for `building_chest_loaded`); a context reading such as `money_before` on `bus_arrived` is a
    // cost, not a delta, and is listed without failing so the difference stays visible.
    const halves = [];
    const seenHalves = new Set();
    for (const [half, at] of [
      ...slots.halves.map((half) => [half, where]),
      ...hostReadings.halves.map((half) => [
        half,
        `${POSTCONDITION_DELTA.hostContract}:${contract.predicate ?? action.actionId}`,
      ]),
    ]) {
      if (seenHalves.has(half)) continue;
      seenHalves.add(half);
      halves.push({ half, at });
    }
    for (const { half, at } of halves) {
      const finding = `postcondition_delta_half:${action.actionId}:${half}_before has no ${half}_after:${at}`;
      if (sharesAWord(half, declaredName)) raise(finding);
      else contextHalves.push(finding);
    }
    if (live.length > 0 || hostReadings.pairs.length > 0 || hostReadings.assertions.length > 0) {
      withDelta.push({
        actionId: action.actionId,
        postcondition: declaredName,
        pairs: [
          ...live.map((reading) => reading.display),
          ...hostReadings.pairs.map((key) => `${key}_before/${key}_after@host`),
          ...hostReadings.assertions.map((display) => `${display}@host`),
        ],
        evidence: live.map((reading) => ({ key: reading.key, after: reading.after, because: reading.because })),
        where,
      });
    }
    // A slot that CLAIMS to be the after reading and is not one is named whatever the rest of the receipt does: the
    // defect is the claim, not the absence of other readings.
    for (const reading of dead)
      raise(
        `postcondition_delta_not_measured:${action.actionId}:${reading.display}=${reading.after}:` +
          `${reading.because}:${where}`,
      );
    if (live.length > 0 || hostReadings.pairs.length > 0 || hostReadings.assertions.length > 0) continue;
    if (dead.length > 0) continue;
    if (reasons.length > 0) {
      unavailable.push({ actionId: action.actionId, postcondition: declaredName, reasons, where });
      continue;
    }
    absent.push({ actionId: action.actionId, postcondition: declaredName, where });
    raise(`postcondition_delta_absent:${action.actionId}:declared=${declaredName}:handler=${where}`);
  }
  const declaredIds = new Set(declared.map((action) => action.actionId));
  // An entry expires when the action is out of debt in BOTH directions: it must still declare a postcondition, and it
  // must have no finding left of the shape this gate names. An action that gained one delta while another of its
  // members is still a half keeps its entry, and its remaining findings stay visible as debt.
  for (const actionId of recorded) {
    if (!declaredIds.has(actionId)) findings.push(`postcondition_delta_debt_unknown_declaration:${actionId}`);
    else if ((debtByAction.get(actionId) ?? 0) === 0) findings.push(`stale_postcondition_delta_debt:${actionId}`);
  }
  if (totalWrite === 0) findings.push("postcondition_delta_population_empty");
  else if (checked !== declared.length)
    findings.push(`postcondition_delta_population_incomplete:${checked}/${declared.length}`);
  return {
    findings,
    checked,
    totalWrite,
    declaredCount: declared.length,
    undeclared: totalWrite - declared.length,
    withDelta,
    unavailable,
    absent,
    debt,
    contextHalves,
    undeclaredMember,
  };
}

function contractReadingsOf(contract) {
  if (contract === null) return { pairs: [], halves: [], assertions: [] };
  return hostContractReadings(contract);
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/** The Mod's C# sources with comments removed and string literals kept, which is what an evidence key lives in. */
export function readModFiles({ root = ROOT } = {}) {
  return readModSources({ root, modRoot: "integrations/stardew" }).map(({ path, source }) => ({
    path,
    text: withoutComments(source),
  }));
}

/** The handler bodies behind every action, from one pass over the Mod source. */
export function readActionHandlers({ files, dispatch }) {
  const handlers = new Map();
  for (const [actionId, request] of dispatch) {
    const bodies = handlerBodies({ files, request });
    if (bodies === null) continue;
    handlers.set(actionId, { request, bodies });
  }
  return handlers;
}

/** The real tree, read once, so the CLI and the suite cannot read it two different ways. */
export function auditPostconditionDeltas({ root = ROOT } = {}) {
  const raw = readModSources({ root, modRoot: "integrations/stardew" });
  const dispatch = handlerDispatch(raw);
  const hosts = readHostCompletionContracts(readFileSync(resolve(root, POSTCONDITION_DELTA.hostContract), "utf8"));
  const surface = JSON.parse(readFileSync(resolve(root, POSTCONDITION_DELTA.surface), "utf8"));
  const baseline = readPostconditionDeltaBaseline(readFileSync(resolve(root, POSTCONDITION_DELTA.baseline), "utf8"));
  const result = findPostconditionDeltas({
    surface,
    handlers: readActionHandlers({ files: readModFiles({ root }), dispatch }),
    contracts: hosts.contracts,
    baseline,
  });
  return { ...result, findings: [...hosts.findings, ...result.findings], baselineReason: baseline.reason };
}

export function formatCounts(result) {
  return (
    `checked ${result.checked} of ${result.totalWrite} write actions` +
    ` (${result.declaredCount} declare a postcondition, ${result.undeclared} carry the generic name),` +
    ` with delta ${result.withDelta.length}, declared-but-unavailable ${result.unavailable.length},` +
    ` absent ${result.absent.length} (${result.debt.length} recorded as debt),` +
    ` member-disjoint ${result.undeclaredMember.length}`
  );
}

/**
 * The gate's own falsifiers, run on every invocation.
 *
 * A gate whose red case nobody re-checks drifts into a gate that passes because its subject moved out of the way. Each
 * check below plants one defect in the REAL recolour handler (`ship` returns the Mod sources with one edit) and
 * demands the finding that names it, or in a synthetic case for the shapes the real tree has no live example of.
 */
export function selfVerification({ files = readModFiles() } = {}) {
  const checks = [];
  const record = (id, ok, detail) => checks.push({ id, status: ok ? "passed" : "failed", detail });
  const request = "RequestLocalColorPlacedObject";
  const mutant = (replace) => {
    const patched = files.map((file) => ({ path: file.path, text: replace(file.text) }));
    return handlerBodies({ files: patched, request });
  };
  const surface = {
    actions: [{ actionId: "color_placed_object", effect: "write", postcondition: { name: "placed_object_recolored" } }],
  };
  const run = (bodies) =>
    findPostconditionDeltas({
      surface,
      handlers: new Map([["color_placed_object", { request, bodies }]]),
      contracts: new Map(),
    });

  const intact = handlerBodies({ files, request });
  record(
    "the real recolour handler carries its delta",
    intact !== null && run(intact).findings.length === 0,
    intact === null ? "the handler is not locatable" : "color_before/color_after read off chest.playerChoiceColor",
  );

  const withoutAfter = mutant((text) => text.replace("color_after={FormatColor(after)}", ""));
  record(
    "deleting the after slot names the half",
    run(withoutAfter).findings.some((finding) =>
      finding.startsWith("postcondition_delta_half:color_placed_object:color_before has no color_after"),
    ),
    "postcondition_delta_half:color_placed_object:color_before has no color_after",
  );

  const beforeRooted = mutant((text) =>
    text
      .replace("Color after = chest.playerChoiceColor.Value;", "Color after = before;")
      .replace("color_after={FormatColor(after)}", "color_after={FormatColor(before)}"),
  );
  record(
    "a before-rooted after slot is not a measurement",
    run(beforeRooted).findings.some((finding) => finding.includes("is the before reading")),
    "postcondition_delta_not_measured:color_placed_object:color_before/color_after=FormatColor(before)",
  );

  const bare = findPostconditionDeltas({
    surface,
    handlers: new Map([
      [
        "color_placed_object",
        {
          request,
          bodies: [{ name: request, path: "x", text: 'string evidence = $"target={targetId}";' }],
        },
      ],
    ]),
    contracts: new Map(),
  });
  record(
    "an action whose receipt names no reading is refused by name",
    bare.findings.some((finding) => finding.startsWith("postcondition_delta_absent:color_placed_object")),
    "postcondition_delta_absent:color_placed_object",
  );

  const host = readHostCompletionContracts(
    [
      "function hasStardewCompletionEvidence(actionId: string, detail: string): boolean {",
      '  switch (actionId) { case "recolor": return exactEvidence(detail, ["color_before", "color_after"]); }',
      "}",
    ].join("\n"),
  );
  record(
    "the Host contract's key list is read as a receipt schema",
    host.contracts.get("recolor")?.keys.includes("color_after") === true,
    "exactEvidence(detail, [color_before, color_after])",
  );
  return checks;
}

function report(result, checks) {
  process.stdout.write(`postcondition delta: ${formatCounts(result)}\n`);
  for (const entry of result.withDelta)
    process.stdout.write(
      `postcondition delta: ${entry.actionId} ${entry.postcondition} <- ${entry.pairs.join("+")} (${entry.where})\n`,
    );
  for (const line of result.undeclaredMember) process.stdout.write(`postcondition delta member disjoint: ${line}\n`);
  for (const entry of result.unavailable)
    process.stdout.write(`postcondition delta unavailable: ${entry.actionId} ${entry.reasons.join("+")}\n`);
  for (const line of result.contextHalves) process.stdout.write(`postcondition delta context half: ${line}\n`);
  for (const line of result.debt) process.stdout.write(`postcondition delta recorded debt: ${line}\n`);
  for (const finding of result.findings) process.stdout.write(`postcondition delta finding: ${finding}\n`);
  for (const check of checks.filter((entry) => entry.status === "failed"))
    process.stdout.write(`postcondition delta self check failed: ${check.id} (${check.detail})\n`);
  const status =
    result.findings.length === 0 && checks.every((entry) => entry.status === "passed") ? "passed" : "failed";
  process.stdout.write(
    `${JSON.stringify({ gate: SELF_VERIFICATION_SCHEMA, mode: "self_verification", status, examined: result.checked, checks })}\n`,
  );
  if (status === "passed") return 0;
  return result.totalWrite === 0 ? 2 : 1;
}

const SELF_VERIFICATION_SCHEMA = "stardew_postcondition_delta/v1";

function main() {
  const result = auditPostconditionDeltas();
  const checks = selfVerification();
  const status = report(result, checks);
  if (result.totalWrite === 0)
    process.stdout.write("postcondition delta: not_measured (the write surface declares no postcondition)\n");
  process.exitCode = status;
}

if (import.meta.main) main();
