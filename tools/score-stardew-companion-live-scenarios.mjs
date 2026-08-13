import { readFile } from "node:fs/promises";
import { scoreScenarioSuite } from "./lib/stardew-companion-live-scenario.mjs";
const index = process.argv.indexOf("--summary");
try {
  if (index < 0 || !process.argv[index + 1]) throw new Error("missing_summary");
  const summary = JSON.parse(await readFile(process.argv[index + 1], "utf8"));
  const score = scoreScenarioSuite(summary);
  console.log(JSON.stringify(score));
  if (score.verdict !== "pass") process.exitCode = 2;
} catch {
  console.log(JSON.stringify({ verdict: "fail", failures: ["summary_ingress_invalid"], reviewRequired: [], evidenceClass: "deterministic_fixture" }));
  process.exitCode = 2;
}
