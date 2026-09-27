#!/usr/bin/env node
/**
 * Gate: every tool-family action's succeeded receipt must report the agent's
 * stamina change, because a tool use is a first-order embodied mutation.
 *
 * The native attack tree: `Game1.toolAnimationDone` calls `CurrentTool.DoFunction`
 * only when `who.Stamina > 0f` and every concrete tool (`Axe`, `Pickaxe`, `Hoe`,
 * `WateringCan`, `MilkPail`, `Shears`) deducts stamina inside `DoFunction`
 * (`Stamina -= ...`). Scythe costs 0 but the receipt must still say `stamina_after`
 * so the agent learns "this family is free".
 *
 * `action-specific` has never meant "each action bespoke"; it means "same native
 * family, same evidence shape". Causal completeness -- the world side AND the agent
 * side of the irreversible mutation -- requires both halves on the receipt.
 *
 * Tool-family entries are keyed by handler prefix and the native tool each drives.
 *
 * Second invariant: the cross-day exhaustion consequence. A vanilla swing runs
 * through `FarmerSprite` -> `Farmer.useTool`, which calls
 * `who.checkForExhaustion(oldStamina)` after `DoFunction`. That method is the ONLY
 * writer of the persistent `exhausted.Value` flag (`if (stamina <= 0f) exhausted.Value
 * = true`), and that flag halves the next morning's restored stamina
 * (`Farmer.cs` day-update: `Stamina = MaxStamina / 2 + 1`). A direct
 * game-thread `DoFunction` bypasses `Farmer.useTool`, so it must call
 * `checkForExhaustion` itself or the companion silently escapes vanilla's
 * exhaustion penalty -- an embodiment difference that is invisible in the
 * receipt without this gate.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
export const STARDEW_EXECUTION_MANAGER_FILES = Object.freeze([
  "integrations/stardew/farmhandexecutioncontroller.cs",
  "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs",
  "integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs",
  "integrations/stardew/farmhandexecutioncontroller.machinesanimalsitemsactions.cs",
]);
const EXECUTION_MANAGER_FILES = STARDEW_EXECUTION_MANAGER_FILES;

/**
 * Tool-family entries: the native side of each handler drives a real Tool
 * (DoFunction directly, or BeginUsingTool whose apex frame calls DoFunction).
 * Each of those tools deducts stamina inside DoFunction (Axe/Pickaxe/Hoe/
 * WateringCan/MilkPail/Shears); Scythe and the watering-can refill branch cost
 * 0 but must still report stamina_delta so the agent learns the fact.
 *
 * harvest_crop is deliberately NOT in this family: it is a hand-pick
 * (HoeDirt.performUseAction Grab) with no tool involved, so it has no stamina
 * side-effect to report.
 */
const TOOL_FAMILY = Object.freeze({
  RequestLocalChopTreeSource: { tool: "axe", dispatch: "DoFunction", terminal: "tree_source_chopped" },
  RequestLocalChopStump: { tool: "axe", dispatch: "DoFunction", terminal: "stump_cleared" },
  RequestLocalBreakRockSource: { tool: "pickaxe", dispatch: "DoFunction", terminal: "rock_source_broken" },
  RequestLocalClearHoeDirt: { tool: "pickaxe", dispatch: "DoFunction", terminal: "hoedirt_cleared" },
  RequestLocalDigArtifactSpot: { tool: "hoe", dispatch: "DoFunction", terminal: "artifact_spot_dug" },
  RequestLocalTillSoil: { tool: "hoe", dispatch: "DoFunction", terminal: "soil_tilled" },
  RequestLocalWaterCrop: { tool: "wateringCan", dispatch: "DoFunction", terminal: "crop_watered" },
  RequestLocalRefillWateringCan: { tool: "wateringCan", dispatch: "DoFunction", terminal: "watering_can_refilled" },
  RequestLocalClearDebris: { tool: "activeTool", dispatch: "DoFunction", terminal: "debris_cleared" },
  RequestLocalScytheCrop: { tool: "scythe", dispatch: "performToolAction", terminal: "scythe_crops_harvested" },
  RequestLocalCutWeeds: { tool: "scythe", dispatch: "performToolAction", terminal: "weeds_cut" },
  RequestLocalCollectAnimalProduct: { tool: "tool", dispatch: "BeginUsingTool", terminal: "animal_product_collected" },
});
export const STARDEW_TOOL_FAMILY = TOOL_FAMILY;

const STAMINA_EVIDENCE_ALL = /stamina_before/;
const STAMINA_EVIDENCE_FIELDS = ["stamina_before", "stamina_after", "stamina_delta", "expected_stamina_cost"];

