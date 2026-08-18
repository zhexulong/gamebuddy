#!/usr/bin/env node
/**
 * Diagnostic validator for an early source-derived Player-Reachable Command
 * Path (PRCP) report from the exact target game installation.
 *
 * Its intentionally strict result is research evidence only: it must not be
 * treated as the gameplay-capability completeness gate. Capability-set
 * decisions are reuse-first and are closed by per-capability live gates.
 *
 * Exit status means only whether one explicitly bounded diagnostic report is
 * internally complete. It never means the entire game or capability set is
 * complete, and this command is intentionally not part of the default CI gate.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

const defaultCatalogPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../design/gameplay-capability-catalog.json",
);
const ROUTE_KINDS = new Set(["primitive", "composite", "coordinated"]);
const ROOT_CLASSIFICATIONS = new Set(["command_path", "supporting_path", "non_gameplay_path"]);
const PROHIBITED_BRIDGE_TERMS =
  /(?:\bui\b|visual|window(?:\s+focus)?|keyboard|mouse|os input|input injection|raw coordinate|arbitrary (?:action|string|native))/i;

function arrayOfStrings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function catalogBasisIds(catalog) {
  return new Set(
    Array.isArray(catalog?.records)
      ? catalog.records.flatMap((record) => (Array.isArray(record?.basisPrimitiveIds) ? record.basisPrimitiveIds : []))
      : [],
  );
}

function validRoute(route, knownBasis) {
  if (!route || typeof route !== "object" || !ROUTE_KINDS.has(route.kind)) return false;
  if (PROHIBITED_BRIDGE_TERMS.test(JSON.stringify(route))) return false;
  if (route.kind === "primitive") {
    return (
      typeof route.basisPrimitiveId === "string" &&
      knownBasis.has(route.basisPrimitiveId) &&
      typeof route.nativeEquivalenceEvidence === "string" &&
      route.nativeEquivalenceEvidence.length > 0
    );
  }
  if (route.kind === "composite") {
    return (
      typeof route.compositeGraphRef === "string" &&
      route.compositeGraphRef.length > 0 &&
      arrayOfStrings(route.basisPrimitiveIds) &&
      route.basisPrimitiveIds.every((basisId) => knownBasis.has(basisId)) &&
      typeof route.nativeEquivalenceEvidence === "string" &&
      route.nativeEquivalenceEvidence.length > 0
    );
  }
  return (
    typeof route.coordinationRef === "string" &&
    route.coordinationRef.length > 0 &&
    typeof route.nativeEquivalenceEvidence === "string" &&
    route.nativeEquivalenceEvidence.length > 0
  );
}

/**
 * Validate a report without reading the installed game. This is exported so
 * graph and fail-closed rules remain deterministic under unit test.
 */
