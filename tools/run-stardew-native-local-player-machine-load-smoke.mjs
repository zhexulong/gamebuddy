// Stardew-local machine_load smoke.
//
// The lifecycle - the fixture-config refusal, observe-fresh and the capability check, the requestId mint and the
// execute, the terminal wait and its identity, the evidence parse and the stale reread, the stale re-send, the
// bootstrap and the exit code - is `tools/lib/native-local-runner-scaffold.mjs`. What is left here is what is
// actually about loading a keg.
//
// The receipt is not the proof. The machine's own published row is: after the load the `machineTargets`
// projection must show the SAME target holding the held object, scheduled for the duration its live data
// derives, with the input it consumed recorded as its last input. The evidence must agree with that row
// field by field, and the receipt must not claim a duration the Mod did not derive.

import { defineSmokeScenario, runSmokeScenarioMain } from "./lib/native-local-runner-scaffold.mjs";

const ACTION = "machine_load";
/** The action's own success word (`ExecuteMachineLoad`: the keg took the input and scheduled its product). */
const SUCCESS_CODE = "machine_coffee_loaded";
/** The one `NativeLocalPlayerFixture.FixtureScenario` this gate arms (gate descriptor `native_machine_coffee_load_v1`). */
const FIXTURE_SCENARIO = "native_machine_coffee_load_v1";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
/** The machine's catalogue id — the keg the fixture stages, and the row this contract re-reads. */
const KEG_QUALIFIED_ITEM_ID = "(BC)12";

const scenario = defineSmokeScenario({
  action: ACTION,
  fixtureScenario: FIXTURE_SCENARIO,
  successCode: SUCCESS_CODE,
  requiredCapabilities: REQUIRED_CAPABILITIES,
  requiredActions: [ACTION],
  experimentalActions: [ACTION],
  projection: { collections: ["machineTargets"] },

  /** The one loadable keg the fixture stages: empty, idle, and publishing the slot and stack it will take. */
  prepare: ({ snapshot }) => ({ snapshot, plan: { target: chooseOnlyLoadableKeg(snapshot) } }),

  describePlan: ({ target }) => ({
    target: target.targetId,
    tile: `${target.x},${target.y}`,
    machine: target.qualifiedItemId,
    slot: target.loadInputSlot,
    input: target.loadInputQualifiedItemId,
    inputStack: target.loadInputStack,
  }),

  request: ({ target }) => ({
    args: {
      slot: target.loadInputSlot,
      x: target.x,
      y: target.y,
      expectedQualifiedItemId: target.loadInputQualifiedItemId,
      expectedTargetId: target.targetId,
    },
  }),

  /**
   * The negative case, declared to the template: the load spent the stack it named, so the same request now names a
   * slot that no longer holds it - and, if the machine's own held-object gate answers first, a target that is no longer
   * loadable. Both words are the Mod's (`FarmhandExecutionController.MachineActions`); anything else, including a
   * second success, fails the run. What "the world did not move" means is the machine row, compared by its value.
   */
  negative: {
    args: ({ target }) => ({
      slot: target.loadInputSlot,
      x: target.x,
      y: target.y,
      expectedQualifiedItemId: target.loadInputQualifiedItemId,
      expectedTargetId: target.targetId,
    }),
    refusedCodes: ["machine_load_input_not_in_slot", "machine_load_target_changed"],
    unchanged: ({ before, after }) => {
      const shape = (snapshot) =>
        (snapshot.machineTargets ?? [])
          .map(
            (entry) =>
              `${entry?.targetId}:${entry?.heldObjectQualifiedItemId ?? "none"}:${entry?.lastInputQualifiedItemId ?? "none"}:${entry?.minutesUntilReady ?? 0}`,
          )
          .join("|");
      const held = shape(before);
      const settled = shape(after);
      return held === settled ? null : `machineTargets:${held}->${settled}`;
    },
  },

  /**
   * The receipt's fields against the machine's own row, re-read from the world after the terminal.
   *
   * The duration is deliberately NOT asserted against a content constant: the receipt reports the value it
   * observed and the value the Mod derived from live machine data, and those two must agree with each other.
   */
  async assertPostcondition({ evidence, plan, after }) {
    const { target } = plan;
    const reread = (after.machineTargets ?? []).find((entry) => entry?.targetId === target.targetId);
    if (reread === undefined) throw new Error(`machine_load_target_gone_after_the_load:${target.targetId}`);

    const failures = [];
    const check = (name, ok) => {
      if (!ok) failures.push(name);
    };
    check("machine_unchanged", reread.qualifiedItemId === KEG_QUALIFIED_ITEM_ID);
    check("not_ready_after_load", reread.readyForHarvest === false);
    check(
      "held_object_expected",
      typeof reread.heldObjectQualifiedItemId === "string" && reread.heldObjectQualifiedItemId.length > 0,
    );
    check("held_object_matches_receipt", reread.heldObjectQualifiedItemId === evidence.held);
    check("last_input_recorded", reread.lastInputQualifiedItemId === target.loadInputQualifiedItemId);
    check("last_input_matches_receipt", evidence.last_input === evidence.input);
    check("location_matches_receipt", evidence.location === after.location);
    check("target_matches_receipt", evidence.target === target.targetId);
    check("tile_matches_receipt", evidence.tile === `${target.x},${target.y}`);
    check("machine_matches_receipt", evidence.machine === KEG_QUALIFIED_ITEM_ID);
    check("slot_matches_request", evidence.slot === String(target.loadInputSlot));
    check("input_matches_request", evidence.input === target.loadInputQualifiedItemId);
    check("stack_before_matches_request", evidence.input_stack_before === String(target.loadInputStack));
    check("whole_stack_consumed", evidence.input_consumed === String(target.loadInputStack));
    check("nothing_left_in_slot", evidence.input_stack_after === "0");
    check("not_ready_recorded", evidence.ready_for_harvest === "false");
    check("duration_is_the_live_derivation", evidence.minutes_until_ready === evidence.expected_minutes_until_ready);
    check("native_check_action_ran", evidence.native_check_action === "true");
    if (failures.length > 0)
      throw new Error(`machine_load live contract failed: ${failures.join(",")};evidence=${JSON.stringify(evidence)}`);

    return { target: summarizeTarget(target), reread: summarizeTarget(reread), evidence };
  },
});

