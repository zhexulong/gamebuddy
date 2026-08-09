#!/usr/bin/env node
/**
 * Deterministic Phase 3 guard. This checks that the Portfolio contract seam is
 * present and remains schema/ledger-only. It never launches Stardew, grants a
 * capability, writes live evidence, or promotes a candidate into publication.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const contractPath = resolve(root, "tools/lib/stardew-portfolio-contracts.mjs");
const contractTestPath = resolve(root, "tools/stardew-portfolio-contracts.test.mjs");
const packagePath = resolve(root, "package.json");
const [contract, contractTest, packageSource] = await Promise.all([
  readFile(contractPath, "utf8"),
  readFile(contractTestPath, "utf8"),
  readFile(packagePath, "utf8"),
]);
const failures = [];
const required = [
  'PORTFOLIO_TOPOLOGY',
  'candidate_closure',
  'portfolio_run',
  'candidate-closure',
  'portfolio-run',
  'PORTFOLIO_MILESTONE_MONITORS',
  'validateCandidateClosureManifest',
  'validatePortfolioDsm',
  'validatePortfolioCcm',
  'validatePortfolioReceipt',
  'validatePortfolioCheckpoint',
  'admitCandidateRegistry',
  'admitCandidateClosureReceipt',
  'admitPortfolioRegistry',
  'admitPortfolioCheckpoint',
  'admitPortfolioMonitorReceipt',
  'createPortfolioExecutionLedger',
  'never launches Stardew',
  'grant a capability',
];
for (const marker of required) if (!contract.includes(marker)) failures.push(`portfolio_p3_contract_missing:${marker}`);
for (const forbidden of ["local-stardew-bridge", "portfolio-stardew-bridge", "action-registry", "SaveGame.Load", "Game1.player", "spawn", "publishCapability"]) {
  if (contract.includes(forbidden)) failures.push(`portfolio_p3_runtime_dependency:${forbidden}`);
}
for (const marker of [
  "candidate closure manifests",
  "all ten monitors",
  "CCM publication",
  "candidate receipts",
  "candidate and final registry admission",
  "candidate closure receipts and Portfolio checkpoints",
  "durable ledger",
  "contract protocol",
]) if (!contractTest.includes(marker)) failures.push(`portfolio_p3_test_missing:${marker}`);
if (!packageSource.includes('"test:stardew-portfolio-p3": "node --test tools/stardew-portfolio-contracts.test.mjs"')) failures.push("portfolio_p3_test_script_missing");
if (!packageSource.includes('"check:stardew-portfolio-p3": "node tools/check-stardew-portfolio-p3.mjs"')) failures.push("portfolio_p3_check_script_missing");

if (failures.length > 0) {
  console.error(JSON.stringify({ state: "FAIL", topology: "single_player_native_companion", phase: "P3_contract_schema_and_ledger_only", failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ state: "PASS", topology: "single_player_native_companion", phase: "P3_contract_schema_and_ledger_only", live: "BLOCKED", publish: "BLOCKED" }));
}
