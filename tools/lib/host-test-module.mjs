import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertLiveRunArtifactFresh } from "./live-run-artifact-freshness.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hostRoot = resolve(repositoryRoot, "host");
const testOutputRoot = resolve(hostRoot, "dist-test");

/**
 * Loads one emitted Host module from the compiled test artifact
 * (`host/dist-test`) for the native-local smoke harness.
 *
 * The native-local lane follows the same committed pattern as
 * `run-stardew-native-local-agent-ab-live.mjs`, which already imports
 * `LocalStardewBridgeClient` and the other live clients directly from
 * `host/dist-test`. This helper lets the shared smoke harness
 * (`stardew-native-smoke-harness-v1.mjs`) resolve that same carrier through its
 * injectable `loadModule` seam without each runner hard-coding a relative
 * import. It is a loader only: it grants no capability and changes no lifecycle.
 */
export async function loadHostTestModule(module) {
  if (typeof module !== "string" || !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.js$/.test(module))
    throw new Error("host_test_module_not_configured");
  const modulePath = resolve(testOutputRoot, module);
  if (modulePath !== resolve(testOutputRoot, module)) throw new Error("host_test_module_escapes_test_root");
  // Refuse to run a live gate against an artifact older than the sources it was compiled from. This is the one
  // place every native-local runner passes through, and a stale artifact is otherwise invisible: the run tests
  // the wrong code and the failure looks like a product bug (observed as an unsupported committed action, a fix
  // with "no effect", and a bridge that rejected every snapshot).
  await assertLiveRunArtifactFresh();
  return await import(pathToFileURL(modulePath).href);
}