/**
 * Router exit-classifier gate: every syntax invocation in one exact router inventory must receive exactly one
 * classification, and a dynamic or unresolved exit must carry a blocking gameplay-bearing gap id.
 *
 * red-proof: fixture  an inventory with one invocation and a classifier with an empty `records` array ->
 *                    `router_exit_classifier_unclassified: Every exact router invocation must receive one exit
 *                    classification.`, exit 1; the same classifier naming that invocation prints its
 *                    `classificationState` and exits 0 (tools/check-stardew-native-router-exit-classifier.mjs)
 */
import { readFile } from "node:fs/promises";
import { validateNativeRouterExitClassifier } from "./lib/stardew-native-router-exit-classifier.mjs";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[++index];
    if (!key?.startsWith("--") || !value || value.startsWith("--"))
      fail(
        "router_exit_classifier_arguments_invalid",
        "Usage: --inventory <router-invocations.json> --classifier <router-exits.json>",
      );
    result[key.slice(2)] = value;
  }
  if (!result.inventory || !result.classifier)
    fail(
      "router_exit_classifier_arguments_required",
      "Usage: --inventory <router-invocations.json> --classifier <router-exits.json>",
    );
  return result;
}
async function json(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail("router_exit_classifier_json_invalid", `Could not read ${label}: ${error.message}`);
  }
}
async function main() {
  const input = args(process.argv.slice(2).filter((value) => value !== "--"));
  const result = validateNativeRouterExitClassifier(await json(input.classifier, "classifier"), {
    inventory: await json(input.inventory, "inventory"),
  });
  process.stdout.write(`${JSON.stringify({ artifactKind: "native_router_exit_classifier_check", ...result })}\n`);
}
main().catch((error) => {
  process.stderr.write(`${error.code ?? "router_exit_classifier_check_failed"}: ${error.message}\n`);
  process.exitCode = 1;
});
