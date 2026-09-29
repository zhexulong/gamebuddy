#!/usr/bin/env node
// Discovery-channel audit for the Stardew action surface.
//
// An action is not usable just because it is registered: the Agent must also be
// able to (1) see the action as a tool and (2) name a real target for it. The
// second leg is a four-hop chain owned by four different layers:
//
//   1. Mod wire        - integrations/stardew/src/Core/Models/BridgeProtocolModels.cs
//                        declares IReadOnlyList<BridgeXTarget>? XTargets
//   2. Host projection - host/src/protocol.ts validates and types the field
//   3. Envelope schema - protocol/bridge-v1.schema.json admits the field under
//                        $defs/snapshot (additionalProperties:false, so a
//                        missing entry makes the field unshippable)
//   4. Agent contract  - host/src/game-tools.ts names the field in the tool
//                        description so the Agent knows where to read it
//
// Any hole in the chain is silent: the game state exists, the Mod sends it, and
// the Agent still cannot act. This tool reports per-action holes rather than a
// single pass/fail, and exits non-zero when a target-bearing action has one.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SURFACE = "integrations/stardew/action-development/contracts/generated/action-surface.v1.json";
const MODELS = "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs";
const PROTOCOL = "host/src/protocol.ts";
const SCHEMA = "protocol/bridge-v1.schema.json";
const TOOLS = "host/src/game-tools.ts";

/**
 * The snapshot field each action's opaque target is published under.
 *
 * This is the observation contract, declared once here rather than scraped from
 * tool prose: if the prose is wrong the audit must still catch it, which is
 * exactly how the craft_item/cook_recipe `recipeTargets` drift was found.
 */
const TARGET_FIELD = Object.freeze({
  pickup_forage: "ForageTargets",
  pickup_item: "ItemTargets",
  water_crop: "CropTargets",
  plant_seed: "SeedTargets",
  fertilize_tile: "FertilizerTargets",
  machine_inspect: "MachineTargets",
  machine_load: "MachineTargets",
  machine_collect_output: "MachineTargets",
  collect_animal_product: "AnimalProductTargets",
  feed_animal: "FeedTroughTargets",
  use_item: "FoodTargets",
  harvest_crop: "HarvestTargets",
  place_wood_fence: "WoodFenceTargets",
  place_crab_pot: "CrabPotTargets",
  bait_crab_pot: "BaitCrabPotTargets",
  chop_tree_source: "TreeChopSourceTargets",
  break_rock_source: "RockSourceTargets",
  clear_hoedirt: "ClearHoeDirtTargets",
  dig_artifact_spot: "ArtifactSpotTargets",
  refill_watering_can: "RefillWateringCanTargets",
  clear_debris: "DebrisTargets",
  npc_relationship: "NpcRelationshipTargets",
  interact_npc_with_item: "NpcRelationshipTargets",
  pet_animal: "PetTargets",
  water_pet_bowl: "PetBowlTargets",
  water_slime_hutch_trough: "SlimeHutchTroughTargets",
  chest_store: "ChestStoreTargets",
  chest_retrieve: "ChestRetrieveTargets",
  chop_stump: "TreeStumpTargets",
  plant_sapling: "TreeSaplingTargets",
  cut_weeds: "WeedTargets",
  scythe_crop: "ScytheCropTargets",
  craft_item: "CraftingRecipeTargets",
  cook_recipe: "CookingRecipeTargets",
  collect_crab_pot_output: "CrabPotCollectTargets",
  ship_item: "ShippingBinTargets",
});

/** Actions that carry a target but whose target is not a snapshot list. */
const NON_SNAPSHOT_TARGET_ACTIONS = Object.freeze([
  "navigate_to_destination", // destination selector, resolved by the Mod
  "travel", // source tile of a native warp
  "enter_exit", // tile of a door/warp
  "move_to_tile", // raw coordinates
  "till_soil",
  "equip_tool",
  "express_emote",
  "face_direction",
  "advance_day", // no arguments at all: the actor's own bed is the target
]);

