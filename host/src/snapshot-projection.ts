import type { Snapshot } from "./protocol.js";
import { seasonName } from "./game-world-vocabulary.js";
import { formatGameClock } from "./snapshot-hud.js";

const GAME_SNAPSHOT_PROJECTION_SCHEMA = "gamebuddy-game-snapshot-projection/v1" as const;
/** The projection is smaller than the bridge frame and remains safe to attach to a turn batch. */
export const MAX_GAME_SNAPSHOT_PROJECTION_BYTES = 4_096;
const MAX_PROJECTION_TEXT_BYTES = 1_024;
const MAX_PROJECTION_STRING_BYTES = 128;
const MAX_PROJECTION_TOOL_LABELS = 12;
/** Carried non-tool stacks one projection may name. A hot context is a bound, not an inventory dump. */
const MAX_PROJECTION_CARRYING_ROWS = 8;
/** The carrying line's own share of the text, so a full inventory cannot crowd out the facts around it. */
const MAX_PROJECTION_CARRYING_BYTES = 192;
const MAX_PROJECTION_PETS = 12;
const MAX_PROJECTION_PET_BOWLS = 8;
// The Slime Hutch gate accepts exactly x == 16, y in 6..9, so at most 4 rows.
const MAX_PROJECTION_SLIME_HUTCH_TROUGHS = 4;
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1_000;

export interface MovementContextProjection {
  readonly revision: number;
  readonly location: string;
  readonly tile: { readonly x: number; readonly y: number };
  readonly actionable: boolean;
  /** The modal class holding the screen, or null when nothing does. */
  readonly holdingModal: string | null;
  /** Whether the companion's own newest execution opened `holdingModal`; null when there is no modal or it went unreported. */
  readonly holdingModalActionOwned: boolean | null;
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
  readonly carrying: CarryingContextProjection;
}

/**
 * What she is carrying that is NOT a tool.
 *
 * <p>
 * The projection kept the tool family only (`toolSlots`), so a companion holding forty parsnip seeds and no food read
 * both answers as "nothing". `inventoryItemFacts` is the Mod's own bounded inventory publication (36 rows: slot,
 * qualified item id, name, stack), projected here minus the slots `toolSlots` already names - so the tool labels are
 * not printed twice and the set of tool slots stays the Mod's own answer rather than a Host predicate.
 * </p>
 * <p>
 * `measured` is the distinction the old answer could not make. `false` means the Mod published no inventory rows at
 * all (the field is gated on the actions that read the inventory), which is a different statement from `rows: []` -
 * "nothing but tools". `omitted` is always present for the same reason: "nothing was dropped" has to be a measurement.
 * </p>
 */
export interface CarryingContextProjection {
  readonly revision: number;
  readonly measured: boolean;
  readonly rows: readonly Readonly<{ slot: number; label: string; stack: number }>[];
  readonly omitted: number;
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

/** A live, unwatered Slime Hutch trough row: the companion needs to know where to stand, not its state. */
export interface SlimeHutchTroughContextProjection {
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
      readonly slimeHutchTroughs: readonly SlimeHutchTroughContextProjection[];
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
    holdingModal: holdingModalOf(snapshot),
    holdingModalActionOwned: holdingModalActionOwnedOf(snapshot),
    warpsCount: snapshot.warps?.length ?? 0,
    doorsCount: snapshot.doorTargets?.length ?? 0,
  });
}

/**
 * The modal the Mod says holds the screen, or null when nothing does.
 *
 * `actionable` answers "may an action run", and a modal does not make that false - the modal family is admitted
 * precisely because `dismiss_modal` is one - so the flag reads as "nothing is in the way" while a menu owns the
 * screen. Measured 2026-10-28: a `ShippingMenu` held a FarmHouse for 31 minutes and the game clock stood at 06:00
 * while the last projection the model saw said `Actionable: true` at 22:30.
 *
 * `actorDispositionDetail` is `ModalType ?? TransientKind` (`farmhandexecutioncontroller.cs:2401`), so the kind is
 * consulted first: `eating` is a transient body lock, and naming it as a modal would point the model at a tool that
 * refuses to clear it.
 */
function holdingModalOf(snapshot: Snapshot): string | null {
  if (snapshot.actorDispositionKind !== "modal") return null;
  const detail = snapshot.actorDispositionDetail;
  // An empty name is not a modal: rendering it would publish a label that says nothing.
  return typeof detail === "string" && detail.length > 0 ? boundedUtf8(detail, MAX_PROJECTION_STRING_BYTES) : null;
}

/**
 * Whether the companion's own newest execution opened the modal (`ModalActionOwned`), so the model can tell a menu
 * its last action raised from one the world pushed.
 *
 * Null rather than `false` when the field is absent: an older Mod that omits it has said nothing, and a `false`
 * default would report a world-opened menu no one measured.
 */
