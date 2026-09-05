import type { Snapshot } from "./protocol.js";

const GAME_SNAPSHOT_PROJECTION_SCHEMA = "gamebuddy-game-snapshot-projection/v1" as const;
/** The projection is smaller than the bridge frame and remains safe to attach to a turn batch. */
export const MAX_GAME_SNAPSHOT_PROJECTION_BYTES = 4_096;
const MAX_PROJECTION_TEXT_BYTES = 1_024;
const MAX_PROJECTION_STRING_BYTES = 128;
const MAX_PROJECTION_TOOL_LABELS = 12;
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1_000;

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

export type GameSnapshotContextProjection = Readonly<
  | {
      readonly schema: typeof GAME_SNAPSHOT_PROJECTION_SCHEMA;
      readonly available: true;
      readonly snapshotRevision: number;
      readonly sampledAgeMs: number;
      readonly text: string;
      readonly movement: MovementContextProjection;
      readonly farming: FarmingContextProjection;
      readonly inventory: InventoryContextProjection;
    }
  | {
      readonly schema: typeof GAME_SNAPSHOT_PROJECTION_SCHEMA;
      readonly available: false;
      readonly reasonCode: "unavailable" | "invalid";
      readonly text: "[Game Snapshot Unavailable]";
    }
>;

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
    // Labels are situational context, not an inventory dump. Keep the
    // structured helper bounded before the combined projection is serialized.
    toolLabels: Object.freeze(toolSlots.slice(0, MAX_PROJECTION_TOOL_LABELS).map((t) => t.label)),
  });
}

/**
 * Builds the sole Game hot-context snapshot projection. Only situational facts
 * and bounded counts cross this boundary; capabilities, action IDs, execution
 * state, receipts, and request identity are deliberately not represented.
 */
export function projectGameSnapshotContext(
  snapshot: Snapshot | null | undefined,
  sampledAtMs: number,
  nowMs: number,
): GameSnapshotContextProjection {
  if (snapshot === null || snapshot === undefined)
    return unavailableProjection("unavailable");
  if (!isSnapshotInput(snapshot)) return unavailableProjection("invalid");

  const movementSource = projectMovementContext(snapshot);
  const farmingSource = projectFarmingContext(snapshot);
  const inventorySource = projectInventoryContext(snapshot);
  const location = boundedUtf8(snapshot.location, MAX_PROJECTION_STRING_BYTES);
  const currentTool = boundedUtf8(snapshot.currentTool ?? "none", MAX_PROJECTION_STRING_BYTES);
  const toolLabels = Object.freeze(
    inventorySource.toolLabels
      .slice(0, MAX_PROJECTION_TOOL_LABELS)
      .map((label) => boundedUtf8(label, MAX_PROJECTION_STRING_BYTES)),
  );
  const movement = Object.freeze({ ...movementSource, location });
  const farming = Object.freeze({ ...farmingSource, location });
  const inventory = Object.freeze({ ...inventorySource, toolLabels });
  const sampledAgeMs = boundedAge(sampledAtMs, nowMs);
  const text = boundedUtf8(
    [
      "[Game Snapshot Projection v1:",
      `- Snapshot Revision: #${snapshot.revision} (Sampled: ${sampledAgeMs}ms ago)`,
      `- Location: ${location}, Tile: (${movement.tile.x}, ${movement.tile.y}), Actionable: ${movement.actionable}`,
      `- Farming: Stamina=${snapshot.stamina}, Health=${snapshot.health}, SoilTiles=${farming.soilTilesCount}, CanTill=${farming.canTill}, CanWater=${farming.canWater}`,
      `- Tools: Slots=${inventory.inventorySlots}, Equipped=${currentTool}, Labels=${toolLabels.join(", ")}]`,
    ].join("\n"),
    MAX_PROJECTION_TEXT_BYTES,
  );
  const projection = deepFreeze({
    schema: GAME_SNAPSHOT_PROJECTION_SCHEMA,
    available: true as const,
    snapshotRevision: snapshot.revision,
    sampledAgeMs,
    text,
    movement,
    farming,
    inventory,
  });

  // The static field caps above make this a normal path, while this assertion
  // keeps a future allowlisted field from silently weakening the boundary.
  if (Buffer.byteLength(JSON.stringify(projection), "utf8") > MAX_GAME_SNAPSHOT_PROJECTION_BYTES)
    return unavailableProjection("invalid");
  return projection;
}

function unavailableProjection(reasonCode: "unavailable" | "invalid"): GameSnapshotContextProjection {
  return Object.freeze({
    schema: GAME_SNAPSHOT_PROJECTION_SCHEMA,
    available: false as const,
    reasonCode,
    text: "[Game Snapshot Unavailable]" as const,
  });
}

function boundedAge(sampledAtMs: number, nowMs: number): number {
  if (!Number.isFinite(sampledAtMs) || !Number.isFinite(nowMs)) return 0;
  return Math.min(MAX_SNAPSHOT_AGE_MS, Math.max(0, Math.trunc(nowMs - sampledAtMs)));
}

function boundedUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8");
}

function isSnapshotInput(value: Snapshot): boolean {
  return (
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    typeof value.location === "string" &&
    value.tile !== null &&
    typeof value.tile === "object" &&
    Number.isFinite(value.tile.x) &&
    Number.isFinite(value.tile.y) &&
    Number.isFinite(value.stamina) &&
    Number.isFinite(value.health) &&
    typeof value.actionable === "boolean" &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) => typeof capability === "string") &&
    (value.currentTool === undefined || value.currentTool === null || typeof value.currentTool === "string") &&
    (value.inventorySlots === undefined || Number.isSafeInteger(value.inventorySlots)) &&
    (value.warps === undefined || Array.isArray(value.warps)) &&
    (value.doorTargets === undefined || Array.isArray(value.doorTargets)) &&
    (value.soilTiles === undefined || Array.isArray(value.soilTiles)) &&
    (value.toolSlots === undefined ||
      (Array.isArray(value.toolSlots) &&
        value.toolSlots.every(
          (tool) =>
            tool !== null &&
            typeof tool === "object" &&
            typeof tool.label === "string",
        )))
  );
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object") return value as Readonly<T>;
  for (const key of Object.getOwnPropertyNames(value)) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== null && typeof nested === "object") deepFreeze(nested);
  }
  return Object.freeze(value);
}
