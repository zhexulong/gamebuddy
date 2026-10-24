/**
 * The Mod's own action families, as the settings surface may name them.
 *
 * The authority for this list is `integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs`:
 * the Mod validates `DeniedActionFamilies` against exactly those registrations
 * (`ActionPolicyEngine.ValidateActionPolicy`) and REFUSES THE WHOLE POLICY when one
 * entry names a family it does not define. A surface that offered a family of its
 * own invention would therefore not merely be wrong about one checkbox - it would
 * disable the player's entire action policy. So the set is derived from the Mod's
 * catalog, and `stardew-action-families.test.ts` re-derives it from that source
 * and fails loudly when this list drifts from it.
 *
 * The order is the order a player reads: the everyday farm work first, then the
 * infrastructure, then the world-facing families. The Mod's registration order is
 * an implementation order (first-registered first), and a settings list that
 * reshuffled itself whenever an action was added would be unreadable.
 */
export const STARDEW_ACTION_FAMILIES = Object.freeze([
  "farming_crops",
  "resource_gathering",
  "animals_pets",
  "machines_processing",
  "crafting_cooking",
  "buildings_farm_management",
  "inventory_items",
  "body_tools",
  "movement_navigation",
  "world_navigation",
  "world_perception",
  "transport_warps",
  "water_travel",
  "animal_transport",
  "npc_social",
  "shops_economy",
  "quests_journal",
  "world_lifecycle",
  "facility_storage_lighting",
  "modal_handling",
  "expression",
] as const);

export type StardewActionFamily = (typeof STARDEW_ACTION_FAMILIES)[number];

const STARDEW_ACTION_FAMILY_SET: ReadonlySet<string> = new Set(STARDEW_ACTION_FAMILIES);

/** True only for a family the Mod's catalog really declares. */
export function isStardewActionFamily(value: unknown): value is StardewActionFamily {
  return typeof value === "string" && STARDEW_ACTION_FAMILY_SET.has(value);
}