function holdingModalActionOwnedOf(snapshot: Snapshot): boolean | null {
  if (snapshot.actorDispositionKind !== "modal") return null;
  return typeof snapshot.actorDispositionActionOwned === "boolean" ? snapshot.actorDispositionActionOwned : null;
}

export function projectFarmingContext(snapshot: Snapshot): FarmingContextProjection {
  const capabilities = new Set(snapshot.capabilities ?? []);
  return Object.freeze({
    revision: snapshot.revision,
    location: snapshot.location,
    stamina: snapshot.stamina,
    // Read the validated field through. Never `=== true`: absence is a
    // protocol error now, and a default would quietly reintroduce the false report.
    exhausted: snapshot.exhausted,
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
    carrying: projectCarryingContext(snapshot, toolSlots),
  });
}

/**
 * The carried stacks, bounded by rows and by the bytes they cost the text line.
 *
 * Both bounds report what they cost (`omitted`), because a list that silently stops at eight reads as a complete
 * inventory of eight. The byte bound is the one that matters: the line is joined into a text capped at
 * `MAX_PROJECTION_TEXT_BYTES`, and a truncation there would cut a fact in half rather than drop a whole one.
 */
export function projectCarryingContext(
  snapshot: Snapshot,
  toolSlots: readonly Readonly<{ slot: number }>[],
): CarryingContextProjection {
  const published = snapshot.inventoryItemFacts;
  if (published === undefined)
    return Object.freeze({ revision: snapshot.revision, measured: false, rows: [], omitted: 0 });
  const toolSlotNumbers = new Set(toolSlots.map((tool) => tool.slot));
  const carried = published.filter((item) => !toolSlotNumbers.has(item.slot));
  const rows: Readonly<{ slot: number; label: string; stack: number }>[] = [];
  let bytes = 0;
  for (const item of carried) {
    const label = boundedUtf8(item.displayName, MAX_PROJECTION_STRING_BYTES);
    const cost = Buffer.byteLength(`${String(item.stack)}x ${label}, `, "utf8");
    if (rows.length >= MAX_PROJECTION_CARRYING_ROWS || bytes + cost > MAX_PROJECTION_CARRYING_BYTES) break;
    bytes += cost;
    rows.push(Object.freeze({ slot: item.slot, label, stack: item.stack }));
  }
  return Object.freeze({
    revision: snapshot.revision,
    measured: true,
    rows: Object.freeze(rows),
    omitted: carried.length - rows.length,
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

export function projectSlimeHutchTroughContext(snapshot: Snapshot): readonly SlimeHutchTroughContextProjection[] {
  return Object.freeze(
    (snapshot.slimeHutchTroughTargets ?? []) // The current hutch's unwatered rows are situational context; keep the structured helper bounded.
      .slice(0, MAX_PROJECTION_SLIME_HUTCH_TROUGHS)
      .map((trough) =>
        Object.freeze({
          targetId: boundedUtf8(trough.targetId, MAX_PROJECTION_STRING_BYTES),
          x: Number.isFinite(trough.x) ? trough.x : 0,
          y: Number.isFinite(trough.y) ? trough.y : 0,
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
/**
 * When the sleep hint starts appearing. 18:00 is where a farm day stops being worth starting another task, and the
 * number exists only so the hint is not printed all morning.
 *
 * It is deliberately NOT an engine rule: the executor ends the day on request, at any hour. If a real precondition is
 * ever added to `sleep`, this errs in the harmless direction - a hint that is too eager - and the executor's refusal is
 * what tells the caller.
 */
const SLEEP_HINT_FROM_TIME_OF_DAY = 1800;

export function projectGameSnapshotContext(
  snapshot: Snapshot | null | undefined,
  sampledAtMs: number,
  nowMs: number,
): GameSnapshotContextProjection {
  if (snapshot === null || snapshot === undefined) return unavailableProjection("unavailable");
  if (!isSnapshotInput(snapshot)) return unavailableProjection("invalid");

  const movementSource = projectMovementContext(snapshot);
  const farmingSource = projectFarmingContext(snapshot);
  const inventorySource = projectInventoryContext(snapshot);
  const clockSource = projectClockContext(snapshot);
  const petSource = projectPetContext(snapshot);
  const petBowlSource = projectPetBowlContext(snapshot);
  const slimeHutchTroughSource = projectSlimeHutchTroughContext(snapshot);
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
  const slimeHutchTroughs = Object.freeze(slimeHutchTroughSource.map((trough) => Object.freeze({ ...trough })));
  const sampledAgeMs = boundedAge(sampledAtMs, nowMs);
  const text = boundedUtf8(
    [
      "[Game Snapshot Projection v1:",
      // No age here. This text is composed once, when the snapshot is taken, so any age printed into it is frozen at
      // that instant and reads as fresh forever - the HUD already says the live age (`observed N turns ago`), and two
      // spellings of one fact let the stale one win (round35: `Sampled: 5ms ago` beside `observed 9 turns ago` for a
      // 112 s old snapshot). One owner, no number here.
      `- Snapshot Revision: #${snapshot.revision}`,
      `- Time: ${formatGameClock(clock.timeOfDay)}, Season: ${seasonName(clock.seasonIndex)}, Day: ${clock.dayOfMonth}, Year: ${clock.year}`,
      `- Location: ${location}, Tile: (${movement.tile.x}, ${movement.tile.y}), Actionable: ${movement.actionable}`,
      ...(movement.holdingModal === null
        ? []
        : [
            // Next to the flag the model misread, and saying what the flag leaves out: a modal IS an action, so
            // `Actionable: true` is not the promise it looks like.
            `- Modal: ${movement.holdingModal} - owns the screen${openedBy(movement.holdingModalActionOwned)}: the game clock does not advance and no other action can run until it is cleared; dismiss_modal closes an informational menu, answer_dialogue a question`,
          ]),
      // `sleep` has no location precondition and no clock precondition: `RequestLocalAdvanceDay` checks the bound actor,
      // world readiness and admission, then runs the lifecycle from wherever the actor stands. So this line must claim
      // neither, and it says exactly what the executor enforces.
      //
      // The threshold below is a PRESENTATION choice - a hint nobody needs at 09:00 - and must never be read as a gate.
      ...(clock.timeOfDay >= SLEEP_HINT_FROM_TIME_OF_DAY
        ? ["- Sleep: `sleep()` ends the day from wherever you are - the actor goes to bed and the save advances"]
        : []),
      `- Farming: Stamina=${snapshot.stamina}, Exhausted=${snapshot.exhausted === true}, Health=${snapshot.health}, SoilTiles=${farming.soilTilesCount}, CanTill=${farming.canTill}, CanWater=${farming.canWater}`,
      `- Tools: Slots=${inventory.inventorySlots}, Equipped=${currentTool}, Labels=${toolLabels.join(", ")}`,
      `- Carrying: ${carryingText(inventory.carrying)}`,
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
    slimeHutchTroughs,
  });

  // The static field caps above make this a normal path, while this assertion
  // keeps a future allowlisted field from silently weakening the boundary.
  if (Buffer.byteLength(JSON.stringify(projection), "utf8") > MAX_GAME_SNAPSHOT_PROJECTION_BYTES)
    return unavailableProjection("invalid");
  return projection;
}

/** The carrying line: three different answers, never one word for all of them. */
function carryingText(carrying: CarryingContextProjection): string {
  if (!carrying.measured) return "not measured";
  if (carrying.rows.length === 0) return "nothing but tools";
  const shown = carrying.rows.map((row) => `${String(row.stack)}x ${row.label}`).join(", ");
  return `${shown}${carrying.omitted === 0 ? "" : ` (+${String(carrying.omitted)} more)`}`;
}

function unavailableProjection(reasonCode: "unavailable" | "invalid"): GameSnapshotContextProjection {
  return Object.freeze({
    schema: GAME_SNAPSHOT_PROJECTION_SCHEMA,
    available: false as const,
    reasonCode,
    text: "[Game Snapshot Unavailable]" as const,
  });
}

/** Renders the modal's owner only when the Mod reported one; an unmeasured owner says nothing. */
function openedBy(actionOwned: boolean | null): string {
  if (actionOwned === null) return "";
  return actionOwned ? " (opened by your own action)" : " (opened by the game, not by your action)";
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
    typeof value.exhausted === "boolean" &&
    Number.isFinite(value.health) &&
    (value.timeOfDay === undefined ||
      (Number.isSafeInteger(value.timeOfDay) && value.timeOfDay >= 0 && value.timeOfDay <= 2600)) &&
    (value.dayOfMonth === undefined ||
      (Number.isSafeInteger(value.dayOfMonth) && value.dayOfMonth >= 1 && value.dayOfMonth <= 28)) &&
    (value.seasonIndex === undefined ||
      (Number.isSafeInteger(value.seasonIndex) && value.seasonIndex >= 0 && value.seasonIndex <= 3)) &&
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
    (value.slimeHutchTroughTargets === undefined ||
      (Array.isArray(value.slimeHutchTroughTargets) &&
        value.slimeHutchTroughTargets.every(
          (trough) =>
            trough !== null &&
            typeof trough === "object" &&
            typeof trough.targetId === "string" &&
            Number.isFinite(trough.x) &&
            Number.isFinite(trough.y),
        ))) &&
    (value.toolSlots === undefined ||
      (Array.isArray(value.toolSlots) &&
        value.toolSlots.every(
          (tool) => tool !== null && typeof tool === "object" && typeof tool.label === "string",
        ))) &&
    (value.inventoryItemFacts === undefined ||
      (Array.isArray(value.inventoryItemFacts) &&
        value.inventoryItemFacts.every(
          (item) =>
            item !== null &&
            typeof item === "object" &&
            Number.isSafeInteger(item.slot) &&
            typeof item.qualifiedItemId === "string" &&
            typeof item.displayName === "string" &&
            Number.isSafeInteger(item.stack),
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
