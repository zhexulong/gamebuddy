// red-proof: inject  one published primitive action with no catalog row pushed into the generated action-surface
//   artefact -> `✖ catalog seed covers every published registry action without claiming completeness` and
//   `Published registry actions missing covered catalog rows: probe_uncovered_action.`, exit 1
// red-proof: history the tree at HEAD, where the Host retired-label table wrote `end_day: [sleep_ready,
//   sleep_after_ready]` -> `✖ the Host retired-label table names only terms a declaration owns` with
//   `capability_term_undeclared:sleep_after_ready:end_day` and
//   `capability_term_unnamed:advance_day_after_ready:end_day (composite end_day_multiplayer_v1)`
//   (tools/check-gameplay-capability-catalog.test.mjs)
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  basisPrimitiveIdsFromSource,
  checkGameplayCapabilityCatalog,
  declaredSurfaceActionIds,
  publishedRegistryEntries,
  retiredMigrationFamiliesFromSource,
  validateGameplayCapabilityCatalog,
  validateRetiredMigrationTerms,
} from "./check-gameplay-capability-catalog.mjs";

// The catalog and its Basis document live in the separately mounted private
// `design/` repository (AGENTS.md). A plain checkout does not create it, so the
// suite skips with a named reason instead of failing on a missing fixture.
const designMountSkipReason = existsSync(new URL("../design/gameplay-capability-catalog.json", import.meta.url))
  ? false
  : "requires the design/ reference mount (design/gameplay-capability-catalog.json and design/legacy/12_STARDEW_PRIMITIVE_ACTION_BASIS.md), which a repository checkout does not create";

const catalogPath = new URL("../design/gameplay-capability-catalog.json", import.meta.url);
const artifactSourcePath = new URL(
  "../integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
  import.meta.url,
);
const basisSourcePath = new URL("../design/legacy/12_STARDEW_PRIMITIVE_ACTION_BASIS.md", import.meta.url);
const registrySourcePath = new URL("../host/src/action-registry.ts", import.meta.url);

async function loadCatalog() {
  return JSON.parse(await readFile(catalogPath, "utf8"));
}

async function realFamilies() {
  return retiredMigrationFamiliesFromSource(await readFile(registrySourcePath, "utf8"));
}

/** The declarations that own names, read from the sources themselves, so no expectation here is a
 * second hand-written copy of what the product already states. */
async function realDeclarations() {
  const [catalog, artifactSource] = await Promise.all([loadCatalog(), readFile(artifactSourcePath, "utf8")]);
  return {
    surfaceActionIds: declaredSurfaceActionIds(artifactSource),
    catalogTerms: new Set(
      catalog.records.flatMap((record) => [
        ...(record.basisPrimitiveIds || []),
        ...(record.implementationActionIds || []),
      ]),
    ),
    coordinationContracts: new Set(
      (catalog.coordinationContracts || []).map((contract) => contract?.coordinationContractId),
    ),
    compositeGraphs: catalog.compositeGraphs,
  };
}

async function publishedEntries() {
  return publishedRegistryEntries(await readFile(artifactSourcePath, "utf8"));
}

test(
  "catalog seed covers every published registry action without claiming completeness",
  { skip: designMountSkipReason },
  async () => {
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
  },
);

test(
  "covered primitive rows require published lifecycle and auditable gameplay evidence",
  { skip: designMountSkipReason },
  async () => {
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
  },
);

test(
  "normal checker path passes real catalog plus source-derived Basis IDs",
  { skip: designMountSkipReason },
  async () => {
    const result = await checkGameplayCapabilityCatalog();
    assert.equal(result.state, "passed");
    assert.ok(result.basisPrimitiveCount > 0);
  },
);

