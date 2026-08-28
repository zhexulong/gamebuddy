import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readGeneratedEquipToolContract } from "./contract-export.mjs";
import { validateActionContractEquipTool } from "./action-contract.mjs";
import { preflightEquipTool } from "./equip-tool-preflight.mjs";
import { readEquipToolLiveStatus, runEquipToolLive } from "./equip-tool-live.mjs";

function fail(code) {
  throw new Error(`stardew_action_project_${code}`);
}

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PACKAGE_INVENTORY = path.join(PACKAGE_DIRECTORY, "tool-inventory.json");

export async function runActionProject({ manifest, invocation, dependencies }) {
  if (!manifest || manifest.gameId !== "stardew" || !invocation) fail("invalid_invocation");
  if (invocation.command === "preflight") return preflightEquipTool({ invocation, dependencies });
  if (invocation.command === "run-live") return runEquipToolLive({ manifest, invocation, dependencies });
  if (invocation.command === "status") return readEquipToolLiveStatus({ manifest, invocation, dependencies });
  if (invocation.command === "check") {
    if (invocation.actionId !== "equip_tool") fail("action_not_available");
    let generated;
    try { generated = await readGeneratedEquipToolContract(); } catch { fail("contract_export_invalid"); }
    let contract;
    try { contract = validateActionContractEquipTool(JSON.parse(generated.toString("utf8"))); } catch { fail("contract_invalid"); }
    return Object.freeze({ gameId: "stardew", status: "checked", actionId: contract.actionId });
  }
  if (invocation.command !== "inventory") fail("command_not_available");
  let expectedInventory;
  let suppliedInventory;
  try { [expectedInventory, suppliedInventory] = await Promise.all([realpath(PACKAGE_INVENTORY), realpath(manifest.inventoryFile)]); } catch { fail("inventory_unreadable"); }
  if (expectedInventory !== suppliedInventory) fail("inventory_not_package_owned");
  let inventory;
  try { inventory = JSON.parse(await readFile(expectedInventory, "utf8")); } catch { fail("inventory_unreadable"); }
  if (inventory.schema !== "gamebuddy-stardew-tool-inventory/v1" || !Array.isArray(inventory.entries)) fail("inventory_invalid");
  return Object.freeze({ gameId: "stardew", status: "inventory", fileCount: inventory.entries.length });
}
