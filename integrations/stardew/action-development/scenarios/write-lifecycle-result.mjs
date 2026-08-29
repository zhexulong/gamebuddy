import { writeLifecycleCleanupResult, writeLifecyclePhaseResult } from "../src/write-lifecycle-result.mjs";

function required(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const resultFile = required("--result-file");
const state = required("--state");
if (state === "completed") {
  await writeLifecycleCleanupResult(resultFile, { completed: true });
} else if (state === "failed") {
  await writeLifecyclePhaseResult(resultFile, {
    phase: required("--phase"),
    code: required("--code"),
  });
} else {
  throw new Error("lifecycle_result_state_invalid");
}