test(
  "basis extraction is source-derived and missing basis IDs fail closed",
  { skip: designMountSkipReason },
  async () => {
    const [catalog, published, basisSource] = await Promise.all([
      loadCatalog(),
      publishedEntries(),
      readFile(new URL("../design/legacy/12_STARDEW_PRIMITIVE_ACTION_BASIS.md", import.meta.url), "utf8"),
    ]);
    const basisIds = basisPrimitiveIdsFromSource(basisSource);
    assert.ok(basisIds.includes("execute_world_operation"));
    assert.ok(basisIds.includes("phone_contact_or_service"));
    const malformed = structuredClone(catalog);
    malformed.records = malformed.records.filter(
      (record) => !record.basisPrimitiveIds.includes("execute_world_operation"),
    );
    const errors = validateGameplayCapabilityCatalog(malformed, published, basisIds);
    assert.match(errors.join("\n"), /Basis primitive IDs missing catalog records: .*execute_world_operation/);
  },
);

test(
  "composite graphs close declared primitive and coordination boundaries",
  { skip: designMountSkipReason },
  async () => {
    const [catalog, published] = await Promise.all([loadCatalog(), publishedEntries()]);

    const missingCrabCoordination = structuredClone(catalog);
    missingCrabCoordination.compositeGraphs.find((graph) => graph.id === "crab_pot_lifecycle_v1").steps =
      missingCrabCoordination.compositeGraphs
        .find((graph) => graph.id === "crab_pot_lifecycle_v1")
        .steps.filter((step) => step.kind !== "coordination");
    const coordinationErrors = validateGameplayCapabilityCatalog(missingCrabCoordination, published);
    assert.match(
      coordinationErrors.join("\n"),
      /place_bait_and_collect_crab_pot: composite graph must contain a typed coordination step for native_ready_barrier/,
    );

    const missingCrabPrimitiveDecision = structuredClone(catalog);
    missingCrabPrimitiveDecision.records = missingCrabPrimitiveDecision.records.filter(
      (record) => record.intentVariantId !== "place_crab_pot_variant",
    );
    const primitiveErrors = validateGameplayCapabilityCatalog(missingCrabPrimitiveDecision, published);
    assert.match(
      primitiveErrors.join("\n"),
      /place_bait_and_collect_crab_pot: composite graph primitive place_crab_pot requires a standalone primitive decision record/,
    );

    const mismatchedCrabComponents = structuredClone(catalog);
    mismatchedCrabComponents.records.find(
      (record) => record.intentVariantId === "place_bait_and_collect_crab_pot",
    ).basisPrimitiveIds = ["place_crab_pot", "collect_crab_pot_output"];
    const componentErrors = validateGameplayCapabilityCatalog(mismatchedCrabComponents, published);
    assert.match(
      componentErrors.join("\n"),
      /place_bait_and_collect_crab_pot: composite graph primitive steps must exactly match basisPrimitiveIds/,
    );

    const weakenedCrabBarrier = structuredClone(catalog);
    const weakenedGraph = weakenedCrabBarrier.compositeGraphs.find((graph) => graph.id === "crab_pot_lifecycle_v1");
    const weakenedStep = weakenedGraph.steps.find(
      (step) => step.coordinationContractId === "advance_day_for_same_pot_output",
    );
    delete weakenedStep.requiredNativeFacts;
    delete weakenedStep.requiredFreshObservation;
    delete weakenedStep.unsatisfiedTerminalStates;
    weakenedGraph.terminalStates = ["completed", "cancelled", "failed"];
    const barrierErrors = validateGameplayCapabilityCatalog(weakenedCrabBarrier, published);
    assert.match(
      barrierErrors.join("\n"),
      /coordination step advance_day_for_same_pot_output must match contract requiredNativeFacts/,
    );
    assert.match(
      barrierErrors.join("\n"),
      /coordination step advance_day_for_same_pot_output must match contract requiredFreshObservation/,
    );
    assert.match(
      barrierErrors.join("\n"),
      /coordination step advance_day_for_same_pot_output must match contract unsatisfiedTerminalStates/,
    );
    assert.match(
      barrierErrors.join("\n"),
      /terminalStates must contain advance_day_for_same_pot_output unsatisfiedTerminalStates/,
    );

    const deletedContractRequirements = structuredClone(catalog);
    const deletedContract = deletedContractRequirements.coordinationContracts.find(
      (contract) => contract.coordinationContractId === "advance_day_for_same_pot_output",
    );
    delete deletedContract.requiredNativeFacts;
    delete deletedContract.requiredFreshObservation;
    delete deletedContract.unsatisfiedTerminalStates;
    const deletedGraph = deletedContractRequirements.compositeGraphs.find(
      (graph) => graph.id === "crab_pot_lifecycle_v1",
    );
    const deletedStep = deletedGraph.steps.find(
      (step) => step.coordinationContractId === "advance_day_for_same_pot_output",
    );
    delete deletedStep.requiredNativeFacts;
    delete deletedStep.requiredFreshObservation;
    delete deletedStep.unsatisfiedTerminalStates;
    deletedGraph.terminalStates = ["completed", "cancelled", "failed"];
    const deletedContractErrors = validateGameplayCapabilityCatalog(deletedContractRequirements, published);
    assert.match(
      deletedContractErrors.join("\n"),
      /advance_day_for_same_pot_output: must match required coordination-contract schema field requiredNativeFacts/,
    );
    assert.match(
      deletedContractErrors.join("\n"),
      /coordination step advance_day_for_same_pot_output must match contract requiredFreshObservation/,
    );
    assert.match(
      deletedContractErrors.join("\n"),
      /terminalStates must contain advance_day_for_same_pot_output unsatisfiedTerminalStates/,
    );
  },
);

