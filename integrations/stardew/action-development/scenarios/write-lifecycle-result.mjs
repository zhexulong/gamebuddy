import { writeLifecycleCleanupResult } from "../src/write-lifecycle-result.mjs";

function required(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const resultFile = required("--result-file");
const state = required("--state");
if (state !== "completed") throw new Error("lifecycle_result_state_invalid");
await writeLifecycleCleanupResult(resultFile, { completed: true });
