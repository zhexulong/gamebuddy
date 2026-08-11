import { readFile } from "node:fs/promises";
import { assessSoilItmConformance } from "./lib/stardew-soil-itm-conformance.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

const modelPath = option("--model") ?? "tools/stardew-soil-itm-canary.model.json";
const sourceReportPath = option("--source-report") ?? ".worktree/stardew-soil-itm-canary-report.json";
const liveCasesPath = option("--live-cases");
const environmentPath = option("--environment");
const projections = [
  { interactionClassId: "soil.till", bridgeAction: "till_soil" },
  { interactionClassId: "soil.plant_seed", bridgeAction: "plant_seed" },
  { interactionClassId: "soil.fertilize_tile", bridgeAction: "fertilize_tile" },
  { interactionClassId: "soil.water", bridgeAction: "water_crop" },
  { interactionClassId: "soil.harvest_grab", bridgeAction: "harvest_crop" },
];
const model = JSON.parse(await readFile(modelPath, "utf8"));
const sourceReport = JSON.parse(await readFile(sourceReportPath, "utf8"));
const liveCases = liveCasesPath ? JSON.parse(await readFile(liveCasesPath, "utf8")) : [];
const environment = environmentPath ? JSON.parse(await readFile(environmentPath, "utf8")) : { state: "blocked_or_not_supplied" };
process.stdout.write(`${JSON.stringify(assessSoilItmConformance({ model, projections, liveCases, sourceReport, environment }), null, 2)}\n`);
