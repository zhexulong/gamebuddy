/** Package-owned migration of the canonical read-only equip_tool preflight semantics. */
const ACTION = "equip_tool";
const SCOPE_KEYS = ["integrationId", "saveId", "worldId", "playerId", "companionId"];

function exactScope(scope) {
  return scope && typeof scope === "object"
    && JSON.stringify(Object.keys(scope).sort()) === JSON.stringify([...SCOPE_KEYS].sort())
    && scope.integrationId === "stardew"
    && SCOPE_KEYS.every((key) => typeof scope[key] === "string" && scope[key].length > 0);
}
function published(value) {
  return Array.isArray(value) && value.includes(ACTION) && new Set(value).size === value.length
    && value.every((id) => typeof id === "string" && /^[a-z][a-z0-9_]{1,127}$/.test(id));
}
function eligible(snapshot) {
  return Array.isArray(snapshot?.toolSlots) && snapshot.toolSlots.some((entry) =>
    Number.isInteger(entry?.slot) && typeof entry?.label === "string" && entry.label.length > 0);
}

export async function runEquipToolReadOnlyPreflight({ client, scope, observeFresh, readPublishedActionIds }) {
  const reasons = [];
  let snapshot = null;
  let observed = false;
  let actionIds = null;
  if (!client || client.state?.connected === false || client.state?.authenticated === false) reasons.push("bridge_unavailable");
  if (!exactScope(scope)) reasons.push("scope_mismatch");
  if (typeof observeFresh !== "function" || typeof readPublishedActionIds !== "function") reasons.push("preflight_dependency_unavailable");
  if (reasons.length === 0) {
    try { snapshot = await observeFresh(client); observed = true; } catch { reasons.push("snapshot_unavailable"); }
  }
  if (reasons.length === 0) {
    try { actionIds = await readPublishedActionIds(); } catch { reasons.push("publication_unavailable"); }
  }
  if (snapshot) {
    if (snapshot.actionable !== true) reasons.push("snapshot_non_actionable");
    if (!Object.hasOwn(snapshot, "activeExecution") || snapshot.activeExecution !== null) reasons.push("active_execution");
    if (!Array.isArray(snapshot.capabilities) || !snapshot.capabilities.includes(ACTION)) reasons.push("capability_mismatch");
    if (actionIds && !published(actionIds)) reasons.push("publication_mismatch");
    if (!eligible(snapshot)) reasons.push("no_eligible_tool_slot");
  }
  return Object.freeze({
    state: reasons.length === 0 ? "READY" : "BLOCKED",
    ready: reasons.length === 0,
    freshSnapshotCount: observed ? 1 : 0,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}
