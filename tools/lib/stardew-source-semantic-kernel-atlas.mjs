import { createHash } from "node:crypto";

export const ATLAS_SCHEMA_VERSION = 1;
const TARGET = Object.freeze({ game: "Stardew Valley", version: "1.6.15", build: 24356 });

function fail(message, details = {}) {
  const error = new Error(message);
  error.code = "source_semantic_kernel_atlas_evidence_invalid";
  error.details = details;
  throw error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0) fail(`Expected non-empty ${field}.`, { field });
  return value;
}

function requiredArray(value, field) {
  if (!Array.isArray(value)) fail(`Expected array ${field}.`, { field });
  return value;
}

function candidateSourceLocus(candidate) {
  const evidence = candidate.sourceEvidence;
  if (!isRecord(evidence)) return null;
  if (typeof evidence.sourceFile !== "string" || typeof evidence.sourceMethod !== "string") return null;
  return `${evidence.sourceFile}:${evidence.sourceMethod}`;
}

function frequency(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null || key === undefined) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

/**
 * Turn an exact target-game surface inspection into a whole-game semantic
 * kernel *atlas*. An atlas is an exhaustive ledger of what this conservative
 * discovery pass found; it intentionally does not infer public API semantics
 * or claim that every discovered path is a semantic primitive.
 */
