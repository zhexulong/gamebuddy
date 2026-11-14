#!/usr/bin/env node
/**
 * A tool can exist, carry a perfect description, and still never be asked for.
 *
 * WHY. `affordances` is the precedent: `stardew_look_up` advertised the subject with a full description and the run it
 * was built for used it zero times, because nothing in the text the companion reads at PLANNING time pointed at it. A
 * query nobody consults is indistinguishable from a missing one - the player loses the capability either way - so the
 * observation tools that answer questions a plan's steps depend on have to be named in `stardew_plan_work`'s own
 * description, which is the text a planning turn holds.
 *
 * WHAT IS NOT COVERED. `stardew_plan_shape` carries guidance of its own, and it lives in
 * `host/src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts`. This gate
 * reads one guidance text: `planWorkDescription`. A second reader for the other tool would be a second spelling of
 * "the planner's guidance"; the place to add it is that file's own description, and the place to gate it is here, once
 * someone decides the two texts are one subject.
 *
 * POPULATION - derived from the declaration on every run, never listed here:
 *   the tools `createStardewObservationTools` returns (`host/src/game-tools.ts`). That function is the observation
 *   class itself: `host/src/stardew-game-integration-adapter.ts` hands its result to the tool set as `observation`, and
 *   `host/src/runtime-core.internal.ts` mounts `integrationToolSet.observation` in the Game surface's `game_action`
 *   group. Both links are asserted as ANCHORS below, so a rename or a rewiring is `observation_chain_unanchored`
 *   rather than a population that quietly shrank to nothing and a gate that agreed with itself.
 *
 *   Inside the producer, each `defineTool({` literal's own `name` is a member. Comments are blanked first: the
 *   read_scene tool carries a comment naming the tool it replaced (`stardew_observe_scene`), and a reader that counted
 *   it would report a tool that does not exist.
 *
 * ASSERTIONS, both directions:
 *   1. every observation tool is either NAMED in `planWorkDescription`'s text, or carries a stated reason here
 *      (`PLANNER_NEED_NOT_MENTION`), in one of the closed classes below. A member with neither is
 *      `planner_guidance_omits_tool:<name>`, and the finding names the tool, because the tool is the thing to fix.
 *   2. the reason table cannot rot: a reason for a tool the guidance now names is `planner_guidance_reason_stale`
 *      (delete it), and one for a name the declaration no longer mounts is `planner_guidance_reason_unknown_tool`.
 *   3. the guidance is read from source with comments blanked, so a name written in a comment beside the text is not a
 *      mention. A name that reaches the model only through a helper function `planWorkDescription` concatenates is NOT
 *      counted either: that reading errs toward red, never toward a false green.
 *
 * A zero population is `observation_population_empty` and blocked - a check whose population is empty agrees with
 * itself. `examined N · named M · with a reason K` is the verdict line, and `node
 * tools/check-planner-guidance-observation-tools.mjs` exits 1 on any finding.
 *
 * THE SECOND POPULATION: A NUMBER THE PUBLISHED TEXT STATES ABOUT THE PLAN.
 *
 * Measured 2026-11-08 (`round55`, turn 152), in her own thinking: "That's 15 tiles - equip + 15 = 16 nodes, at limit… 16
 * nodes max". The real ceiling is `MAX_PLAN_NODES` - `isFull()` refuses one node past it - and it has been 256 since the
 * constant moved; every plan that run wrote stopped at 16, 26 accepted plans averaged 3.69 nodes, and each program
 * boundary cost a measured 55.4 s of model turn. The number she read was the `script` parameter description of
 * `stardew_plan_work`: "builder.nodeCount and builder.isFull() are live and 16 nodes is the whole plan". `256` appears
 * nowhere in her 376-record session and `isFull()` was never called, so that sentence was the only place the ceiling
 * could come from - and nothing tied it to the constant it described.
 *
 * So the population is every description text the plan surface publishes, re-read from the two files that compose it: the
 * planner's guidance (`planWorkDescription` in `host/src/body-program-script.ts`) and every `description:` in the module
 * that defines `stardew_plan_work` and `stardew_submit_action_program`. The REAL limit is written down nowhere here
 * either: it is the constant the `isFull()` guard compares `state.nodes.length` against, read from the guard itself, so a
 * limit that moves without the text moving is `plan_node_limit_disagrees:<published>:<real>`.
 *
 * Two directions, because "states the right number" and "states a number it quotes" are different claims:
 *
 *   `plan_node_limit_disagrees:<published>:<real>`  a claim about how many nodes a plan holds that does not agree with the
 *                                                  guard. A claim whose interpolation this gate cannot resolve to a
 *                                                  declared numeric constant is `plan_node_limit_unresolved:<place>` - the
 *                                                  published value would be unknowable here, and a gate that skipped it
 *                                                  would be green over the thing it exists for.
 *   `plan_node_limit_hand_written:<n>`              a count typed into the text instead of quoted from the constant. That
 *                                                  is the CLASS rather than the instance: 16 was typed in, the constant
 *                                                  moved to 256, and nothing related the two. A hand-written number that
 *                                                  happens to be right today is red here too, because it is the same
 *                                                  sentence one edit later.
 *
 * The boundary, stated rather than hidden: this reads string and template literals, so a limit spelled in words ("capped
 * at sixteen") is not a claim it can see, and a `description:` whose value is a computed expression is
 * `plan_node_limit_place_unreadable` rather than a place silently skipped. It also reaches only the two files that build
 * the plan tools; a limit published anywhere else is a new member of this population and belongs here beside these.
 *
 * THE REPORT. The default run ends with one JSON line carrying `checks`: one entry per rule in `RULES` below, each with
 * its own outcome, so the run says which rules it is able to report red and what each one found - a rule that passed is
 * enumerated beside the one that failed. `status` is `passed` only when every rule passed over a non-empty population,
 * `blocked` when a prerequisite or the population could not be read, `failed` when a rule has a finding; the verdict
 * line above the report carries the same word. `tools/lib/harness-conformance.mjs` reads that line.
 *
 * red-proof: inject  the guidance as it read before the rectangle sentence (the name deleted from the text) -> `examined 9
 *   named 0 reason 6`, `planner_guidance_omits_tool:stardew_inspect_tiles`, `...:stardew_look_up`, `...:stardew_observe`,
 *   failed, exit 1 - measured on the text as it read before the sentence was added, and reproduced by
 *   tools/check-planner-guidance-observation-tools.test.mjs deleting it
 * red-proof: inject  only `stardew_look_up`'s name removed -> that tool alone is named, so the finding points at the tool
 *   that went missing and not at the sentence it was in
 * red-proof: inject  a tenth `defineTool` added to the producer -> `planner_guidance_omits_tool:stardew_inspect_crops`,
 *   `examined 10`: a tool nobody has written yet arrives red instead of arriving invisible
 * red-proof: inject  `blankCommentText` made the identity -> two cases fail: a comment inside `planWorkDescription`
 *   counting as a mention, and a `name:` key inside a producer comment becoming a tool
 * red-proof: inject  `observationToolNames` returning before it walks the producer -> 10 of 13 cases fail, so the derived
 *   population is load-bearing rather than decorative
 * red-proof: self-check  the report's `checks` list names one rule per finding code the gate can emit, and the rule a
 *   finding belongs to is the one whose entry carries it -> asserted by three cases in
 *   tools/check-planner-guidance-observation-tools.test.mjs: "the verdict line and the report carry the same status, and
 *   every rule is enumerated", "a failing rule is the one the report names, and the others still report their own
 *   outcome", "a prerequisite that cannot be read is not_measured, and the whole gate is blocked"
 * red-proof: inject  the shipped sentence typed back in ("16 nodes is the whole plan") -> `plan node limit · places examined
 *   15 · state a limit 1 · disagree 1`, `plan_node_limit_disagrees:16:256` beside `plan_node_limit_hand_written:16`,
 *   failed, exit 1 - the reading that capped a planning companion at 16 nodes per program, replayed from `git show
 *   HEAD:` on the text the run was measured against
 * red-proof: inject  that same number written as the guard's own value -> `plan_node_limit_hand_written:<n>` alone, so the
 *   finding is about where the number came from and not about whether it is right today
 * red-proof: inject  the guard's constant moved and the sentence left alone -> green, because the sentence quotes it, which
 *   is the whole point of deriving instead of correcting
 * red-proof: inject  `String(MAX_PLAN_NODES)` replaced by an undeclared name -> `plan_node_limit_unresolved:<file>:<line>`,
 *   so a published number this gate cannot resolve fails loudly instead of passing unexamined
 */

