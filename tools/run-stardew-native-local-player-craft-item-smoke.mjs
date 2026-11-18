import { defineSmokeScenario, runSmokeScenarioMain } from "./lib/native-local-runner-scaffold.mjs";

const ACTION = "craft_item";
const SCENARIO = "native_craft_item_v1";
const RECIPE_ALIAS = "Wood_Fence";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
export { ACTION as CRAFT_ITEM_ACTION, SCENARIO as CRAFT_ITEM_FIXTURE_SCENARIO };
/** The action's own success word, as the terminal check in the hand-written copy spelled it. */
const SUCCESS_CODE = "crafted_item_created";
const scenario = defineSmokeScenario({
  action: ACTION,
  fixtureScenario: SCENARIO,
  successCode: SUCCESS_CODE,
  refusesConfig: false,
  requiredCapabilities: REQUIRED_CAPABILITIES,
  negativeOmittedBecause: "no_stale_re_send_in_the_hand_written_copy_this_migrated",

  prepare: ({ snapshot }) => {
    return { snapshot, plan: {} };
  },

  request: () => ({ args: { expectedTargetId: RECIPE_ALIAS } }),

  async assertPostcondition({ evidence, terminal, after, plan }) {
    const passed =
      after.revision >= terminal.revision &&
      evidence.disposition === "added_to_inventory" &&
      evidence.materials_consumed_exactly === "true" &&
      evidence.inventory_postcondition === "true" &&
      evidence.count_postcondition === "true" &&
      evidence.native_menu_opened === "false" &&
      Number(evidence.count_after) === Number(evidence.count_before) + 1;
    if (!passed) throw new Error("craft_item_postcondition_mismatch");
    return { recipe: RECIPE_ALIAS };
  },
});

export const runCraftItemSmoke = (client, receipts, config, options) => scenario.run(client, receipts, config, options);

if (import.meta.main) await runSmokeScenarioMain(scenario);
