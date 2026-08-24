import type { Snapshot } from "./protocol.js";

export interface MovementContextProjection {
  readonly revision: number;
  readonly location: string;
  readonly tile: { readonly x: number; readonly y: number };
  readonly actionable: boolean;
  readonly warpsCount: number;
  readonly doorsCount: number;
}

export interface FarmingContextProjection {
  readonly revision: number;
  readonly location: string;
  readonly stamina: number;
  readonly soilTilesCount: number;
  readonly canTill: boolean;
  readonly canWater: boolean;
}

export interface InventoryContextProjection {
  readonly revision: number;
  readonly inventorySlots: number;
  readonly toolSlotsCount: number;
  readonly toolLabels: readonly string[];
}

export function projectMovementContext(snapshot: Snapshot): MovementContextProjection {
  return Object.freeze({
    revision: snapshot.revision,
    location: snapshot.location,
    tile: Object.freeze({ ...snapshot.tile }),
    actionable: snapshot.actionable,
    warpsCount: snapshot.warps?.length ?? 0,
    doorsCount: snapshot.doorTargets?.length ?? 0,
  });
}

export function projectFarmingContext(snapshot: Snapshot): FarmingContextProjection {
  const capabilities = new Set(snapshot.capabilities ?? []);
  return Object.freeze({
    revision: snapshot.revision,
    location: snapshot.location,
    stamina: snapshot.stamina,
    soilTilesCount: snapshot.soilTiles?.length ?? 0,
    canTill: capabilities.has("till_soil"),
    canWater: capabilities.has("water_crop"),
  });
}

export function projectInventoryContext(snapshot: Snapshot): InventoryContextProjection {
  const toolSlots = snapshot.toolSlots ?? [];
  return Object.freeze({
    revision: snapshot.revision,
    inventorySlots: snapshot.inventorySlots ?? 12,
    toolSlotsCount: toolSlots.length,
    toolLabels: Object.freeze(toolSlots.map((t) => t.label)),
  });
}