export const gateDeclaration = {
  id: "check-planner-guidance-observation-tools",
  domain: "product",
  tier: "l0",
  kind: "totality",
};

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gate = "planner_guidance_observation_tools/v1";

/** The three links of the chain that makes these tools the Game surface's observation class. */
const ADAPTER_PATH = "host/src/stardew-game-integration-adapter.ts";
const RUNTIME_CORE_PATH = "host/src/runtime-core.internal.ts";
const ADAPTER_ANCHOR = /observation:\s*createStardewObservationTools\(/u;
const RUNTIME_ANCHOR = /\.\.\.integrationToolSet\.observation/u;

/** The declaration itself, and the planner guidance the companion reads. */
const PRODUCER_PATH = "host/src/game-tools.ts";
const GUIDANCE_PATH = "host/src/body-program-script.ts";
const PRODUCER_FUNCTION = "createStardewObservationTools";
const GUIDANCE_FUNCTION = "planWorkDescription";

/**
 * The module that defines the plan and program tools, and therefore every description either one publishes.
 *
 * The two tools are the whole of the plan surface: `stardew_plan_work` compiles a script into the program
 * `stardew_submit_action_program` submits, and both live here. The planner's guidance is the other half, and it is in
 * `GUIDANCE_PATH` beside the compiler it describes.
 */
const PLAN_TOOLS_PATH =
  "host/src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts";

/**
 * The guard that IS the plan's node ceiling: `isFull()` is `state.nodes.length >= <constant>`, so the constant it names
 * is the real limit and nothing in this file has to restate it.
 */
const PLAN_FULL_GUARD = /isFull"\)\s*return\s*\(\)\s*=>\s*state\.nodes\.length\s*>=\s*([A-Za-z_$][\w$]*)/u;

/**
 * The shapes in which published prose states how many nodes a plan holds.
 *
 * Each one is a sentence a reader acts on, not a word: "16 nodes is the whole plan" is the one that was wrong, and the
 * other two are the ways the same fact is written. A plan-sized claim in STEP words is one of them too ("16 steps is the
 * whole plan", "16 steps per plan"): what makes a claim a plan-size claim is that it names the PLAN, not the noun beside the
 * number. What is deliberately NOT one of them is the bare `at most N steps` - that is the `for_each` chain bound
 * (`MAX_FOR_EACH_STEPS`), a different quantity, and the description prints it from its own constant.
 */
const PLAN_NODE_LIMIT_CLAIMS = Object.freeze([
  /(\d{1,6}|«[^»]{1,160}»)[- ](?:nodes?|steps?)\s+(?:is|are)\s+the\s+(?:whole|entire)\s+plan/giu,
  /(?:at most|up to|no more than|maximum of|max of|limit(?:ed)? to|capped at)\s+(\d{1,6}|«[^»]{1,160}»)\s*[- ]?nodes?/giu,
  /(\d{1,6}|«[^»]{1,160}»)\s*[- ]?(?:nodes?|steps?)\s+(?:per|in)\s+(?:one\s+)?(?:plan|program)/giu,
]);

/** A `const NAME = <digits>` declaration, the only kind of number a published text may quote. */
const NUMERIC_CONSTANT =
  /^[ \t]*(?:export[ \t]+)?const[ \t]+([A-Za-z_$][\w$]*)(?::[^=\n]+)?[ \t]*=[ \t]*(\d+)[ \t]*;[ \t]*$/gmu;

/** An interpolation that quotes a declared constant, with or without `String(...)` around it. */
const QUOTED_CONSTANT = /^(?:String\(\s*([A-Za-z_$][\w$]*)\s*\)|([A-Za-z_$][\w$]*))$/u;

/**
 * A `description:` KEY, not a parameter of that name or the tail of a longer identifier.
 *
 * The module declares `(description: string) => ...` for its selector helper - a type annotation, not a text any model
 * reads - so the key is anchored on not being inside a parameter list.
 */
const PLAN_DESCRIPTION_KEY = /(?<![(\w$])description:\s*/gu;

/** The plan tool's own description, which is the guidance builder's text rather than a literal in that module. */
const BUILT_BY_GUIDANCE = /^planWorkDescription\s*\(/u;

/**
 * Why the planner's text need not name a tool, as closed classes so the count is a measurement.
 *
 * Each class is a claim about the TOOL, not a place to park an awkward name: `covered_by_this_description` says the
 * answer is already inside the very text that would point at the tool, and the two others say the reading is not an
 * input to writing a step.
 */
export const REASON_CLASSES = Object.freeze({
  covered_by_this_description:
    "the question this tool answers is already answered inside the planner's own text, so pointing at it would send " +
    "the companion to read a list it is holding",
  failure_diagnosis:
    "it diagnoses a step the world already refused; a plan is written from the snapshot and the vocabulary, and this " +
    "reading is spent afterwards, on a step that did not land",
  navigation_route:
    "it answers a route or destination question, and a plan step names its own tile instead of resolving one; the map " +
    "is consulted when a walk is in doubt, not while the script is written",
});

/**
 * The observation tools the planner's text deliberately does not name, each with the reason and its class.
 *
 * One entry per tool is the point: the gate reports the tool that has neither, so this table is the whole of the debt
 * and it can only shrink by making a tool worth naming.
 */
export const PLANNER_NEED_NOT_MENTION = Object.freeze({
  stardew_execution_status: {
    kind: "failure_diagnosis",
    reason:
      "a debugging view of the last execution receipt, which its own description says is not completion proof; a node's " +
      "`state` is where the plan learns its step landed, so naming this would advertise a reader the plan does not use",
  },
  stardew_read_scene: {
    kind: "failure_diagnosis",
    reason:
      "reachability of the affordances in front of you, read after a step was refused; a step names a target the " +
      "surface published, and this answers whether that target can be walked to once the world has said no",
  },
  stardew_interaction_catalog: {
    kind: "covered_by_this_description",
    reason:
      "the catalog lists exactly the published action vocabulary, which the planner's text already prints in full, one " +
      "line per family; pointing at it would send the companion to read what it holds",
  },
  stardew_search_interactions: {
    kind: "covered_by_this_description",
    reason:
      "the same vocabulary as the catalog, searched by a word; every name a plan may call is already printed under its " +
      "family in the planner's text, so a search over that list adds no name the text has not taught",
  },
  stardew_inspect_world_map: {
    kind: "navigation_route",
    reason:
      "the authoritative navigation graph for a warp, which a plan writes as the destination tile itself; the map is " +
      "the answer to a route in doubt, not an input to which step to write",
  },
  stardew_find_destination: {
    kind: "navigation_route",
    reason:
      "a destination query resolved against that same graph, so it shares the map's class: a plan's step carries " +
      "coordinates, and a route search is spent when the walk itself is the question",
  },
});

/** Blank TypeScript comments out, preserving every offset and newline. */
function blankCommentText(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "))
    .replace(/\/\/[^\n]*/gu, (comment) => " ".repeat(comment.length));
}

/** The body of the top-level function named `name`, from its signature to the closing brace in column 0, or null. */
export function functionBody(source, name) {
  const signature = source.indexOf(`function ${name}(`);
  if (signature < 0) return null;
  const closing = source.indexOf("\n}", signature);
  return closing < 0 ? null : source.slice(signature, closing + 2);
}

/**
 * The observation class, from the function whose returned array IS `integrationToolSet.observation`.
 *
 * `null` when the producer or its `defineTool` literals are gone: a population that could not be read is blocked, never
 * an empty population that passes.
 */
export function observationToolNames(source) {
  const producer = functionBody(blankCommentText(source), PRODUCER_FUNCTION);
  if (producer === null) return null;
  const names = new Set();
  for (const part of producer.split("defineTool({").slice(1)) {
    const match = /\bname:\s*"([a-z][a-z0-9_]*)"/u.exec(part);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return Object.freeze([...names].sort());
}

/**
 * The text a planning turn holds, from source with comments blanked.
 *
 * The whole function body is one string being built, so every literal in it is text the model reads; a doc comment
 * beside it is not.
 */
export function plannerGuidanceText(source) {
  const body = functionBody(blankCommentText(source), GUIDANCE_FUNCTION);
  return body === null ? null : body;
}

/** Does the guidance name this tool, and not merely as a prefix of a longer id? */
function names(text, toolName) {
  return new RegExp(`\\b${toolName}\\b`, "u").test(text);
}

/** A reader that turns an offset in `source` into the 1-based line the text is written on. */
function lineCounter(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") starts.push(index + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/** The offset just past a quoted run starting at `at`, so a quote inside an interpolation is not read as its end. */
function quotedEnd(source, at) {
  const quote = source[at];
  let index = at + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

/**
 * Every string and template literal in `source`, as the model would read it, with each interpolation kept as a
 * placeholder.
 *
 * The placeholder is the point: `«String(MAX_PLAN_NODES)»` and `«16»` are different claims about where the number comes
 * from, and only the second one can drift away from the constant that owns it. A plain number stays a number; an
 * interpolation stays visible as `«expression»`, so `planNodeLimitClaims` can tell a quoted constant from a typed digit.
 * Escapes are kept as written - a backtick escaped inside a template is text, not a delimiter.
 */
export function modelVisibleLiterals(source, start = 0, end = source.length) {
  const lineOf = lineCounter(source);
  const literals = [];
  let index = start;
  while (index < end) {
    const quote = source[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      index += 1;
      continue;
    }
    const { masked, next } = maskedLiteral(source, index, end);
    literals.push(Object.freeze({ line: lineOf(index), masked }));
    index = next;
  }
  return literals;
}

/**
 * One literal from `start` to the offset after its closing quote, with each interpolation kept as `«expression»`.
 *
 * Split from the scan above so neither half has to carry both questions: which runs of characters are literals, and where
 * one literal ends.
 */
function maskedLiteral(source, start, end) {
  const quote = source[start];
  let masked = "";
  let index = start + 1;
  while (index < end) {
    const character = source[index];
    if (character === "\\") {
      masked += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === quote) return { masked, next: index + 1 };
    if (quote === "`" && character === "$" && source[index + 1] === "{") {
      const { expression, next } = interpolation(source, index, end);
      masked += `«${expression}»`;
      index = next;
      continue;
    }
    masked += character;
    index += 1;
  }
  return { masked, next: end };
}

/** The expression of a `${...}` starting at `start`, and the offset after its closing brace. */
function interpolation(source, start, end) {
  let depth = 0;
  let cursor = start + 1;
  while (cursor < end) {
    const inner = source[cursor];
    if (inner === '"' || inner === "'" || inner === "`") {
      cursor = quotedEnd(source, cursor);
      continue;
    }
    if (inner === "{") depth += 1;
    else if (inner === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
    cursor += 1;
  }
  return { expression: source.slice(start + 2, cursor).trim(), next: cursor + 1 };
}

/** Every `const NAME = <digits>` in these sources, which is the set of numbers a published text may quote. */
export function numericConstants(...sources) {
  const constants = new Map();
  for (const source of sources) {
    for (const match of blankCommentText(source).matchAll(NUMERIC_CONSTANT)) constants.set(match[1], Number(match[2]));
  }
  return constants;
}

/**
 * The places the plan surface publishes prose to the model, each with the literals it is made of.
 *
 * Two sources, and neither is a list of sentences: the planner's guidance is the whole body of the function that builds
 * it, and the tool module is read at every `description:` key it declares. The plan tool's own `description:` is that same
 * guidance, so the call to its builder is the place already counted rather than a second text. Any other `description:`
 * whose value is not a literal is a place this gate could not read, which is `plan_node_limit_place_unreadable` rather
 * than a place it skipped.
 */
export function planTextPlaces({ guidanceSource, toolsSource }) {
  const places = [];
  const unreadable = [];
  const script = blankCommentText(guidanceSource);
  const guidance = plannerGuidanceText(guidanceSource);
  if (guidance !== null) {
    // Read in the FILE's coordinates, not the function body's: a finding has to name the line the sentence is written on.
    const start = script.indexOf(guidance);
    places.push({ place: GUIDANCE_PATH, literals: modelVisibleLiterals(script, start, start + guidance.length) });
  }
  const tools = blankCommentText(toolsSource);
  const lineOf = lineCounter(tools);
  for (const match of tools.matchAll(PLAN_DESCRIPTION_KEY)) {
    const at = match.index + match[0].length;
    if (tools[at] === '"' || tools[at] === "'" || tools[at] === "`") {
      const [literal] = modelVisibleLiterals(tools, at);
      places.push({ place: PLAN_TOOLS_PATH, literals: literal === undefined ? [] : [literal] });
      continue;
    }
    // The plan tool's own description IS the guidance read above, so this value is a call to the builder this gate has
    // already anchored, not a second text nobody read.
    if (BUILT_BY_GUIDANCE.test(tools.slice(at, at + 64))) continue;
    unreadable.push(`${PLAN_TOOLS_PATH}:${lineOf(match.index)}`);
  }
  return { places, unreadable };
}

/** What a claim's number token is worth: the digits it states, and whether it was quoted from a constant. */
export function quotedLimit(token, constants) {
  if (!token.startsWith("«")) return { value: Number(token), derived: false };
  const expression = token.slice(1, -1);
  const quoted = QUOTED_CONSTANT.exec(expression);
  const name = quoted?.[1] ?? quoted?.[2];
  const value = name === undefined ? undefined : constants.get(name);
  return value === undefined ? { value: null, derived: true, expression } : { value, derived: true, name };
}

/**
 * The plan's node limit as the product really has it, and every claim the published text makes about it.
 *
 * The real limit is READ FROM THE GUARD - the constant `isFull()` compares `state.nodes.length` against - so this reading
 * does not carry a second copy of the number to drift from it.
 */
export function planNodeLimitReading({ guidanceSource, toolsSource }) {
  const script = blankCommentText(guidanceSource);
  const guard = PLAN_FULL_GUARD.exec(script);
  const limitConstant = guard?.[1];
  const constants = numericConstants(script, toolsSource);
  const realLimit = limitConstant === undefined ? undefined : constants.get(limitConstant);
  const { places, unreadable } = planTextPlaces({ guidanceSource, toolsSource });
  const claims = [];
  const seen = new Set();
  for (const { place, literals } of places) {
    for (const literal of literals) {
      for (const pattern of PLAN_NODE_LIMIT_CLAIMS) {
        for (const match of literal.masked.matchAll(pattern)) {
          const key = `${place}:${literal.line}:${match[0]}`;
          if (seen.has(key)) continue;
          seen.add(key);
          claims.push({ place, line: literal.line, quoted: quotedLimit(match[1], constants), text: match[0] });
        }
      }
    }
  }
  return { limitConstant, realLimit, places, unreadable, claims };
}

function defaultRead(root, relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

/**
 * The rules this gate asserts, one entry per finding code it can report red with.
 *
 * The report is built from this table, not from the findings: a rule that passed today is still enumerated, because a
 * gate that prints only what it found cannot be told apart from one that never looked. `prerequisite` marks the readings
 * that make the population trustworthy - when one of them fails nothing below it was measured, which is `not_measured`
 * rather than a pass.
 */
export const RULES = Object.freeze([
  {
    id: "observation_chain_anchored",
    codes: ["observation_chain_unanchored"],
    prerequisite: "the class being read is not the one the Game surface mounts",
  },
  {
    id: "observation_population_derived",
    codes: ["observation_population_empty"],
    prerequisite: "the declaration mounts no observation tool, so nothing was measured",
  },
  {
    id: "guidance_read_from_source",
    codes: ["guidance_unanchored"],
    prerequisite: "the planner's guidance was not found, so no name could be missing from it",
  },
  { id: "every_observation_tool_named_or_reasoned", codes: ["planner_guidance_omits_tool"] },
  { id: "reason_table_not_stale", codes: ["planner_guidance_reason_stale"] },
  { id: "reason_class_declared_and_stated", codes: ["planner_guidance_reason_unreasoned"] },
  { id: "reason_table_reads_the_declaration", codes: ["planner_guidance_reason_unknown_tool"] },
  {
    id: "plan_node_limit_read_from_the_guard",
    codes: ["plan_node_limit_guard_unanchored"],
    prerequisite:
      "`isFull()` no longer compares the node count against a declared constant, so there is no real limit to compare the " +
      "published text with",
  },
  {
    id: "plan_text_population_readable",
    codes: ["plan_node_limit_population_empty", "plan_node_limit_place_unreadable"],
    prerequisite: "the plan surface publishes no text this gate could read, so no number in it was examined",
  },
  {
    id: "plan_node_limit_agrees_with_the_guard",
    codes: ["plan_node_limit_disagrees", "plan_node_limit_unresolved"],
  },
  { id: "plan_node_limit_not_typed_into_the_text", codes: ["plan_node_limit_hand_written"] },
]);

/** The per-rule outcomes, each rule's findings named, in `RULES` order. */
export function ruleChecks(findings) {
  const checks = RULES.map((rule) => {
    const hits = findings.filter((finding) => rule.codes.includes(finding.code));
    if (hits.length === 0) return { id: rule.id, status: "passed" };
    const named = hits.map((finding) => `${finding.code}:${finding.member}`);
    return rule.prerequisite === undefined
      ? { id: rule.id, status: "failed", findings: named }
      : { id: rule.id, status: "not_measured", findings: named, reason: rule.prerequisite };
  });
  // A finding code this table does not name is a rule reported red and absent from the report, so it is enumerated
  // rather than dropped: the report's population stays the gate's own capability.
  const covered = RULES.flatMap((rule) => rule.codes);
  for (const finding of findings) {
    if (covered.includes(finding.code)) continue;
    checks.push({
      id: `unclassified:${finding.code}`,
      status: "failed",
      findings: [`${finding.code}:${finding.member}`],
    });
  }
  return checks;
}

/**
 * The findings every stated plan-node limit earns, and the two counts the verdict line prints.
 *
 * Kept out of the gate's own body because each claim is read three ways - where the number came from, whether this gate can
 * resolve it, and whether it agrees with the guard - and inlining those three is what turns a reading into a thicket.
 */
function planNodeLimitClaimFindings(planLimit, push) {
  const disagreeing = [];
  const handWritten = [];
  for (const claim of planLimit.claims) {
    const sentence = `${claim.place}:${claim.line}: "${claim.text}"`;
    if (!claim.quoted.derived) {
      handWritten.push(claim.text);
      push(
        "plan_node_limit_hand_written",
        String(claim.quoted.value),
        `${sentence} - the count is typed into the text; quote ${planLimit.limitConstant ?? "the guard's constant"} ` +
          "instead, so it cannot drift from the guard that enforces it",
      );
    }
    if (claim.quoted.value === null) {
      disagreeing.push(claim.text);
      push(
        "plan_node_limit_unresolved",
        `${claim.place}:${claim.line}`,
        `${sentence} - ${claim.quoted.expression} is not a declared numeric constant, so the number the model reads ` +
          "cannot be checked here",
      );
      continue;
    }
    if (planLimit.realLimit !== undefined && claim.quoted.value !== planLimit.realLimit) {
      disagreeing.push(claim.text);
      push(
        "plan_node_limit_disagrees",
        `${claim.quoted.value}:${planLimit.realLimit}`,
        `${sentence} - the text states ${claim.quoted.value} nodes and the guard states ${planLimit.realLimit} in ` +
          String(planLimit.limitConstant),
      );
    }
  }
  return { disagreeing, handWritten };
}

/**
 * The two anchors that make the observation tools the MOUNTED class, rather than a function that happens to return tools.
 */
function observationChainFindings(read, push) {
  for (const [file, anchor, what] of [
    [ADAPTER_PATH, ADAPTER_ANCHOR, "the adapter no longer hands it to the tool set as `observation`"],
    [RUNTIME_CORE_PATH, RUNTIME_ANCHOR, "the Game surface no longer mounts `integrationToolSet.observation`"],
  ]) {
    if (!anchor.test(blankCommentText(read(file))))
      push("observation_chain_unanchored", file, `${what}; the population below is not the mounted observation class`);
  }
}

/**
 * The plan's node limit, read from the guard and compared with every number the published text states about it.
 *
 * A prerequisite that cannot be read - no guard, no constant, no text - is a finding rather than an empty comparison,
 * because a limit nobody could read has not been checked and the gate must not report that as agreement.
 */
function planNodeLimitFindings(read, push) {
  const planLimit = planNodeLimitReading({ guidanceSource: read(GUIDANCE_PATH), toolsSource: read(PLAN_TOOLS_PATH) });
  if (planLimit.realLimit === undefined)
    push(
      "plan_node_limit_guard_unanchored",
      PLAN_FULL_GUARD.source,
      `${GUIDANCE_PATH} declares no isFull() guard comparing state.nodes.length against a declared constant, so there is ` +
        "no real limit to hold the published text to",
    );
  if (planLimit.places.length === 0)
    push(
      "plan_node_limit_population_empty",
      PLAN_TOOLS_PATH,
      "the plan surface publishes no description text at all, so nothing was examined",
    );
  for (const where of planLimit.unreadable)
    push(
      "plan_node_limit_place_unreadable",
      where,
      "this description is not a string or template literal, so the text it publishes to the model was not read; write " +
        "it as one so a number in it can be checked",
    );
  return { planLimit, ...planNodeLimitClaimFindings(planLimit, push) };
}

/**
 * @param {{ root?: string, overrides?: Record<string, string>, reasons?: object }} options
 */
export function checkPlannerGuidanceObservationTools({
  root = repositoryRoot,
  overrides = {},
  reasons = PLANNER_NEED_NOT_MENTION,
} = {}) {
  const read = (relativePath) => overrides[relativePath] ?? defaultRead(root, relativePath);
  const findings = [];
  const push = (code, member, detail) => findings.push({ code, member, detail });

  observationChainFindings(read, push);

  const tools = observationToolNames(read(PRODUCER_PATH));
  const guidance = plannerGuidanceText(read(GUIDANCE_PATH));
  if (tools === null || tools.length === 0)
    push(
      "observation_population_empty",
      PRODUCER_FUNCTION,
      `${PRODUCER_PATH} declares no observation tool, so nothing was measured`,
    );
  if (guidance === null)
    push(
      "guidance_unanchored",
      GUIDANCE_FUNCTION,
      `${GUIDANCE_PATH} declares no planner guidance, so nothing was read`,
    );

  const named = [];
  const reasoned = [];
  for (const toolName of tools ?? []) {
    const reason = reasons[toolName];
    if (guidance !== null && names(guidance, toolName)) {
      named.push(toolName);
      if (reason !== undefined)
        push(
          "planner_guidance_reason_stale",
          toolName,
          "the planner's text names this tool now, so the reason for not naming it has been overtaken; delete the entry",
        );
      continue;
    }
    if (reason === undefined) {
      push(
        "planner_guidance_omits_tool",
        toolName,
        "mounted on the Game surface as an observation tool, named nowhere in the planner's text, and no stated reason " +
          "here says why the planner need not mention it - name it there, or record the class and reason here",
      );
      continue;
    }
    reasoned.push(toolName);
    if (!Object.hasOwn(REASON_CLASSES, reason.kind))
      push("planner_guidance_reason_unreasoned", toolName, `unknown reason class "${reason.kind}"`);
    else if (typeof reason.reason !== "string" || reason.reason.length < 40)
      push("planner_guidance_reason_unreasoned", toolName, "the reason is too short to name anything");
  }
  const mounted = new Set(tools ?? []);
  for (const toolName of Object.keys(reasons)) {
    if (!mounted.has(toolName))
      push(
        "planner_guidance_reason_unknown_tool",
        toolName,
        "the observation class mounts no such tool; delete the entry so the table stays a reading of the declaration",
      );
  }

  // THE PLAN'S NODE LIMIT: one number, published as prose, owned by a guard.
  const { planLimit, disagreeing, handWritten } = planNodeLimitFindings(read, push);

  findings.sort((left, right) => `${left.code}:${left.member}`.localeCompare(`${right.code}:${right.member}`));
  const checks = ruleChecks(findings);
  return Object.freeze({
    gate,
    status: checks.some((check) => check.status === "not_measured")
      ? "blocked"
      : checks.some((check) => check.status === "failed")
        ? "failed"
        : "passed",
    examined: Object.freeze({
      observationTools: (tools ?? []).length,
      named: named.length,
      withReason: reasoned.length,
      planTextPlaces: planLimit.places.length,
      planLimitClaims: planLimit.claims.length,
      planLimitDisagreements: disagreeing.length,
    }),
    planNodeLimit: Object.freeze({
      constant: planLimit.limitConstant ?? null,
      real: planLimit.realLimit ?? null,
      places: planLimit.places.length,
      stating: planLimit.claims.length,
      disagree: disagreeing.length,
      handWritten: handWritten.length,
    }),
    tools: tools ?? Object.freeze([]),
    named: Object.freeze(named),
    reasoned: Object.freeze(reasoned),
    findings: Object.freeze(findings),
    checks: Object.freeze(checks),
  });
}

export function renderReport(result) {
  const lines = [
    `observation tools examined ${result.examined.observationTools} · named ${result.examined.named} · with a reason ` +
      String(result.examined.withReason),
    `plan node limit · places examined ${result.planNodeLimit.places} · state a limit ` +
      `${result.planNodeLimit.stating} · disagree ${result.planNodeLimit.disagree}`,
    `plan node limit · real ${result.planNodeLimit.real ?? "unreadable"} from ` +
      `${result.planNodeLimit.constant ?? "no guard"} · typed into the text ${result.planNodeLimit.handWritten}`,
  ];
  for (const toolName of result.tools) {
    const reason = PLANNER_NEED_NOT_MENTION[toolName];
    lines.push(
      `planner_guidance_observation_tool:${toolName}: ` +
        (result.named.includes(toolName) ? "named" : `${reason?.kind ?? "omitted"}`),
    );
  }
  for (const finding of result.findings)
    lines.push(`planner_guidance_${finding.code}: ${finding.member} - ${finding.detail}`);
  lines.push(
    `planner_guidance_observation_tools: ${result.status}` +
      `${result.findings.length === 0 ? "" : ` (${result.findings.length} finding(s))`}`,
  );
  lines.push(
    JSON.stringify({ gate: result.gate, examined: result.examined, checks: result.checks, status: result.status }),
  );
  return { lines, exitCode: result.findings.length === 0 ? 0 : 1 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { lines, exitCode } = renderReport(checkPlannerGuidanceObservationTools());
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exitCode = exitCode;
}
