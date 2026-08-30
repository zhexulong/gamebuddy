import { readGeneratedEquipToolContract } from "./contract-export.mjs";
import { validateActionContractEquipTool } from "./action-contract.mjs";
import { preflightEquipTool } from "./equip-tool-preflight.mjs";
import { readEquipToolLiveStatus } from "./equip-tool-live.mjs";

const RESULT_SCHEMA = "gamebuddy-action-scenario-result/v1";
const ACTION_ID = "equip_tool";
const ACTION_BEARING_COMMANDS = new Set(["check", "preflight", "run-live", "status"]);

function fail(code) {
  throw new Error(`stardew_action_project_${code}`);
}

function assertActionBearingInvocation(invocation) {
  if (ACTION_BEARING_COMMANDS.has(invocation.command) && invocation.actionId !== ACTION_ID) fail("action_not_available");
}

function report(invocation, status, fields = {}) {
  return Object.freeze({
    schema: RESULT_SCHEMA,
    gameId: "stardew",
    status,
    actionId: ACTION_ID,
    ...fields,
    ...(invocation.briefFile === undefined ? {} : { briefFile: invocation.briefFile }),
    ...(invocation.runId === undefined ? {} : { runId: invocation.runId }),
  });
}

function safeReason(value, fallback) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(value) ? value : fallback;
}

function preflightReport(invocation, result) {
  const reasons = Array.isArray(result?.reasons) ? result.reasons.filter((reason) => typeof reason === "string" && reason.length > 0) : [];
  const ready = result?.state === "READY" && result?.ready === true;
  return report(invocation, "preflight", {
    outcome: ready ? "ready" : "blocked",
    ...(ready ? {} : { reasonCode: safeReason(reasons[0], "preflight_blocked") }),
  });
}

function statusReport(invocation, result) {
  const observation = result?.observation;
  const available = observation?.availability === "available";
  return report(invocation, "status", {
    outcome: available ? "available" : "unavailable",
    ...(available ? {} : { reasonCode: safeReason(observation?.reason, "status_unavailable") }),
  });
}

export async function runActionProject({ manifest, invocation, dependencies }) {
  if (!manifest || manifest.gameId !== "stardew" || !invocation || typeof invocation.command !== "string") fail("invalid_invocation");
  if (!["check", "preflight", "run-live", "status"].includes(invocation.command)) fail("command_not_available");
  assertActionBearingInvocation(invocation);

  if (invocation.command === "preflight") {
    return preflightReport(invocation, await preflightEquipTool({ invocation, dependencies }));
  }
  if (invocation.command === "status") {
    return statusReport(invocation, await readEquipToolLiveStatus({ manifest, invocation, dependencies }));
  }
  if (invocation.command === "run-live") {
    if (typeof invocation.profileFile !== "string") fail("profile_missing");
    return report(invocation, "blocked", { reasonCode: "live_not_exposed" });
  }

  let generated;
  try { generated = await readGeneratedEquipToolContract(); } catch { fail("contract_export_invalid"); }
  try { validateActionContractEquipTool(JSON.parse(generated.toString("utf8"))); } catch { fail("contract_invalid"); }
  return report(invocation, "checked");
}
