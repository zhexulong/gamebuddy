/**
 * Build the first, conservative layer of the source-derived Player-Reachable
 * Command Path (PRCP) audit graph.
 *
 * This module never defines an Agent action and never injects input. It reads
 * the target-version source reconstruction only to verify that normal-player
 * control routing contains known semantic ingress branches. Every discovered
 * ingress branch begins as a command-path candidate; a later equivalence map
 * must supply its typed bridge route before completeness can pass.
 */

import { extractLiteralOperationSelectors } from "./stardew-gameplay-surface-selector.mjs";
import {
  GAME_LOCATION_CHECK_ACTION_BRANCHES,
  GAME1_PRESS_USE_TOOL_BUTTON_BRANCHES,
  PLAYER_COMMAND_BOUNDARY_CANDIDATES,
  PLAYER_INGRESS_ROOTS,
  TOOL_BEGIN_USING_BRANCHES,
  TOOL_END_USING_BRANCHES,
  TOOL_OVERRIDE_BRANCHES,
} from "./stardew-player-command-branches.mjs";
import { classifyIngressReachableCall, classifyWorldDispatcherCall } from "./stardew-player-command-classification.mjs";

function methodBody(source, methodName) {
  // Declaration prefixes prevent a call-site like `if (pressActionButton()) {`
  // from being mistaken for the method body when both occur in Game1.cs.
  const declaration = new RegExp(
    String.raw`(?:^|\n)\s*(?:public|private|protected|internal)\s+(?:(?:static|virtual|override|sealed|async)\s+)*(?:[\w<>,.?\[\]]+\s+)+${methodName}\s*\([^;{}]*\)\s*\{`,
    "g",
  );
  const match = declaration.exec(source);
  if (!match) return null;
  const openBrace = match.index + match[0].length - 1;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return source.slice(openBrace + 1, index);
  }
  return null;
}

function matchingDelimiter(source, openOffset, openCharacter, closeCharacter) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openOffset; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === openCharacter) depth += 1;
    else if (character === closeCharacter && --depth === 0) return index;
  }
  return -1;
}

/**
 * Return the source range for the innermost `if (...) { ... }` that owns a
 * fragment in its condition/body. This rejects a list of fragment matches
 * merely scattered across unrelated sibling branches.
 */
