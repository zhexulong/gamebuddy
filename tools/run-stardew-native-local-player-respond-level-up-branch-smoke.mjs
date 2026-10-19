/**
 * The MILESTONE half of `respond_level_up`, driven live over the branch world.
 *
 * The launcher resolves a runner from the ACTION id and passes it only a client config, so the branch is chosen by
 * environment (`GAMEBUDDY_LEVEL_UP_BRANCH=a|b`) - and it must be chosen explicitly, because a gate that silently ran
 * the default branch would be certifying a choice nobody made.
 *
 * The proof itself lives in the action's own smoke module, next to the ordinary half, so both halves share one parser
 * and one gate: this file only selects the branch and reports what that gate says.
 */
import { readNativeClientConfig } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";
import { connectNativeLocalClient } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { runRespondLevelUpBranchSmoke } from "./run-stardew-native-local-player-respond-level-up-smoke.mjs";

// Re-exported because the runner/fixture contract asks every runner on disk for a runnable export (the same shape its
// own gate calls), and this file is a runner: the proof lives next door, the entry point lives here.
export { runRespondLevelUpBranchSmoke };

const requested = process.env.GAMEBUDDY_LEVEL_UP_BRANCH ?? "";
if (requested !== "a" && requested !== "b") {
  console.error(
    JSON.stringify({
      scenario: "native_level_up_branch_v1",
      state: "blocked",
      reasonCode: `branch_not_selected:${requested === "" ? "unset" : requested}`,
    }),
  );
  process.exitCode = 2;
} else {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runRespondLevelUpBranchSmoke(session.client, session.receipts, config, {
      choice: requested === "a" ? "branch_a" : "branch_b",
    });
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
