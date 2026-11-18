import { defineSmokeScenario, runSmokeScenarioMain } from "./lib/native-local-runner-scaffold.mjs";

const ACTION = "collect_crab_pot_output";
const SCENARIO = "native_crab_pot_collect_v1";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
function chooseOnlyCrabPotCollectTarget(snapshot) {
  const targets = snapshot.crabPotCollectTargets ?? [];
  if (targets.length !== 1) throw new Error(`crab_pot_collect_target_count_expected_1_got_${targets.length}`);
  const target = targets[0];
  if (
    typeof target?.targetId !== "string" ||
    !/^collect_crab_pot_[a-f0-9]{16}$/u.test(target.targetId) ||
    !Number.isInteger(target.x) ||
    !Number.isInteger(target.y) ||
    target.qualifiedItemId !== "(O)710" ||
    typeof target.outputQualifiedItemId !== "string" ||
    target.outputQualifiedItemId.length === 0 ||
    !Number.isInteger(target.outputStack) ||
    target.outputStack < 1
  )
    throw new Error("crab_pot_collect_target_malformed");
  return target;
}
export { ACTION as CRAB_POT_COLLECT_ACTION, SCENARIO as CRAB_POT_COLLECT_FIXTURE_SCENARIO };
/** The action's own success word, as the terminal check in the hand-written copy spelled it. */
const SUCCESS_CODE = "crab_pot_output_collected";
const scenario = defineSmokeScenario({
  action: ACTION,
  fixtureScenario: SCENARIO,
  successCode: SUCCESS_CODE,
  refusesConfig: false,
  requiredCapabilities: REQUIRED_CAPABILITIES,
  negativeOmittedBecause: "no_stale_re_send_in_the_hand_written_copy_this_migrated",

  prepare: ({ snapshot }) => {
    const target = chooseOnlyCrabPotCollectTarget(snapshot);
    return { snapshot, plan: { target } };
  },

  request: (plan) => {
    const { target } = plan;
    return { args: { x: target.x, y: target.y, expectedTargetId: target.targetId } };
  },

  async assertPostcondition({ evidence, terminal, after, plan }) {
    const { target } = plan;
    const delivered = Number(evidence.stack_delivered);
    const passed =
      after.revision >= terminal.revision &&
      evidence.target === target.targetId &&
      evidence.pot === "(O)710" &&
      evidence.pot_retained === "true" &&
      evidence.native_handled === "true" &&
      evidence.held_after === "none" &&
      evidence.ready_after === "false" &&
      evidence.tile_index_after === "710" &&
      evidence.bait_after === "none" &&
      Number.isSafeInteger(delivered) &&
      delivered >= 1 &&
      delivered <= 2 &&
      Number(evidence.inventory_after) === Number(evidence.inventory_before) + delivered &&
      (after.crabPotCollectTargets ?? []).every((entry) => entry?.targetId !== target.targetId);
    if (!passed) throw new Error("crab_pot_collect_postcondition_mismatch");
    return { target };
  },
});

export const runCrabPotCollectSmoke = (client, receipts, config, options) =>
  scenario.run(client, receipts, config, options);

if (import.meta.main) await runSmokeScenarioMain(scenario);
