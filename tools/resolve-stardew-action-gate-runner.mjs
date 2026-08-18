import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";

/** Resolve the one current shared-harness runner for a published Farmhand action. */
export function resolveStardewActionGateRunner(actionId) {
  if (typeof actionId !== "string" || !/^[a-z][a-z0-9_]{1,127}$/.test(actionId))
    throw new Error("invalid_stardew_action_id");
  const gate = STARDEW_PUBLISHED_ACTION_GATES.find((candidate) => candidate.actionId === actionId);
  if (gate === undefined) throw new Error("unknown_stardew_action_id");
  return gate.runner;
}

if (import.meta.main) {
  const values = process.argv.slice(2);
  if (values.length !== 2 || values[0] !== "--action") throw new Error("usage: --action <published-action-id>");
  process.stdout.write(resolveStardewActionGateRunner(values[1]));
}
