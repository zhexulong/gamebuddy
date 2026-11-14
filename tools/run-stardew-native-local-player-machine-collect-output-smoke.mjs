// Stardew-local machine_collect_output smoke.
//
// The lifecycle - the fixture-config refusal, observe-fresh and the capability check, the requestId mint and the
// execute, the terminal wait and its identity, the evidence parse and the stale reread, the stale re-send, the
// bootstrap and the exit code - is `tools/lib/native-local-runner-scaffold.mjs`. What is left here is what is
// actually about collecting a finished keg: loading it, waiting for its own processing clock, and then proving the
// output the world reports is the output the pack received.
//
// The receipt is not the proof. Three readings come from the machine's own row: it must be PROCESSING after the load
// (held object, input recorded, a non-zero duration), READY on its own clock before the collect, and EMPTY after it.
// The pack's own count of the output must rise by exactly the stack the machine held, which is the invariant the
// receipt's two numbers can only corroborate.

import { defineSmokeScenario, runSmokeScenarioMain } from "./lib/native-local-runner-scaffold.mjs";
import { delay, observeFresh, summarizeReceipt, waitForTerminal } from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "machine_collect_output";
const ACTION_LOAD = "machine_load";
/** The action's own success word (`MachineActions.CollectOutput`: the held stack moved to the pack). */
const SUCCESS_CODE = "machine_coffee_collected";
/** The one `NativeLocalPlayerFixture.FixtureScenario` this gate arms (gate descriptor `native_machine_coffee_load_v1`). */
const FIXTURE_SCENARIO = "native_machine_coffee_load_v1";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION_LOAD, ACTION];
const KEG_QUALIFIED_ITEM_ID = "(BC)12";
const COFFEE_QUALIFIED_ITEM_ID = "(O)395";
const INPUT_QUALIFIED_ITEM_ID = "(O)433";
const DEFAULT_READY_TIMEOUT_MS = 180_000;

