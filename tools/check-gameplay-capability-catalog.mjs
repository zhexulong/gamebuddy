#!/usr/bin/env node
/**
 * Structural guard for the versioned Stardew gameplay-semantic catalog.
 *
 * The catalog is a non-runtime description of player-reachable gameplay. It
 * must never grant capabilities, materialize Host tools, interpret receipts,
 * or impose a permission model. It verifies only semantic coverage records:
 * target domain, native boundary, result evidence, primitive/composite shape,
 * and the fact that already-published primitives have a corresponding record.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "design", "gameplay-capability-catalog.json");
/** The Mod-owned generated action surface is the cross-language authority for
 * which actions exist and at what lifecycle. `host/src/action-registry.ts`
 * is only a restrictive Host adapter projection: it states in its own header
 * that it is "deliberately not an action registry" and carries "no Mod-owned
 * membership, family, identity-version, or lifecycle facts". Reading adapters
 * here would both force Mod-experimental actions to be recorded as published
 * and hide published read-only actions that have no adapter tool. */
const actionSurfaceArtifactPath = path.join(
  root,
  "integrations",
  "stardew",
  "action-development",
  "contracts",
  "generated",
  "action-surface.v1.json",
);
const basisSourcePath = path.join(root, "design", "legacy", "12_STARDEW_PRIMITIVE_ACTION_BASIS.md");

const requiredRecordFields = Object.freeze([
  "intentVariantId",
  "playerLanguage",
  "supportedScope",
  "playerReachability",
  "implementationLifecycle",
  "coverageKind",
  "coverageState",
  "basisPrimitiveIds",
  "implementationActionIds",
  "compositeGraphRef",
  "contentOperationId",
  "contentProvenance",
  "closedParameterDomain",
  "nativeBoundaries",
  "aggregateSuccess",
  "evidenceState",
  "gapsNextGate",
  "coordinationDependency",
]);

const COORDINATION_DEPENDENCIES = new Set(["none", "player_text", "other_player", "host_save", "native_ready_barrier"]);

// Some coordination contracts are semantically typed, not merely labelled:
// their mandatory facts belong to the contract schema, so catalog authors
// cannot weaken an aggregate by deleting descriptive fields. Extend this map
// only with a reviewed target-version coordination contract.
const COORDINATION_CONTRACT_SCHEMAS = Object.freeze({
  advance_day_for_same_pot_output: Object.freeze({
    dependency: "native_ready_barrier",
    requiredNativeFacts: Object.freeze(["saving", "saved", "new_day"]),
    requiredFreshObservation: "same_pot_ready_output",
    unsatisfiedTerminalStates: Object.freeze(["waiting_for_day_progression", "blocked"]),
  }),
});

function fail(messages) {
  const error = new Error(messages.join("\n"));
  error.code = "gameplay_capability_catalog_invalid";
  throw error;
}

function enumHas(catalog, name, value) {
  return Array.isArray(catalog.enums?.[name]) && catalog.enums[name].includes(value);
}

/** Parse the Mod-owned published action surface. This artifact is the
 * generator's tracked output and the only place that carries the Mod's
 * lifecycle fact (adapter membership is a separate, restrictive Host
 * projection). Test expectations are intentionally not a source of truth. */