test(
  "coordination and content records require typed lifecycle metadata rather than synthetic authorization",
  { skip: designMountSkipReason },
  async () => {
    const [catalog, published] = await Promise.all([loadCatalog(), publishedEntries()]);
    const allowed = structuredClone(catalog);
    const resource = allowed.records.find(
      (record) => record.intentVariantId === "collect_wood_from_discovered_tree_source",
    );
    delete resource.policyFamily;
    delete resource.impactClass;
    delete resource.actorAuthority;
    delete resource.liveOwnershipPredicate;
    delete resource.onDeniedOrUnknown;
    assert.equal(
      validateGameplayCapabilityCatalog(allowed, published).some((error) =>
        error.startsWith(`${resource.intentVariantId}:`),
      ),
      false,
    );

    const malformed = structuredClone(catalog);
    const malformedResource = malformed.records.find(
      (record) => record.intentVariantId === "collect_wood_from_discovered_tree_source",
    );
    malformedResource.compositeGraphRef = "unknown_graph";
    const graphErrors = validateGameplayCapabilityCatalog(malformed, published);
    assert.match(graphErrors.join("\n"), /must reference an existing composite graph/);

    const missingGate = structuredClone(catalog);
    const missingGateResource = missingGate.records.find(
      (record) => record.intentVariantId === "collect_wood_from_discovered_tree_source",
    );
    missingGateResource.gapsNextGate = null;
    const gateErrors = validateGameplayCapabilityCatalog(missingGate, published);
    assert.match(gateErrors.join("\n"), /blocked state must declare a concrete remaining semantic gate/);

    const malformedCoordination = structuredClone(catalog);
    const endDay = malformedCoordination.records.find(
      (record) => record.intentVariantId === "end_day_with_all_players_ready",
    );
    endDay.coordinationDependency = "none";
    const coordinationErrors = validateGameplayCapabilityCatalog(malformedCoordination, published);
    assert.match(coordinationErrors.join("\n"), /coordinated record must declare a non-none coordinationDependency/);

    const malformedGraph = structuredClone(catalog);
    malformedGraph.compositeGraphs.find((graph) => graph.id === "end_day_multiplayer_v1").steps[0] = {
      basisPrimitiveId: "sleep_ready",
    };
    const graphStepErrors = validateGameplayCapabilityCatalog(malformedGraph, published);
    assert.match(graphStepErrors.join("\n"), /graph step must be a typed primitive or declared coordination contract/);
  },
);

