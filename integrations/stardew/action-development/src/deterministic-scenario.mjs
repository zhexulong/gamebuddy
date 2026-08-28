import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  beginPrivateResultFile,
  cleanupPrivateResultFile,
  readPrivateResultFile,
  runBoundedChild,
} from "@gamebuddy/game-action-devkit";
import { parseScenarioResultText } from "./scenario-result.mjs";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHILD = path.join(PACKAGE_DIRECTORY, "tests", "fixtures", "fake-scenario-child.mjs");

function fail(code) {
  throw new Error(`stardew_action_deterministic_scenario_${code}`);
}

function exactIdentity(identity) {
  if (identity === null || typeof identity !== "object") fail("invalid_identity");
  const keys = ["gameId", "actionId", "runId", "stage", "profileIdentity", "claimScope"];
  if (Object.keys(identity).length !== keys.length || keys.some((key) => typeof identity[key] !== "string")) fail("invalid_identity");
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, identity[key]])));
}

/** Package-internal deterministic fixture only; it neither starts Stardew nor invokes a legacy runner. */
export async function runDeterministicScenario({ identity, mode = "valid", timeoutMs = 1_000, privateResultRoot } = {}) {
  const expected = exactIdentity(identity);
  const claim = await beginPrivateResultFile(privateResultRoot === undefined ? undefined : { root: privateResultRoot });
  let primaryFailure;
  try {
    let outcome;
    try {
      outcome = await runBoundedChild({
        command: process.execPath,
        args: [CHILD, "--result-file", claim.resultFile, "--mode", mode, "--identity", JSON.stringify(expected)],
        cwd: PACKAGE_DIRECTORY,
        timeoutMs,
        cleanupTimeoutMs: 500,
        heartbeatIntervalMs: 100,
        terminationPolicy: "immediate",
      });
    } catch (error) {
      throw new Error(`stardew_action_deterministic_scenario_child_failed:${error instanceof Error ? error.message : "unknown"}`);
    }
    try {
      const result = parseScenarioResultText(await readPrivateResultFile(claim), expected);
      return Object.freeze({ result, output: outcome.output });
    } catch (error) {
      throw new Error(`stardew_action_deterministic_scenario_result_invalid:${error instanceof Error ? error.message : "unknown"}`);
    }
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await cleanupPrivateResultFile(claim);
    } catch (error) {
      if (!primaryFailure) throw new Error(`stardew_action_deterministic_scenario_cleanup_failed:${error instanceof Error ? error.message : "unknown"}`);
    }
  }
}
