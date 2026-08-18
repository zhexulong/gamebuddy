import { readFile } from "node:fs/promises";
import { validatePortfolioM4ResourceSourceAudit } from "./lib/stardew-portfolio-m4-resource-source-audit.mjs";

const ACTION = "break_rock_source";
const BLOCKER = "m4_target_version_decompilation_correlation";
const FORBIDDEN = Object.freeze([
  "UI/input, reflection, generic dispatcher/native invoker, raw save/day calls, or save edits",
  "Debris pickup, inventory delivery, collect_resource, chop_tree_source, or generic tool/resource actions",
  "synthetic receipt, synthetic fresh-debris observation, or live-closure claim",
]);
function fail(message) {
  throw Object.assign(new Error(message), { code: "portfolio_m4_break_rock_contract_invalid" });
}
function exact(value, keys, name) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    fail(`${name} shape is invalid.`);
}
export function validateM4BreakRockSourceContract(value) {
  exact(
    value,
    ["schemaVersion", "contractId", "action", "topology", "sourceAudit", "scenario", "forbidden", "status"],
    "contract",
  );
  if (
    value.schemaVersion !== 1 ||
    value.contractId !== "portfolio_m4_break_rock_source_v1" ||
    value.action !== ACTION ||
    value.topology !== "single_player_native_companion"
  )
    fail("identity is invalid.");
  exact(value.sourceAudit, ["path", "auditId", "projectionState", "blocker"], "sourceAudit");
  if (
    value.sourceAudit.path !== "tools/stardew-portfolio-m4-resource-source-audit.json" ||
    value.sourceAudit.auditId !== "portfolio_m4_resource_delivery_source_audit_v1" ||
    value.sourceAudit.projectionState !== "blocked" ||
    value.sourceAudit.blocker !== BLOCKER
  )
    fail("source-audit boundary is invalid.");
  exact(value.scenario, ["given", "when", "then"], "scenario");
  if (
    value.scenario.given !== "fresh source identity, positive health, and eligible equipped Pickaxe" ||
    value.scenario.when !== "typed request is game-thread guarded before any semantic edge" ||
    value.scenario.then !== "source-transform receipt correlates exact fresh Debris IDs; pickup remains distinct"
  )
    fail("BDD pipeline is invalid.");
  if (JSON.stringify(value.forbidden) !== JSON.stringify(FORBIDDEN) || value.status !== "dependency_blocked")
    fail("scope/status is invalid.");
  return Object.freeze({ action: ACTION, status: "dependency_blocked", blocker: BLOCKER, liveClosure: "none" });
}
export async function checkM4BreakRockSourceContract(
  path = "tools/stardew-portfolio-m4-break-rock-source-contract.json",
) {
  const contract = validateM4BreakRockSourceContract(JSON.parse(await readFile(path, "utf8")));
  const audit = JSON.parse(await readFile("tools/stardew-portfolio-m4-resource-source-audit.json", "utf8"));
  // Audit structure is revalidated by its owned audit test/CLI; this check refuses promotion.
  if (
    audit.conclusion?.projectionState !== "blocked" ||
    audit.unresolvedQuestions?.some((question) => question.questionId === BLOCKER) !== true
  )
    fail("required source blocker is absent.");
  return Object.freeze({
    ...contract,
    producer: "fresh source observation",
    consumer: "typed guarded coordinator",
    verifier: "future exact fresh-debris reader",
  });
}
if (process.argv[1]?.endsWith("stardew-portfolio-m4-break-rock-source-contract.mjs"))
  console.log(JSON.stringify(await checkM4BreakRockSourceContract(), null, 2));