export function deriveStardewSemanticKernelAtlas(inspection) {
  if (!isRecord(inspection)) fail("Expected a gameplay-surface inspection object.");
  if (inspection.state !== "inspected")
    fail("The source inspection must be in inspected state.", { state: inspection.state });
  const target = inspection.target;
  if (
    !isRecord(target) ||
    target.game !== TARGET.game ||
    target.version !== TARGET.version ||
    target.build !== TARGET.build
  ) {
    fail("The source inspection is not for the locked Stardew target.", { target });
  }
  const assembly = inspection.assembly;
  if (
    !isRecord(assembly) ||
    !/^[a-f0-9]{64}$/.test(assembly.sha256 ?? "") ||
    typeof assembly.lengthBytes !== "number" ||
    assembly.lengthBytes <= 0
  ) {
    fail("The source inspection lacks an attested target assembly.");
  }
  const snapshot = inspection.sourceSnapshot;
  if (!isRecord(snapshot) || !/^[a-f0-9]{64}$/.test(snapshot.contentManifestSha256 ?? "")) {
    fail("The source inspection lacks an attested decompiled source snapshot.");
  }
  const graph = inspection.playerCommandGraph;
  if (!isRecord(graph)) fail("The source inspection lacks its player command graph.");
  const ingressRoots = requiredArray(graph.ingressRoots, "playerCommandGraph.ingressRoots");
  const commandCandidates = requiredArray(graph.commandPathCandidates, "playerCommandGraph.commandPathCandidates");
  const staticNodes = requiredArray(inspection.staticGameplayNodes, "staticGameplayNodes");
  const content = inspection.content;
  if (!isRecord(content)) fail("The source inspection lacks content evidence.");
  const contentFamilies = requiredArray(content.contentOperationFamilies, "content.contentOperationFamilies");
  const tables = inspection.dataLoaderProbe;
  if (!isRecord(tables)) fail("The source inspection lacks DataLoader evidence.");
  const dataLoaderTables = requiredArray(tables.tables, "dataLoaderProbe.tables");

  const ingressIds = new Set(ingressRoots.map((root) => (isRecord(root) ? root.ingressId : null)));
  const malformedCandidates = commandCandidates.filter(
    (candidate) =>
      !isRecord(candidate) ||
      typeof candidate.candidateId !== "string" ||
      candidate.candidateId.length === 0 ||
      typeof candidate.ingressId !== "string" ||
      !ingressIds.has(candidate.ingressId) ||
      typeof candidate.nativeRuleBoundaryCandidate !== "string" ||
      candidate.nativeRuleBoundaryCandidate.length === 0 ||
      !isRecord(candidate.sourceEvidence) ||
      typeof candidate.sourceEvidence.sourceFile !== "string" ||
      candidate.sourceEvidence.sourceFile.length === 0 ||
      typeof candidate.sourceEvidence.sourceMethod !== "string" ||
      candidate.sourceEvidence.sourceMethod.length === 0,
  );
  if (malformedCandidates.length)
    fail("The source inspection contains malformed command-boundary candidates.", {
      count: malformedCandidates.length,
    });

  const candidateIds = new Set();
  for (const candidate of commandCandidates) {
    if (candidateIds.has(candidate.candidateId))
      fail("The source inspection contains duplicate command-boundary candidate IDs.", {
        candidateId: candidate.candidateId,
      });
    candidateIds.add(candidate.candidateId);
  }

  const entries = commandCandidates
    .map((candidate) =>
      Object.freeze({
        atlasEntryId: `command:${candidate.candidateId}`,
        kind: "normal_player_command_boundary",
        candidateId: candidate.candidateId,
        ingressId: candidate.ingressId,
        semanticFamily: candidate.semanticFamily ?? "unclassified",
        nativeRuleBoundaryCandidate: candidate.nativeRuleBoundaryCandidate,
        sourceLocus: candidateSourceLocus(candidate),
        sourceEvidence: candidate.sourceEvidence,
        selector: candidate.selector ?? null,
        selectorKind: candidate.selectorKind ?? null,
        discoveryState: candidate.status ?? "unknown",
        typedBridgeRoute: candidate.route ?? null,
        semanticKernelState: "unproven",
        publicActionState: "not_inferred",
        reason:
          "A command boundary is source-reachable evidence. It is not merged with a sibling merely because their source locus or semantic-family label matches.",
      }),
    )
    .sort((left, right) => left.atlasEntryId.localeCompare(right.atlasEntryId));

  const unresolvedEntries = entries.filter(
    (entry) => entry.discoveryState !== "classified" || entry.typedBridgeRoute === null,
  );
  const staticNodeSummary = Object.freeze({
    total: staticNodes.length,
    byMappingStatus: Object.freeze(
      frequency(staticNodes, (node) =>
        isRecord(node) && typeof node.mappingStatus === "string" ? node.mappingStatus : "unknown",
      ),
    ),
    bySemanticKind: Object.freeze(
      frequency(staticNodes, (node) =>
        isRecord(node) && typeof node.semanticKind === "string" ? node.semanticKind : "unknown",
      ),
    ),
  });
  const contentSummary = Object.freeze({
    operationFamilyCount: contentFamilies.length,
    relevantAssetCount: typeof content.relevantAssetCount === "number" ? content.relevantAssetCount : null,
    unmappedRelevantAssetCount:
      typeof content.unmappedRelevantAssetCount === "number" ? content.unmappedRelevantAssetCount : null,
    familiesNeedingExpansion: Object.freeze(
      contentFamilies
        .filter((family) => isRecord(family) && family.mappingStatus === "needs_expansion")
        .map((family) => family.operationFamily)
        .filter((family) => typeof family === "string")
        .sort(),
    ),
  });
  const dataLoaderSummary = Object.freeze({
    tableCount: dataLoaderTables.length,
    gameplayTableCount: typeof tables.gameplayTableCount === "number" ? tables.gameplayTableCount : null,
    pendingGameplayTableCount:
      typeof tables.pendingGameplayTableCount === "number" ? tables.pendingGameplayTableCount : null,
    tablesNeedingExpansion: Object.freeze(
      dataLoaderTables
        .filter((table) => isRecord(table) && table.mappingStatus === "needs_expansion")
        .map((table) => table.method)
        .filter((method) => typeof method === "string")
        .sort(),
    ),
  });

  // These are deliberately named reuse hypotheses rather than kernels. They
  // are ranked work queues for human/effect-summary analysis, never a proof
  // that two API actions have compatible postconditions or authority.
  const reuseHypotheses = Object.freeze(
    frequency(entries, (entry) => entry.sourceLocus)
      .filter((group) => group.count > 1)
      .map((group) =>
        Object.freeze({
          hypothesisId: `source-locus:${group.key}`,
          sourceLocus: group.key,
          entryIds: Object.freeze(
            entries.filter((entry) => entry.sourceLocus === group.key).map((entry) => entry.atlasEntryId),
          ),
          evidence:
            "Several normal-player command-boundary candidates were extracted from one decompiled source method.",
          conclusion: "implementation_reuse_observed_semantic_kernel_unproven",
          requiredProof: Object.freeze([
            "effect summary and control/data-flow slice for every selected branch",
            "typed target/precondition/terminal-state comparison",
            "policy and receipt/evidence compatibility review",
            "native AI-Farmhand live closure for every non-equivalent branch",
          ]),
        }),
      ),
  );

  const attestation = Object.freeze({
    target: TARGET,
    assembly: Object.freeze({
      relativePath: assembly.relativePath,
      fileVersion: assembly.fileVersion,
      lengthBytes: assembly.lengthBytes,
      sha256: assembly.sha256,
    }),
    decompilation: inspection.decompilation ?? null,
    sourceSnapshot: Object.freeze({
      fileCount: snapshot.fileCount ?? null,
      gameplaySourceFileCount: snapshot.gameplaySourceFileCount ?? null,
      contentManifestSha256: snapshot.contentManifestSha256,
    }),
  });
  const inputDigest = sha256(
    JSON.stringify({
      assembly: attestation.assembly,
      sourceSnapshot: attestation.sourceSnapshot,
      ingressRoots: ingressRoots.map((root) => [root.ingressId, root.classification, root.targetMethod]),
      candidates: entries.map((entry) => [
        entry.candidateId,
        entry.nativeRuleBoundaryCandidate,
        entry.sourceLocus,
        entry.selector,
      ]),
      staticNodes: staticNodeSummary,
      content: contentSummary,
      tables: dataLoaderSummary,
    }),
  );

  return Object.freeze({
    schemaVersion: ATLAS_SCHEMA_VERSION,
    state: "source_discovery_partial",
    nonRuntimeNotice:
      "This atlas is a version-locked static discovery ledger. It grants no capability, changes no public action, does not invoke raw dispatch/UI, and cannot satisfy contract, live, receipt, or publish gates.",
    attestation,
    inputDigest,
    coverageClaim: Object.freeze({
      claim:
        "Every command-boundary candidate emitted by this exact conservative inspector invocation is represented below.",
      doesNotClaim: Object.freeze([
        "all player-achievable Stardew behavior is discovered",
        "all source candidates have complete semantics",
        "source reuse establishes public-action equivalence",
        "a candidate is bridge-representable or publishable",
        "any action has target-version live evidence",
      ]),
    }),
    ingressRoots: Object.freeze(
      ingressRoots
        .map((root) =>
          Object.freeze({
            ingressId: root.ingressId,
            targetMethod: root.targetMethod,
            classification: root.classification,
            sourceFile: root.sourceFile,
            sourceMethod: root.sourceMethod,
          }),
        )
        .sort((left, right) => left.ingressId.localeCompare(right.ingressId)),
    ),
    commandBoundaryEntries: Object.freeze(entries),
    summaries: Object.freeze({
      commandBoundaryCandidateCount: entries.length,
      unresolvedCommandBoundaryCount: unresolvedEntries.length,
      byIngress: Object.freeze(frequency(entries, (entry) => entry.ingressId)),
      bySemanticFamily: Object.freeze(frequency(entries, (entry) => entry.semanticFamily)),
      bySourceLocus: Object.freeze(frequency(entries, (entry) => entry.sourceLocus)),
      staticNodes: staticNodeSummary,
      content: contentSummary,
      dataLoader: dataLoaderSummary,
    }),
    reuseHypotheses,
    workQueues: Object.freeze({
      first: Object.freeze([
        "Resolve every normal-player ingress and command-boundary entry into classified, source-backed effect summaries; unknown is not exclusion.",
        "Treat each literal map selector and content operation as distinct until its target domain, lifecycle and effect summary prove an equivalence relation.",
        "Use source-locus reuse hypotheses only to prioritize slices; retain plant_seed and fertilize_tile-like public semantic distinctions unless contract equivalence is independently proven.",
      ]),
      beforeAnyPublication: Object.freeze([
        "typed bridge-equivalence proof",
        "action-specific contract test",
        "formal native AI-Farmhand target-version live proof with authoritative receipt and postcondition",
        "publication/policy evidence",
      ]),
    }),
  });
}
