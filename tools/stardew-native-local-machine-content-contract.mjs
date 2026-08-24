import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EXPECTED_XNB_SHA256 = "d77e939ec715634fe2f77506d55e8c21f701ef7ff6447f9048c677929ebc84e4";
const EXPECTED_MACHINE_DIGEST = "1516b6a7a7d80263081c1ca5ec5a79cfef808be7f167fc679cab5de2850d245b";
const CONTRACT = Object.freeze({
  schemaVersion: 2,
  topology: "native_local_player_fixture",
  machineId: "(BC)12",
  ruleId: "Default_CoffeeBeans",
  input: { qualifiedItemId: "(O)433", requiredCount: 5 },
  output: {
    qualifiedItemId: "(O)395",
    randomItemIds: [],
    maxItems: null,
    minStack: -1,
    maxStack: -1,
    quality: -1,
    objectInternalName: "",
    objectDisplayName: "",
    objectColor: "",
    toolUpgradeLevel: -1,
    isRecipe: false,
    stackModifiers: [],
    stackModifierMode: "Stack",
    qualityModifiers: [],
    qualityModifierMode: "Stack",
    modData: {},
    perItemCondition: "",
    condition: "",
    outputMethod: "",
    customData: {},
    copyColor: false,
    copyPrice: false,
    copyQuality: false,
    preserveType: "",
    preserveId: "",
    incrementMachineParentSheetIndex: 0,
    priceModifiers: [],
    priceModifierMode: "Stack",
  },
  minutesUntilReady: 120,
  daysUntilReady: -1,
  allowLoadWhenFull: false,
  onlyCompleteOvernight: false,
  invalidCountMessage: "[LocalizedText Strings\\\\StringsFromCSFiles:Object.cs.12721]",
  useFirstValidOutput: false,
  recalculateOnCollect: false,
  additionalConsumedItems: [],
  preventTimePass: [],
  readyTimeModifiers: [],
  readyTimeModifierMode: "Stack",
  clearContentsOvernightCondition: "",
  interactMethod: "",
  targetMachineEntryCount: 39,
  targetMachineInteractMethodCount: 0,
});

export function validateProbeShapes(probe) {
  const machines = probe?.machinesContent;
  if (machines?.state !== "loaded" || !Array.isArray(machines.entries)) return "machines_content_probe_invalid";
  const machine = machines.entries.find((entry) => entry?.machineId === CONTRACT.machineId);
  if (!machine) return "machine_rule_container_missing";
  if (!Array.isArray(machine.shapeFailures)) return "machine_shape_failure_evidence_missing";
  if (machine.shapeFailures.length) return "machine_content_shape_unknown";
  if (!Array.isArray(machine.shapeEvidence)) return "machine_shape_evidence_missing";
  const allowed = /^(StackModifiers|QualityModifiers|PriceModifiers|ModData|CustomData)$/;
  for (const evidence of machine.shapeEvidence) {
    const validPath =
      typeof evidence?.path === "string" &&
      /^machine\[\(BC\)12\]\.outputRules\[\d+\]\.outputs\[\d+\]\.(stackModifiers|qualityModifiers|priceModifiers|modData|customData)$/.test(
        evidence.path,
      );
    if (
      !evidence ||
      evidence.status !== "documented_absent" ||
      !allowed.test(evidence.member) ||
      evidence.sourceOptional !== true ||
      evidence.runtimeType !== null ||
      typeof evidence.declaredType !== "string" ||
      evidence.declaredType.length === 0 ||
      !validPath ||
      evidence.path.split(".").pop()?.toLowerCase() !== evidence.member.toLowerCase()
    )
      return "machine_shape_evidence_unknown";
  }
  return null;
}

