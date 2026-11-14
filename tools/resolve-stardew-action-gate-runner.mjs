import { CONTRACT_ROUTE, resolveStardewActionGateRoute } from "./lib/stardew-action-gate-route.mjs";

const TOOLS_DIRECTORY = "tools";

/**
 * The RUNNER that drives a Farmhand action's live gate, answered from the one resolver.
 *
 * This used to be the resolver: it held the three declarations to search (published gate table, experimental/harness
 * map, published-action gate exemptions) and returned `row.runner`. That made it a second copy of the resolution order
 * `tools/lib/stardew-action-gate-route.mjs` owns, and it answered `null` for a row whose gate is a contract - an answer
 * three consumers read as "a runner named null" rather than "this action has no runner".
 *
 * It is now a PROJECTION of the route: the route says where the gate lives, and this answers the runner for the two
 * routes that have one. A contract-route row answers `null` because the row names no runner and its gate is
 * `contracts/smoke/<actionId>.json`, run by the slice driver - not because a cell is empty.
 *
 * Resolution grants no capability, changes no lifecycle, and never claims publication or success.
 */
export function resolveStardewActionGateRunner(actionId) {
  if (typeof actionId !== "string" || !/^[a-z][a-z0-9_]{1,127}$/.test(actionId))
    throw new Error("invalid_stardew_action_id");
  const route = resolveStardewActionGateRoute(actionId);
  if (route.route === null) throw new Error("unknown_stardew_action_id");
  if (route.route === CONTRACT_ROUTE) return null;
  return route.gate.startsWith(`${TOOLS_DIRECTORY}/`) ? route.gate.slice(TOOLS_DIRECTORY.length + 1) : route.gate;
}

if (import.meta.main) {
  const values = process.argv.slice(2);
  if (values.length !== 2 || values[0] !== "--action") throw new Error("usage: --action <published-action-id>");
  const runner = resolveStardewActionGateRunner(values[1]);
  if (runner === null) throw new Error(`stardew_action_gate_route_is_contract:${values[1]}`);
  process.stdout.write(runner);
}
