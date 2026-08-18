import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadCompanionLiveFixtures, runScenarioSuite } from "./lib/stardew-companion-live-scenario.mjs";

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
try {
  if (args.some((arg) => arg === "--mode" || arg === "--preflight-only" || arg === "--live-evidence-artifact"))
    throw new Error("fixture_cli_forbidden_flag");
  const adapterModule = value("--fixture-adapter");
  const output = value("--output");
  if (!adapterModule || !output || args.filter((arg) => arg === "--fixture-adapter" || arg === "--output").length !== 2)
    throw new Error("fixture_cli_required_flag_missing");
  if (args.some((arg, index) => index % 2 === 0 && !["--fixture-adapter", "--output"].includes(arg)))
    throw new Error("fixture_cli_unknown_flag");
  const { manifest, phrases } = await loadCompanionLiveFixtures();
  const loaded = await import(pathToFileURL(resolve(adapterModule)).href);
  const summary = await runScenarioSuite({ manifest, phrases, adapter: loaded.controlPort ?? loaded.default });
  const destination = resolve(output);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(
    resolve(dirname(destination), "timeline.jsonl"),
    `${summary.scenarios.map((scenario) => JSON.stringify({ scenarioId: scenario.scenarioId, phraseId: scenario.phraseId, eventRange: scenario.eventRange, events: scenario.events, evidenceDigest: scenario.evidenceDigest })).join("\n")}\n`,
  );
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      evidenceClass: "deterministic_fixture",
      reasonCode: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 2;
}
