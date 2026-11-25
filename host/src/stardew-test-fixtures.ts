import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ActionRegistration, ActionRegistrationDescriptor } from "./protocol.js";

/** One argument of one action as the Mod's own surface artifact publishes it. */
type PublishedArgument = Readonly<{
  type: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  resolvedAtExecution?: boolean;
}>;

/**
 * One action's descriptor, exactly as the Mod's own surface artifact publishes it.
 *
 * The fixture used to carry no descriptor at all, and every Game Action tool still mounted - because all 25 actions it
 * names had a hand-written mount block that never consulted the catalog. They are projections of the declaration now
 * (`game-tools.ts` `HOST_PRESENTED_ACTION_IDS`), so a fixture that publishes arguments and no descriptor would be a Mod
 * this Host cannot build a tool for: the mount skips it, and a test that looked the tool up by name would read the
 * absence as a behaviour change. Reading the artifact keeps the fixture a Mod rather than a shape the Host invented.
 */
const SURFACE: readonly Readonly<{
  actionId: string;
  argumentSchema?: Readonly<Record<string, PublishedArgument>>;
  effect?: "read" | "write";
  postcondition?: Readonly<{ name?: string }>;
  nativeBinding?: string;
  label?: string;
  targetKinds?: readonly string[];
}>[] = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "integrations",
      "stardew",
      "action-development",
      "contracts",
      "generated",
      "action-surface.v1.json",
    ),
    "utf8",
  ),
).actions;

export function publishedDescriptor(actionId: string): ActionRegistrationDescriptor {
  const action = SURFACE.find((candidate) => candidate.actionId === actionId);
  if (action === undefined) throw new Error(`test_fixture_action_not_in_the_surface_artifact:${actionId}`);
  const arguments_ = Object.entries(action.argumentSchema ?? {}).map(([name, schema]) => ({
    name,
    type: schema.type,
    ...(schema.enum === undefined ? {} : { enum: schema.enum }),
    ...(schema.minimum === undefined ? {} : { minimum: schema.minimum }),
    ...(schema.maximum === undefined ? {} : { maximum: schema.maximum }),
    ...(schema.minLength === undefined ? {} : { minLength: schema.minLength }),
    ...(schema.maxLength === undefined ? {} : { maxLength: schema.maxLength }),
    ...(schema.resolvedAtExecution === true ? { resolvedAtExecution: true as const } : {}),
  }));
  return Object.freeze({
    arguments: arguments_,
    ...(action.effect === undefined ? {} : { effect: action.effect }),
    ...(action.postcondition?.name === undefined ? {} : { postcondition: { name: action.postcondition.name } }),
    ...(action.nativeBinding === undefined ? {} : { nativeBinding: action.nativeBinding }),
    // The two FACTS the mount loop reads before it projects anything: a derived action whose descriptor omits its
    // label mounts no tool at all, so a fixture that dropped it would exercise a surface the Mod never advertises.
    ...(action.label === undefined ? {} : { label: action.label }),
    ...(action.targetKinds === undefined ? {} : { targetKinds: action.targetKinds }),
  });
}

/**
 * Test-only authenticated Mod catalog. This explicit fixture deliberately does
 * not derive from Host adapters: the Mod owns action membership and metadata.
 */
export const TEST_MOD_REGISTRATIONS: readonly ActionRegistration[] = Object.freeze(
  (
    [
      ["move_to_tile", "movement_navigation"],
      ["equip_tool", "body_tools"],
      ["travel", "transport_warps"],
      ["enter_exit", "movement_navigation"],
      ["till_soil", "farming_crops"],
      ["pickup_forage", "resource_gathering"],
      ["pickup_item", "inventory_items"],
      ["water_crop", "farming_crops"],
      ["refill_watering_can", "farming_crops"],
      ["plant_seed", "farming_crops"],
      ["fertilize_tile", "farming_crops"],
      ["place_wood_fence", "buildings_farm_management"],
      ["place_crab_pot", "buildings_farm_management"],
      ["bait_crab_pot", "buildings_farm_management"],
      ["machine_inspect", "machines_processing"],
      ["machine_load", "machines_processing"],
      ["machine_collect_output", "machines_processing"],
      ["collect_animal_product", "animals_pets"],
      ["feed_animal", "animals_pets"],
      ["use_item", "inventory_items"],
      ["harvest_crop", "farming_crops"],
      ["break_rock", "resource_gathering"],
      ["clear_hoedirt", "farming_crops"],
      ["dig_artifact_spot", "resource_gathering"],
      ["chop_tree", "resource_gathering"],
    ] as const
  ).map(([actionId, familyId]) =>
    Object.freeze({
      actionId,
      familyId,
      identityVersion: 1,
      lifecycle: "published" as const,
      kind: "execution" as const,
      descriptor: publishedDescriptor(actionId),
    }),
  ),
);