export const STARDEW_EXHAUSTION_FAMILY = Object.freeze([
  "RequestLocalChopTreeSource",
  "RequestLocalChopStump",
  "RequestLocalBreakRockSource",
  "RequestLocalClearHoeDirt",
  "RequestLocalDigArtifactSpot",
  "RequestLocalTillSoil",
  "RequestLocalWaterCrop",
  "RequestLocalRefillWateringCan",
  "RequestLocalClearDebris",
]);

/**
 * Handlers that drive their tool through native `BeginUsingTool` and let the
 * game run the swing animation. The native frame ends in `Farmer.useTool`, which
 * calls `checkForExhaustion` for them -- so, unlike the direct-dispatch family,
 * they must NOT hand-roll it (a second call would be redundant, not wrong, but
 * asserting absence keeps the ownership unambiguous).
 */
export const STARDEW_NATIVE_ANIMATION_FAMILY = Object.freeze([
  "RequestLocalCollectAnimalProduct",
]);

/** Extract one handler body by brace balance from its declaration. */
function handlerBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) return null;
  let depth = 0;
  let started = false;
  for (let i = start; i < source.length; i += 1) {
    const c = source[i];
    if (c === "{") {
      depth += 1;
      started = true;
    } else if (c === "}") {
      depth -= 1;
      if (started && depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

export function validateToolFamilyStaminaEvidence(sources) {
  const failures = [];
  const bodies = new Map();
  const files = Object.keys(sources);
  const allSources = Object.values(sources).join("\n");
  /** A handler lives in one of the provided source files; search all, first hit wins. */
  for (const [handler, entry] of Object.entries(TOOL_FAMILY)) {
    let found = false;
    for (const file of files) {
      const text = sources[file] ?? "";
      const sig = `public LocalExecutionReceipt ${handler}(`;
      const body = handlerBody(text, sig);
      if (body !== null) {
        bodies.set(handler, { body, tool: entry.tool, dispatch: entry.dispatch, terminal: entry.terminal, file });
        found = true;
        break;
      }
    }
    if (!found) failures.push(`handler ${handler} not found in any execution-manager file`);
  }

  for (const [handler, { body, tool, dispatch, terminal }] of bodies) {
    // Some families are async (BeginUsingTool → native animation frame → terminal
    // receipt in the tick handler, not in the accept body). The succeeded receipt
    // names the terminal reasonCode as an argument, followed by an inline `$"..."`
    // evidence string inside the same constructor call. Resolve exactly that
    // statement: from the reasonCode forward to the first `);` (the constructor's
    // close). Never a fixed window, so a neighbor handler's evidence in another
    // file/statement can never satisfy this receiver.
    let scanned = body;
    if (!STAMINA_EVIDENCE_ALL.test(body)) {
      const idx = allSources.indexOf(terminal);
      if (idx >= 0) {
        const close = allSources.indexOf(");", idx);
        const window = close >= 0 ? allSources.slice(Math.max(0, idx - 40), close + 2) : allSources.slice(idx, idx + 1500);
        if (window.includes("ExecutionState.Succeeded")) scanned = window;
      }
    }
    const missing = STAMINA_EVIDENCE_FIELDS.filter((f) => !scanned.includes(f));
    if (missing.length > 0) {
      failures.push(
        `${handler}: terminal receipt lacks ${missing.join("/")} (tool=${tool}, dispatch=${dispatch}; scanned ${scanned === body ? "handler body" : "terminal receipt"})`,
      );
    }
    // Second invariant: a directly dispatched stamina-deducting tool must set the
    // persistent exhaustion consequence the way Farmer.useTool does.
    if (STARDEW_EXHAUSTION_FAMILY.includes(handler) && !body.includes("checkForExhaustion")) {
      failures.push(
        `${handler}: direct tool dispatch never calls checkForExhaustion, so the vanilla cross-day exhaustion penalty (exhausted.Value -> half stamina next morning) is bypassed`,
      );
    }
  }
  return failures;
}

async function main() {
  const sources = {};
  for (const file of EXECUTION_MANAGER_FILES) {
    sources[file] = await readFile(resolve(ROOT, file), "utf8");
  }
  const failures = validateToolFamilyStaminaEvidence(sources);
  if (failures.length > 0) {
    console.error(`tool-family stamina evidence: ${failures.length} violation(s)`);
    for (const f of failures) console.error(`  ✖ ${f}`);
    process.exitCode = 1;
  } else {
    console.log("tool-family stamina evidence: OK (every tool-family action reports stamina)");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => {
    console.error(`${e.message}`);
    process.exitCode = 2;
  });
}