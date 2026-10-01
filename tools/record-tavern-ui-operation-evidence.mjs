import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  MOUNTED_TAVERN_MANAGEMENT_OPERATION_IDS,
} from "./lib/tavern-mounted-operation-vocabulary.mjs";

const OPAQUE_ID = /^[a-f0-9]{16,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const OPERATIONS = new Set(MOUNTED_TAVERN_MANAGEMENT_OPERATION_IDS);

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
 * content, prompts, URLs, cookies, or operator identity. It also creates no
 * operator record, because the gate does not require one: the mapping it emits
 * is the gate's operation evidence, and the gate's verdict comes from the
 * authenticated live run itself.
 *
 * Input shape:
 * { profile: <ComposedTavernProfile>, operations: [{ operationId, outcome, projectionRevision? }] }
 * The operations array is the exported value of the opt-in browser
 * sessionStorage key `gamebuddy.tavern.ui.operation-observations`. Only
 * outcome === "passed" is mapped. The caller must obtain it from the real
 * same-origin UI/API execution, not from static declarations.
 *
 * The recorder also writes the COMPOSED PROFILE it measured, next to the mapping
 * (`<outputPath>.profile.json`). This is not a convenience: the mapping's
 * `profile_hash` is derived from the profile the LIVE session mounted, so the
 * gate must be given that same profile, not a hand-maintained transcription of
 * the composition source. A transcription drifted three times (voice settings,
 * connection settings, and again when this file was written), each time making
 * the gate reject the real production profile with `..._profile_mismatch` - which
 * is indistinguishable from a genuine regression. Emitting the pair together
 * makes the evidence and the identity it is checked against come from one
 * observed session, so they cannot disagree.
 */
export async function recordTavernUiOperationEvidence({ inputPath, outputPath }) {
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  assertProfile(input.profile);
  if (!Array.isArray(input.operations) || input.operations.length === 0) throw new Error("ui_operation_outcomes_missing");
  const mapped = {};
  const seen = new Set();
  const declared = new Set(input.profile.operationIds);
  for (const outcome of input.operations) {
    if (!outcome || typeof outcome !== "object" || !OPERATIONS.has(outcome.operationId) || seen.has(outcome.operationId))
      throw new Error("ui_operation_outcome_invalid");
    seen.add(outcome.operationId);
    if (
      outcome.outcome !== "passed" &&
      outcome.outcome !== "not_applicable" &&
      outcome.outcome !== "blocked"
    )
      throw new Error("ui_operation_outcome_invalid");
    if (!declared.has(outcome.operationId)) throw new Error("ui_operation_not_declared");
    if (outcome.outcome !== "passed") throw new Error("ui_operation_not_passed");
    mapped[outcome.operationId] = [opaque()];
  }
  // The mapping is the proof the WHOLE mounted surface was exercised and
  // every declared operation passed (design/28 §7: each lifecycle needs an
  // observable durable postcondition before its control enters the UI). A
  // blocked or skipped operation is a finding, not evidence to omit: dropping
  // it would make the gate approve a surface whose profile lists an operation
  // that was never shown to work. Fail closed instead of producing a mapping
  // that hides the gap.
  for (const operationId of declared) {
    if (!seen.has(operationId)) throw new Error("ui_operation_incomplete");
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
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  // The measured profile travels with its evidence. Only the fields the gate's
  // composed-profile contract declares are written; nothing else from the live
  // session is copied.
  await writeFile(
    `${outputPath}.profile.json`,
    `${JSON.stringify(
      {
        profileId: input.profile.profileId,
        releaseTier: input.profile.releaseTier,
        routeIds: input.profile.routeIds,
        operationIds: input.profile.operationIds,
        navigationItemIds: input.profile.navigationItemIds,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) throw new Error("usage: node tools/record-tavern-ui-operation-evidence.mjs <ui-outcomes.json> <mapping.json>");
  await recordTavernUiOperationEvidence({ inputPath, outputPath });
}
