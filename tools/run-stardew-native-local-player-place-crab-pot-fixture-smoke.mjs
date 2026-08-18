import {
  connectNativeLocalClient,
  observeFresh,
  readNativeClientConfig,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "place_crab_pot";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "place_crab_pot"];

/** Verify the fixture surface for a crab-pot placement without any production request. */
export async function runPlaceCrabPotFixtureSmoke(client, config) {
  validateConfig(config);
  const snapshot = await observeFresh(client, { actionable: true });
  for (const action of EXPECTED_ACTIONS)
    if (!snapshot.capabilities.includes(action)) throw new Error(`native_local_${action}_capability_missing`);
  const target = snapshot.crabPotTargets?.find(
    (entry) => Math.abs(entry.x - snapshot.tile.x) <= 1 && Math.abs(entry.y - snapshot.tile.y) <= 1,
  );
  if (!target) throw new Error("no_adjacent_live_crab_pot_target");
  if (target.qualifiedItemId !== "(O)710") throw new Error("fixture_crab_pot_target_item_mismatch");
  return {
    state: "fixture_prepared",
    action: ACTION,
    productionRequestSent: false,
    target,
    latestReceipt: snapshot.latestReceipt ?? null,
    contract: "fixture preparation only; production placement is verified by the separately mapped production runner",
  };
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runPlaceCrabPotFixtureSmoke(session.client, config);
    console.log(JSON.stringify(result));
    if (result.state !== "fixture_prepared") process.exitCode = 2;
  } catch (error) {
    console.error(
      JSON.stringify({
        state: "blocked",
        reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      }),
    );
    process.exitCode = 2;
  } finally {
    session.close();
  }
}

function validateConfig(config) {
  if (JSON.stringify(config.EnabledActions) !== JSON.stringify(EXPECTED_ACTIONS))
    throw new Error("fixture_capability_profile_invalid");
}