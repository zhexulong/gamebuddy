import type { Snapshot } from "./protocol.js";

const GAME_SNAPSHOT_PROJECTION_SCHEMA = "gamebuddy-game-snapshot-projection/v1" as const;
/** The projection is smaller than the bridge frame and remains safe to attach to a turn batch. */
export const MAX_GAME_SNAPSHOT_PROJECTION_BYTES = 4_096;
const MAX_PROJECTION_TEXT_BYTES = 1_024;
const MAX_PROJECTION_STRING_BYTES = 128;
const MAX_PROJECTION_TOOL_LABELS = 12;
const MAX_PROJECTION_PETS = 12;
const MAX_PROJECTION_PET_BOWLS = 8;
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
  /** Persistent fatigue: while true, the next day restores only half stamina. */
  readonly exhausted: boolean;
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

export interface ClockContextProjection {
  readonly timeOfDay: number;
  readonly dayOfMonth: number;
  readonly seasonIndex: number;
  readonly year: number;
}

export interface PetContextProjection {
  readonly targetId: string;
  readonly petType: string;
  readonly stationary: boolean;
}

/** A live, unwatered native Pet Bowl: the companion needs to know where one is, not its state. */
export interface PetBowlContextProjection {
  readonly targetId: string;
  readonly x: number;
  readonly y: number;
}

