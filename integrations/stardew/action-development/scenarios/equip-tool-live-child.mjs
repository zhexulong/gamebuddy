import { writePrivateResultFile } from "@gamebuddy/game-action-devkit";
import { connectNativeLocalClient, readNativeClientConfig } from "../../../../tools/lib/stardew-native-smoke-harness-v1.mjs";
import { runEquipToolSmoke } from "../../../../tools/run-stardew-native-local-player-equip-tool-smoke.mjs";
import { observeFresh } from "../../../../tools/lib/stardew-native-smoke-harness-v1.mjs";
import { readPublishedStardewActionIds } from "../../../../tools/lib/stardew-published-action-registry.mjs";
import { runEquipToolReadOnlyPreflight } from "./equip-tool-preflight.mjs";

function required(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const resultFile = required("--result-file");
const clientConfig = required("--client-config");
const identity = JSON.parse(required("--identity"));
const config = await readNativeClientConfig(["node", "equip-tool-live", "--client-config", clientConfig]);
const session = await connectNativeLocalClient(config);
try {
  const admission = await runEquipToolReadOnlyPreflight({
    client: session.client,
    scope: session.scope,
    observeFresh,
    readPublishedActionIds: readPublishedStardewActionIds,
  });
  if (admission.state !== "READY" || admission.ready !== true || admission.freshSnapshotCount !== 1) {
    throw new Error(`equip_tool_live_admission_blocked:${admission.reasons.join(",")}`);
  }
  const smoke = await runEquipToolSmoke(session.client, session.receipts, config);
  const passed = smoke.state === "passed";
  const result = {
    schema: "gamebuddy-action-scenario-result/v1",
    ...identity,
    receipt: passed
      ? {
          state: smoke.terminal.state,
          reasonCode: smoke.terminal.reasonCode,
          hasEvidence: true,
          request: smoke.request,
          accepted: smoke.accepted,
          terminal: smoke.terminal,
          evidence: smoke.evidence,
        }
      : null,
    postcondition: passed ? smoke.postcondition : null,
    verdict: passed ? "passed" : "failed",
    reasonCode: smoke.reasonCode,
  };
  await writePrivateResultFile(resultFile, JSON.stringify(result));
  if (!passed) process.exitCode = 2;
} finally {
  await session.close();
}
