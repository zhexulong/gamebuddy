import {
  connectNativeLocalClient,
  readNativeClientConfig,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

/**
 * Deterministic probe for the `reachable` affordance field.
 *
 * It connects over the real named pipe, calls `observe_scene` (the read_scene tool the Agent uses), and prints
 * every affordance with its reachability. This is deliberately independent of the Agent: a ladder may spend its
 * turn not observing at all (observed in a live session), which would make the field invisible for reasons that
 * are behavioral, not structural. This runner makes the presence or absence of `reachable` a fact about the Mod.
 */
export async function runSceneReachableProbe(client, _receipts, config) {
  validateNativeLocalFixtureConfig(config);
  // The bridge client checks `hasPublishedReadOnlyCapability("observe_scene")` against cached state, which is only
  // populated once a snapshot arrives. Pull the snapshot first, and fail loudly if the capability is not there.
  const snapshot = await client.observe();
  if (!Array.isArray(snapshot?.capabilities) || !snapshot.capabilities.includes("observe_scene")) {
    throw new Error("observe_scene_not_in_snapshot_capabilities");
  }
  const scene = await client.observeScene({});
  const affordances = Array.isArray(scene?.affordances) ? scene.affordances : [];
  const lines = affordances.map((affordance) =>
    `${affordance.kind}:${affordance.name} reachable=${affordance.reachable === undefined ? "ABSENT" : JSON.stringify(affordance.reachable)}`,
  );
  console.log("SCENE_RESULT observationId=" + (scene?.observationId ?? "?") + " currentLocation=" + (scene?.currentLocation ?? "?"));
  console.log("SCENE_AFFORDANCES " + (lines.length > 0 ? lines.join(" | ") : "(none)"));
  const withReachable = affordances.filter((affordance) => affordance.reachable !== undefined);
  const reachableCount = withReachable.filter((affordance) => affordance.reachable === true).length;
  const unreachableCount = withReachable.filter((affordance) => affordance.reachable === false).length;
  const absentCount = affordances.length - withReachable.length;
  console.log(`SCENE_REACHABLE summary affordances=${affordances.length} reachable=${reachableCount} unreachable=${unreachableCount} absent=${absentCount}`);
  if (affordances.length > 0 && withReachable.length === 0) {
    throw new Error("reachable_field_absent_from_scene_observation");
  }
  return { state: "passed", reason: "scene_observed", affordances: affordances.length, reachableCount, unreachableCount, absentCount };
}

function validateNativeLocalFixtureConfig(value) {
  if (value?.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runSceneReachableProbe(session.client, session.receipts, config);
    console.log("SCENE_PROBE_RESULT " + JSON.stringify(result));
    process.exitCode = 0;
  } catch (error) {
    console.error("SCENE_PROBE_FAILED " + (error?.message ?? String(error)));
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}