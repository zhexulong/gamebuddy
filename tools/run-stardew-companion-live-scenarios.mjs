import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runScenarioSuite, validatePhraseManifest, validateScenarioManifest } from "./lib/stardew-companion-live-scenario.mjs";

const root = new URL("../fixtures/stardew/companion-live/", import.meta.url);
const option = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] ?? null; };
const mode = option("--mode") ?? "real";
const output = option("--output");
try {
  if (!["real", "deterministic_fixture"].includes(mode)) throw new Error("runner_mode_invalid");
  if (mode === "real") throw new Error("production_artifact_bootstrap_unavailable");
  const adapterModule = option("--fixture-adapter");
  if (!adapterModule || process.argv.includes("--adapter")) throw new Error("deterministic_fixture_adapter_required");
  const [manifest, phrases] = await Promise.all([readJson(new URL("scenarios.v1.json", root)), readJson(new URL("phrases.zh-CN.v1.json", root))]);
  validateScenarioManifest(manifest); validatePhraseManifest(phrases);
  const loaded = await import(resolve(adapterModule)); const adapter = loaded.controlPort ?? loaded.default;
  const summary = await runScenarioSuite({ manifest, phrases, adapter, mode });
  if (output) { const destination = resolve(output); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, `${JSON.stringify(summary, null, 2)}\n`); await writeFile(resolve(dirname(destination), "timeline.jsonl"), `${summary.scenarios.map((scenario) => JSON.stringify({ scenarioId: scenario.scenarioId, phraseId: scenario.phraseId, eventRange: scenario.eventRange, events: scenario.events, evidenceDigest: scenario.evidenceDigest })).join("\n")}\n`); }
  console.log(JSON.stringify(summary));
} catch (error) { const reasonCode = error instanceof Error ? error.message : String(error); console.error(JSON.stringify({ state: "blocked", evidenceClass: mode === "deterministic_fixture" ? "deterministic_fixture" : "production_port", reasonCode })); process.exitCode = 2; }
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
