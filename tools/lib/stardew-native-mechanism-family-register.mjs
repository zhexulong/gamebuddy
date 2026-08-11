import { createHash } from "node:crypto";
import { validateMechanismReport } from "./stardew-native-mechanism-review-register.mjs";

function fail(code, message, details = {}) { const error = new Error(message); error.code = code; error.details = details; throw error; }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function sourceCluster(sourcePath) {
  const segments = sourcePath.split("/");
  if (segments.length === 1) return sourcePath;
  if (segments.length === 2 && segments[1].endsWith(".cs")) return sourcePath;
  return `${segments[0]}/${segments[1]}`;
}

/**
 * Convert the intentionally broad Stage-1 match ledger into an exhaustive
 * review index. A row stays attached to its discovery rule; the register
 * neither determines relevance nor assigns a transition/action meaning.
 */
export function deriveNativeInteractionMechanismFamilyRegister(mechanismReport) {
  const exact = validateMechanismReport(mechanismReport);
  const grouped = new Map();
  for (const mechanism of exact.mechanisms.values()) {
    const cluster = sourceCluster(mechanism.sourcePath);
    const key = `${mechanism.category}\0${mechanism.family}\0${cluster}`;
    const group = grouped.get(key) ?? {
      familyId: `mechanism-family:${digest(key)}`,
      category: mechanism.category,
      discoveryFamily: mechanism.family,
      sourceCluster: cluster,
      memberIds: [],
      sourcePaths: new Set(),
      syntaxStates: new Set(),
      lexicalOwnerSyntaxes: new Set(),
      lexicalMemberSyntaxes: new Set(),
    };
    group.memberIds.push(mechanism.mechanismId);
    group.sourcePaths.add(mechanism.sourcePath);
    group.syntaxStates.add(mechanism.fileSyntaxState);
    if (mechanism.lexicalOwnerSyntax) group.lexicalOwnerSyntaxes.add(mechanism.lexicalOwnerSyntax);
    if (mechanism.lexicalMemberSyntax) group.lexicalMemberSyntaxes.add(mechanism.lexicalMemberSyntax);
    grouped.set(key, group);
  }
  const families = [...grouped.values()].map((group) => Object.freeze({
    familyId: group.familyId,
    category: group.category,
    discoveryFamily: group.discoveryFamily,
    sourceCluster: group.sourceCluster,
    memberCount: group.memberIds.length,
    memberIds: Object.freeze(group.memberIds.sort()),
    sourcePathCount: group.sourcePaths.size,
    sourcePaths: Object.freeze([...group.sourcePaths].sort()),
    fileSyntaxStates: Object.freeze([...group.syntaxStates].sort()),
    lexicalOwnerSyntaxes: Object.freeze([...group.lexicalOwnerSyntaxes].sort()),
    lexicalMemberSyntaxes: Object.freeze([...group.lexicalMemberSyntaxes].sort()),
    reviewState: "unreviewed_source_mechanism_family",
  })).sort((a, b) => a.familyId.localeCompare(b.familyId));
  const assigned = families.flatMap((family) => family.memberIds);
  if (assigned.length !== exact.mechanisms.size || new Set(assigned).size !== assigned.length) fail("mechanism_family_register_non_exhaustive", "Every exact Stage-1 mechanism row must be assigned to exactly one family index row.");
  return Object.freeze({
    schemaVersion: 1,
    artifactKind: "native_interaction_mechanism_family_register",
    attestation: Object.freeze({ targetAssemblySha256: exact.targetAssemblySha256, sourceManifestSha256: exact.sourceManifestSha256 }),
    inputMechanismCount: exact.mechanisms.size,
    familyCount: families.length,
    families: Object.freeze(families),
    analysisBoundary: Object.freeze({
      syntaxDiscoveryIndexing: "performed",
      sourceOwnerResolution: "not_performed",
      transitionDerivation: "not_performed",
      primitiveDerivation: "not_performed",
      playerOperationDerivation: "not_performed",
      publicActionProjection: "not_performed",
    }),
  });
}
