import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  consumptionCoverage,
  loadConsumptionSources,
  snapshotParameterOrder,
} from "../src/analysis/stardew-action-inventory-reconciliation.mjs";
import { methodBody, readModSources } from "../src/analysis/stardew-mod-csharp-source.mjs";

/**
 * `observation_computes_what_no_consumer_reads` - every field and every scan an observation produces has a consumer.
 *
 * WHY. One observation runs the whole radar: `CreateBridgeSnapshot` invokes ~78 `Discover*` sources, each walking the
 * map and minting a SHA-256 target id per published row, and it publishes 121 top-level fields. The question this gate
 * asks is not whether that is expensive - it is whether any of it is WASTED: a field the Mod computes and the Host
 * neither renders, names, nor declares withheld with a reason.
 *
 * THE POPULATION IS DERIVED TWICE, never listed here:
 *   - fields: every parameter of `record BridgeSnapshot(...)` in the Mod's own wire model, scalars and row families
 *     alike. A field added to the Mod is in this population before anyone remembers to write it down.
 *   - scans: every `Discover*` name the snapshot builder invokes, cross-checked against the `Discover*` methods the
 *     Mod's C# actually declares, so a call site that names a method nothing declares is reported rather than counted.
 *
 * THE CONSUMERS ARE THE HOST'S OWN DECLARATION, read from `host/src/snapshot-projection-coverage.ts` through the same
 * `consumptionCoverage` the reconciliation's F section uses: a projection that reads the key, the per-turn text that
 * prints it, a tool description that names it, or an entry in the Host's withheld lists (each carrying its reason).
 * `computed-and-dropped` is therefore exactly the set of keys with NO consumer and NO declared reason - the only
 * reading this gate can call a defect.
 *
 * MEASURED 2026-11-24 on `65dcc6b3`: `produced examined 121 · read 110 · computed-and-dropped 0 · declared-withheld
 * 11`. The reviewer's premise that the Host discards most of an observation does not hold at the payload level: the
 * Host's `boundObservedSnapshot` copies the snapshot through and removes four narrow things (the action surface when
 * its revision is unchanged, uncraftable recipe rows, other-map villager tiles, and seed/sapling rows past the nearest
 * sixteen of a stack). What the MODEL reads per turn is narrower than that - but the rest is answered on demand by
 * `stardew_observe`'s `select.kinds`, which is a consumer, and the Host's own gate is what keeps that true.
 *
 * RED-PROOF, both directions, in this file:
 *   - a field the Mod publishes and no Host declaration names  -> red, naming the field and both ends;
 *   - a field the Host stops declaring                          -> red, naming the field it no longer classifies;
 *   - a scan the builder invokes and no `Discover*` declares    -> red, naming the method.
 * A population of zero is BLOCKED, never green: a gate that examines nothing agrees with itself.
 */

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const MODELS_PATH = "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs";
const INVENTORY_PATH = "host/src/snapshot-projection-coverage.ts";
const CONTROLLER_PATH = "integrations/stardew/farmhandexecutioncontroller.cs";

function read(relative) {
  return readFileSync(path.join(REPOSITORY_ROOT, relative), "utf8");
}

