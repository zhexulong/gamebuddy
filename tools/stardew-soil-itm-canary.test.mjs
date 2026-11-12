import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveSoilInteractionTransitionModel,
  missingSoilItmWitnesses,
  SOIL_ITM_DECOMPILE_ROOT_RELATIVE_PATH,
  SOIL_ITM_NOT_MEASURED,
  SOIL_ITM_WITNESS_PATHS,
  sourceManifestForSoilItm,
} from "./lib/stardew-soil-itm-canary.mjs";
import { ALLOW_ABSENT_ROOT_ENV, ALLOW_ABSENT_ROOT_FLAG } from "./stardew-soil-itm-canary-gate.mjs";

const root = fileURLToPath(new URL(`../${SOIL_ITM_DECOMPILE_ROOT_RELATIVE_PATH}/`, import.meta.url));
const missingWitnesses = missingSoilItmWitnesses({ root });

// The canary reads its witnesses out of a decompiled Stardew tree, which a checkout does not carry, so every case below
// skips there - and a suite whose whole population skips is not a measurement. `test:stardew-soil-itm-canary` runs this
// file through `tools/stardew-soil-itm-canary-gate.mjs`, which reports that absence as exit 2 with
// `soil_itm_canary_not_measured:decompile_root_absent:<root>` unless the caller passes `--allow-absent-decompile-root`.
// Running the file directly bypasses the runner, so the same absence fails here rather than reading as five skips.
if (missingWitnesses.length > 0 && process.env[ALLOW_ABSENT_ROOT_ENV] !== "1") {
  process.stderr.write(`${SOIL_ITM_NOT_MEASURED}:decompile_root_absent:${root}\n`);
  process.stderr.write(
    `  ${missingWitnesses.length} witness(es) absent; run \`pnpm test:stardew-soil-itm-canary\` for the blocked exit ` +
      `(2), or pass ${ALLOW_ABSENT_ROOT_FLAG} to run the skips deliberately\n`,
  );
  process.exit(1);
}

const decompileSkipReason =
  missingWitnesses.length === 0
    ? false
    : `requires the decompiled Stardew source tree under ${SOIL_ITM_DECOMPILE_ROOT_RELATIVE_PATH}/, absent here by ` +
      `explicit request`;

async function fixture() {
  const sourceFiles = Object.fromEntries(
    await Promise.all(
      SOIL_ITM_WITNESS_PATHS.map(async (witness) => [witness, await readFile(new URL(witness, root), "utf8")]),
    ),
  );
  const model = JSON.parse(await readFile(new URL("./stardew-soil-itm-canary.model.json", import.meta.url), "utf8"));
  model.sourceManifestSha256 = sourceManifestForSoilItm(sourceFiles).sha256;
  return { sourceFiles, model };
}

test("derives a trace-first soil ITM with source-realization witnesses", { skip: decompileSkipReason }, async () => {
  const input = await fixture();
  const result = deriveSoilInteractionTransitionModel(input);
  assert.equal(result.canaryId, "stardew_1_6_15_soil_interaction_transition_model_v1");
  assert.equal(result.coverage.traceClosureState, "scope_bounded_complete");
  assert.equal(result.coverage.interactionClassCount, 5);
  assert.equal(result.coverage.protocolCount, 1);
  assert.equal(result.analysisBoundary.legacyCatalog, "not_read");
  assert.equal(result.analysisBoundary.publicActionProjection, "not_performed");
  assert.ok(result.interactionClasses.every((entry) => entry.nativeWitnesses.length > 0));
  assert.equal(result.protocols[0].protocolId, "native_day_progression_with_fresh_observation");
});

test("fails closed when a required source witness drifts", { skip: decompileSkipReason }, async () => {
  const input = await fixture();
  input.sourceFiles["StardewValley/Tools/Hoe.cs"] = input.sourceFiles["StardewValley/Tools/Hoe.cs"].replace(
    "location.makeHoeDirt(item)",
    "location.makeChangedDirt(item)",
  );
  assert.throws(() => deriveSoilInteractionTransitionModel(input), { code: "soil_itm_source_manifest_mismatch" });
});

test(
  "rejects a source model that erases seed/fertilizer semantic separation",
  { skip: decompileSkipReason },
  async () => {
    const input = await fixture();
    input.model.separationObligations = input.model.separationObligations.filter(
      (entry) => entry.leftClassId !== "soil.plant_seed",
    );
    assert.throws(() => deriveSoilInteractionTransitionModel(input), { code: "soil_itm_separation_missing" });
  },
);

test(
  "rejects a source model that omits an action-layer deletion counterfactual",
  { skip: decompileSkipReason },
  async () => {
    const input = await fixture();
    input.model.irredundancyObligations = input.model.irredundancyObligations.filter(
      (entry) => entry.interactionClassId !== "soil.water",
    );
    assert.throws(() => deriveSoilInteractionTransitionModel(input), { code: "soil_itm_irredundancy_missing" });
  },
);

test("rejects product registry vocabulary as a model input", { skip: decompileSkipReason }, async () => {
  const input = await fixture();
  input.model.interactionClasses[0].actionId = "till_soil";
  assert.throws(() => deriveSoilInteractionTransitionModel(input), { code: "soil_itm_forbidden_vocabulary" });
});
