import { defineSmokeScenario, runSmokeScenarioMain } from "./lib/native-local-runner-scaffold.mjs";

const ACTION = "cook_recipe";
const SCENARIO = "native_cook_recipe_v1";
const RECIPE_ALIAS = "Fried_Egg";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
export { ACTION as COOK_RECIPE_ACTION, SCENARIO as COOK_RECIPE_FIXTURE_SCENARIO };
/** The action's own success word, as the terminal check in the hand-written copy spelled it. */
const SUCCESS_CODE = "dish_cooked";
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
      evidence.station?.startsWith("cookout_kit@") === true &&
      evidence.disposition === "inventory" &&
      evidence.count_incremented === "true" &&
      evidence.native_menu_opened === "false" &&
      Number(evidence.recipes_cooked_after) === Number(evidence.recipes_cooked_before) + 1 &&
      Number(evidence.inventory_after) === Number(evidence.inventory_before) + Number(evidence.delivered);
    if (!passed) throw new Error("cook_recipe_postcondition_mismatch");
    return { recipe: RECIPE_ALIAS };
  },
});

export const runCookRecipeSmoke = (client, receipts, config, options) =>
  scenario.run(client, receipts, config, options);

if (import.meta.main) await runSmokeScenarioMain(scenario);
