import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateProbeShapes } from "./stardew-native-local-machine-content-contract.mjs";

const contractPath = new URL("./stardew-native-local-machine-content-contract.mjs", import.meta.url);
const probePath = new URL("./stardew-content-probe/ContentProbe.cs", import.meta.url);

test("Keg content contract names every selected-rule equivalence field and rejects unknown probe fields", async () => {
  const contract = await readFile(contractPath, "utf8");
  const probe = await readFile(probePath, "utf8");
  for (const field of [
    "AdditionalConsumedItems",
    "PreventTimePass",
    "ReadyTimeModifiers",
    "ReadyTimeModifierMode",
    "CustomData",
    "CopyColor",
    "CopyPrice",
    "CopyQuality",
    "PreserveType",
    "PreserveId",
    "IncrementMachineParentSheetIndex",
    "PriceModifiers",
    "PriceModifierMode",
  ]) {
    assert.ok(probe.includes(`"${field}"`), `probe must expose ${field}`);
  }
  assert.match(contract, /schemaVersion: 2/);
  assert.match(contract, /machine_rule_container_fields_missing/);
  assert.match(contract, /machine_rule_fields_missing/);
  assert.match(contract, /machine_rule_output_fields_missing/);
  assert.match(contract, /machine_rule_output_unknown_fields/);
  assert.match(probe, /unknownFields = MissingFields\(definition/);
  assert.match(probe, /unknownFields = MissingFields\(output/);
});

test("probe shape validation accepts complete evidence and rejects missing or unknown shape evidence", () => {
  const valid = {
    machinesContent: {
      state: "loaded",
      entries: [
        {
          machineId: "(BC)12",
          shapeFailures: [],
          shapeEvidence: [
            {
              path: "machine[(BC)12].outputRules[0].outputs[0].stackModifiers",
              status: "documented_absent",
              member: "StackModifiers",
              declaredType: "System.Collections.Generic.List`1[[StardewValley.GameData.QuantityModifier]]",
              sourceOptional: true,
              runtimeType: null,
            },
          ],
        },
      ],
    },
  };
  assert.equal(validateProbeShapes(valid), null);

  const missingEvidence = { machinesContent: { state: "loaded", entries: [{ machineId: "(BC)12" }] } };
  assert.equal(validateProbeShapes(missingEvidence), "machine_shape_failure_evidence_missing");

  const unknownShape = {
    machinesContent: {
      state: "loaded",
      entries: [
        { machineId: "(BC)12", shapeFailures: ["machine[(BC)12].readyTimeModifiers:unsupported_shape:System.String"] },
      ],
    },
  };
  assert.equal(validateProbeShapes(unknownShape), "machine_content_shape_unknown");

  const missingMachineField = {
    machinesContent: {
      state: "loaded",
      entries: [
        { machineId: "(BC)12", shapeFailures: ["machine[(BC)12].preventTimePass:missing_member"], shapeEvidence: [] },
      ],
    },
  };
  assert.equal(validateProbeShapes(missingMachineField), "machine_content_shape_unknown");

  const nonNullableNull = {
    machinesContent: {
      state: "loaded",
      entries: [
        {
          machineId: "(BC)12",
          shapeFailures: ["machine[(BC)12].additionalConsumedItems:nonnullable_null"],
          shapeEvidence: [],
        },
      ],
    },
  };
  assert.equal(validateProbeShapes(nonNullableNull), "machine_content_shape_unknown");

  const untrustedAbsent = {
    machinesContent: {
      state: "loaded",
      entries: [
        {
          machineId: "(BC)12",
          shapeFailures: [],
          shapeEvidence: [
            {
              path: "machine[(BC)12].additionalConsumedItems",
              status: "documented_absent",
              member: "AdditionalConsumedItems",
              declaredType: "System.Collections.Generic.List`1",
              sourceOptional: true,
              runtimeType: null,
            },
          ],
        },
      ],
    },
  };
  assert.equal(validateProbeShapes(untrustedAbsent), "machine_shape_evidence_unknown");
});

test("content contract retains target hash, decoded-table digest, and an empty configuration-ingress universe gate", async () => {
  const contract = await readFile(contractPath, "utf8");
  assert.match(contract, /EXPECTED_XNB_SHA256 = "d77e939ec715634fe2f77506d55e8c21f701ef7ff6447f9048c677929ebc84e4"/);
  assert.match(
    contract,
    /EXPECTED_MACHINE_DIGEST = "1516b6a7a7d80263081c1ca5ec5a79cfef808be7f167fc679cab5de2850d245b"/,
  );
  assert.match(contract, /machines\.digest !== EXPECTED_MACHINE_DIGEST/);
  assert.match(contract, /targetMachineEntryCount: 39/);
  assert.match(contract, /targetMachineInteractMethodCount: 0/);
  assert.match(contract, /machines_entry_count_mismatch/);
  assert.match(contract, /machine_interact_method_universe_changed/);
});
