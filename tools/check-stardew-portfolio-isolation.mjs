#!/usr/bin/env node
/**
 * Static guard for the Portfolio P0a pipeline. It intentionally validates only
 * topology isolation of the local transaction/prerequisite tools; it does not
 * validate a runtime bridge, action, receipt, or live evidence.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const profilePath = resolve(root, "tools/lib/stardew-portfolio-profile.mjs");
const prerequisitePath = resolve(root, "tools/check-stardew-portfolio-prerequisites.mjs");
const p0bPath = resolve(root, "tools/check-stardew-portfolio-p0b.mjs");
const p0bLibPath = resolve(root, "tools/lib/stardew-portfolio-p0b.mjs");
const testPath = resolve(root, "tools/stardew-portfolio-profile.test.mjs");
const p0bTestPath = resolve(root, "tools/stardew-portfolio-p0b.test.mjs");
const p1cPath = resolve(root, "tools/run-stardew-portfolio-observe-smoke.mjs");
const p1cTestPath = resolve(root, "tools/stardew-portfolio-observe-smoke.test.mjs");
const p3Path = resolve(root, "tools/check-stardew-portfolio-p3.mjs");
const p3TestPath = resolve(root, "tools/stardew-portfolio-contracts.test.mjs");
const contractLibPath = resolve(root, "tools/lib/stardew-portfolio-contracts.mjs");
const packagePath = resolve(root, "package.json");
const [
  profile,
  prerequisite,
  p0b,
  p0bLib,
  testSource,
  p0bTestSource,
  p1c,
  p1cTestSource,
  p3,
  p3TestSource,
  contractLib,
  packageSource,
] = await Promise.all([
  readFile(profilePath, "utf8"),
  readFile(prerequisitePath, "utf8"),
  readFile(p0bPath, "utf8"),
  readFile(p0bLibPath, "utf8"),
  readFile(testPath, "utf8"),
  readFile(p0bTestPath, "utf8"),
  readFile(p1cPath, "utf8"),
  readFile(p1cTestPath, "utf8"),
  readFile(p3Path, "utf8"),
  readFile(p3TestPath, "utf8"),
  readFile(contractLibPath, "utf8"),
  readFile(packagePath, "utf8"),
]);
const failures = [];
for (const required of [
  'PORTFOLIO_TOPOLOGY = "single_player_native_companion"',
  "portfolio_contaminated_farmhand_manifest",
  "portfolio_contaminated_farmhand_provisioner",
  "portfolio_contaminated_host_farmhand_provisioning",
  "portfolio_contaminated_host_automation",
  "portfolio_duplicate_mod_bundle",
  "portfolio_transaction_locked",
  "portfolio_game_path_missing",
  "portfolio_config_unknown_field",
  'toLocaleLowerCase("en-US")',
  "byte-for-byte",
  "portfolio_runtime_bridge_not_closed_or_scoped",
]) {
  if (!profile.includes(required)) failures.push(`portfolio_isolation_missing:${required}`);
}
for (const forbidden of ["stardew-fixture-profile.mjs", "A-host", "A-ai-client"]) {
  if (profile.includes(forbidden)) failures.push(`portfolio_isolation_farmhand_dependency:${forbidden}`);
}
if (!prerequisite.includes('state: "BLOCKED"') || !prerequisite.includes("GAMEBUDDY_PORTFOLIO_PROFILE_ROOT")) {
  failures.push("portfolio_prerequisite_blocked_contract_missing");
}
for (const expected of [
  "Farmhand provisioner",
  "mixed-case cross-topology artifacts",
  "unmanaged files",
  "never steals an existing or invalid lock",
]) {
  if (!testSource.includes(expected)) failures.push(`portfolio_isolation_test_missing:${expected}`);
}
const manifest = JSON.parse(packageSource);
if (manifest.scripts?.["test:stardew-portfolio-pipeline"] !== "node --test tools/stardew-portfolio-profile.test.mjs")
  failures.push("portfolio_pipeline_test_script_missing");
if (
  manifest.scripts?.["check:stardew-portfolio-prerequisites"] !== "node tools/check-stardew-portfolio-prerequisites.mjs"
)
  failures.push("portfolio_prerequisite_script_missing");
if (manifest.scripts?.["check:stardew-portfolio-p0b"] !== "node tools/check-stardew-portfolio-p0b.mjs")
  failures.push("portfolio_p0b_script_missing");
if (manifest.scripts?.["test:stardew-portfolio-p0b"] !== "node --test tools/stardew-portfolio-p0b.test.mjs")
  failures.push("portfolio_p0b_test_script_missing");
if (
  manifest.scripts?.["test:stardew-portfolio-p1"] !==
  "pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.portfolio.json && pnpm --filter @gamebuddy/companion-host exec node --test dist-portfolio/portfolio-protocol.test.js dist-portfolio/portfolio-stardew-bridge.test.js"
)
  failures.push("portfolio_p1_test_script_missing");
if (!packageSource.includes('"test:stardew-portfolio-p1c"')) failures.push("portfolio_p1c_test_script_missing");
if (!prerequisite.includes("GAMEBUDDY_STARDEW_GAME_PATH"))
  failures.push("portfolio_game_path_environment_gate_missing");
if (prerequisite.includes("requireP0bAttestation: true")) failures.push("portfolio_p0b_attestation_must_not_gate_action_first");
for (const required of [
  "portfolio_installation_attestation",
  "portfolio_save_directory_missing",
  "SaveGame.Load",
  "portfolio_start_manifest_preloaded_result",
  "createHmac",
]) {
  if (!p0bLib.includes(required)) failures.push(`portfolio_p0b_missing:${required}`);
}
if (!p0bLib.includes("portfolio_start_manifest_preloaded_result"))
  failures.push("portfolio_p0b_terminal_guard_missing");
for (const expected of [
  "signed clean start manifest",
  "preloaded results",
  "exact target and SMAPI executable identity",
]) {
  if (!p0bTestSource.includes(expected)) failures.push(`portfolio_p0b_test_missing:${expected}`);
}
if (!p0b.includes("inspectPortfolioP0b") || !p0b.includes("P0b_read_only_save_and_target_attestation"))
  failures.push("portfolio_p0b_runner_missing");
for (const required of [
  "P1c_live_observe_only",
  "BLOCKED",
  "title_invalidation",
  "disconnect_invalidation",
  "observe-only",
  "P0b",
  "portfolio_lifecycle_event_required",
])
  if (!p1c.includes(required)) failures.push(`portfolio_p1c_runner_missing:${required}`);
for (const required of ["P1c", "title and disconnect invalidation", "does not expose mutation"])
  if (!p1cTestSource.includes(required)) failures.push(`portfolio_p1c_test_missing:${required}`);
if (manifest.scripts?.["check:stardew-portfolio-p1c"] !== "node tools/run-stardew-portfolio-observe-smoke.mjs")
  failures.push("portfolio_p1c_script_missing");
if (manifest.scripts?.["test:stardew-portfolio-p1c"] !== "node --test tools/stardew-portfolio-observe-smoke.test.mjs")
  failures.push("portfolio_p1c_test_script_missing");
for (const required of [
  "single_player_native_companion",
  "candidate-closure",
  "portfolio-run",
  "candidate_closure",
  "portfolio_run",
  "never launches Stardew",
  "grant a capability",
]) {
  if (!p3.includes(required) && !contractLib.includes(required))
    failures.push(`portfolio_p3_contract_missing:${required}`);
}
for (const required of [
  "candidate closure manifests",
  "candidate and final registry admission",
  "all ten monitors",
  "CCM publication",
  "candidate receipts",
  "candidate closure receipts and Portfolio checkpoints",
  "durable ledger",
  "contract protocol",
]) {
  if (!p3TestSource.includes(required)) failures.push(`portfolio_p3_test_missing:${required}`);
}
if (manifest.scripts?.["test:stardew-portfolio-p3"] !== "node --test tools/stardew-portfolio-contracts.test.mjs")
  failures.push("portfolio_p3_test_script_missing");
if (manifest.scripts?.["check:stardew-portfolio-p3"] !== "node tools/check-stardew-portfolio-p3.mjs")
  failures.push("portfolio_p3_check_script_missing");

if (failures.length > 0) {
  console.error(JSON.stringify({ state: "FAIL", topology: "single_player_native_companion", failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({ state: "PASS", topology: "single_player_native_companion", phase: "P0a_static_isolation_only" }),
  );
}
