#!/usr/bin/env node
/**
 * Structural guard for the versioned Stardew gameplay-semantic catalog.
 *
 * The catalog is a non-runtime description of player-reachable gameplay. It
 * must never grant capabilities, materialize Host tools, interpret receipts,
 * or impose a permission model. It verifies only semantic coverage records:
 * target domain, native boundary, result evidence, primitive/composite shape,
 * and the fact that already-published primitives have a corresponding record.
 * red-proof: history the tree at HEAD, where the Mod surface publishes `fish_here` and no covered catalog row ->
 * *                    `gameplay_capability_catalog_invalid: Published registry actions missing covered catalog rows:
 * *                    fish_here.`, exit 1 (tools/check-gameplay-capability-catalog.mjs)
 * red-proof: history the tree at HEAD, where the Host retired-label table writes `end_day: [sleep_ready,
 * *                    sleep_after_ready]` and no declaration in this repository or the design mount owns
 * *                    `sleep_after_ready` -> `capability_term_undeclared:sleep_after_ready:end_day` and
 * *                    `capability_term_unnamed:advance_day_after_ready:end_day`,
 * *                    `families examined 19 · replacement ids checked 41 · declared terms checked 235 ·
 * *                    coordination contracts checked 14`, exit 1 (tools/check-gameplay-capability-catalog.mjs)
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
/** The Host's retired-label table is the only declaration that says which current or planned
 * capabilities replace a label the product no longer publishes. It is read from its own source
 * so this gate never restates the table: `host/src/action-registry.ts` owns it, and a second
 * hand-written copy here would be a disagreement scheduled for later. */
const hostRegistryPath = path.join(root, "host", "src", "action-registry.ts");

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

function parseSurfaceArtifact(artifactSource) {
  let surface;
  try {
    surface = JSON.parse(artifactSource);
  } catch (error) {
    throw new Error(`Unable to parse the Mod action-surface artifact: ${error.message}`);
  }
  if (!Array.isArray(surface?.actions)) {
    throw new Error("Mod action-surface artifact has no actions array.");
  }
  return surface;
}

/** Every action id the Mod's generated surface declares, at any lifecycle. The retired-label check
 * asks whether the product owns a name at all, so a `live_verified` or `experimental` action is as
 * much a declaration as a published one - only the coverage check below narrows to `published`. */
export function declaredSurfaceActionIds(artifactSource) {
  return new Set(
    parseSurfaceArtifact(artifactSource)
      .actions.map((action) => action?.actionId)
      .filter((actionId) => typeof actionId === "string" && actionId.length > 0),
  );
}

/** Parse the Mod-owned published action surface. This artifact is the
 * generator's tracked output and the only place that carries the Mod's
 * lifecycle fact (adapter membership is a separate, restrictive Host
 * projection). Test expectations are intentionally not a source of truth. */
