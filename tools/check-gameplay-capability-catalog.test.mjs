import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { basisPrimitiveIdsFromSource, checkGameplayCapabilityCatalog, publishedRegistryEntries, validateGameplayCapabilityCatalog } from "./check-gameplay-capability-catalog.mjs";

const catalogPath = new URL("../design/gameplay-capability-catalog.json", import.meta.url);
const registrySourcePath = new URL("../host/src/action-registry.ts", import.meta.url);
const basisSourcePath = new URL("../design/12_STARDEW_PRIMITIVE_ACTION_BASIS.md", import.meta.url);

async function loadCatalog() {
  return JSON.parse(await readFile(catalogPath, "utf8"));
}

async function publishedEntries() {
  return publishedRegistryEntries(await readFile(registrySourcePath, "utf8"));
}

test("catalog seed covers every published registry action without claiming completeness", async () => {
  const [catalog, published] = await Promise.all([loadCatalog(), publishedEntries()]);
  assert.equal(catalog.catalogKind, "gameplay_semantic_catalog");
  assert.equal(catalog.nonRuntimeNotice.includes("does not grant a capability"), true);
  const basisIds = basisPrimitiveIdsFromSource(await readFile(basisSourcePath, "utf8"));
  assert.deepEqual(validateGameplayCapabilityCatalog(catalog, published, basisIds), []);
  assert.ok(published.every((entry) => entry.actionClass === "primitive"));

  const covered = new Set(
    catalog.records
      .filter((record) => record.coverageState === "covered" && record.implementationLifecycle === "published")
      .flatMap((record) => record.implementationActionIds),
  );
  assert.deepEqual([...covered].sort(), published.map((entry) => entry.actionId).sort());
});

test("covered primitive rows require published lifecycle and auditable gameplay evidence", async () => {
  const [catalog, published] = await Promise.all([loadCatalog(), publishedEntries()]);
  const malformed = structuredClone(catalog);
  const move = malformed.records.find((record) => record.intentVariantId === "move_farmhand_to_discovered_tile");
  move.closedParameterDomain = "";
  move.evidenceState = "";
  move.coverageState = "covered";
  move.implementationLifecycle = "proposed";

  const errors = validateGameplayCapabilityCatalog(malformed, published);
  assert.match(errors.join("\n"), /closedParameterDomain must be a nonempty auditable string/);
  assert.match(errors.join("\n"), /evidenceState must be a nonempty auditable string/);
  assert.match(errors.join("\n"), /covered state requires a published implementation lifecycle/);
});

test("normal checker path passes real catalog plus source-derived Basis IDs", async () => {
  const result = await checkGameplayCapabilityCatalog();
  assert.equal(result.state, "passed");
  assert.ok(result.basisPrimitiveCount > 0);
});

test("basis extraction is source-derived and missing basis IDs fail closed", async () => {
  const [catalog, published, basisSource] = await Promise.all([
    loadCatalog(),
    publishedEntries(),
    readFile(new URL("../design/12_STARDEW_PRIMITIVE_ACTION_BASIS.md", import.meta.url), "utf8"),
  ]);
  const basisIds = basisPrimitiveIdsFromSource(basisSource);
  assert.ok(basisIds.includes("execute_world_operation"));
  assert.ok(basisIds.includes("phone_contact_or_service"));
  const malformed = structuredClone(catalog);
  malformed.records = malformed.records.filter((record) => !record.basisPrimitiveIds.includes("execute_world_operation"));
  const errors = validateGameplayCapabilityCatalog(malformed, published, basisIds);
  assert.match(errors.join("\n"), /Basis primitive IDs missing catalog records: .*execute_world_operation/);
});