if (resolve(process.argv[1] ?? "") !== resolve(fileURLToPath(import.meta.url))) {
  // Imported by targeted tests; keep the verifier side effects CLI-only.
} else {
  const gamePath = required("--game-path");
  const probeProject = resolve("tools/stardew-content-probe/ContentProbe.csproj");
  const xnbPath = resolve(gamePath, "Content", "Data", "Machines.xnb");
  const xnb = await readFile(xnbPath);
  const xnbSha256 = createHash("sha256").update(xnb).digest("hex");
  if (xnbSha256 !== EXPECTED_XNB_SHA256) fail("machines_xnb_hash_mismatch");
  const { stdout } = await execFileAsync("dotnet", ["run", "--project", probeProject, "--", resolve(gamePath)], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const probe = JSON.parse(stdout);
  const machines = probe?.machinesContent;
  if (machines?.state !== "loaded" || machines.digest !== EXPECTED_MACHINE_DIGEST || !Array.isArray(machines.entries))
    fail("machines_content_probe_invalid");
  const shapeFailure = validateProbeShapes(probe);
  if (shapeFailure) fail(shapeFailure);
  const requiredMachineFields = [
    "unknownFields",
    "additionalConsumedItems",
    "preventTimePass",
    "readyTimeModifiers",
    "readyTimeModifierMode",
    "clearContentsOvernightCondition",
    "interactMethod",
  ];
  const requiredRuleFields = [
    "unknownFields",
    "triggers",
    "outputs",
    "minutesUntilReady",
    "daysUntilReady",
    "invalidCountMessage",
    "useFirstValidOutput",
    "recalculateOnCollect",
  ];
  const requiredOutputFields = [
    "unknownFields",
    "customData",
    "copyColor",
    "copyPrice",
    "copyQuality",
    "preserveType",
    "preserveId",
    "incrementMachineParentSheetIndex",
    "priceModifiers",
    "priceModifierMode",
  ];
  function requireFields(value, fields, reason) {
    if (!value || fields.some((field) => !Object.hasOwn(value, field))) fail(reason);
  }

  const machine = machines.entries.find((entry) => entry?.machineId === CONTRACT.machineId);
  requireFields(machine, requiredMachineFields, "machine_rule_container_fields_missing");
  if (!machine || machine.unknownFields?.length)
    fail(machine ? "machine_rule_container_unknown_fields" : "machine_rule_container_missing");
  if (machines.entries.length !== CONTRACT.targetMachineEntryCount) fail("machines_entry_count_mismatch");
  const configuredInteractMethods = machines.entries.filter(
    (entry) => typeof entry?.interactMethod === "string" && entry.interactMethod.length > 0,
  );
  if (configuredInteractMethods.length !== CONTRACT.targetMachineInteractMethodCount)
    fail("machine_interact_method_universe_changed");
  for (const [key, expected] of Object.entries({
    allowLoadWhenFull: CONTRACT.allowLoadWhenFull,
    onlyCompleteOvernight: CONTRACT.onlyCompleteOvernight,
    recalculateOnCollect: CONTRACT.recalculateOnCollect,
    additionalConsumedItems: CONTRACT.additionalConsumedItems,
    preventTimePass: CONTRACT.preventTimePass,
    readyTimeModifiers: CONTRACT.readyTimeModifiers,
    readyTimeModifierMode: CONTRACT.readyTimeModifierMode,
    clearContentsOvernightCondition: CONTRACT.clearContentsOvernightCondition,
    interactMethod: CONTRACT.interactMethod,
  }))
    if (JSON.stringify(machine[key]) !== JSON.stringify(expected)) fail(`machine_rule_container_${key}_mismatch`);
  const rule = machine.outputRules?.find((entry) => entry?.ruleId === CONTRACT.ruleId);
  requireFields(rule, requiredRuleFields, "machine_rule_fields_missing");
  if (
    !rule ||
    rule.unknownFields?.length ||
    rule.minutesUntilReady !== CONTRACT.minutesUntilReady ||
    rule.daysUntilReady !== CONTRACT.daysUntilReady ||
    rule.invalidCountMessage !== CONTRACT.invalidCountMessage ||
    rule.recalculateOnCollect !== CONTRACT.recalculateOnCollect ||
    rule.useFirstValidOutput !== CONTRACT.useFirstValidOutput
  )
    fail(rule?.unknownFields?.length ? "machine_rule_unknown_fields" : "machine_rule_timing_mismatch");
  if (
    JSON.stringify(rule.triggers) !==
    JSON.stringify([
      {
        unknownFields: [],
        trigger: "ItemPlacedInMachine",
        requiredItemId: CONTRACT.input.qualifiedItemId,
        requiredCount: CONTRACT.input.requiredCount,
        requiredTags: [],
        condition: "",
      },
    ])
  )
    fail("machine_rule_trigger_mismatch");
  const expectedOutput = {
    itemId: CONTRACT.output.qualifiedItemId,
    ...Object.fromEntries(Object.entries(CONTRACT.output).filter(([key]) => key !== "qualifiedItemId")),
  };
  if (!Array.isArray(rule.outputs) || rule.outputs.length !== 1) fail("machine_rule_output_count_mismatch");
  requireFields(rule.outputs[0], requiredOutputFields, "machine_rule_output_fields_missing");
  if (rule.outputs?.some((output) => output.unknownFields?.length)) fail("machine_rule_output_unknown_fields");
  if (JSON.stringify(rule.outputs?.map(({ unknownFields, ...output }) => output)) !== JSON.stringify([expectedOutput]))
    fail("machine_rule_output_mismatch");
  console.log(
    JSON.stringify({
      state: "verified",
      artifactKind: "stardew_native_local_machine_content_contract_v2",
      xnbPath: "Content/Data/Machines.xnb",
      xnbSha256,
      machineTableDigest: machines.digest,
      contract: CONTRACT,
    }),
  );

  function required(name) {
    const index = process.argv.indexOf(name);
    if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`);
    return process.argv[index + 1];
  }
  function fail(reasonCode) {
    console.error(JSON.stringify({ state: "blocked", reasonCode }));
    process.exit(2);
  }
}