export function publishedRegistryEntries(artifactSource) {
  let surface;
  try {
    surface = JSON.parse(artifactSource);
  } catch (error) {
    throw new Error(`Unable to parse the Mod action-surface artifact: ${error.message}`);
  }
  if (!Array.isArray(surface?.actions)) {
    throw new Error("Mod action-surface artifact has no actions array.");
  }
  const entries = [];
  for (const action of surface.actions) {
    if (action?.lifecycle !== "published") continue;
    if (typeof action.actionId !== "string" || action.actionId.length === 0) {
      throw new Error("Mod action-surface artifact published action has no actionId.");
    }
    entries.push(
      Object.freeze({
        actionId: action.actionId,
        // Catalog coverage is recorded at primitive granularity; read_only and
        // execution are both minimal semantic capabilities there.
        actionClass: "primitive",
        surfaceKind: typeof action.kind === "string" ? action.kind : "execution",
      }),
    );
  }
  if (entries.length === 0) {
    throw new Error("Mod action-surface artifact declares no published actions.");
  }
  return entries;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function basisPrimitiveIdsFromSource(basisSource) {
  const ids = [...basisSource.matchAll(/\|\s*`([a-z0-9_]+)`\s*\|/g)].map((match) => match[1]);
  return [...new Set(ids)].sort();
}

export function validateGameplayCapabilityCatalog(catalog, publishedEntries, basisIds = []) {
  const publishedIds = publishedEntries.map((entry) => entry.actionId);
  const errors = [];
  if (catalog?.schemaVersion !== 3 || catalog?.catalogKind !== "gameplay_semantic_catalog") {
    errors.push("Catalog must declare schemaVersion=3 and catalogKind=gameplay_semantic_catalog.");
  }
  if (!Array.isArray(catalog?.records) || !Array.isArray(catalog?.compositeGraphs)) {
    errors.push("Catalog must contain records and compositeGraphs arrays.");
    return errors;
  }

  const seenVariants = new Set();
  const graphById = new Map(catalog.compositeGraphs.map((graph) => [graph?.id, graph]));
  const graphIds = new Set(graphById.keys());
  const coordinationContracts = new Map(
    (catalog.coordinationContracts || []).map((contract) => [contract?.coordinationContractId, contract]),
  );
  if (!Array.isArray(catalog.coordinationContracts)) errors.push("Catalog must declare coordinationContracts.");
  for (const [contractId, schema] of Object.entries(COORDINATION_CONTRACT_SCHEMAS)) {
    const contract = coordinationContracts.get(contractId);
    if (!contract) {
      errors.push(`Missing required coordination contract ${contractId}.`);
      continue;
    }
    for (const [field, value] of Object.entries(schema)) {
      if (JSON.stringify(contract[field]) !== JSON.stringify(value)) {
        errors.push(`${contractId}: must match required coordination-contract schema field ${field}.`);
      }
    }
  }
  for (const graph of catalog.compositeGraphs) {
    for (const step of graph.steps || []) {
      if (step?.kind === "primitive" && typeof step.basisPrimitiveId === "string") continue;
      if (
        step?.kind === "coordination" &&
        typeof step.coordinationContractId === "string" &&
        coordinationContracts.has(step.coordinationContractId)
      ) {
        const contract = coordinationContracts.get(step.coordinationContractId);
        // Contract-level requirements are mandatory whenever the declared
        // contract has them. A graph cannot opt out by deleting a step field.
        const requirementSchema = COORDINATION_CONTRACT_SCHEMAS[step.coordinationContractId];
        const requirements = requirementSchema || contract;
        for (const field of ["requiredNativeFacts", "unsatisfiedTerminalStates"]) {
          if (requirements[field] !== undefined) {
            if (
              !Array.isArray(requirements[field]) ||
              requirements[field].length === 0 ||
              requirements[field].some((value) => !nonEmptyString(value))
            ) {
              errors.push(
                `${contract.coordinationContractId}: ${field} must be a nonempty string array when declared.`,
              );
            } else {
              if (JSON.stringify(step[field]) !== JSON.stringify(requirements[field])) {
                errors.push(
                  `${graph?.id || "<missing graph id>"}: coordination step ${step.coordinationContractId} must match contract ${field}.`,
                );
              }
              if (
                field === "unsatisfiedTerminalStates" &&
                (!(graph.terminalStates || []).every((state) => typeof state === "string") ||
                  !requirements.unsatisfiedTerminalStates.every((state) => graph.terminalStates.includes(state)))
              ) {
                errors.push(
                  `${graph?.id || "<missing graph id>"}: terminalStates must contain ${step.coordinationContractId} unsatisfiedTerminalStates.`,
                );
              }
            }
          }
        }
        if (
          requirements.requiredFreshObservation !== undefined &&
          step.requiredFreshObservation !== requirements.requiredFreshObservation
        ) {
          errors.push(
            `${graph?.id || "<missing graph id>"}: coordination step ${step.coordinationContractId} must match contract requiredFreshObservation.`,
          );
        }
        continue;
      }
      errors.push(
        `${graph?.id || "<missing graph id>"}: graph step must be a typed primitive or declared coordination contract.`,
      );
    }
  }
  const primitiveDecisionIds = new Set(
    catalog.records
      .filter((record) => record?.coverageKind === "primitive")
      .flatMap((record) => record.basisPrimitiveIds || []),
  );
  for (const record of catalog.records) {
    const label = record?.intentVariantId || "<missing intentVariantId>";
    for (const field of requiredRecordFields) {
      if (!(field in record)) errors.push(`${label}: missing required field ${field}.`);
    }
    if (seenVariants.has(record.intentVariantId)) errors.push(`${label}: duplicate intentVariantId.`);
    seenVariants.add(record.intentVariantId);

    for (const field of ["implementationLifecycle", "coverageKind", "coverageState"]) {
      if (!enumHas(catalog, field, record[field]))
        errors.push(`${label}: invalid ${field}=${JSON.stringify(record[field])}.`);
    }
    for (const field of ["closedParameterDomain", "nativeBoundaries", "aggregateSuccess", "evidenceState"]) {
      if (!nonEmptyString(record[field])) errors.push(`${label}: ${field} must be a nonempty auditable string.`);
    }
    if (!COORDINATION_DEPENDENCIES.has(record.coordinationDependency)) {
      errors.push(`${label}: coordinationDependency must be a known dependency enum.`);
    }
    if (record.coverageKind === "coordinated" && record.coordinationDependency === "none") {
      errors.push(`${label}: coordinated record must declare a non-none coordinationDependency.`);
    }
    for (const field of ["basisPrimitiveIds", "implementationActionIds"]) {
      if (
        !Array.isArray(record[field]) ||
        record[field].some((value) => typeof value !== "string" || value.length === 0)
      ) {
        errors.push(`${label}: ${field} must be a string array.`);
      }
    }
    if (record.coverageKind === "composite" || record.coverageKind === "coordinated") {
      if (typeof record.compositeGraphRef !== "string" || !graphIds.has(record.compositeGraphRef)) {
        errors.push(`${label}: ${record.coverageKind} record must reference an existing composite graph.`);
      } else if (record.coverageKind === "composite") {
        const graph = graphById.get(record.compositeGraphRef);
        const graphPrimitiveIds = (graph.steps || [])
          .filter((step) => step?.kind === "primitive")
          .map((step) => step.basisPrimitiveId)
          .sort();
        const declaredPrimitiveIds = [...new Set(record.basisPrimitiveIds || [])].sort();
        if (JSON.stringify(graphPrimitiveIds) !== JSON.stringify(declaredPrimitiveIds)) {
          errors.push(`${label}: composite graph primitive steps must exactly match basisPrimitiveIds.`);
        }
        for (const primitiveId of graphPrimitiveIds) {
          if (!primitiveDecisionIds.has(primitiveId)) {
            errors.push(
              `${label}: composite graph primitive ${primitiveId} requires a standalone primitive decision record.`,
            );
          }
        }
        const graphDependencies = new Set(
          (graph.steps || [])
            .filter((step) => step?.kind === "coordination")
            .map((step) => coordinationContracts.get(step.coordinationContractId)?.dependency),
        );
        if (record.coordinationDependency !== "none" && !graphDependencies.has(record.coordinationDependency)) {
          errors.push(
            `${label}: composite graph must contain a typed coordination step for ${record.coordinationDependency}.`,
          );
        }
      }
    } else if (record.compositeGraphRef !== null) {
      errors.push(`${label}: non-composite record must have compositeGraphRef=null.`);
    }
    if (
      record.coverageKind === "content_operation" &&
      record.coverageState === "covered" &&
      (typeof record.contentOperationId !== "string" || record.contentOperationId === "UNEXPANDED")
    ) {
      errors.push(`${label}: covered content_operation must have a concrete contentOperationId.`);
    }
    if (record.coverageState === "covered" && record.implementationLifecycle !== "published") {
      errors.push(`${label}: covered state requires a published implementation lifecycle.`);
    }
    if (record.implementationLifecycle === "published" && record.coverageState !== "covered") {
      errors.push(`${label}: published implementation must map to a covered intent variant.`);
    }
    if (record.coverageKind === "primitive") {
      for (const actionId of record.implementationActionIds || []) {
        if (
          publishedIds.includes(actionId) &&
          (record.coverageState !== "covered" || record.implementationLifecycle !== "published")
        ) {
          errors.push(`${label}: published primitive implementation action ${actionId} must be covered/published.`);
        }
      }
    }
    if (record.coverageState === "blocked" && !nonEmptyString(record.gapsNextGate)) {
      errors.push(`${label}: blocked state must declare a concrete remaining semantic gate.`);
    }
  }

  if (basisIds.length > 0) {
    const catalogBasisIds = new Set(catalog.records.flatMap((record) => record.basisPrimitiveIds));
    const missingBasis = basisIds.filter((basisId) => !catalogBasisIds.has(basisId));
    if (missingBasis.length) errors.push(`Basis primitive IDs missing catalog records: ${missingBasis.join(", ")}.`);
  }

  const coveredActionIds = new Set(
    catalog.records
      .filter((record) => record.coverageState === "covered" && record.implementationLifecycle === "published")
      .flatMap((record) => record.implementationActionIds),
  );
  const missingPublished = publishedIds.filter((actionId) => !coveredActionIds.has(actionId));
  const unknownCatalogPublished = [...coveredActionIds].filter((actionId) => !publishedIds.includes(actionId));
  if (missingPublished.length)
    errors.push(`Published registry actions missing covered catalog rows: ${missingPublished.join(", ")}.`);
  if (unknownCatalogPublished.length)
    errors.push(`Catalog declares non-registry actions as published/covered: ${unknownCatalogPublished.join(", ")}.`);
  return errors;
}

export async function checkGameplayCapabilityCatalog({
  catalogFile = catalogPath,
  artifactFile = actionSurfaceArtifactPath,
} = {}) {
  const [catalogSource, artifactSource, basisSource] = await Promise.all([
    readFile(catalogFile, "utf8"),
    readFile(artifactFile, "utf8"),
    readFile(basisSourcePath, "utf8"),
  ]);
  let catalog;
  try {
    catalog = JSON.parse(catalogSource);
  } catch (error) {
    throw new Error(`Catalog is not valid JSON: ${error.message}`);
  }
  const entries = publishedRegistryEntries(artifactSource);
  const basisIds = basisPrimitiveIdsFromSource(basisSource);
  const errors = validateGameplayCapabilityCatalog(catalog, entries, basisIds);
  if (errors.length) fail(errors);
  return Object.freeze({
    state: "passed",
    catalogKind: catalog.catalogKind,
    recordCount: catalog.records.length,
    coveredPublishedActionCount: entries.length,
    semanticCompleteness: catalog.semanticCompleteness,
    basisPrimitiveCount: basisIds.length,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkGameplayCapabilityCatalog()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.code || "error"}: ${error.message}\n`);
      process.exitCode = 1;
    });
}