test("the Host retired-label table names only terms a declaration owns", { skip: designMountSkipReason }, async () => {
  const [families, declarations] = await Promise.all([realFamilies(), realDeclarations()]);
  const { errors, census } = validateRetiredMigrationTerms({ families, ...declarations });
  assert.deepEqual(
    errors,
    [],
    "a replacement id nothing declares points an operator migrating off a retired label at no capability",
  );
  // The census is the difference between "nothing to do" and "nothing measured". Every denominator
  // comes from a source read here, so a reader can tell the population from a silent pass.
  assert.equal(census.familiesExamined, families.size);
  assert.ok(census.familiesExamined > 0, "the retired-label table must declare families");
  assert.ok(census.replacementIdsChecked >= census.familiesExamined);
  assert.ok(census.catalogTermsChecked > 0, "the catalog and surface must declare terms");
  assert.ok(census.coordinationContractsChecked > 0, "the catalog must declare coordination contracts");
  process.stdout.write(
    `families examined ${census.familiesExamined} · replacement ids checked ${census.replacementIdsChecked} · ` +
      `declared terms checked ${census.catalogTermsChecked} · coordination contracts checked ` +
      `${census.coordinationContractsChecked}\n`,
  );
});

test(
  "a replacement id no declaration owns reds and names the family that wrote it",
  { skip: designMountSkipReason },
  async () => {
    const [families, declarations] = await Promise.all([realFamilies(), realDeclarations()]);
    const injected = new Map(families);
    injected.set("tool_upgrade", [...families.get("tool_upgrade"), "probe_undeclared_term"]);
    const { errors } = validateRetiredMigrationTerms({ families: injected, ...declarations });
    assert.deepEqual(errors, ["capability_term_undeclared:probe_undeclared_term:tool_upgrade"]);
  },
);

test(
  "a declared coordination step the family never names reds, and is the shipped defect",
  {
    skip: designMountSkipReason,
  },
  async () => {
    const [families, declarations] = await Promise.all([realFamilies(), realDeclarations()]);
    // The real tree before this check existed wrote `sleep_after_ready` here. Nothing in this repository
    // or the design mount declares that name; the catalog declares `advance_day_after_ready` as the
    // second coordination step of `end_day_multiplayer_v1`. Replaying the shipped value reds both
    // directions, which is why the subset check alone would have kept it green.
    const replayed = new Map(families);
    replayed.set(
      "end_day",
      families.get("end_day").map((term) => (term === "advance_day_after_ready" ? "sleep_after_ready" : term)),
    );
    const { errors } = validateRetiredMigrationTerms({ families: replayed, ...declarations });
    assert.deepEqual(errors, [
      "capability_term_undeclared:sleep_after_ready:end_day",
      "capability_term_unnamed:advance_day_after_ready:end_day (composite end_day_multiplayer_v1)",
    ]);
  },
);

test(
  "a family whose replacement list is empty reds rather than passing quietly",
  { skip: designMountSkipReason },
  async () => {
    const [families, declarations] = await Promise.all([realFamilies(), realDeclarations()]);
    const emptied = new Map(families);
    emptied.set("tool_upgrade", []);
    const { errors } = validateRetiredMigrationTerms({ families: emptied, ...declarations });
    assert.deepEqual(errors, ["family_without_actions:tool_upgrade"]);
  },
);

test("the family reader reads the Host declaration itself and blocks on a missing table", async () => {
  const families = await realFamilies();
  assert.ok(families.size > 1, "the reader must find the table in host/src/action-registry.ts");
  assert.deepEqual(families.get("tool_upgrade"), ["request_tool_upgrade", "claim_tool_upgrade"]);
  assert.throws(
    () => retiredMigrationFamiliesFromSource("export const UNRELATED = Object.freeze({});"),
    /no longer declares RETIRED_ACTION_POLICY_MIGRATIONS/,
  );
  assert.throws(
    () => retiredMigrationFamiliesFromSource("export const RETIRED_ACTION_POLICY_MIGRATIONS = Object.freeze({\n});"),
    /declares no families; the reader is blocked, not passing/,
  );
});

test("an absent design mount is not_measured with a named reason, never a pass", async () => {
  await assert.rejects(
    checkGameplayCapabilityCatalog({
      catalogFile: fileURLToPath(new URL("./probe-absent-catalog.json", import.meta.url)),
    }),
    (error) => {
      assert.equal(error.code, "not_measured");
      assert.match(error.message, /design mount not present: the gameplay-semantic catalog/);
      return true;
    },
  );
});
