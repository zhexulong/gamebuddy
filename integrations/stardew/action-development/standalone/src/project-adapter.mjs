import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readGeneratedEquipToolContract } from "./contract-export.mjs";
import { validateActionContractEquipTool } from "./action-contract.mjs";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PACKAGE_INVENTORY = path.join(PACKAGE_DIRECTORY, "tool-inventory.json");
const ACTION_ID = "equip_tool";

function fail(code) {
  throw new Error(`stardew_standalone_project_${code}`);
}

function assertAction(invocation) {
  if (invocation.actionId !== ACTION_ID) fail("action_not_available");
}

export async function runActionProject({ manifest, invocation }) {
  if (!manifest || manifest.gameId !== "stardew" || !invocation) fail("invalid_invocation");
  if (["check", "preflight", "run-live", "status"].includes(invocation.command)) assertAction(invocation);

  if (invocation.command === "check") {
    let generated;
    try { generated = await readGeneratedEquipToolContract(); } catch { fail("contract_export_invalid"); }
    let contract;
    try { contract = validateActionContractEquipTool(JSON.parse(generated.toString("utf8"))); } catch { fail("contract_invalid"); }
    return Object.freeze({ schema: "gamebuddy-action-scenario-result/v1", gameId: "stardew", status: "checked", actionId: contract.actionId });
  }

  if (invocation.command === "status") {
    return Object.freeze({ schema: "gamebuddy-action-scenario-result/v1", gameId: "stardew", status: "observed", outcome: "non_production_standalone", reasonCode: "standalone_extraction_only", claimScope: "deterministic", actionId: ACTION_ID, briefFile: invocation.briefFile ?? null });
  }

  if (invocation.command === "preflight" || invocation.command === "run-live") {
    return Object.freeze({ schema: "gamebuddy-action-scenario-result/v1", gameId: "stardew", status: invocation.command === "preflight" ? "preflight" : "live", outcome: "blocked", reasonCode: "non_production_standalone", claimScope: "deterministic", actionId: ACTION_ID, runId: invocation.runId ?? null, briefFile: invocation.briefFile ?? null });
  }

  if (invocation.command !== "inventory") fail("command_not_available");
  let expectedInventory;
  let suppliedInventory;
  try { [expectedInventory, suppliedInventory] = await Promise.all([realpath(PACKAGE_INVENTORY), realpath(manifest.inventoryFile)]); } catch { fail("inventory_unreadable"); }
  if (expectedInventory !== suppliedInventory) fail("inventory_not_package_owned");
  let inventory;
  try { inventory = JSON.parse(await readFile(expectedInventory, "utf8")); } catch { fail("inventory_unreadable"); }
  if (inventory.schema !== "gamebuddy-stardew-tool-inventory/v1" || !Array.isArray(inventory.entries)) fail("inventory_invalid");
  return Object.freeze({ schema: "gamebuddy-action-scenario-result/v1", gameId: "stardew", status: "inventory", fileCount: inventory.entries.length });
}
