import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { readPublishedStardewActionIds } from "./lib/stardew-published-action-registry.mjs";
import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const files = Object.freeze({
  registry: resolve(ROOT, "host/src/action-registry.ts"),
  modConfig: resolve(ROOT, "integrations/stardew/ModConfig.cs"),
  gameTools: resolve(ROOT, "host/src/game-tools.ts"),
  registryTest: resolve(ROOT, "host/src/action-registry.test.ts"),
  toolsTest: resolve(ROOT, "host/src/game-tools.test.ts"),
  modEntry: resolve(ROOT, "integrations/stardew/ModEntry.cs"),
  nativeFixture: resolve(ROOT, "tools/lib/stardew-native-local-player-fixture.mjs"),
});
const contents = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, path]) => [key, await readFile(path, "utf8")] )));
const published = await readPublishedStardewActionIds({ registryPath: files.registry });
const modPublished = parseModPublishedActions(contents.modConfig);
const fixtureAllowlist = parseModConfigFixtureAllowlist(contents.modConfig);
const fixtureInitializerAllowlist = parseHostInitializerFixtureAllowlist(contents.modEntry);
const transactionAllowlist = parseNativeLocalFixtureScenarios(contents.nativeFixture);
const failures = [];

if (new Set(published).size !== published.length) failures.push("registry_published_duplicates");
if (new Set(modPublished).size !== modPublished.length) failures.push("mod_published_duplicates");
for (const action of published) {
  if (!modPublished.includes(action)) failures.push(`published_missing_in_mod:${action}`);
  if (!contents.gameTools.includes(`isVisible("${action}")`)) failures.push(`published_missing_host_tool_gate:${action}`);
}
for (const action of modPublished) if (!published.includes(action)) failures.push(`mod_published_missing_registry:${action}`);
for (const action of published) {
  if (!contents.registryTest.includes(`"${action}"`)) failures.push(`published_missing_registry_test:${action}`);
}
const countMatch = contents.registryTest.match(/PUBLISHED_STARDEW_ACTIONS\.length, (\d+)/);
if (!countMatch) failures.push("registry_published_count_assertion_missing");
else if (Number(countMatch[1]) !== published.length) failures.push(`registry_published_count_mismatch:${countMatch[1]}!=${published.length}`);

const gates = STARDEW_PUBLISHED_ACTION_GATES;
const gateActionIds = gates.map((gate) => gate.actionId);
if (new Set(gateActionIds).size !== gateActionIds.length) failures.push("gate_descriptor_duplicates");
for (const action of published) if (!gateActionIds.includes(action)) failures.push(`published_missing_gate_descriptor:${action}`);
for (const gate of gates) {
  if (!published.includes(gate.actionId)) failures.push(`gate_descriptor_not_published:${gate.actionId}`);
  if (!isIdentifier(gate.terminalReasonCode)) failures.push(`gate_descriptor_invalid_reason:${gate.actionId}`);
  const runnerPath = resolve(ROOT, "tools", gate.runner);
  try {
    await access(runnerPath, constants.R_OK);
  } catch {
    failures.push(`gate_runner_missing:${gate.actionId}:${gate.runner}`);
  }
  if (gate.fixtureScenario !== null) {
    if (!fixtureAllowlist.has(gate.fixtureScenario)) failures.push(`gate_fixture_missing_mod_allowlist:${gate.actionId}:${gate.fixtureScenario}`);
    if (!fixtureInitializerAllowlist.has(gate.fixtureScenario)) failures.push(`gate_fixture_missing_initializer_allowlist:${gate.actionId}:${gate.fixtureScenario}`);
    if (!transactionAllowlist.has(gate.fixtureScenario)) failures.push(`gate_fixture_missing_transaction_allowlist:${gate.actionId}:${gate.fixtureScenario}`);
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ state: "failed", failures, registryPublished: published, modPublished }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    state: "passed",
    publishedCount: published.length,
    publishedActions: published,
    fixtureBackedPublishedCount: gates.filter((gate) => gate.fixtureScenario !== null).length,
  }));
}

function parseModPublishedActions(source) {
  const match = source.match(/PublishedActions = new HashSet<string>\(new\[\] \{([^}]+)\}/s);
  if (!match) throw new Error("mod_published_actions_not_found");
  return [...match[1].matchAll(/"([a-z0-9_]+)"/g)].map((entry) => entry[1]);
}
function parseModConfigFixtureAllowlist(source) {
  const match = source.match(/FixtureScenario is ([^\r\n;]+)/);
  if (!match) throw new Error("mod_fixture_allowlist_not_found");
  return parseNativeScenarioStrings(match[1]);
}
function parseHostInitializerFixtureAllowlist(source) {
  const match = source.match(/fixture\.FixtureScenario is not \(([^\r\n]+)\)/);
  if (!match) throw new Error("native_local_initializer_fixture_allowlist_not_found");
  return parseNativeScenarioStrings(match[1]);
}
function parseNativeLocalFixtureScenarios(source) {
  const scenarios = parseNativeScenarioStrings(source);
  if (scenarios.size === 0) throw new Error("native_local_fixture_scenarios_not_found");
  return scenarios;
}
function parseNativeScenarioStrings(source) {
  return new Set([...source.matchAll(/"(native_[a-z0-9_]+_v\d+)"/g)].map((entry) => entry[1]));
}
function isIdentifier(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{1,127}$/.test(value);
}