test("composite graphs close declared primitive and coordination boundaries", async () => {
  const [catalog, published] = await Promise.all([loadCatalog(), publishedEntries()]);

  const missingCrabCoordination = structuredClone(catalog);
  missingCrabCoordination.compositeGraphs
    .find((graph) => graph.id === "crab_pot_lifecycle_v1")
    .steps = missingCrabCoordination.compositeGraphs
      .find((graph) => graph.id === "crab_pot_lifecycle_v1")
      .steps.filter((step) => step.kind !== "coordination");
  const coordinationErrors = validateGameplayCapabilityCatalog(missingCrabCoordination, published);
  assert.match(coordinationErrors.join("\n"), /place_bait_and_collect_crab_pot: composite graph must contain a typed coordination step for native_ready_barrier/);

  const missingCrabPrimitiveDecision = structuredClone(catalog);
  missingCrabPrimitiveDecision.records = missingCrabPrimitiveDecision.records
    .filter((record) => record.intentVariantId !== "place_crab_pot_variant");
  const primitiveErrors = validateGameplayCapabilityCatalog(missingCrabPrimitiveDecision, published);
  assert.match(primitiveErrors.join("\n"), /place_bait_and_collect_crab_pot: composite graph primitive place_crab_pot requires a standalone primitive decision record/);

  const mismatchedCrabComponents = structuredClone(catalog);
  mismatchedCrabComponents.records
    .find((record) => record.intentVariantId === "place_bait_and_collect_crab_pot")
    .basisPrimitiveIds = ["place_crab_pot", "bait_crab_pot"];
  const componentErrors = validateGameplayCapabilityCatalog(mismatchedCrabComponents, published);
  assert.match(componentErrors.join("\n"), /place_bait_and_collect_crab_pot: composite graph primitive steps must exactly match basisPrimitiveIds/);

  const weakenedCrabBarrier = structuredClone(catalog);
  const weakenedGraph = weakenedCrabBarrier.compositeGraphs.find((graph) => graph.id === "crab_pot_lifecycle_v1");
  const weakenedStep = weakenedGraph.steps.find((step) => step.coordinationContractId === "advance_day_for_same_pot_output");
  delete weakenedStep.requiredNativeFacts;
  delete weakenedStep.requiredFreshObservation;
  delete weakenedStep.unsatisfiedTerminalStates;
  weakenedGraph.terminalStates = ["completed", "cancelled", "failed"];
  const barrierErrors = validateGameplayCapabilityCatalog(weakenedCrabBarrier, published);
  assert.match(barrierErrors.join("\n"), /coordination step advance_day_for_same_pot_output must match contract requiredNativeFacts/);
  assert.match(barrierErrors.join("\n"), /coordination step advance_day_for_same_pot_output must match contract requiredFreshObservation/);
  assert.match(barrierErrors.join("\n"), /coordination step advance_day_for_same_pot_output must match contract unsatisfiedTerminalStates/);
  assert.match(barrierErrors.join("\n"), /terminalStates must contain advance_day_for_same_pot_output unsatisfiedTerminalStates/);

  const deletedContractRequirements = structuredClone(catalog);
  const deletedContract = deletedContractRequirements.coordinationContracts
    .find((contract) => contract.coordinationContractId === "advance_day_for_same_pot_output");
  delete deletedContract.requiredNativeFacts;
  delete deletedContract.requiredFreshObservation;
  delete deletedContract.unsatisfiedTerminalStates;
  const deletedGraph = deletedContractRequirements.compositeGraphs.find((graph) => graph.id === "crab_pot_lifecycle_v1");
  const deletedStep = deletedGraph.steps.find((step) => step.coordinationContractId === "advance_day_for_same_pot_output");
  delete deletedStep.requiredNativeFacts;
  delete deletedStep.requiredFreshObservation;
  delete deletedStep.unsatisfiedTerminalStates;
  deletedGraph.terminalStates = ["completed", "cancelled", "failed"];
  const deletedContractErrors = validateGameplayCapabilityCatalog(deletedContractRequirements, published);
  assert.match(deletedContractErrors.join("\n"), /advance_day_for_same_pot_output: must match required coordination-contract schema field requiredNativeFacts/);
  assert.match(deletedContractErrors.join("\n"), /coordination step advance_day_for_same_pot_output must match contract requiredFreshObservation/);
  assert.match(deletedContractErrors.join("\n"), /terminalStates must contain advance_day_for_same_pot_output unsatisfiedTerminalStates/);
});

test("coordination and content records require typed lifecycle metadata rather than synthetic authorization", async () => {
  const [catalog, published] = await Promise.all([loadCatalog(), publishedEntries()]);
  const allowed = structuredClone(catalog);
  const resource = allowed.records.find((record) => record.intentVariantId === "collect_wood_from_discovered_tree_source");
  delete resource.policyFamily;
  delete resource.impactClass;
  delete resource.actorAuthority;
  delete resource.liveOwnershipPredicate;
  delete resource.onDeniedOrUnknown;
  assert.equal(
    validateGameplayCapabilityCatalog(allowed, published).some((error) => error.startsWith(`${resource.intentVariantId}:`)),
    false,
  );

  const malformed = structuredClone(catalog);
  const malformedResource = malformed.records.find((record) => record.intentVariantId === "collect_wood_from_discovered_tree_source");
  malformedResource.compositeGraphRef = "unknown_graph";
  const graphErrors = validateGameplayCapabilityCatalog(malformed, published);
  assert.match(graphErrors.join("\n"), /must reference an existing composite graph/);

  const missingGate = structuredClone(catalog);
  const missingGateResource = missingGate.records.find((record) => record.intentVariantId === "collect_wood_from_discovered_tree_source");
  missingGateResource.gapsNextGate = null;
  const gateErrors = validateGameplayCapabilityCatalog(missingGate, published);
  assert.match(gateErrors.join("\n"), /blocked state must declare a concrete remaining semantic gate/);

  const malformedCoordination = structuredClone(catalog);
  const endDay = malformedCoordination.records.find((record) => record.intentVariantId === "end_day_with_all_players_ready");
  endDay.coordinationDependency = "none";
  const coordinationErrors = validateGameplayCapabilityCatalog(malformedCoordination, published);
  assert.match(coordinationErrors.join("\n"), /coordinated record must declare a non-none coordinationDependency/);

  const malformedGraph = structuredClone(catalog);
  malformedGraph.compositeGraphs.find((graph) => graph.id === "end_day_multiplayer_v1").steps[0] = { basisPrimitiveId: "sleep_ready" };
  const graphStepErrors = validateGameplayCapabilityCatalog(malformedGraph, published);
  assert.match(graphStepErrors.join("\n"), /graph step must be a typed primitive or declared coordination contract/);
});
