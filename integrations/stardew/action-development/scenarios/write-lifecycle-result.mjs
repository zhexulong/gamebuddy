import { writeStardewClosureBackendResult } from "../src/write-lifecycle-result.mjs";

const FLAGS = process.argv.slice(2);

function flagValue(name) {
  const index = FLAGS.indexOf(name);
  if (index < 0) throw new Error(`missing_${name.slice(2)}`);
  if (index + 1 >= FLAGS.length) throw new Error(`missing_${name.slice(2)}`);
  return FLAGS[index + 1];
}

function countFlag(name) {
  return FLAGS.filter((flag) => flag === name).length;
}

const resultFile = flagValue("--result-file");
const state = flagValue("--state");
const known = ["--result-file", "--state"];
let phase;
let code;
if (state === "completed") {
  phase = undefined;
  code = undefined;
} else if (state === "failed") {
  phase = flagValue("--phase");
  code = flagValue("--code");
  known.push("--phase", "--code");
} else {
  throw new Error("lifecycle_result_state_invalid");
}
for (const flag of known) {
  if (countFlag(flag) > 1) throw new Error("lifecycle_result_extra_argument");
}
const extra = FLAGS.filter((flag) => flag.startsWith("-") && !known.includes(flag));
if (extra.length > 0) throw new Error("lifecycle_result_extra_argument");

await writeStardewClosureBackendResult(resultFile, { state, phase, code });