const scenario = defineSmokeScenario({
  action: ACTION,
  fixtureScenario: FIXTURE_SCENARIO,
  successCode: SUCCESS_CODE,
  refusesConfig: true,
  requiredCapabilities: REQUIRED_CAPABILITIES,
  requiredActions: [ACTION_LOAD, ACTION],
  experimentalActions: [ACTION],
  projection: { collections: ["machineTargets"] },

  /**
   * Load the keg, prove it is PROCESSING, then wait for its own clock to make it ready.
   *
   * The load is a legitimate request of its own, so it goes through the template's traced `execute`; its terminal is
   * checked here because it is a precondition of the collect rather than the outcome this gate is about. The snapshot
   * handed back is the ready one, so the collect is planned against the world it is about to act on.
   */
  async prepare({ client, receipts, trace, snapshot, options, execute }) {
    const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const loadTarget = chooseOnlyLoadableKeg(snapshot);
    const loadAccepted = await execute(
      "load",
      ACTION_LOAD,
      {
        slot: loadTarget.loadInputSlot,
        x: loadTarget.x,
        y: loadTarget.y,
        expectedQualifiedItemId: loadTarget.loadInputQualifiedItemId,
        expectedTargetId: loadTarget.targetId,
      },
      snapshot,
    );
    if (loadAccepted.state !== "accepted") throw new Error(`machine_load_not_accepted:${loadAccepted.reasonCode}`);
    // The load's own terminal, waited for here rather than 180 s later: a load the Mod refused would otherwise be
    // reported as the readiness timeout, which names the wrong layer.
    const loadTerminal = await waitForTerminal(receipts, loadAccepted, options.terminalTimeoutMs ?? 5_000);
    if (loadTerminal.state !== "succeeded" || loadTerminal.reasonCode !== "machine_coffee_loaded")
      throw new Error(`machine_load_failed:${loadTerminal.state}/${loadTerminal.reasonCode}`);
    trace.push({ phase: "load", action: ACTION_LOAD, receipt: summarizeReceipt(loadTerminal) });

    const loaded = await actionableSnapshot(client);
    const processing = (loaded.machineTargets ?? []).find((entry) => entry?.targetId === loadTarget.targetId);
    if (!isProcessingCoffee(processing)) throw new Error("machine_collect_processing_postcondition_mismatch");

    const ready = await waitForReadyTarget(client, loadTarget.targetId, readyTimeoutMs);
    trace.push({ phase: "ready", target: ready.targetId, tile: `${ready.x},${ready.y}` });
    return {
      snapshot: await actionableSnapshot(client),
      plan: { loadTarget, ready, loadReceipt: summarizeReceipt(loadTerminal) },
    };
  },

  describePlan: ({ loadTarget, ready }) => ({
    target: loadTarget.targetId,
    tile: `${ready.x},${ready.y}`,
    machine: KEG_QUALIFIED_ITEM_ID,
    output: COFFEE_QUALIFIED_ITEM_ID,
  }),

  request: ({ ready }) => ({ args: { x: ready.x, y: ready.y, expectedTargetId: ready.targetId } }),

  /**
   * The negative case, declared to the template: the collect emptied the keg, so the same target is no longer ready
   * (`machine_collect_target_not_ready`) and - if the held object is already gone before the readiness gate is asked -
   * no longer the target the request named (`machine_collect_target_changed`). Both are the Mod's words
   * (`FarmhandExecutionController.MachineActions`).
   */
  negative: {
    args: ({ ready }) => ({ x: ready.x, y: ready.y, expectedTargetId: ready.targetId }),
    refusedCodes: ["machine_collect_target_not_ready", "machine_collect_target_changed"],
    unchanged: ({ before, after }) => {
      const rows = (snapshot) =>
        (snapshot.machineTargets ?? [])
          .map(
            (entry) =>
              `${entry?.targetId}:${entry?.heldObjectQualifiedItemId ?? "none"}:${entry?.readyForHarvest}:${entry?.minutesUntilReady}:${entry?.collectOutputReady ?? "n/a"}`,
          )
          .join("|");
      return rows(before) === rows(after) ? null : `machineTargets:${rows(before)}->${rows(after)}`;
    },
  },

  async assertPostcondition({ evidence, plan, after, terminal }) {
    const { loadTarget, ready } = plan;
    if (!Array.isArray(after.machineTargets)) throw new Error("native_local_machine_collect_snapshot_not_actionable");
    const reread = (after.machineTargets ?? []).find((entry) => entry?.targetId === loadTarget.targetId);
    if (reread === undefined) throw new Error(`machine_collect_target_gone:${loadTarget.targetId}`);

    const inventoryBefore = parseNonNegativeSafeInteger(evidence.inventory_output_before);
    const inventoryAfter = parseNonNegativeSafeInteger(evidence.inventory_output_after);
    const outputStack = parseNonNegativeSafeInteger(evidence.output_stack);

    const failures = [];
    const check = (name, ok) => {
      if (!ok) failures.push(name);
    };
    check("location_matches_observation", evidence.location === after.location);
    check("target_matches_the_collected_machine", evidence.target === loadTarget.targetId);
    check("tile_matches_the_ready_target", evidence.tile === `${ready.x},${ready.y}`);
    check("machine_matches_the_keg", evidence.machine === KEG_QUALIFIED_ITEM_ID);
    check("output_is_the_held_object", evidence.output === COFFEE_QUALIFIED_ITEM_ID);
    check("input_is_the_loaded_item", evidence.input === INPUT_QUALIFIED_ITEM_ID);
    check("was_ready_before", evidence.ready_before === "true");
    check("had_nothing_left_to_wait", evidence.minutes_until_ready_before === "0");
    check("stack_is_positive", outputStack !== null && outputStack >= 1);
    // The pack gained exactly the stack the machine held: "one item" would be a second, weaker rule.
    check("pack_gained_the_whole_stack", inventoryBefore !== null && inventoryAfter === inventoryBefore + outputStack);
    check("keg_holds_nothing_after", evidence.held_after === "none");
    check("keg_not_ready_after", evidence.ready_after === "false");
    check("native_check_action_ran", evidence.native_check_action === "true");
    check("reread_holds_nothing", reread.heldObjectQualifiedItemId == null);
    check("reread_not_ready", reread.readyForHarvest === false);
    check("reread_no_longer_collectable", reread.collectOutputReady === false);

    if (failures.length > 0)
      throw new Error(
        `machine_collect live contract failed: ${failures.join(",")};evidence=${JSON.stringify(evidence)}`,
      );

    return {
      loadTarget: summarizeTarget(loadTarget),
      readyTarget: summarizeTarget(ready),
      loadReceipt: plan.loadReceipt,
      collectReceipt: summarizeReceipt(terminal),
      evidence,
      reread: summarizeTarget(reread),
    };
  },
});