export function validateDirectGameplaySurfaceReport(report, catalog = null) {
  const errors = [];
  if (report?.state !== "inspected") errors.push("Surface report is not an inspected candidate report.");
  if (
    report?.target?.version !== "1.6.15" ||
    report?.target?.build !== 24356 ||
    report?.assembly?.fileVersion !== "1.6.15.24356"
  ) {
    errors.push("Surface report target does not match Stardew 1.6.15 build 24356.");
  }
  if (
    !report?.assembly?.sha256 ||
    !Number.isInteger(report?.assembly?.lengthBytes) ||
    report.assembly.lengthBytes <= 0
  ) {
    errors.push("Surface report is missing the target assembly length/SHA-256 attestation.");
  }
  if (
    !report?.attestation?.extractedAtUtc ||
    !report?.decompilation?.tool ||
    !report?.decompilation?.toolVersion ||
    !report?.decompilation?.configurationDigest ||
    !report?.sourceSnapshot?.contentManifestSha256
  ) {
    errors.push("Surface report is missing decompilation/source attestation.");
  }
  if (!report?.content?.contentHashesSha256 || !report?.content?.relevantAssetManifestSha256) {
    errors.push("Surface report is missing ContentHashes/asset manifest attestation.");
  }

  const bridgeEquivalenceAudit = Array.isArray(report?.bridgeEquivalenceAudit) ? report.bridgeEquivalenceAudit : [];
  const bridgeEquivalenceGaps = bridgeEquivalenceAudit.filter(
    (finding) => finding?.state !== "source_guard_equivalence_candidate",
  );
  const graph = report?.playerCommandGraph;
  if (!graph || typeof graph !== "object") {
    errors.push("Surface report is missing the source-derived player-command reachability graph.");
    return { errors, details: { commandPaths: 0, unknownReachableEdges: 0 } };
  }
  if (
    graph.schemaVersion !== 1 ||
    !Array.isArray(graph.ingressRoots) ||
    !Array.isArray(graph.reachableEdges) ||
    !Array.isArray(graph.commandPaths) ||
    !Array.isArray(graph.commandPathCandidates) ||
    !Array.isArray(graph.supportingPaths) ||
    !Array.isArray(graph.nonGameplayPaths) ||
    !Array.isArray(graph.unknownReachableEdges) ||
    !Array.isArray(graph.pendingCommandCandidates)
  ) {
    errors.push("Player-command graph has an invalid schema.");
    return { errors, details: { commandPaths: 0, unknownReachableEdges: 0 } };
  }

  const knownBasis = catalogBasisIds(catalog);
  const ingressUnknown = graph.ingressRoots.filter((root) => !ROOT_CLASSIFICATIONS.has(root.classification));
  const malformedReachableEdges = graph.reachableEdges.filter(
    (edge) =>
      typeof edge?.edgeId !== "string" ||
      edge.edgeId.length === 0 ||
      typeof edge?.from !== "string" ||
      edge.from.length === 0 ||
      typeof edge?.to !== "string" ||
      edge.to.length === 0 ||
      !["command_path", "supporting_path", "non_gameplay_path", "unknown", "candidate_dispatch_edge"].includes(
        edge?.classification,
      ),
  );
  const unresolvedReachableEdges = graph.reachableEdges.filter(
    (edge) => edge?.classification === "unknown" || edge?.classification === "candidate_dispatch_edge",
  );
  const unknownReachableEdges = graph.unknownReachableEdges;
  const pendingCommandCandidates = graph.pendingCommandCandidates;
  const commandPaths = graph.commandPaths;
  const candidateIds = graph.commandPathCandidates
    .map((candidate) => candidate?.candidateId)
    .filter((id) => typeof id === "string");
  const duplicateCommandPathCandidateIds = candidateIds.filter((id, index) => candidateIds.indexOf(id) !== index);
  const malformedCommandPathCandidates = graph.commandPathCandidates.filter(
    (candidate) =>
      typeof candidate?.candidateId !== "string" ||
      candidate.candidateId.length === 0 ||
      typeof candidate?.ingressId !== "string" ||
      candidate.ingressId.length === 0 ||
      typeof candidate?.semanticFamily !== "string" ||
      candidate.semanticFamily.length === 0 ||
      typeof candidate?.nativeRuleBoundaryCandidate !== "string" ||
      candidate.nativeRuleBoundaryCandidate.length === 0 ||
      !arrayOfStrings(candidate?.sourceEdgeIds) ||
      candidate?.status !== "boundary_candidate" ||
      !candidate?.sourceEvidence ||
      typeof candidate.sourceEvidence !== "object" ||
      typeof candidate.sourceEvidence?.sourceType !== "string" ||
      candidate.sourceEvidence.sourceType.length === 0 ||
      typeof candidate.sourceEvidence?.sourceFile !== "string" ||
      candidate.sourceEvidence.sourceFile.length === 0 ||
      typeof candidate.sourceEvidence?.sourceMethod !== "string" ||
      candidate.sourceEvidence.sourceMethod.length === 0 ||
      !arrayOfStrings(candidate.sourceEvidence?.requiredFragments) ||
      !candidate.sourceEvidence?.anchorPositions ||
      typeof candidate.sourceEvidence.anchorPositions !== "object",
  );
  const duplicateCommandPathIds = commandPaths
    .map((path) => path?.prcpId)
    .filter((id) => typeof id === "string")
    .filter((id, index, all) => all.indexOf(id) !== index);
  const malformedCommandPaths = commandPaths.filter(
    (commandPath) =>
      typeof commandPath?.prcpId !== "string" ||
      commandPath.prcpId.length === 0 ||
      typeof commandPath?.ingressId !== "string" ||
      commandPath.ingressId.length === 0 ||
      typeof commandPath?.nativeRuleBoundary !== "string" ||
      commandPath.nativeRuleBoundary.length === 0 ||
      !validRoute(commandPath.route, knownBasis),
  );
  const prohibitedBridgeRoutes = commandPaths.filter((commandPath) =>
    PROHIBITED_BRIDGE_TERMS.test(JSON.stringify(commandPath?.route ?? {})),
  );
  const commandPathIds = new Set(commandPaths.map((commandPath) => commandPath?.prcpId).filter(Boolean));
  // A partial graph may discover lifecycle/supporting edges before its parent
  // command path is reconstructed. It is already rejected through state,
  // unresolved edges, and pending candidates; do not misreport those edges as
  // independently malformed. A complete graph must bind every one.
  const malformedSupportingPaths = graph.supportingPaths.filter(
    (path) =>
      typeof path?.reason !== "string" ||
      path.reason.length === 0 ||
      (graph.state === "complete" &&
        (typeof path?.parentCommandPathId !== "string" || !commandPathIds.has(path.parentCommandPathId))),
  );
  const malformedNonGameplayPaths = graph.nonGameplayPaths.filter(
    (path) => typeof path?.reason !== "string" || path.reason.length === 0,
  );

  if (graph.state !== "complete")
    errors.push(`Player-command graph state is ${graph.state ?? "unknown"}, not complete.`);
  if (ingressUnknown.length) errors.push(`${ingressUnknown.length} normal-player ingress roots are unclassified.`);
  if (malformedReachableEdges.length)
    errors.push(
      `${malformedReachableEdges.length} ingress-reachable graph edges have invalid identity or classification.`,
    );
  if (unresolvedReachableEdges.length)
    errors.push(`${unresolvedReachableEdges.length} ingress-reachable graph edges are unresolved.`);
  if (unknownReachableEdges.length)
    errors.push(`${unknownReachableEdges.length} ingress-reachable graph edges are unknown.`);
  if (pendingCommandCandidates.length)
    errors.push(
      `${pendingCommandCandidates.length} normal-player command candidates have not reached a native rule boundary.`,
    );
  if (malformedCommandPathCandidates.length)
    errors.push(
      `${malformedCommandPathCandidates.length} source-derived command-boundary candidates have invalid identity or native boundary evidence.`,
    );
  if (duplicateCommandPathCandidateIds.length)
    errors.push(
      `Duplicate source-derived command-boundary candidate IDs: ${[...new Set(duplicateCommandPathCandidateIds)].join(", ")}.`,
    );
  if (malformedCommandPaths.length)
    errors.push(
      `${malformedCommandPaths.length} command paths lack a canonical PRCP identity, native boundary, or typed bridge equivalence route.`,
    );
  if (duplicateCommandPathIds.length)
    errors.push(`Duplicate canonical PRCP IDs: ${[...new Set(duplicateCommandPathIds)].join(", ")}.`);
  if (malformedSupportingPaths.length)
    errors.push(`${malformedSupportingPaths.length} supporting paths lack an auditable parent command path or reason.`);
  if (malformedNonGameplayPaths.length)
    errors.push(`${malformedNonGameplayPaths.length} non-gameplay paths lack a source classification reason.`);
  if (prohibitedBridgeRoutes.length)
    errors.push(
      `${prohibitedBridgeRoutes.length} command paths contain prohibited UI/input/raw-dispatch bridge terms.`,
    );
  if (bridgeEquivalenceGaps.length)
    errors.push(`${bridgeEquivalenceGaps.length} source-derived bridge equivalence audits have unresolved guard gaps.`);

  return {
    errors,
    details: {
      ingressRoots: graph.ingressRoots.length,
      reachableEdges: graph.reachableEdges.length,
      unresolvedReachableEdges: unresolvedReachableEdges.length,
      malformedReachableEdges: malformedReachableEdges.length,
      commandPaths: commandPaths.length,
      commandPathCandidates: graph.commandPathCandidates.length,
      malformedCommandPathCandidates: malformedCommandPathCandidates.length,
      duplicateCommandPathCandidateIds: [...new Set(duplicateCommandPathCandidateIds)],
      supportingPaths: graph.supportingPaths.length,
      nonGameplayPaths: graph.nonGameplayPaths.length,
      unknownReachableEdges: unknownReachableEdges.length,
      pendingCommandCandidates: pendingCommandCandidates.length,
      malformedCommandPaths: malformedCommandPaths.length,
      malformedSupportingPaths: malformedSupportingPaths.length,
      malformedNonGameplayPaths: malformedNonGameplayPaths.length,
      prohibitedBridgeRoutes: prohibitedBridgeRoutes.length,
      bridgeEquivalenceGaps: bridgeEquivalenceGaps.length,
      sampleBridgeEquivalenceGaps: bridgeEquivalenceGaps.slice(0, 20),
      sampleUnknownEdges: unknownReachableEdges.slice(0, 20),
      samplePendingCandidates: pendingCommandCandidates.slice(0, 20),
    },
  };
}

async function main() {
  const reportPath = argument("--report");
  if (!reportPath || process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stderr.write(
      "Usage: node tools/check-stardew-gameplay-completeness.mjs --report <direct-inspector-report.json> [--catalog <catalog.json>]\n",
    );
    return reportPath ? 0 : 2;
  }
  try {
    const catalogPath = path.resolve(argument("--catalog") || defaultCatalogPath);
    const [reportSource, catalogSource] = await Promise.all([
      readFile(path.resolve(reportPath), "utf8"),
      readFile(catalogPath, "utf8"),
    ]);
    const result = validateDirectGameplaySurfaceReport(JSON.parse(reportSource), JSON.parse(catalogSource));
    if (result.errors.length)
      fail(
        "player_command_graph_diagnostic_incomplete",
        "Direct target-game inspection found an intentionally incomplete PRCP research graph; this does not decide the gameplay capability set.",
        result.details,
      );
    process.stdout.write(
      `${JSON.stringify({ state: "passed", diagnosticState: "bounded_native_audit_complete", capabilitySetDecision: "not_decided_by_this_diagnostic", ...result.details })}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error.code || "player_command_coverage_failed"}: ${error.message}\n`);
    if (error.details) process.stderr.write(`${JSON.stringify(error.details)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