export const runMachineLoadSmoke = (client, receipts, config, options) =>
  scenario.run(client, receipts, config, options);

if (import.meta.main) await runSmokeScenarioMain(scenario);

/** The one keg the fixture stages as loadable, or the reason there is not exactly one. */
function chooseOnlyLoadableKeg(snapshot) {
  const targets = (snapshot.machineTargets ?? []).filter(
    (entry) =>
      entry?.qualifiedItemId === KEG_QUALIFIED_ITEM_ID &&
      Number.isInteger(entry.x) &&
      Number.isInteger(entry.y) &&
      typeof entry.targetId === "string" &&
      entry.readyForHarvest === false &&
      entry.minutesUntilReady === 0 &&
      entry.heldObjectQualifiedItemId == null &&
      entry.lastInputQualifiedItemId == null &&
      Number.isInteger(entry.loadInputSlot) &&
      typeof entry.loadInputQualifiedItemId === "string" &&
      Number.isInteger(entry.loadInputStack) &&
      entry.loadInputStack >= 1,
  );
  if (targets.length !== 1) throw new Error(targets.length ? "ambiguous_loadable_keg" : "no_loadable_keg");
  return targets[0];
}

function summarizeTarget(target) {
  return target
    ? {
        targetId: target.targetId,
        x: target.x,
        y: target.y,
        qualifiedItemId: target.qualifiedItemId,
        readyForHarvest: target.readyForHarvest,
        minutesUntilReady: target.minutesUntilReady,
        heldObjectQualifiedItemId: target.heldObjectQualifiedItemId ?? null,
        lastInputQualifiedItemId: target.lastInputQualifiedItemId ?? null,
        loadInputSlot: target.loadInputSlot ?? null,
        loadInputQualifiedItemId: target.loadInputQualifiedItemId ?? null,
        loadInputStack: target.loadInputStack ?? null,
      }
    : null;
}