export const runMachineCollectOutputSmoke = (client, receipts, config, options) =>
  scenario.run(client, receipts, config, options);

if (import.meta.main) await runSmokeScenarioMain(scenario);

async function actionableSnapshot(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  if (!(Number.isInteger(snapshot?.revision) && Array.isArray(snapshot?.machineTargets)))
    throw new Error("native_local_machine_collect_snapshot_not_actionable");
  return snapshot;
}

/** The one keg the fixture stages as loadable with the coffee input it expects. */
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
      entry.loadInputQualifiedItemId === INPUT_QUALIFIED_ITEM_ID &&
      entry.loadInputStack === 5,
  );
  if (targets.length !== 1) throw new Error(targets.length ? "ambiguous_loadable_keg" : "no_loadable_keg");
  return targets[0];
}

function isProcessingCoffee(entry) {
  return (
    entry?.qualifiedItemId === KEG_QUALIFIED_ITEM_ID &&
    entry.readyForHarvest === false &&
    entry.minutesUntilReady > 0 &&
    entry.heldObjectQualifiedItemId === COFFEE_QUALIFIED_ITEM_ID &&
    entry.lastInputQualifiedItemId === INPUT_QUALIFIED_ITEM_ID
  );
}

/** Poll the machine's own row until its clock says the output is collectable. */
async function waitForReadyTarget(client, targetId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await actionableSnapshot(client);
    const entry = (snapshot.machineTargets ?? []).find((candidate) => candidate?.targetId === targetId);
    if (
      entry?.qualifiedItemId === KEG_QUALIFIED_ITEM_ID &&
      entry.readyForHarvest === true &&
      entry.minutesUntilReady === 0 &&
      entry.heldObjectQualifiedItemId === COFFEE_QUALIFIED_ITEM_ID &&
      entry.lastInputQualifiedItemId === INPUT_QUALIFIED_ITEM_ID &&
      entry.collectOutputReady === true
    )
      return entry;
    await delay(250);
  }
  throw new Error("machine_ready_timeout_without_time_skip");
}

function parseNonNegativeSafeInteger(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function summarizeTarget(value) {
  return value
    ? {
        targetId: value.targetId,
        x: value.x,
        y: value.y,
        qualifiedItemId: value.qualifiedItemId,
        readyForHarvest: value.readyForHarvest,
        minutesUntilReady: value.minutesUntilReady,
        heldObjectQualifiedItemId: value.heldObjectQualifiedItemId ?? null,
        lastInputQualifiedItemId: value.lastInputQualifiedItemId ?? null,
        loadInputSlot: value.loadInputSlot ?? null,
        loadInputQualifiedItemId: value.loadInputQualifiedItemId ?? null,
        loadInputStack: value.loadInputStack ?? null,
        collectOutputReady: value.collectOutputReady ?? null,
      }
    : null;
}
