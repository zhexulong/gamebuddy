import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseBridgeMessage, newEnvelope, type Scope, type Snapshot } from "./protocol.js";
import { boundObservedSnapshot } from "./stardew-observation-budget.js";

/**
 * WHAT THE COMPANION CAN DECIDE WITHOUT ASKING A SECOND QUESTION.
 *
 * <p>
 * The crop row published `watered` and `harvestable` and nothing about the crop itself, so "how should this crop be
 * planted" was only answerable through `look_up({subject:"data", table:"Crops"})` - a channel that exists and that a
 * day of runs (measured 2026-11-09) never used: `look_up` was called once, with `subject: "affordances"`. A fact that
 * is only reachable through a call nobody makes is the same defect as a fact nobody publishes.
 * </p>
 *
 * <p>
 * These tests drive the REAL path the model's world arrives by: a bridge frame the Mod would publish -> the Host's own
 * diagnostic -> `boundObservedSnapshot`, which is what `stardew_observe` hands the model. A field the wire accepts and
 * the projection drops fails here. They are deliberately two-directional: the frame the current Mod sends must be
 * accepted, and a row carrying a key the Mod does not send must be refused - the state four live runs died at hello
 * with.
 * </p>
 */

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};
const now = 1_700_000_000_000;

const snapshot: Snapshot = {
  revision: 12,
  location: "Farm",
  tile: { x: 10, y: 11 },
  stamina: 270,
  exhausted: false,
  health: 100,
  actionable: true,
  capabilities: ["water_crop"],
  catalogRevision: 3,
  enabledActionIds: ["water_crop"],
  presentationLocale: "en-US",
  timeOfDay: 600,
  dayOfMonth: 1,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
  activeExecution: null,
};

/** One row as the Mod publishes it: every fact read from `CropData`/`Crop`/the location at that revision. */
const trellisRow = {
  targetId: "crop_deadbeef",
  x: 10,
  y: 12,
  cropId: "9671",
  displayName: "Grape Starter",
  watered: false,
  harvestable: false,
  daysToHarvest: 6,
  regrowDays: 3,
  harvestMethod: "grab",
  isRaised: true,
  seasons: ["spring", "summer"],
  fullyGrown: false,
  tileBlockedNow: true,
} as const;

const frameOf = (rows: readonly unknown[]) =>
  newEnvelope(
    "snapshot",
    scope,
    { ...snapshot, cropTargets: rows } as unknown as Snapshot,
    "snapshot_crop_row_01",
    now,
  );

test("a Mod crop row's layout facts reach the model without a second question", () => {
  const frame = frameOf([trellisRow]);
  assert.equal(diagnoseBridgeMessage(frame, scope, now), "accepted");

  // The projection `stardew_observe` hands the model, not the validated frame: a field the wire accepts and this
  // drops would leave the companion exactly as blind as before.
  const { snapshot: visible } = boundObservedSnapshot(frame.payload as unknown as Snapshot);
  const rows = (visible as Readonly<{ cropTargets?: readonly Record<string, unknown>[] }>).cropTargets;
  assert.ok(rows !== undefined, "the crop family must survive the observation budget");
  assert.deepEqual(rows[0], trellisRow);
});

test("a crop row carrying a key the Mod does not publish is refused rather than silently ignored", () => {
  const frame = frameOf([{ ...trellisRow, isPaddyCrop: true }]);
  assert.match(diagnoseBridgeMessage(frame, scope, now) ?? "", /^invalid_snapshot:cropTargets/u);
});

test("a row that states why the data is unknown and also states the data is refused", () => {
  const frame = frameOf([{ ...trellisRow, cropFactsUnknown: "crop_data_missing" }]);
  assert.match(diagnoseBridgeMessage(frame, scope, now) ?? "", /^invalid_snapshot:cropTargets/u);
});

test("a row with no data facts and the gap token is accepted, and the gap reaches the model", () => {
  const rowWithoutData = {
    targetId: "crop_deadbeef",
    x: 10,
    y: 12,
    cropId: "9673",
    displayName: "Modded Seed",
    watered: false,
    harvestable: false,
    fullyGrown: false,
    tileBlockedNow: false,
    cropFactsUnknown: "crop_data_missing",
  };
  const frame = frameOf([rowWithoutData]);
  assert.equal(diagnoseBridgeMessage(frame, scope, now), "accepted");

  const { snapshot: visible } = boundObservedSnapshot(frame.payload as unknown as Snapshot);
  const rows = (visible as Readonly<{ cropTargets?: readonly Record<string, unknown>[] }>).cropTargets;
  assert.deepEqual(rows?.[0], rowWithoutData, "the token that says WHY is the fact she plans with, not a default");
});

test("a season list longer than the engine's own vocabulary is refused at the wire", () => {
  const frame = frameOf([{ ...trellisRow, seasons: ["spring", "summer", "fall", "winter", "spring"] }]);
  assert.match(diagnoseBridgeMessage(frame, scope, now) ?? "", /^invalid_snapshot:cropTargets/u);
});
