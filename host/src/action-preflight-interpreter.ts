// host/src/action-preflight-interpreter.ts
import type { DomainActionPipeline, DomainActionNode } from "./action-ast.js";
import type { Snapshot } from "./protocol.js";

export interface PreflightSnapshot {
  readonly currentLocation: string;
  readonly playerStamina: number;
  readonly inventorySlots: readonly { readonly slot: number; readonly label: string }[];
  readonly verifiedHandles: readonly string[];
}

export interface PreflightResult {
  readonly isValid: boolean;
  readonly estimatedStaminaCost: number;
  readonly simulatedFinalStamina: number;
  readonly missingTools: readonly string[];
  readonly missingHandles: readonly string[];
}

export function snapshotToPreflightState(snapshot: Snapshot): PreflightSnapshot {
  const verifiedHandles: string[] = [];
  if (snapshot.doorTargets) {
    for (const dt of snapshot.doorTargets) {
      verifiedHandles.push(`door:${dt.targetLocation}:${dt.targetX},${dt.targetY}`);
    }
  }
  if (snapshot.soilTiles) {
    for (const st of snapshot.soilTiles) {
      verifiedHandles.push(`soil:${st.x},${st.y}`);
    }
  }
  if (snapshot.forageTargets) {
    for (const ft of snapshot.forageTargets) {
      verifiedHandles.push(ft.targetId);
    }
  }
  if ((snapshot as any).cropTargets) {
    for (const ct of (snapshot as any).cropTargets) {
      verifiedHandles.push(ct.targetId);
    }
  }
  if ((snapshot as any).harvestTargets) {
    for (const ht of (snapshot as any).harvestTargets) {
      verifiedHandles.push(ht.targetId);
    }
  }

  return {
    currentLocation: snapshot.location,
    playerStamina: snapshot.stamina,
    inventorySlots: Object.freeze(snapshot.toolSlots ?? []),
    verifiedHandles: Object.freeze(verifiedHandles),
  };
}

export function interpretPreflight(
  plan: DomainActionPipeline,
  initialState: PreflightSnapshot,
): PreflightResult {
  let staminaCost = 0;
  const missingTools: string[] = [];
  const missingHandles: string[] = [];

  for (const node of plan.nodes) {
    switch (node.type) {
      case "equip_tool":
      case "equip_tool_slot": {
        const slotMatch = initialState.inventorySlots.find(
          (s) => s.slot === node.slot && s.label === node.toolName,
        );
        if (!slotMatch) {
          const missingKey = `slot_${node.slot}:${node.toolName}`;
          if (!missingTools.includes(missingKey)) {
            missingTools.push(missingKey);
          }
        }
        break;
      }
      case "till_soil":
      case "water_crop":
      case "harvest_crop":
      case "pickup_forage":
      case "collect_forage":
      case "clear_hoedirt": {
        if (!initialState.verifiedHandles.includes(node.targetHandle)) {
          if (!missingHandles.includes(node.targetHandle)) {
            missingHandles.push(node.targetHandle);
          }
        }
        if (node.type === "till_soil" || node.type === "water_crop" || node.type === "clear_hoedirt") {
          staminaCost += 2;
        }
        break;
      }
      case "plant_seed":
      case "fertilize_tile": {
        if (!initialState.verifiedHandles.includes(node.targetHandle)) {
          if (!missingHandles.includes(node.targetHandle)) {
            missingHandles.push(node.targetHandle);
          }
        }
        break;
      }
      case "use_item":
      case "contribute_bundle":
      case "skip_event":
        break;
    }
  }

  const isValid =
    missingTools.length === 0 &&
    missingHandles.length === 0 &&
    initialState.playerStamina >= staminaCost;

  return {
    isValid,
    estimatedStaminaCost: staminaCost,
    simulatedFinalStamina: Math.max(0, initialState.playerStamina - staminaCost),
    missingTools: Object.freeze(missingTools),
    missingHandles: Object.freeze(missingHandles),
  };
}
