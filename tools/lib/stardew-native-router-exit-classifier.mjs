import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const EXIT_KINDS = new Set([
  "direct_source_handoff",
  "dynamic_dispatch_boundary",
  "source_local_mutation_region",
  "non_dispatch_helper",
  "unresolved_gap",
]);
function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
function noProductTerms(value, at = "$") {
  const forbidden = new Set([
    "action",
    "actionId",
    "primitive",
    "primitiveId",
    "operation",
    "operationId",
    "semanticFamily",
    "intent",
    "contract",
    "receipt",
    "evidence",
    "policy",
    "capability",
    "publicActionId",
    "projection",
    "reuse",
  ]);
  if (Array.isArray(value)) return value.forEach((entry, index) => noProductTerms(entry, `${at}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (forbidden.has(key))
      fail("router_exit_classifier_forbidden_field", `Router exit classifier must not infer ${key}.`, {
        at: `${at}.${key}`,
      });
    noProductTerms(entry, `${at}.${key}`);
  }
}
function exactLocator(locator, label, details) {
  if (
    !locator ||
    typeof locator.relativePath !== "string" ||
    !Number.isInteger(locator.startByte) ||
    !Number.isInteger(locator.endByte) ||
    locator.endByte <= locator.startByte ||
    !SHA256.test(locator.sliceSha256 ?? "") ||
    !SHA256.test(locator.sourceFileSha256 ?? "")
  )
    fail("router_exit_classifier_locator_invalid", `Expected exact ${label} locator.`, details);
}
function same(left, right) {
  return (
    left.relativePath === right.relativePath &&
    left.startByte === right.startByte &&
    left.endByte === right.endByte &&
    left.sliceSha256 === right.sliceSha256 &&
    left.sourceFileSha256 === right.sourceFileSha256
  );
}
/**
 * Exhaustively disposes every syntax invocation in one exact router inventory.
 * It remains a classification of source exits, not an action/transition model.
 */
export function validateNativeRouterExitClassifier(classifier, { inventory } = {}) {
  noProductTerms(classifier);
  if (!inventory || inventory.schemaVersion !== 1 || inventory.artifactKind !== "native_router_invocation_inventory")
    fail("router_exit_classifier_inventory_invalid", "An exact router invocation inventory is required.");
  if (!classifier || classifier.schemaVersion !== 1 || classifier.artifactKind !== "native_router_exit_classifier")
    fail("router_exit_classifier_schema_invalid", "Expected native router exit classifier schema version 1.");
  if (!same(classifier.routerDeclaration ?? {}, inventory.routerDeclaration ?? {}))
    fail("router_exit_classifier_router_mismatch", "Classifier must bind exactly to its router inventory declaration.");
  if (!Array.isArray(classifier.records)) fail("router_exit_classifier_invalid", "Classifier requires records array.");
  const expected = new Map(inventory.invocations.map((item) => [item.invocationId, item]));
  const records = new Set();
  for (const record of classifier.records) {
    const details = { invocationId: record?.invocationId };
    if (
      typeof record?.invocationId !== "string" ||
      !expected.has(record.invocationId) ||
      records.has(record.invocationId) ||
      !EXIT_KINDS.has(record.exitKind) ||
      typeof record.reason !== "string" ||
      !record.reason.trim()
    )
      fail("router_exit_classifier_invalid", "Every exact invocation needs one valid classified record.", details);
    records.add(record.invocationId);
    const invocation = expected.get(record.invocationId);
    if (!same(record.sourceLocator ?? {}, invocation.sourceLocator))
      fail(
        "router_exit_classifier_locator_mismatch",
        "Record must retain the exact source invocation locator.",
        details,
      );
    if (record.exitKind === "direct_source_handoff") {
      if (!record.targetDeclaration)
        fail("router_exit_classifier_target_missing", "Direct source handoff needs exact target declaration.", details);
      exactLocator(record.targetDeclaration, "target declaration", details);
    }
    if (record.exitKind === "dynamic_dispatch_boundary" || record.exitKind === "unresolved_gap") {
      if (!record.gapId || record.possiblyGameplayBearing !== true)
        fail(
          "router_exit_classifier_dynamic_gap_required",
          "Dynamic/unresolved exits require a blocking gameplay-bearing gap ID.",
          details,
        );
    }
    if (record.exitKind === "source_local_mutation_region") {
      if (!record.regionLocator)
        fail(
          "router_exit_classifier_region_missing",
          "Local mutation region needs an exact source region locator.",
          details,
        );
      exactLocator(record.regionLocator, "mutation region", details);
    }
  }
  const missingInvocationIds = [...expected.keys()].filter((id) => !records.has(id));
  if (missingInvocationIds.length)
    fail("router_exit_classifier_unclassified", "Every exact router invocation must receive one exit classification.", {
      missingInvocationIds,
    });
  const dynamicRecords = classifier.records.filter(
    (record) => record.exitKind === "dynamic_dispatch_boundary" || record.exitKind === "unresolved_gap",
  );
  const blockingGapIds = [...new Set(dynamicRecords.map((record) => record.gapId))].sort();
  return Object.freeze({
    invocationCount: expected.size,
    blockingGapCount: dynamicRecords.length,
    blockingGapIds,
    classificationState: dynamicRecords.length ? "partial_with_blocking_dynamic_exits" : "not_completion_claimed",
  });
}
