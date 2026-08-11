/**
 * Source-level equivalence audit for reconstructed Player-Reachable Command
 * Paths (PRCPs). This is diagnostic only: it never publishes an action and
 * never converts a candidate into a covered command path.
 *
 * A bridge route can only claim equivalence after it preserves every relevant
 * human-path guard or supplies a source-backed proof of a stricter substitute.
 */

export const BRIDGE_ROUTE_AUDIT_RULES = Object.freeze([
  {
    candidateId: "forage.pickup_spawned_object",
    implementationActionId: "pickup_forage",
    bridgeMethod: "RequestLocalPickupForage",
    humanPath: "Game1.tryToCheckAt -> GameLocation.checkAction",
    requiredHumanGuards: [
      {
        id: "not_on_bridge",
        humanFragment: "if (player.onBridge.Value)",
        bridgeFragments: ["Game1.player.onBridge.Value", "Game1.tryToCheckAt("],
        explanation: "Normal player action returns before location interaction while the Farmer is on a bridge; delegating to target-version Game1.tryToCheckAt preserves that guard.",
      },
      {
        id: "within_action_radius",
        humanFragment: "Utility.tileWithinRadiusOfPlayer",
        bridgeFragments: ["Utility.tileWithinRadiusOfPlayer", "Game1.tryToCheckAt("],
        explanation: "Both routes must enforce the same one-tile action reachability before interaction; delegating to target-version Game1.tryToCheckAt preserves that guard.",
      },
      {
        id: "native_check_action_hook",
        humanFragment: "hooks.OnGameLocation_CheckAction",
        bridgeFragments: ["Game1.tryToCheckAt("],
        explanation: "The player path enters GameLocation.checkAction through the target-version hook-bearing tryToCheckAt boundary.",
      },
    ],
  },
]);

function methodBody(source, methodName) {
  if (typeof source !== "string") return null;
  const declaration = new RegExp(String.raw`(?:^|\n)\s*(?:public|private|protected|internal)\s+(?:(?:static|virtual|override|sealed|async)\s+)*(?:[\w<>,.?\[\]]+\s+)+${methodName}\s*\([^;{}]*\)\s*\{`, "g");
  const match = declaration.exec(source);
  if (!match) return null;
  const openBrace = match.index + match[0].length - 1;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return source.slice(openBrace + 1, index);
  }
  return null;
}

/**
 * Audit rules against exact repository bridge source. Missing source or a
 * missing guard is an evidence gap, never a successful equivalence claim.
 */
export function auditBridgeRouteEquivalence(bridgeSource, rules = BRIDGE_ROUTE_AUDIT_RULES) {
  return rules.map((rule) => {
    const body = methodBody(bridgeSource, rule.bridgeMethod);
    if (body === null) {
      return {
        candidateId: rule.candidateId,
        implementationActionId: rule.implementationActionId,
        bridgeMethod: rule.bridgeMethod,
        humanPath: rule.humanPath,
        state: "bridge_source_missing",
        missingGuards: rule.requiredHumanGuards.map((guard) => ({ id: guard.id, explanation: guard.explanation })),
      };
    }
    const missingGuards = rule.requiredHumanGuards
      .filter((guard) => {
        const bridgeFragments = Array.isArray(guard.bridgeFragments)
          ? guard.bridgeFragments
          : [guard.bridgeFragment];
        return !bridgeFragments.some((fragment) => typeof fragment === "string" && body.includes(fragment));
      })
      .map((guard) => ({
        id: guard.id,
        humanFragment: guard.humanFragment,
        expectedBridgeFragments: Array.isArray(guard.bridgeFragments) ? guard.bridgeFragments : [guard.bridgeFragment],
        explanation: guard.explanation,
      }));
    return {
      candidateId: rule.candidateId,
      implementationActionId: rule.implementationActionId,
      bridgeMethod: rule.bridgeMethod,
      humanPath: rule.humanPath,
      state: missingGuards.length === 0 ? "source_guard_equivalence_candidate" : "bridge_equivalence_gap",
      missingGuards,
      note: missingGuards.length === 0
        ? "Source guard parity is only a candidate; target-specific live equivalence evidence is still required before a PRCP route is covered."
        : "This candidate must not be mapped to a covered PRCP route until the source guard gap is resolved and action gates are rerun.",
    };
  });
}
