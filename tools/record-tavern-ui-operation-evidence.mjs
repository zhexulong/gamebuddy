import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const OPAQUE_ID = /^[a-f0-9]{16,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const OPERATIONS = new Set([
  "draft.save",
  "draft.discard",
  "chat.rename",
  "memory.mutate",
  "world-info.bind",
]);

function opaque() {
  return randomBytes(24).toString("hex");
}

function profileHash(profile) {
  return createHash("sha256")
    .update(JSON.stringify({
      profileId: profile.profileId,
      releaseTier: profile.releaseTier,
      routeIds: profile.routeIds,
      operationIds: profile.operationIds,
      navigationItemIds: profile.navigationItemIds,
    }), "utf8")
    .digest("hex");
}

function assertProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("mounted_profile_invalid");
  if (typeof profile.profileId !== "string" || profile.releaseTier !== "tavern_management") throw new Error("mounted_profile_invalid");
  if (!Array.isArray(profile.operationIds) || !profile.operationIds.every((id) => OPERATIONS.has(id))) throw new Error("mounted_profile_operations_invalid");
}

/**
 * Convert independently captured, content-free UI operation outcomes into the
 * release gate's operation mapping. This tool never records titles, memory
 * content, prompts, URLs, cookies, or operator identity. It also deliberately
 * does not create an operator record: automation evidence cannot substitute
 * for direct operator observation.
 *
 * Input shape:
 * { profile: <ComposedTavernProfile>, operations: [{ operationId, outcome, projectionRevision? }] }
 * The operations array is the exported value of the opt-in browser
 * sessionStorage key `gamebuddy.tavern.ui.operation-observations`. Only
 * outcome === "passed" is mapped. The caller must obtain it from the real
 * same-origin UI/API execution, not from static declarations.
 */
export async function recordTavernUiOperationEvidence({ inputPath, outputPath }) {
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  assertProfile(input.profile);
  if (!Array.isArray(input.operations) || input.operations.length === 0) throw new Error("ui_operation_outcomes_missing");
  const mapped = {};
  const seen = new Set();
  for (const outcome of input.operations) {
    if (!outcome || typeof outcome !== "object" || !OPERATIONS.has(outcome.operationId) || seen.has(outcome.operationId))
      throw new Error("ui_operation_outcome_invalid");
    seen.add(outcome.operationId);
      if (outcome.outcome !== "passed" && outcome.outcome !== "not_applicable" && outcome.outcome !== "blocked") throw new Error("ui_operation_outcome_invalid");
    if (!input.profile.operationIds.includes(outcome.operationId)) throw new Error("ui_operation_not_declared");
    if (outcome.outcome !== "passed") continue;
    mapped[outcome.operationId] = [opaque()];
  }
  if (Object.keys(mapped).length === 0) throw new Error("ui_operation_no_passed_outcomes");
  const result = {
    schema_version: 1,
    evidence_kind: "automation_evidence",
    profile_id: input.profile.profileId,
    profile_hash: profileHash(input.profile),
    release_tier: input.profile.releaseTier,
    operations: mapped,
  };
  if (!HASH.test(result.profile_hash) || !Object.values(result.operations).every((ids) => ids.every((id) => OPAQUE_ID.test(id))))
    throw new Error("ui_operation_evidence_internal_invalid");
  await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  return result;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) throw new Error("usage: node tools/record-tavern-ui-operation-evidence.mjs <ui-outcomes.json> <mapping.json>");
  await recordTavernUiOperationEvidence({ inputPath, outputPath });
}
