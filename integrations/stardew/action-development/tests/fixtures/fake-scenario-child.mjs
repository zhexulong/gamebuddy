import { writePrivateResultFile } from "@gamebuddy/game-action-devkit";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) process.exit(64);
  return process.argv[index + 1];
}

const resultFile = option("--result-file");
const mode = option("--mode");
const identity = JSON.parse(option("--identity"));

if (mode === "crash") process.exit(1);
if (mode === "hang") setInterval(() => {}, 1_000);
if (mode === "missing") process.exit(0);
const result = {
  schema: "gamebuddy-action-scenario-result/v1",
  ...identity,
  receipt: { executionId: "fake-execution", state: "succeeded" },
  postcondition: { currentTool: "Axe" },
  verdict: "passed",
  reasonCode: "tool_selected",
};
if (mode === "wrong-identity") result.runId = "other-run";
if (mode === "invalid") result.receipt = { secret: "not-allowed" };
await writePrivateResultFile(resultFile, JSON.stringify(result));
