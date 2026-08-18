import { readFile } from "node:fs/promises";
import { loadCompanionLiveFixtures, scoreScenarioSuite } from "./lib/stardew-companion-live-scenario.mjs";
const index = process.argv.indexOf("--summary");
try {
  if (index < 0 || !process.argv[index + 1]) throw new Error("missing_summary");
  if (
    process.argv.slice(2).filter((argument) => argument === "--summary").length !== 1 ||
    process.argv.length !== index + 3
  )
    throw new Error("summary_cli_invalid");
  const [summary, fixtures] = await Promise.all([
    JSON.parse(await readFile(process.argv[index + 1], "utf8")),
    loadCompanionLiveFixtures(),
  ]);
  const score = scoreScenarioSuite(summary, fixtures);
  console.log(JSON.stringify(score));
  if (score.verdict !== "pass") process.exitCode = 2;
} catch {
  console.log(
    JSON.stringify({
      verdict: "fail",
      failures: ["summary_ingress_invalid"],
      reviewRequired: [],
      evidenceClass: "deterministic_fixture",
    }),
  );
  process.exitCode = 2;
}