function enclosingConditionalBlockRange(source, offset) {
  // Do not choose merely the last textual `if` before an offset: sibling
  // branches can occur later in the same containing block. Select the
  // innermost conditional whose body actually encloses the target offset.
  const conditional = /\bif\s*\(/g;
  const candidates = [];
  const prefix = source.slice(0, offset + 1);
  let match;
  while ((match = conditional.exec(prefix))) {
    const openParenthesis = source.indexOf("(", match.index);
    const closeParenthesis = matchingDelimiter(source, openParenthesis, "(", ")");
    if (closeParenthesis < 0) continue;
    const nextToken = source.slice(closeParenthesis + 1).search(/\S/);
    if (nextToken < 0) continue;
    const statementStart = closeParenthesis + 1 + nextToken;
    if (source[statementStart] === "{") {
      const closeBrace = matchingDelimiter(source, statementStart, "{", "}");
      if (closeBrace >= offset) candidates.push({ start: match.index, end: closeBrace });
    } else {
      // Target source normally uses braces, but accept a decompiler/test
      // single-statement branch without treating it as an unknown omission.
      const statementEnd = source.indexOf(";", statementStart);
      if (statementEnd >= offset) candidates.push({ start: match.index, end: statementEnd });
    }
  }
  return candidates.sort((left, right) => left.end - left.start - (right.end - right.start))[0] ?? null;
}

function enclosingStatementBlockRange(source, offset) {
  const stack = [];
  let quote = null;
  let escaped = false;
  for (let index = 0; index <= offset; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") stack.push(index);
    else if (character === "}") stack.pop();
  }
  const start = stack.at(-1);
  if (start === undefined) return null;
  const end = matchingDelimiter(source, start, "{", "}");
  return end < 0 ? null : { start, end };
}

function enclosingBlockRanges(source, offset) {
  const ranges = [];
  const statement = enclosingStatementBlockRange(source, offset);
  if (statement) ranges.push(statement);
  const conditional = /\bif\s*\(/g;
  let match;
  while ((match = conditional.exec(source.slice(0, offset + 1))) !== null) {
    const open = source.indexOf("(", match.index);
    const close = matchingDelimiter(source, open, "(", ")");
    if (close < 0) continue;
    const whitespace = source.slice(close + 1).search(/\S/);
    if (whitespace < 0) continue;
    const start = close + 1 + whitespace;
    const end = source[start] === "{" ? matchingDelimiter(source, start, "{", "}") : source.indexOf(";", start);
    // The native call can be part of an `if` condition (for example
    // `TryGetValue(...) && performToolAction(...)`), not only its body.
    if (end >= offset && offset >= match.index) ranges.push({ start: match.index, end });
  }
  return ranges
    .filter((range) => range.end >= offset)
    .sort((left, right) => left.end - left.start - (right.end - right.start));
}

function positionOfAll(source, fragment) {
  const positions = [];
  let start = 0;
  while (true) {
    const index = source.indexOf(fragment, start);
    if (index < 0) return positions;
    positions.push(index);
    start = index + fragment.length;
  }
}

const NON_CALL_IDENTIFIERS = new Set([
  "if",
  "for",
  "foreach",
  "while",
  "switch",
  "catch",
  "using",
  "lock",
  "return",
  "new",
  "typeof",
  "nameof",
  "default",
  "base",
  "this",
]);

function callsFromMethodBody(body) {
  if (!body) return [];
  const calls = new Map();
  const pattern = /\b((?:[A-Za-z_]\w*\s*\.\s*)*[A-Za-z_]\w*)\s*(?:<[^;{}()\r\n]+>)?\s*\(/g;
  for (const match of body.matchAll(pattern)) {
    const expression = match[1].replace(/\s+/g, "");
    const leaf = expression.split(".").at(-1);
    if (NON_CALL_IDENTIFIERS.has(leaf)) continue;
    if (!calls.has(expression)) calls.set(expression, { expression, leaf, sourceOffset: match.index });
  }
  return [...calls.values()].sort((left, right) => left.expression.localeCompare(right.expression));
}

/**
 * Find a matching method across the temporary target-version source tree.
 * The source type may use a namespace-shaped path such as
 * StardewValley.GameLocation; callers must still treat dynamic overrides as
 * unresolved until their branch targets are reconstructed.
 */
function sourceForType(sourceIndex, typeName) {
  if (!sourceIndex || typeof sourceIndex !== "object") return null;
  const normalize = (candidateType, value) =>
    typeof value === "string"
      ? { typeName: candidateType, source: value, sourceFile: `${candidateType.replaceAll(".", "/")}.cs` }
      : value && typeof value.source === "string"
        ? {
            typeName: candidateType,
            source: value.source,
            sourceFile: value.sourceFile ?? `${candidateType.replaceAll(".", "/")}.cs`,
          }
        : null;
  const exact = normalize(typeName, sourceIndex[typeName]);
  if (exact) return exact;
  const shortType = typeName.split(".").at(-1);
  const candidates = Object.entries(sourceIndex)
    .map(([candidateType, value]) => normalize(candidateType, value))
    .filter((candidate) => candidate && candidate.typeName.split(".").at(-1) === shortType)
    .sort((left, right) => left.typeName.localeCompare(right.typeName));
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Expand the shared GameLocation.checkAction boundary after the control router
 * has reached it through either action-button targeting or tool-use targeting.
 * A synthetic tryToCheckAt edge is explicit provenance, not a collapsed route.
 */
function reachableSecondHopEdges(gameLocationSource, rootDispatchEdges, ingress, options) {
  if (!gameLocationSource) return [];
  const edges = [];
  const actionRoot = ingress.ingressRoots.find(
    (root) => root.ingressId === "world_action_interaction" && root.classification !== "unknown",
  );
  const toolRoot = ingress.ingressRoots.find(
    (root) => root.ingressId === "world_tool_use" && root.classification !== "unknown",
  );
  const actionReachesCheck =
    actionRoot &&
    rootDispatchEdges.some((edge) => edge.ingressId === actionRoot.ingressId && edge.to === "tryToCheckAt");
  const toolReachesCheck =
    toolRoot &&
    rootDispatchEdges.some(
      (edge) => edge.ingressId === toolRoot.ingressId && edge.to === "currentLocation.checkAction",
    );
  if (actionReachesCheck) {
    edges.push({
      edgeId: "StardewValley.Game1.tryToCheckAt->StardewValley.GameLocation.checkAction",
      from: "StardewValley.Game1.tryToCheckAt",
      to: "StardewValley.GameLocation.checkAction",
      sourceType: "StardewValley.Game1",
      sourceFile: options.sourceFile ?? "StardewValley/Game1.cs",
      sourceMethod: "tryToCheckAt",
      ingressId: actionRoot.ingressId,
      classification: "candidate_dispatch_edge",
      reason: "second_hop_source_anchor",
    });
  }
  for (const root of [actionRoot, toolRoot].filter(Boolean)) {
    const reachesCheck = root.ingressId === "world_action_interaction" ? actionReachesCheck : toolReachesCheck;
    if (!reachesCheck) continue;
    edges.push(
      ...extractDirectCallEdges(gameLocationSource.source, "checkAction", {
        sourceType: gameLocationSource.typeName,
        sourceFile: gameLocationSource.sourceFile,
        ingressId: root.ingressId,
      }).map((edge) => ({ ...edge, reason: "second_hop_from_game_location_check_action" })),
    );
  }
  return edges;
}

/**
 * Read source-specific rule branches only after proving the normal control
 * router reaches GameLocation.checkAction. A branch candidate retains every
 * source fragment and offset; it is not inferred from the candidate name.
 */
function sourceBranchCandidates({ source, sourceType, sourceFile, sourceMethod, definitions, sourceEdgeIds, reason }) {
  const body = methodBody(source, sourceMethod);
  if (body === null) return [];
  return definitions
    .map((definition) => {
      const positions = Object.fromEntries(
        definition.requiredFragments.map((fragment) => [fragment, positionOfAll(body, fragment).slice(0, 8)]),
      );
      if (Object.values(positions).some((offsets) => offsets.length === 0)) return null;
      const anchorFragment = definition.branchAnchorFragment ?? definition.requiredFragments[0];
      const candidateOffsets = positionOfAll(body, anchorFragment).slice(0, 8);
      const evidence = candidateOffsets
        .map((primaryOffset) => {
          const nonTerminalFragments = definition.requiredFragments;
          const ranges = enclosingBlockRanges(body, primaryOffset);
          const smallestContainingAll = ranges.find((branchRange) =>
            nonTerminalFragments.every((fragment) =>
              (positions[fragment] ?? []).some((offset) => offset >= branchRange.start && offset <= branchRange.end),
            ),
          );
          // In compact source a placement call can sit in an outer object branch
          // preceded by a target-resolution helper. The helper is still part of
          // the same path only when the common outer scope proves every fragment;
          // sibling-only fragments remain rejected because no shared scope exists.
          if (smallestContainingAll) return smallestContainingAll;
          // Some leaf tool overrides contain unrelated early guards followed by a
          // linear native transition (for example Axe's location action and Pan
          // delivery). A definition must explicitly opt in, and its anchor must
          // not itself belong to a conditional; this never merges sibling branches.
          if (definition.allowMethodScope && !enclosingConditionalBlockRange(body, primaryOffset))
            return { start: 0, end: body.length };
          // A fully linear leaf body can retain method-scope provenance without a
          // special opt-in because it has no sibling conditional branches.
          return /\bif\s*\(/.test(body) ? null : { start: 0, end: body.length };
        })
        .find(Boolean);
      if (!evidence) return null;
      return {
        ...definition,
        sourceEdgeIds,
        sourceEvidence: {
          sourceType,
          sourceFile,
          sourceMethod,
          branchKind: "source_fragment_conjunction",
          requiredFragments: definition.requiredFragments,
          contextFragments: [],
          anchorPositions: positions,
          branchRange: evidence,
        },
        status: "boundary_candidate",
        route: null,
        reason,
      };
    })
    .filter(Boolean);
}

export function game1PressUseToolButtonBranchCandidates(game1Source, rootDispatchEdges, ingress, options = {}) {
  const root = ingress.ingressRoots.find(
    (item) => item.ingressId === "world_tool_use" && item.classification !== "unknown",
  );
  if (
    !(
      root &&
      rootDispatchEdges.some((edge) => edge.ingressId === root.ingressId && edge.from.endsWith(".pressUseToolButton"))
    )
  )
    return [];
  return sourceBranchCandidates({
    source: game1Source,
    sourceType: options.sourceType ?? "StardewValley.Game1",
    sourceFile: options.sourceFile ?? "StardewValley/Game1.cs",
    sourceMethod: "pressUseToolButton",
    definitions: GAME1_PRESS_USE_TOOL_BUTTON_BRANCHES,
    sourceEdgeIds: rootDispatchEdges
      .filter((edge) => edge.ingressId === root.ingressId && edge.from.endsWith(".pressUseToolButton"))
      .map((edge) => edge.edgeId),
    reason: "target_domain_and_bridge_equivalence_not_yet_reconstructed",
  });
}

export function toolOverrideBranchCandidates(sourceIndex, rootDispatchEdges, ingress) {
  const root = ingress.ingressRoots.find(
    (item) => item.ingressId === "world_tool_use" && item.classification !== "unknown",
  );
  const toolDispatchEdges = rootDispatchEdges.filter(
    (edge) =>
      edge.ingressId === "world_tool_use" && (edge.to.includes("BeginUsingTool") || edge.to.includes("DoFunction")),
  );
  if (!root || toolDispatchEdges.length === 0) return [];
  return TOOL_OVERRIDE_BRANCHES.flatMap((definition) => {
    const source = sourceForType(sourceIndex, definition.sourceType);
    if (!source) return [];
    return sourceBranchCandidates({
      source: source.source,
      sourceType: source.typeName,
      sourceFile: source.sourceFile,
      sourceMethod: definition.sourceMethod,
      definitions: [definition],
      sourceEdgeIds: toolDispatchEdges.map((edge) => edge.edgeId),
      reason: "dynamic_tool_target_domain_phase_and_bridge_equivalence_not_yet_reconstructed",
    });
  });
}

export function toolBeginUsingBranchCandidates(sourceIndex, beginEdges, ingress) {
  const root = ingress.ingressRoots.find(
    (item) => item.ingressId === "world_tool_use" && item.classification !== "unknown",
  );
  if (!(root && beginEdges.some((edge) => edge.ingressId === root.ingressId && edge.to.includes("beginUsing"))))
    return [];
  const source = sourceForType(sourceIndex, "StardewValley.Tools.FishingRod");
  if (!source) return [];
  return sourceBranchCandidates({
    source: source.source,
    sourceType: source.typeName,
    sourceFile: source.sourceFile,
    sourceMethod: "beginUsing",
    definitions: TOOL_BEGIN_USING_BRANCHES,
    sourceEdgeIds: beginEdges
      .filter((edge) => edge.ingressId === root.ingressId && edge.to.includes("beginUsing"))
      .map((edge) => edge.edgeId),
    reason: "fishing_phase_target_domain_and_bridge_equivalence_not_yet_reconstructed",
  });
}

export function toolEndUsingBranchCandidates(sourceIndex, releaseEdges, ingress) {
  const root = ingress.ingressRoots.find(
    (item) => item.ingressId === "world_tool_release" && item.classification !== "unknown",
  );
  if (!(root && releaseEdges.some((edge) => edge.ingressId === root.ingressId && edge.to.includes("endUsing"))))
    return [];
  const source = sourceForType(sourceIndex, "StardewValley.Tool");
  if (!source) return [];
  return sourceBranchCandidates({
    source: source.source,
    sourceType: source.typeName,
    sourceFile: source.sourceFile,
    sourceMethod: "endUsing",
    definitions: TOOL_END_USING_BRANCHES,
    sourceEdgeIds: releaseEdges
      .filter((edge) => edge.ingressId === root.ingressId && edge.to.includes("endUsing"))
      .map((edge) => edge.edgeId),
    reason: "tool_release_phase_target_domain_and_bridge_equivalence_not_yet_reconstructed",
  });
}

export function gameLocationCheckActionBranchCandidates(gameLocationSource, rootDispatchEdges, ingress) {
  if (!gameLocationSource) return [];
  const actionRoot = ingress.ingressRoots.find(
    (root) => root.ingressId === "world_action_interaction" && root.classification !== "unknown",
  );
  const actionReachesCheck =
    actionRoot &&
    rootDispatchEdges.some((edge) => edge.ingressId === actionRoot.ingressId && edge.to === "tryToCheckAt");
  if (!actionReachesCheck) return [];
  const body = methodBody(gameLocationSource.source, "checkAction");
  if (body === null) return [];
  return GAME_LOCATION_CHECK_ACTION_BRANCHES.map((definition) => {
    const positions = Object.fromEntries(
      definition.requiredFragments.map((fragment) => [fragment, positionOfAll(body, fragment).slice(0, 8)]),
    );
    const contextPositions = Object.fromEntries(
      (definition.contextFragments ?? []).map((fragment) => [fragment, positionOfAll(body, fragment).slice(0, 8)]),
    );
    if (
      Object.values(positions).some((offsets) => offsets.length === 0) ||
      Object.values(contextPositions).some((offsets) => offsets.length === 0)
    )
      return null;
    const anchorFragment = definition.branchAnchorFragment ?? definition.requiredFragments[0];
    const candidateOffsets = positionOfAll(body, anchorFragment).slice(0, 8);
    const evidence = candidateOffsets
      .map((primaryOffset) => {
        // A source branch may be represented by an outer condition plus a
        // nested short-circuit/return expression. Pick the smallest enclosing
        // range that proves the whole conjunction, never arbitrary sibling
        // fragments elsewhere in checkAction.
        const terminalFragments = definition.terminalFragments
          ? definition.terminalFragments.filter((fragment) => Array.isArray(positions[fragment]))
          : [];
        const nonTerminalFragments = definition.requiredFragments.filter(
          (fragment) => !terminalFragments.includes(fragment),
        );
        return (
          enclosingBlockRanges(body, primaryOffset).find((branchRange) => {
            if (
              nonTerminalFragments.some(
                (fragment) =>
                  !(positions[fragment] ?? []).some(
                    (offset) => offset >= branchRange.start && offset <= branchRange.end,
                  ),
              )
            )
              return false;
            if (
              terminalFragments.some(
                (fragment) =>
                  !positions[fragment].some((offset) => offset >= branchRange.start && offset <= body.length),
              )
            )
              return false;
            // A loop declaration is outside its nested `if` body; retain explicit
            // context evidence without weakening the branch-local conjunction.
            if (Object.values(contextPositions).some((offsets) => !offsets.some((offset) => offset <= branchRange.end)))
              return false;
            return true;
          }) ?? null
        );
      })
      .find(Boolean);
    if (!evidence) return null;
    const branchRange = evidence;
    return {
      ...definition,
      candidateId: definition.sourceVariant
        ? `${definition.candidateId}.${definition.sourceVariant}`
        : definition.candidateId,
      sourceEdgeIds: ["StardewValley.Game1.tryToCheckAt->StardewValley.GameLocation.checkAction"],
      sourceEvidence: {
        sourceType: gameLocationSource.typeName,
        sourceFile: gameLocationSource.sourceFile,
        sourceMethod: "checkAction",
        branchKind: "source_fragment_conjunction",
        requiredFragments: definition.requiredFragments,
        contextFragments: definition.contextFragments ?? [],
        anchorPositions: positions,
        branchRange,
      },
      status: "boundary_candidate",
      route: null,
      reason: "live_target_identity_and_bridge_equivalence_not_yet_reconstructed",
    };
  }).filter(Boolean);
}

/**
 * Extract direct call edges from a single reconstructed method. This is not a
 * whole-program call graph: unresolved virtual/external calls deliberately
 * remain candidate edges for later classification.
 */
/**
 * Expand literal map Action selectors below an already source-proved
 * `checkAction -> performAction` branch. These are command candidates, not
 * generic dispatcher routes: each carries the exact target-version selector
 * and stays pending until a finite typed route proves equivalent.
 */
export function gameLocationPerformActionSelectorCandidates(gameLocationSource, sourceBranchCandidates = []) {
  if (
    !(gameLocationSource && sourceBranchCandidates.some((candidate) => candidate.candidateId === "map.action_property"))
  )
    return [];
  const selectors = extractLiteralOperationSelectors(gameLocationSource.source, "performAction");
  return selectors.map((entry) => ({
    candidateId: `map.action_property.${entry.selectorKind}.${entry.selectorVariable ?? "literal"}.${entry.selector}`,
    ingressId: "world_action_interaction",
    semanticFamily: "map_operation",
    nativeRuleBoundaryCandidate: `GameLocation.performAction selector ${entry.selector}`,
    selector: entry.selector,
    selectorKind: entry.selectorKind,
    selectorVariable: entry.selectorVariable ?? null,
    sourceEdgeIds: ["StardewValley.Game1.tryToCheckAt->StardewValley.GameLocation.checkAction"],
    sourceEvidence: {
      sourceType: gameLocationSource.typeName,
      sourceFile: gameLocationSource.sourceFile,
      sourceMethod: "performAction",
      branchKind: "literal_operation_selector",
      parentCandidateId: "map.action_property",
      requiredFragments: [`${entry.selectorKind}:${entry.selector}`],
      anchorPositions: { [`${entry.selectorKind}:${entry.selector}`]: [] },
      selector: entry.selector,
      selectorKind: entry.selectorKind,
      selectorVariable: entry.selectorVariable ?? null,
    },
    status: "boundary_candidate",
    route: null,
    reason: "map_action_selector_requires_content_domain_and_typed_bridge_equivalence",
  }));
}

export function extractDirectCallEdges(
  source,
  methodName,
  {
    sourceType = "StardewValley.Game1",
    sourceFile = "StardewValley/Game1.cs",
    ingressId = null,
    dispatcherClassification = false,
  } = {},
) {
  const body = methodBody(source, methodName);
  if (body === null) return [];
  return callsFromMethodBody(body).map((call) => {
    const auditClassification = dispatcherClassification
      ? classifyWorldDispatcherCall(methodName, call.expression)
      : classifyIngressReachableCall(call.expression);
    return {
      edgeId: `${sourceType}.${methodName}->${call.expression}`,
      from: `${sourceType}.${methodName}`,
      to: call.expression,
      sourceType,
      sourceFile,
      sourceMethod: methodName,
      sourceOffset: call.sourceOffset,
      ...(ingressId ? { ingressId } : {}),
      classification: auditClassification?.classification ?? "candidate_dispatch_edge",
      ...(auditClassification ? { reason: auditClassification.reason } : {}),
    };
  });
}

/**
 * Return source-derived root edges from the exact target Game1 control router.
 * Absence is unknown, never evidence that a player cannot issue that command.
 */
export function extractPlayerIngressRoots(
  game1Source,
  { sourceFile = "StardewValley/Game1.cs", sourceType = "StardewValley.Game1" } = {},
) {
  const rootBodies = new Map();
  for (const definition of PLAYER_INGRESS_ROOTS) {
    const sourceMethod = definition.sourceMethod ?? "UpdateControlInput";
    rootBodies.set(sourceMethod, methodBody(game1Source, sourceMethod));
  }
  const controlBody = rootBodies.get("UpdateControlInput");
  if (controlBody === null) {
    return {
      rootMethod: `${sourceType}.UpdateControlInput`,
      state: "unknown",
      sourceFile,
      errors: ["Game1.UpdateControlInput could not be located in the target-version source reconstruction."],
      ingressRoots: [],
    };
  }

  const ingressRoots = PLAYER_INGRESS_ROOTS.map((definition) => {
    const sourceMethod = definition.sourceMethod ?? "UpdateControlInput";
    const body = rootBodies.get(sourceMethod) ?? "";
    const missingFragments = definition.requiredFragments.filter((fragment) => !body.includes(fragment));
    const anchorPositions = Object.fromEntries(
      definition.requiredFragments.map((fragment) => [fragment, positionOfAll(body, fragment).slice(0, 8)]),
    );
    return {
      ingressId: definition.ingressId,
      inputState: definition.inputState,
      targetMethod: definition.targetMethod,
      sourceType,
      sourceFile,
      sourceMethod,
      requiredFragments: definition.requiredFragments,
      anchorPositions,
      classification: missingFragments.length === 0 ? "command_path_candidate" : "unknown",
      ...(missingFragments.length ? { missingFragments } : {}),
      // No PRCP is claimed until the candidate's target branches and native
      // rule boundary have been reconstructed and mapped to a typed route.
      prcpId: null,
      route: null,
    };
  });

  return {
    rootMethod: `${sourceType}.UpdateControlInput`,
    state: ingressRoots.some((root) => root.classification === "unknown") ? "incomplete" : "extracted",
    sourceFile,
    errors: [],
    ingressRoots,
  };
}

/** Create a normalized graph envelope used by the completeness gate. */
export function buildPlayerCommandGraph(game1Source, options = {}) {
  const ingress = extractPlayerIngressRoots(game1Source, options);
  const gameLocationSource = sourceForType(options.sourceIndex, "StardewValley.GameLocation");
  const farmerSource = sourceForType(options.sourceIndex, "StardewValley.Farmer");
  const unknownIngressRoots = ingress.ingressRoots.filter((root) => root.classification === "unknown");
  const rootEdges = ingress.ingressRoots.map((root) => ({
    edgeId: `${root.sourceType}.${root.sourceMethod}/${root.ingressId}->${root.targetMethod}`,
    from: `${root.sourceType}.${root.sourceMethod}:${root.ingressId}`,
    to: root.targetMethod,
    sourceFile: root.sourceFile,
    sourceMethod: root.sourceMethod,
    sourceAnchor: root.requiredFragments.at(-1),
    ingressId: root.ingressId,
    // A root itself is a control-router anchor, not yet a native dispatch.
    classification: root.classification === "unknown" ? "unknown" : "supporting_path",
    ...(root.classification === "unknown"
      ? { reason: "ingress_source_anchor_missing" }
      : { reason: "normal_player_control_router_anchor" }),
  }));
  const rootDispatchEdges = ingress.ingressRoots.flatMap((root) => {
    const match = root.targetMethod.match(/^StardewValley\.Game1\.(\w+)$/);
    return match && root.classification !== "unknown"
      ? extractDirectCallEdges(game1Source, match[1], {
          sourceFile: ingress.sourceFile,
          ingressId: root.ingressId,
          dispatcherClassification: ["pressActionButton", "pressUseToolButton"].includes(match[1]),
        })
      : [];
  });
  const worldCheckActionEdges = reachableSecondHopEdges(gameLocationSource, rootDispatchEdges, ingress, options);
  const releaseLifecycleEdges = ingress.ingressRoots
    .filter((root) => root.ingressId === "world_tool_release" && root.classification !== "unknown")
    .flatMap((root) =>
      extractDirectCallEdges(game1Source, root.sourceMethod, {
        sourceFile: ingress.sourceFile,
        ingressId: root.ingressId,
      }).filter((edge) => edge.to === "player.EndUsingTool"),
    );
  const toolReleaseSecondHopEdges =
    farmerSource && releaseLifecycleEdges.length > 0
      ? extractDirectCallEdges(farmerSource.source, "performEndUsingTool", {
          sourceType: farmerSource.typeName,
          sourceFile: farmerSource.sourceFile,
          ingressId: "world_tool_release",
        })
          .filter((edge) => edge.to.includes("endUsing"))
          .map((edge) => ({
            ...edge,
            edgeId: `${farmerSource.typeName}.performEndUsingTool->StardewValley.Tool.endUsing`,
            to: "StardewValley.Tool.endUsing",
            reason: "source_proved_tool_release_second_hop",
          }))
      : [];
  const toolBeginSecondHopEdges =
    farmerSource &&
    rootDispatchEdges.some((edge) => edge.ingressId === "world_tool_use" && edge.to.includes("BeginUsingTool"))
      ? extractDirectCallEdges(farmerSource.source, "performBeginUsingTool", {
          sourceType: farmerSource.typeName,
          sourceFile: farmerSource.sourceFile,
          ingressId: "world_tool_use",
        })
          .filter((edge) => edge.to.includes("beginUsing"))
          .map((edge) => ({
            ...edge,
            edgeId: `${farmerSource.typeName}.performBeginUsingTool->StardewValley.Tool.beginUsing`,
            to: "StardewValley.Tool.beginUsing",
            reason: "source_proved_tool_begin_second_hop",
          }))
      : [];
  const textDispatchEdges = ingress.ingressRoots
    .filter((root) => root.ingressId === "text_chat_submission" && root.classification !== "unknown")
    .flatMap((root) =>
      extractDirectCallEdges(game1Source, root.sourceMethod, {
        sourceFile: ingress.sourceFile,
        ingressId: root.ingressId,
      }).filter((edge) => /(?:textEntry|chatBox)\.(?:receive|release|leftClickHeld|gamePadButtonHeld)/.test(edge.to)),
    );
  const minigameDispatchEdges = ingress.ingressRoots
    .filter((root) => root.ingressId === "minigame_continuous_control" && root.classification !== "unknown")
    .flatMap((root) =>
      extractDirectCallEdges(game1Source, root.sourceMethod, {
        sourceFile: ingress.sourceFile,
        ingressId: root.ingressId,
      }).filter((edge) => /currentMinigame\.(?:receive|tick|forceQuit)|currentMinigame\?\.receive/.test(edge.to)),
    );
  const menuDispatchEdges = ingress.ingressRoots
    .filter((root) => root.ingressId === "menu_semantic_selection" && root.classification !== "unknown")
    .flatMap((root) =>
      extractDirectCallEdges(game1Source, root.sourceMethod, {
        sourceFile: ingress.sourceFile,
        ingressId: root.ingressId,
      }).filter((edge) =>
        /(?:childMenu|active_menu|chatBox)\.(?:receive|release|leftClickHeld|gamePadButtonHeld)|CurrentEvent\.receiveMouseClick/.test(
          edge.to,
        ),
      ),
    );
  const eventDispatchEdges = ingress.ingressRoots
    .filter((root) => root.ingressId === "event_dialogue_or_choice" && root.classification !== "unknown")
    .flatMap((root) =>
      extractDirectCallEdges(game1Source, "updateActiveMenu", {
        sourceFile: ingress.sourceFile,
        ingressId: root.ingressId,
      }).filter((edge) =>
        /CurrentEvent\.(?:receiveMouseClick|skipEvent)|childMenu\.receive|chatBox\.receive/.test(edge.to),
      ),
    );
  const allCandidateEdges = [
    ...rootEdges,
    ...rootDispatchEdges,
    ...worldCheckActionEdges,
    ...toolBeginSecondHopEdges,
    ...releaseLifecycleEdges,
    ...toolReleaseSecondHopEdges,
    ...menuDispatchEdges,
    ...eventDispatchEdges,
    ...textDispatchEdges,
    ...minigameDispatchEdges,
  ];
  const seenEdgeIds = new Set();
  const reachableEdges = allCandidateEdges.filter(
    (edge) => !seenEdgeIds.has(edge.edgeId) && seenEdgeIds.add(edge.edgeId),
  );
  const supportingPaths = reachableEdges
    .filter((edge) => edge.classification === "supporting_path")
    .map((edge) => ({
      edgeId: edge.edgeId,
      parentCommandPathId: null,
      ingressId: edge.ingressId ?? null,
      reason: edge.reason,
      state: "parent_command_path_pending",
    }));
  const nonGameplayPaths = reachableEdges
    .filter((edge) => edge.classification === "non_gameplay_path")
    .map((edge) => ({ edgeId: edge.edgeId, ingressId: edge.ingressId ?? null, reason: edge.reason }));
  const toolUseBranchCandidates = game1PressUseToolButtonBranchCandidates(game1Source, rootDispatchEdges, ingress, {
    sourceFile: ingress.sourceFile,
  });
  const toolOverrideCandidates = toolOverrideBranchCandidates(options.sourceIndex, rootDispatchEdges, ingress);
  const toolBeginCandidates = toolBeginUsingBranchCandidates(options.sourceIndex, toolBeginSecondHopEdges, ingress);
  const toolReleaseCandidates = toolEndUsingBranchCandidates(options.sourceIndex, toolReleaseSecondHopEdges, ingress);
  const sourceBranchCandidates = gameLocationCheckActionBranchCandidates(
    gameLocationSource,
    rootDispatchEdges,
    ingress,
  );
  const mapActionSelectorCandidates = gameLocationPerformActionSelectorCandidates(
    gameLocationSource,
    sourceBranchCandidates,
  );
  const candidatePairs = PLAYER_COMMAND_BOUNDARY_CANDIDATES.filter((candidate) => {
    if (candidate.rootTarget)
      return ingress.ingressRoots.some(
        (root) => root.ingressId === candidate.ingressId && root.classification === "command_path_candidate",
      );
    return reachableEdges.some((edge) => edge.ingressId === candidate.ingressId && edge.to === candidate.expression);
  }).map((candidate) => {
    const sourceEdges = candidate.rootTarget
      ? rootEdges.filter((edge) => edge.ingressId === candidate.ingressId)
      : reachableEdges.filter((edge) => edge.ingressId === candidate.ingressId && edge.to === candidate.expression);
    const sourceEdgeIds = sourceEdges.map((edge) => edge.edgeId).sort();
    if (sourceEdgeIds.length === 0) return null;
    const primarySourceEdge = sourceEdges[0];
    return [
      `${candidate.ingressId}/${candidate.candidateId}/${candidate.nativeRuleBoundaryCandidate}`,
      {
        ...candidate,
        // The same semantic family may be reached from distinct normal-player
        // ingresses. Preserve ingress in the candidate identity rather than
        // silently merging those paths into one generic action name.
        candidateId: `${candidate.ingressId}.${candidate.candidateId}`,
        sourceEdgeIds,
        sourceEvidence: {
          sourceType: primarySourceEdge.sourceType ?? "StardewValley.Game1",
          sourceFile: primarySourceEdge.sourceFile,
          sourceMethod: primarySourceEdge.sourceMethod,
          branchKind: candidate.rootTarget ? "ingress_root" : "direct_dispatch_call",
          requiredFragments: [candidate.rootTarget ? candidate.nativeRuleBoundaryCandidate : candidate.expression],
          anchorPositions: Object.fromEntries(
            sourceEdges.map((edge) => [edge.edgeId, Number.isInteger(edge.sourceOffset) ? [edge.sourceOffset] : []]),
          ),
        },
        status: "boundary_candidate",
        route: null,
        reason: "branch_predicate_target_domain_and_bridge_equivalence_not_yet_reconstructed",
      },
    ];
  });
  const candidatePairsWithBranches = [
    ...candidatePairs.filter(Boolean),
    ...toolUseBranchCandidates.map((candidate) => [
      `${candidate.ingressId}/${candidate.candidateId}/${candidate.nativeRuleBoundaryCandidate}`,
      candidate,
    ]),
    ...toolOverrideCandidates.map((candidate) => [
      `${candidate.ingressId}/${candidate.candidateId}/${candidate.nativeRuleBoundaryCandidate}`,
      candidate,
    ]),
    ...toolBeginCandidates.map((candidate) => [
      `${candidate.ingressId}/${candidate.candidateId}/${candidate.nativeRuleBoundaryCandidate}`,
      candidate,
    ]),
    ...toolReleaseCandidates.map((candidate) => [
      `${candidate.ingressId}/${candidate.candidateId}/${candidate.nativeRuleBoundaryCandidate}`,
      candidate,
    ]),
    ...sourceBranchCandidates.map((candidate) => [
      `${candidate.ingressId}/${candidate.candidateId}/${candidate.nativeRuleBoundaryCandidate}`,
      candidate,
    ]),
    ...mapActionSelectorCandidates.map((candidate) => [
      `${candidate.ingressId}/${candidate.candidateId}/${candidate.nativeRuleBoundaryCandidate}`,
      candidate,
    ]),
  ];
  const commandPathCandidates = [...new Map(candidatePairsWithBranches).values()].sort((left, right) =>
    `${left.ingressId}/${left.candidateId}/${left.nativeRuleBoundaryCandidate}`.localeCompare(
      `${right.ingressId}/${right.candidateId}/${right.nativeRuleBoundaryCandidate}`,
    ),
  );

  const pendingByIngress = ingress.ingressRoots
    .filter((root) => root.classification === "command_path_candidate")
    .map((root) => ({
      ingressId: root.ingressId,
      targetMethod: root.targetMethod,
      candidateEdgeCount: reachableEdges.filter(
        (edge) =>
          edge.classification === "candidate_dispatch_edge" &&
          (edge.ingressId === root.ingressId || edge.from.includes(`:${root.ingressId}`)),
      ).length,
      commandBoundaryCandidateCount: commandPathCandidates.filter((candidate) => candidate.ingressId === root.ingressId)
        .length,
      reason: "native_dispatch_and_rule_boundary_not_yet_reconstructed",
    }));
  return {
    schemaVersion: 1,
    state: ingress.state === "unknown" ? "unknown" : "partial",
    rootMethod: ingress.rootMethod,
    sourceFile: ingress.sourceFile,
    errors: ingress.errors,
    ingressRoots: ingress.ingressRoots,
    reachableEdges,
    commandPaths: [],
    commandPathCandidates,
    supportingPaths,
    nonGameplayPaths,
    unknownReachableEdges: unknownIngressRoots.map((root) => ({
      ingressId: root.ingressId,
      reason: "ingress_source_anchor_missing",
      missingFragments: root.missingFragments,
    })),
    pendingCommandCandidates: pendingByIngress,
    note: "Ingress roots and first-hop Game1 dispatch edges are source evidence only. They are not input-injection routes and do not expose UI callbacks as actions.",
  };
}
