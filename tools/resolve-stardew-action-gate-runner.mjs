import {
  GATE_EXEMPT_PUBLISHED_ACTIONS,
} from "./lib/stardew-published-action-registry.mjs";
import { STARDEW_EXPERIMENTAL_ACTION_RUNNERS, STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";

/**
 * Resolve the one current shared-harness runner for a Farmhand action.
 *
 * Published actions resolve through `STARDEW_PUBLISHED_ACTION_GATES` (the
 * contract-exact published set). Experimental actions resolve through the
 * separate `STARDEW_EXPERIMENTAL_ACTION_RUNNERS` map so the disposable
 * native-local launcher can drive their live mechanics gate without adding an
 * experimental action to the published-only projection.
 *
 * Actions named in `GATE_EXEMPT_PUBLISHED_ACTIONS` resolve through the runner
 * their declaration carries. Those actions run on a different pipeline
 * (navigation's long-horizon watchdog) and use a runner whose scenario does
 * not match the descriptor contract shape, so they cannot sit in the gate
 * list; the exemption names the runner that covers them instead.
 *
 * Resolution grants no capability, changes no lifecycle, and never claims
 * publication or success.
 */
export function resolveStardewActionGateRunner(actionId) {
  if (typeof actionId !== "string" || !/^[a-z][a-z0-9_]{1,127}$/.test(actionId))
    throw new Error("invalid_stardew_action_id");
  const gate = STARDEW_PUBLISHED_ACTION_GATES.find((candidate) => candidate.actionId === actionId);
  if (gate !== undefined) return gate.runner;
  const experimental = STARDEW_EXPERIMENTAL_ACTION_RUNNERS[actionId];
  if (experimental !== undefined) return experimental;
  const exemption = GATE_EXEMPT_PUBLISHED_ACTIONS.find((candidate) => candidate.actionId === actionId);
  if (exemption !== undefined) return exemption.runner;
  throw new Error("unknown_stardew_action_id");
}

if (import.meta.main) {
  const values = process.argv.slice(2);
  if (values.length !== 2 || values[0] !== "--action") throw new Error("usage: --action <published-action-id>");
  process.stdout.write(resolveStardewActionGateRunner(values[1]));
}