/** The `Discover*` names one source invokes, in first-seen order and without duplicates. */
export function invokedDiscoveries(source) {
  return [...new Set([...source.matchAll(/\b(Discover[A-Za-z]+)\s*\(/gu)].map((match) => match[1]))].sort();
}

/**
 * The verdict over one declared surface.
 *
 * Pure over its inputs so the two falsifiers can inject a Mod or an inventory that diverges from today's, instead of
 * editing the repository to prove the check can be red.
 */
export function observationConsumerVerdict({
  models,
  sources,
  inventory,
  tools,
  perTurnFields,
  projectionSources,
}) {
  const parameters = snapshotParameterOrder(models);
  const fields = parameters.map((parameter) => parameter.name).filter((name) => name !== null);
  const coverage = consumptionCoverage({
    families: fields,
    inventory,
    tools,
    perTurnFields,
    projectionSources,
    targetField: {},
  });
  const dropped = coverage.rows.filter((row) => !row.classified).map((row) => row.family);
  const withheld = coverage.rows.filter((row) => row.declared !== null && !row.consumed).map((row) => row.family);

  // The SCAN population: what the snapshot builder invokes, cross-checked against what the Mod declares. The builder
  // is one file of the partial class; the declarations are the whole Mod, because `Discover*` lives in a dozen of them.
  // A declared BODY is the test rather than a `Bridge*` row type: two of the invoked sources are not families
  // (`DiscoverActiveSpecialOrderKeys` returns strings, `DiscoverStorageContainers` yields containers), and a gate that
  // could only see families would report them as undeclared for the rest of their lives.
  const builderBody = methodBody(sources, "CreateBridgeSnapshot");
  assert.notEqual(builderBody, null, "the snapshot builder is gone, so this gate's scan population would be empty");
  const invoked = invokedDiscoveries(builderBody);
  const undeclaredScans = invoked.filter((name) => methodBody(sources, name) === null);

  return {
    examined: coverage.rows.length,
    read: coverage.rows.filter((row) => row.consumed).length,
    dropped,
    withheld,
    scans: { examined: invoked.length, undeclared: undeclaredScans },
    findings: coverage.findings,
  };
}

function verdictFor(overrides = {}) {
  const sources = loadConsumptionSources();
  return observationConsumerVerdict({
    models: read(MODELS_PATH),
    sources: readModSources(),
    inventory: sources.inventory,
    tools: sources.tools,
    perTurnFields: sources.perTurnFields,
    projectionSources: sources.projectionSources,
    ...overrides,
  });
}

test("the real tree: the observation computes exactly what a consumer reads, and the numbers are printed", () => {
  const verdict = verdictFor();

  // The population is the Mod's, so a floor rather than an equality: a field added tomorrow belongs here too.
  assert.ok(verdict.examined >= 110, `produced examined ${String(verdict.examined)} · the wire record's own parameters`);
  assert.ok(verdict.read >= 90, `read ${String(verdict.read)} · of ${String(verdict.examined)} produced`);
  assert.ok(verdict.scans.examined >= 60, `scans examined ${String(verdict.scans.examined)}`);

  console.log(
    `observation_computes_what_no_consumer_reads: produced examined ${String(verdict.examined)} · read ${String(
      verdict.read,
    )} · computed-and-dropped ${String(verdict.dropped.length)} · declared-withheld ${String(
      verdict.withheld.length,
    )} · scans examined ${String(verdict.scans.examined)} · computed-and-dropped ${String(verdict.scans.undeclared.length)}`,
  );

  assert.deepEqual(
    verdict.dropped,
    [],
    `produced by ${MODELS_PATH} record BridgeSnapshot(...), read by nothing in ${INVENTORY_PATH} and declared withheld by nobody`,
  );
  assert.deepEqual(verdict.scans.undeclared, [], `invoked by CreateBridgeSnapshot and declared by no Discover* method`);
});

test("a field the Mod publishes and no Host declaration names is red, naming the field and both ends", () => {
  // The injected field is a scalar, which is the half the population used to leave out.
  const injected = read(MODELS_PATH).replace(
    /record BridgeSnapshot\(\n/u,
    "record BridgeSnapshot(\n    int? NoConsumerEverReadThis = null,\n",
  );
  assert.notEqual(injected, read(MODELS_PATH), "the injection must actually change the declaration");

  const verdict = verdictFor({ models: injected });

  assert.deepEqual(verdict.dropped, ["NoConsumerEverReadThis"]);
  assert.equal(verdict.examined, verdictFor().examined + 1, "a field added to the Mod is in the population");
});

test("a field the Host stops declaring is red, naming the field it no longer classifies", () => {
  // `soilTilesOmitted` is declared withheld today; an inventory that dropped the entry models a Host that stopped
  // reading the pair, which is the direction that rots silently.
  const inventory = read(INVENTORY_PATH).replace(
    /  soilTilesOmitted:\n    "[^"]*",\n/u,
    "",
  );
  assert.notEqual(inventory, read(INVENTORY_PATH), "the injection must actually remove the declaration");

  assert.deepEqual(verdictFor({ inventory }).dropped, ["SoilTilesOmitted"]);
});

test("a scan the snapshot builder invokes and no `Discover*` declares is red, naming the method", () => {
  const sources = readModSources().map((entry) =>
    entry.path.endsWith("farmhandexecutioncontroller.cs")
      ? {
          ...entry,
          source: entry.source.replace(
            /DiscoverRockSourceTargets\(player\) : null,/u,
            "DiscoverRockSourceTargets(player) : DiscoverNoMethodDeclaresThis(player) : null,",
          ),
        }
      : entry,
  );
  assert.notEqual(sources.find((entry) => entry.path.endsWith("farmhandexecutioncontroller.cs")).source, read(CONTROLLER_PATH), "the injection must actually change the builder");

  assert.deepEqual(verdictFor({ sources }).scans.undeclared, ["DiscoverNoMethodDeclaresThis"]);
});

test("a population of zero is blocked, never green", () => {
  const verdict = verdictFor({ models: "public sealed record Unrelated();\n" });

  assert.equal(verdict.examined, 0);
  assert.deepEqual(
    verdict.findings.map((finding) => finding.code).filter((code) => code.startsWith("consumption_inventory_unreadable")),
    [],
    "the inventory was readable here, so the zero is about the Mod",
  );
  // The caller's floor is what turns this into a block: `examined >= 110` cannot hold over an empty record.
  assert.ok(
    verdict.examined < 110,
    "a gate whose population is empty must fail the floor rather than agree with itself",
  );
});