export function publishedRegistryEntries(artifactSource) {
  const surface = parseSurfaceArtifact(artifactSource);
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

/**
 * Every family the Host's retired-label table declares, with the replacement ids it writes.
 *
 * The table is a retired-label -> replacement-ids map, not an action list: its keys are labels the
 * product once planned and no longer publishes, and its values name the capabilities that replace
 * them. Both halves of that relation are checked against the declarations that own the names - the
 * Mod's published surface, the semantic catalog's `basisPrimitiveIds`/`implementationActionIds`, and
 * the catalog's coordination contracts - because the values may legitimately name a capability whose
 * implementation does not exist yet, but they may not name a capability nothing declares at all.
 */
export function retiredMigrationFamiliesFromSource(registrySource) {
  const marker = "export const RETIRED_ACTION_POLICY_MIGRATIONS = Object.freeze({";
  const start = registrySource.indexOf(marker);
  if (start < 0) {
    throw new Error("host/src/action-registry.ts no longer declares RETIRED_ACTION_POLICY_MIGRATIONS.");
  }
  const bodyStart = start + marker.length;
  const bodyEnd = registrySource.indexOf("\n});", bodyStart);
  if (bodyEnd < 0) {
    throw new Error("RETIRED_ACTION_POLICY_MIGRATIONS has no closing brace in host/src/action-registry.ts.");
  }
  const families = new Map();
  for (const match of registrySource
    .slice(bodyStart, bodyEnd)
    .matchAll(/^ {2}([a-z][a-z0-9_]*): Object\.freeze\(\[([\s\S]*?)\]\)/gmu)) {
    const family = match[1];
    if (families.has(family)) throw new Error(`RETIRED_ACTION_POLICY_MIGRATIONS declares ${family} twice.`);
    families.set(family, Object.freeze([...match[2].matchAll(/"([a-z][a-z0-9_]*)"/gu)].map((term) => term[1])));
  }
  if (families.size === 0) {
    throw new Error("RETIRED_ACTION_POLICY_MIGRATIONS declares no families; the reader is blocked, not passing.");
  }
  return families;
}

/**
 * Both directions of one relation, over the declarations that own the names.
 *
 * `capability_term_undeclared:<id>:<family>` - the table writes a replacement id that the published
 * surface, the catalog's basis primitives, and the catalog's implementation actions all fail to own.
 * An operator migrating off a retired label would be pointed at nothing.
 *
 * `capability_term_unnamed:<id>:<family>` - the reverse, and the one a subset check cannot see: the
 * catalog declares a coordination contract as a step of a composite capability that this family
 * already names, and the family never names that step. Dropping a term from the table, or renaming
 * one, stays green under a subset check; here the declared step goes unnamed and the family is named
 * as the drifting member. The population is the catalog's own coordination contracts, so no list is
 * maintained by hand.
 *
 * `family_without_actions:<family>` - a family whose replacement list is empty says a label was
 * retired and nothing replaced it, which is the shape a half-finished edit leaves behind.
 */
export function validateRetiredMigrationTerms({
  families,
  surfaceActionIds,
  catalogTerms,
  coordinationContracts,
  compositeGraphs,
}) {
  const graphContractSteps = coordinationStepsByGraph(compositeGraphs);
  const ownsTerm = (term) => surfaceActionIds.has(term) || catalogTerms.has(term);
  const errors = [];
  let replacementIdCount = 0;
  for (const [family, terms] of families) {
    if (terms.length === 0) {
      errors.push(`family_without_actions:${family}`);
      continue;
    }
    replacementIdCount += terms.length;
    for (const term of terms) {
      if (!ownsTerm(term)) errors.push(`capability_term_undeclared:${term}:${family}`);
    }
    for (const { sibling, graphId } of unnamedCoordinationSiblings(terms, coordinationContracts, graphContractSteps)) {
      errors.push(`capability_term_unnamed:${sibling}:${family} (composite ${graphId})`);
    }
  }
  return Object.freeze({
    errors,
    census: Object.freeze({
      familiesExamined: families.size,
      replacementIdsChecked: replacementIdCount,
      catalogTermsChecked: surfaceActionIds.size + catalogTerms.size,
      coordinationContractsChecked: coordinationContracts.size,
    }),
  });
}

/** The coordination steps each composite graph declares, so a family that names one step of a
 * coordinated capability can be asked for the others. A graph with no coordination step is absent. */
function coordinationStepsByGraph(compositeGraphs) {
  const steps = new Map();
  for (const graph of compositeGraphs) {
    const stepped = new Set(
      (graph.steps || [])
        .filter((step) => step?.kind === "coordination" && typeof step.coordinationContractId === "string")
        .map((step) => step.coordinationContractId),
    );
    if (stepped.size > 0) steps.set(graph?.id || "<missing graph id>", stepped);
  }
  return steps;
}

/** The reverse of "is this term declared": a coordination step the catalog declares alongside a
 * term this family already names, and that the family leaves unnamed. */
function unnamedCoordinationSiblings(terms, coordinationContracts, graphContractSteps) {
  const named = new Set(terms);
  const unnamed = [];
  for (const term of terms) {
    if (!coordinationContracts.has(term)) continue;
    for (const [graphId, stepped] of graphContractSteps) {
      if (!stepped.has(term)) continue;
      for (const sibling of stepped) {
        if (!named.has(sibling)) unnamed.push({ sibling, graphId });
      }
    }
  }
  return unnamed;
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

/** A prerequisite this repository does not carry is not a pass: the design mount is a separate
 * checkout, so its absence is reported by name with a non-zero exit instead of a silent skip. */
async function readDesignSource(file, what) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const blocked = new Error(
      `design mount not present: ${what} (${path.relative(root, file)}) - the retired-label term check was not measured`,
    );
    blocked.code = "not_measured";
    throw blocked;
  }
}

export async function checkGameplayCapabilityCatalog({
  catalogFile = catalogPath,
  artifactFile = actionSurfaceArtifactPath,
  basisFile = basisSourcePath,
  registryFile = hostRegistryPath,
} = {}) {
  const [catalogSource, artifactSource, basisSource, registrySource] = await Promise.all([
    readDesignSource(catalogFile, "the gameplay-semantic catalog"),
    readFile(artifactFile, "utf8"),
    readDesignSource(basisFile, "the primitive action basis"),
    readFile(registryFile, "utf8"),
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
  const migration = validateRetiredMigrationTerms({
    families: retiredMigrationFamiliesFromSource(registrySource),
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
  });
  errors.push(...migration.errors);
  const census =
    `families examined ${migration.census.familiesExamined} · replacement ids checked ${migration.census.replacementIdsChecked} · ` +
    `declared terms checked ${migration.census.catalogTermsChecked} · coordination contracts checked ${migration.census.coordinationContractsChecked}`;
  if (errors.length) fail([...errors, census]);
  return Object.freeze({
    state: "passed",
    catalogKind: catalog.catalogKind,
    recordCount: catalog.records.length,
    coveredPublishedActionCount: entries.length,
    semanticCompleteness: catalog.semanticCompleteness,
    basisPrimitiveCount: basisIds.length,
    census,
    migrationCensus: migration.census,
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
