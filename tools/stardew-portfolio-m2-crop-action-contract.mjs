import { readFile } from "node:fs/promises";
const PRIMITIVES = ["till", "plant", "water", "harvest"];
const FORBIDDEN = [
  "UI/input",
  "reflection",
  "generic dispatcher/native invoker",
  "raw save/day calls",
  "save edits",
  "synthetic/live evidence",
];
function fail(message) {
  throw new Error(message);
}
function exact(value, fields, name) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field))
  )
    fail(`${name} must have exact fields.`);
}
export function validatePortfolioM2CropActionContract(value) {
  exact(
    value,
    [
      "schemaVersion",
      "contractId",
      "topology",
      "sourceAudit",
      "scenario",
      "primitives",
      "producerConsumerVerifier",
      "blocker",
      "forbidden",
      "status",
    ],
    "M2 crop contract",
  );
  if (
    value.schemaVersion !== 1 ||
    value.contractId !== "portfolio_m2_crop_action_batch_v1" ||
    value.topology !== "single_player_native_companion" ||
    value.status !== "blocked_no_projection_or_live_claim"
  )
    fail("M2 crop contract identity/status is invalid.");
  exact(value.sourceAudit, ["auditId", "projectionState", "liveState"], "sourceAudit");
  if (
    value.sourceAudit.auditId !== "portfolio_m2_crop_lifecycle_source_audit_v1" ||
    value.sourceAudit.projectionState !== "blocked" ||
    value.sourceAudit.liveState !== "not_performed"
  )
    fail("M2 source audit must remain blocked.");
  if (JSON.stringify(value.primitives) !== JSON.stringify(PRIMITIVES))
    fail("M2 must retain exactly till, plant, water, harvest.");
  exact(value.scenario, ["given", "when", "then", "and"], "scenario");
  exact(value.producerConsumerVerifier, ["given", "when", "then", "and"], "producerConsumerVerifier");
  exact(value.blocker, ["code", "producer", "consumer", "verifier"], "blocker");
  if (
    value.blocker.code !== "source_realization_blocked" ||
    value.blocker.consumer !== "PortfolioCropActionCoordinator"
  )
    fail("M2 blocker handoff is invalid.");
  if (JSON.stringify(value.forbidden) !== JSON.stringify(FORBIDDEN)) fail("M2 forbidden boundary was weakened.");
  return Object.freeze({ primitives: PRIMITIVES, state: "blocked", liveClosure: "none" });
}
export async function checkPortfolioM2CropActionContract(
  path = "tools/stardew-portfolio-m2-crop-action-contract.json",
) {
  return validatePortfolioM2CropActionContract(JSON.parse(await readFile(path, "utf8")));
}