function read(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

function lower(name) {
  return name[0].toLowerCase() + name.slice(1);
}

export function auditDiscoveryChannels({
  surface = JSON.parse(read(SURFACE)),
  models = read(MODELS),
  protocol = read(PROTOCOL),
  schema = JSON.parse(read(SCHEMA)),
  gameTools = read(TOOLS),
} = {}) {
  const modFields = new Set(
    [...models.matchAll(/IReadOnlyList<Bridge\w+>\??\s+(\w+),/g)].map((m) =>
      m[1].toLowerCase(),
    ),
  );
  const schemaProps = new Set(
    Object.keys(schema.$defs?.snapshot?.properties ?? {}).map((k) =>
      k.toLowerCase(),
    ),
  );

  // Agent-facing tools: `isVisible("<action>")` is the Host's own gate.
  const toolVisible = new Set(
    [...gameTools.matchAll(/if \(isVisible\("([a-z0-9_]+)"\)\)/g)].map(
      (m) => m[1],
    ),
  );

  // The snapshot list each tool description actually tells the Agent to read.
  //
  // Slice on the isVisible markers rather than requiring tools.push to follow
  // immediately: a few actions (pet_animal, interact_npc_with_item, ...) run a
  // descriptor-completeness guard and a schema build before pushing, so a
  // pattern anchored on tools.push would silently skip them and report a
  // "does not name its field" gap that is not real.
  const describedFields = new Map();
  const chunks = gameTools.split(/if \(isVisible\("/).slice(1);
  for (const chunk of chunks) {
    const visible = chunk.match(/^([a-z0-9_]+)"\)\)/);
    if (!visible) continue;
    const desc = chunk.match(
      /description:\s*\n?\s*"([\s\S]*?)",\s*\n\s*parameters:/,
    );
    const text = desc ? desc[1] : "";
    const named = [...text.matchAll(/\b([a-zA-Z]+Targets)\b/g)].map(
      (x) => x[1],
    );
    describedFields.set(visible[1], [...new Set(named)]);
  }

  const rows = [];
  for (const action of surface.actions) {
    const args = Object.keys(action.argumentSchema ?? {});
    const needsTarget = args.includes("expectedTargetId");
    const field =
      TARGET_FIELD[action.actionId] ??
      (NON_SNAPSHOT_TARGET_ACTIONS.includes(action.actionId)
        ? null
        : needsTarget
          ? undefined
          : null);

    rows.push({
      actionId: action.actionId,
      lifecycle: action.lifecycle,
      kind: action.kind,
      needsTarget,
      field,
      toolVisible: toolVisible.has(action.actionId),
      inMod: field ? modFields.has(field.toLowerCase()) : null,
      inProtocol: field
        ? protocol.includes(lower(field)) || protocol.includes(field)
        : null,
      inSchema: field ? schemaProps.has(field.toLowerCase()) : null,
      describedAs: describedFields.get(action.actionId) ?? [],
      declared: action.actionId in TARGET_FIELD ||
        NON_SNAPSHOT_TARGET_ACTIONS.includes(action.actionId),
    });
  }

  const gaps = [];
  for (const row of rows) {
    if (row.kind === "read_only") continue;
    if (!row.toolVisible)
      gaps.push({ ...row, gap: "no_agent_tool" });
    if (row.field === undefined)
      gaps.push({ ...row, gap: "undeclared_target_field" });
    else if (row.field) {
      if (!row.inMod) gaps.push({ ...row, gap: "missing_mod_wire_field" });
      if (!row.inProtocol) gaps.push({ ...row, gap: "missing_host_protocol_field" });
      if (!row.inSchema)
        gaps.push({ ...row, gap: "missing_envelope_schema_field" });
      const real = row.describedAs.filter(
        (n) => n.toLowerCase() === row.field.toLowerCase(),
      );
      const wrong = row.describedAs.filter(
        (n) => n.toLowerCase() !== row.field.toLowerCase(),
      );
      if (wrong.length > 0)
        gaps.push({ ...row, gap: `tool_names_wrong_field:${wrong.join(",")}` });
      else if (real.length === 0)
        gaps.push({ ...row, gap: "tool_does_not_name_target_field" });
    }
  }

  return Object.freeze({
    schema: "gamebuddy-stardew-discovery-channel-audit/v1",
    actionCount: rows.length,
    targetBearingCount: rows.filter((r) => r.needsTarget).length,
    rows,
    gaps,
    ok: gaps.length === 0,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = auditDiscoveryChannels();
  const byGap = new Map();
  for (const gap of report.gaps) {
    const list = byGap.get(gap.gap) ?? [];
    list.push(gap.actionId);
    byGap.set(gap.gap, list);
  }
  process.stdout.write(
    `discovery channels: ${report.actionCount} actions, ${report.targetBearingCount} target-bearing\n`,
  );
  for (const [gap, actions] of [...byGap].sort())
    process.stdout.write(`  [${gap}] ${actions.length}: ${actions.join(", ")}\n`);
  process.stdout.write(
    report.ok
      ? "  all target-bearing actions have a complete discovery chain\n"
      : `  ${report.gaps.length} gap(s)\n`,
  );
  process.exitCode = report.ok ? 0 : 1;
}