export type GameSnapshotContextProjection = Readonly<
  | {
      readonly schema: typeof GAME_SNAPSHOT_PROJECTION_SCHEMA;
      readonly available: true;
      readonly snapshotRevision: number;
      readonly sampledAgeMs: number;
      readonly text: string;
      readonly clock: ClockContextProjection;
      readonly movement: MovementContextProjection;
      readonly farming: FarmingContextProjection;
      readonly inventory: InventoryContextProjection;
        readonly pets: readonly PetContextProjection[];
      readonly petBowls: readonly PetBowlContextProjection[];
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
    exhausted: snapshot.exhausted === true,
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

export function projectClockContext(snapshot: Snapshot): ClockContextProjection {
  return Object.freeze({
    timeOfDay: snapshot.timeOfDay,
    dayOfMonth: snapshot.dayOfMonth,
    seasonIndex: snapshot.seasonIndex,
    year: snapshot.year,
  });
}

export function projectPetBowlContext(snapshot: Snapshot): readonly PetBowlContextProjection[] {
  return Object.freeze(
    (snapshot.petBowlTargets ?? []) // Nearby pet bowls are situational context, not an inventory dump; keep the structured helper bounded.
      .slice(0, MAX_PROJECTION_PET_BOWLS)
      .map((bowl) =>
        Object.freeze({
          targetId: boundedUtf8(bowl.targetId, MAX_PROJECTION_STRING_BYTES),
          x: Number.isFinite(bowl.x) ? bowl.x : 0,
          y: Number.isFinite(bowl.y) ? bowl.y : 0,
        }),
      ),
  );
}

export function projectPetContext(snapshot: Snapshot): readonly PetContextProjection[] {
  return Object.freeze(
    (snapshot.petTargets ?? []) // Nearby pets are situational context, not a roster; keep the structured helper bounded.
      .slice(0, MAX_PROJECTION_PETS)
      .map((pet) =>
        Object.freeze({
          targetId: boundedUtf8(pet.targetId, MAX_PROJECTION_STRING_BYTES),
          petType: boundedUtf8(pet.petType, MAX_PROJECTION_STRING_BYTES),
          stationary: pet.stationary === true,
        }),
      ),
  );
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
  const clockSource = projectClockContext(snapshot);
  const petSource = projectPetContext(snapshot);
  const petBowlSource = projectPetBowlContext(snapshot);
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
  const clock = Object.freeze({ ...clockSource });
  const pets = Object.freeze(petSource.map((pet) => Object.freeze({ ...pet })));
  const petBowls = Object.freeze(petBowlSource.map((bowl) => Object.freeze({ ...bowl })));
  const sampledAgeMs = boundedAge(sampledAtMs, nowMs);
  const seasonName = ["Spring", "Summer", "Fall", "Winter"][clock.seasonIndex] ?? "Unknown";
  const text = boundedUtf8(
    [
      "[Game Snapshot Projection v1:",
      `- Snapshot Revision: #${snapshot.revision} (Sampled: ${sampledAgeMs}ms ago)`,
      `- Time: ${formatClock(clock.timeOfDay)}, Season: ${seasonName}, Day: ${clock.dayOfMonth}, Year: ${clock.year}`,
      `- Location: ${location}, Tile: (${movement.tile.x}, ${movement.tile.y}), Actionable: ${movement.actionable}`,
      `- Farming: Stamina=${snapshot.stamina}, Exhausted=${snapshot.exhausted === true}, Health=${snapshot.health}, SoilTiles=${farming.soilTilesCount}, CanTill=${farming.canTill}, CanWater=${farming.canWater}`,
      `- Tools: Slots=${inventory.inventorySlots}, Equipped=${currentTool}, Labels=${toolLabels.join(", ")}`,
      `- Pets: ${pets.length > 0 ? pets.map((pet) => `${pet.petType}(${pet.stationary ? "stationary" : "moving"})`).join(", ") : "none within range"}]`,
    ].join("\n"),
    MAX_PROJECTION_TEXT_BYTES,
  );
  const projection = deepFreeze({
    schema: GAME_SNAPSHOT_PROJECTION_SCHEMA,
    available: true as const,
    snapshotRevision: snapshot.revision,
    sampledAgeMs,
    text,
    clock,
    movement,
    farming,
    inventory,
    pets,
    petBowls,
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

/** Renders a Stardew time-of-day int (e.g. 2350) as HH:MM (23:50). */
function formatClock(timeOfDay: number): string {
  if (!Number.isInteger(timeOfDay) || timeOfDay < 0 || timeOfDay > 2600) return `${timeOfDay}`;
  const hours = Math.floor(timeOfDay / 100);
  const minutes = timeOfDay % 100;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
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
    (value.exhausted === undefined || typeof value.exhausted === "boolean") &&
    Number.isFinite(value.health) &&
    (value.timeOfDay === undefined || (Number.isSafeInteger(value.timeOfDay) && value.timeOfDay >= 0 && value.timeOfDay <= 2600)) &&
    (value.dayOfMonth === undefined || (Number.isSafeInteger(value.dayOfMonth) && value.dayOfMonth >= 1 && value.dayOfMonth <= 28)) &&
    (value.seasonIndex === undefined || (Number.isSafeInteger(value.seasonIndex) && value.seasonIndex >= 0 && value.seasonIndex <= 3)) &&
    (value.year === undefined || (Number.isSafeInteger(value.year) && value.year >= 1)) &&
    typeof value.actionable === "boolean" &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) => typeof capability === "string") &&
    (value.currentTool === undefined || value.currentTool === null || typeof value.currentTool === "string") &&
    (value.inventorySlots === undefined || Number.isSafeInteger(value.inventorySlots)) &&
    (value.warps === undefined || Array.isArray(value.warps)) &&
    (value.doorTargets === undefined || Array.isArray(value.doorTargets)) &&
    (value.soilTiles === undefined || Array.isArray(value.soilTiles)) &&
    (value.petTargets === undefined ||
      (Array.isArray(value.petTargets) &&
        value.petTargets.every(
          (pet) =>
            pet !== null &&
            typeof pet === "object" &&
            typeof pet.targetId === "string" &&
            typeof pet.petType === "string" &&
            typeof pet.stationary === "boolean",
        ))) &&
    (value.petBowlTargets === undefined ||
      (Array.isArray(value.petBowlTargets) &&
        value.petBowlTargets.every(
          (bowl) =>
            bowl !== null &&
            typeof bowl === "object" &&
            typeof bowl.targetId === "string" &&
            Number.isFinite(bowl.x) &&
            Number.isFinite(bowl.y),
        ))) &&
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
