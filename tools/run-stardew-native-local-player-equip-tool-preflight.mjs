#!/usr/bin/env node
/**
 * Read-only native-local `equip_tool` preflight.
 *
 * Production connects only through the shared native smoke harness, observes
 * exactly one fresh target-version snapshot, and consumes the Mod-owned
 * published-action registry as a restrictive parity check. It never submits
 * execution, starts a process, writes runtime state, or creates a receipt.
 */

import {
  connectNativeLocalClient,
  observeFresh,
  readNativeClientConfig,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { readPublishedStardewActionIds } from "./lib/stardew-published-action-registry.mjs";

const ACTION = "equip_tool";
const READY = "READY";
const BLOCKED = "BLOCKED";
const EXPECTED_SCOPE_KEYS = Object.freeze([
  "integrationId",
  "saveId",
  "worldId",
  "playerId",
  "companionId",
]);
const EXPECTED_SCOPE = Object.freeze({ integrationId: "stardew" });

/**
 * Run the production preflight. `dependencies` is intentionally private to
 * this module's test-only factory and is not accepted by the CLI path.
 */
export async function runEquipToolPreflight(
  { client, scope, readPublishedActionIds = readPublishedStardewActionIds } = {},
) {
  const reasons = [];
  let snapshot = null;
  let observed = false;

  if (!client || typeof client !== "object") reasons.push("bridge_unavailable");
  if (client?.state?.connected === false || client?.state?.authenticated === false)
    reasons.push("bridge_unavailable");
  if (!isExactScope(scope)) reasons.push("scope_mismatch");
  if (typeof readPublishedActionIds !== "function") reasons.push("registry_unavailable");

  if (reasons.length === 0) {
    try {
      snapshot = await observeFresh(client);
      observed = true;
    } catch {
      reasons.push("snapshot_unavailable");
    }
  }

  let published = null;
  let publicationRead = false;
  if (reasons.length === 0) {
    try {
      published = await readPublishedActionIds();
      publicationRead = true;
    } catch {
      reasons.push("publication_unavailable");
    }
  }

  if (snapshot !== null) {
    if (snapshot.actionable !== true) reasons.push("snapshot_non_actionable");
    if (!Object.hasOwn(snapshot, "activeExecution") || snapshot.activeExecution !== null)
      reasons.push("active_execution");
    if (!Array.isArray(snapshot.capabilities) || !snapshot.capabilities.includes(ACTION))
      reasons.push("capability_mismatch");
    if (publicationRead && !hasAction(published)) reasons.push("publication_mismatch");
    if (eligibleToolSlot(snapshot) === null) reasons.push("no_eligible_tool_slot");
  }

  const ready = reasons.length === 0;
  return Object.freeze({
    state: ready ? READY : BLOCKED,
    ready,
    freshSnapshotCount: observed ? 1 : 0,
    capabilityDeclared: snapshot !== null && Array.isArray(snapshot.capabilities) && snapshot.capabilities.includes(ACTION),
    publicationDeclared: hasAction(published),
    eligibleToolSlotCount: snapshot === null ? 0 : countEligibleToolSlots(snapshot),
    activeExecution: snapshot !== null && snapshot.activeExecution != null,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

/** Private/test-only factory; production has no injectable bridge or registry. */
export function createEquipToolPreflightForTest({ client, scope, readPublishedActionIds, close = () => {} } = {}) {
  return Object.freeze({
    async run() {
      try {
        return await runEquipToolPreflight({ client, scope, readPublishedActionIds });
      } finally {
        close();
      }
    },
  });
}

if (import.meta.main) {
  let session;
  try {
    const config = await readNativeClientConfig();
    session = await connectNativeLocalClient(config);
    const result = await runEquipToolPreflight({ client: session.client, scope: session.scope });
    console.log(JSON.stringify(result));
    if (result.state !== READY) process.exitCode = 2;
  } catch {
    console.log(JSON.stringify({
      state: BLOCKED,
      ready: false,
      freshSnapshotCount: 0,
      capabilityDeclared: false,
      publicationDeclared: false,
      eligibleToolSlotCount: 0,
      activeExecution: false,
      reasons: ["bridge_unavailable"],
    }));
    process.exitCode = 2;
  } finally {
    session?.close();
  }
}

function isExactScope(scope) {
  if (!scope || typeof scope !== "object") return false;
  const keys = Object.keys(scope).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...EXPECTED_SCOPE_KEYS].sort())) return false;
  if (scope.integrationId !== EXPECTED_SCOPE.integrationId) return false;
  return EXPECTED_SCOPE_KEYS.every((key) => typeof scope[key] === "string" && scope[key].length > 0);
}

function hasAction(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((id) => typeof id === "string" && /^[a-z][a-z0-9_]{1,127}$/.test(id)) &&
    new Set(value).size === value.length &&
    value.includes(ACTION)
  );
}

function eligibleToolSlot(snapshot) {
  return (
    Array.isArray(snapshot?.toolSlots)
      ? snapshot.toolSlots.find(
          (entry) =>
            Number.isInteger(entry?.slot) &&
            typeof entry?.label === "string" &&
            entry.label.length > 0 &&
            entry.label !== snapshot.currentTool,
        ) ??
        snapshot.toolSlots.find(
          (entry) => Number.isInteger(entry?.slot) && typeof entry?.label === "string" && entry.label.length > 0,
        ) ?? null
      : null
  );
}

function countEligibleToolSlots(snapshot) {
  if (!Array.isArray(snapshot?.toolSlots)) return 0;
  return snapshot.toolSlots.filter(
    (entry) => Number.isInteger(entry?.slot) && typeof entry?.label === "string" && entry.label.length > 0,
  ).length;
}
