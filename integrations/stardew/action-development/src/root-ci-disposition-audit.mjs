import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_ROOT = path.resolve(PACKAGE_DIRECTORY, "../../..");
const ROOT_WORKFLOW = path.join(REPOSITORY_ROOT, ".github", "workflows", "ci.yml");
const ROOT_PORTFOLIO = path.join(REPOSITORY_ROOT, ".ci", "test-portfolio-manifest.v1.json");
const PACKAGE_PORTFOLIO = path.join(PACKAGE_DIRECTORY, "portfolio.json");
const ROOT_PACKAGE = path.join(REPOSITORY_ROOT, "package.json");
const ACTIVE_REFERENCE_FILES = Object.freeze([
  ".github/workflows/ci.yml",
  "fixtures/stardew/RUNBOOK.md",
  "tools/verify-stardew-action-projection-local.ps1",
  "tools/verify-stardew-action-projection-p2c.ps1",
  "integrations/stardew/action-development/ACTION_RUNBOOK.md",
  "integrations/stardew/action-development/package.json",
  "package.json",
]);
const RETIRED_STATIC_FILES = Object.freeze([
  "tools/verify-stardew-static.mjs",
  "tools/verify-stardew-static.test.mjs",
  "tools/stardew-static-portfolio.v1.json",
]);

const PACKAGE_WORKFLOW_COMMAND = "pnpm --dir integrations/stardew/action-development action:ci";
const RETIRED_WORKFLOW_COMMANDS = Object.freeze([
  "pnpm test:stardew-action-projection",
  "pnpm check:stardew-action-surface",
  "pnpm test:stardew:static",
  "pnpm verify:stardew:static",
  "./tools/verify-stardew-scaffold.ps1",
]);
const RETIRED_ROOT_SCRIPTS = Object.freeze([
  "check:stardew-action-surface",
  "test:stardew-action-projection",
  "test:stardew:static",
  "verify:stardew:static",
  "test:stardew-static-portfolio-projection",
]);
const RETIRED_ROOT_PORTFOLIO_ENTRY = "p7-p9-stardew-static-portfolio";
const CANONICAL_PACKAGE_ENTRIES = Object.freeze([
  "equip-tool-contract-check",
  "scaffold-contract",
  "action-surface-check",
  "action-surface-export-check",
  "action-source-projection-check",
  "static-production-admission",
  "package-deterministic-tests",
]);
const FORBIDDEN_PACKAGE_COMMAND_TEXT = /(?:run-live|stardew-companion-live|target-publication|GAMEBUDDY_STARDEW_GAME_PATH|fixture.*mutation)/i;

function fail(code) {
  throw new Error(`stardew_action_root_ci_disposition_${code}`);
}

function occurrenceCount(text, value) {
  return text.split(value).length - 1;
}

function isStardewRootPortfolioEntry(entry) {
  return /\bstardew\b/i.test(JSON.stringify(entry));
}

function requireFileExists(relativePath) {
  return existsSync(path.join(REPOSITORY_ROOT, relativePath));
}

async function readActiveReferences() {
  return await Promise.all(ACTIVE_REFERENCE_FILES.map(async (relativePath) => [relativePath, await readFile(path.join(REPOSITORY_ROOT, relativePath), "utf8")]));
}

export async function auditRootStardewCiDisposition() {
  let workflowText;
  let rootPortfolio;
  let packagePortfolio;
  let rootPackage;
  let activeReferences;
  try {
    [workflowText, rootPortfolio, packagePortfolio, rootPackage] = await Promise.all([
      readFile(ROOT_WORKFLOW, "utf8"),
      readFile(ROOT_PORTFOLIO, "utf8").then(JSON.parse),
      readFile(PACKAGE_PORTFOLIO, "utf8").then(JSON.parse),
      readFile(ROOT_PACKAGE, "utf8").then(JSON.parse),
    ]);
    activeReferences = await readActiveReferences();
  } catch {
    fail("inputs_unreadable");
  }

  const workflowCommandOccurrences = occurrenceCount(workflowText, PACKAGE_WORKFLOW_COMMAND);
  if (workflowCommandOccurrences !== 1) fail("package_workflow_command_not_unique");
  for (const command of RETIRED_WORKFLOW_COMMANDS) {
    if (activeReferences.some(([, text]) => text.includes(command))) fail(`retired_active_reference_present:${command}`);
  }
  for (const script of RETIRED_ROOT_SCRIPTS) {
    if (Object.hasOwn(rootPackage.scripts ?? {}, script)) fail(`retired_root_script_present:${script}`);
  }
  for (const command of RETIRED_WORKFLOW_COMMANDS) {
    if (Object.values(rootPackage.scripts ?? {}).some((script) => typeof script === "string" && script.includes(command))) {
      fail(`retired_root_script_reference_present:${command}`);
    }
  }
  if (Object.hasOwn(rootPackage.scripts ?? {}, "test:stardew-static-portfolio-projection"))
    fail("retired_static_projection_script_present");
  for (const relativePath of RETIRED_STATIC_FILES) {
    if (requireFileExists(relativePath)) fail(`retired_static_file_present:${relativePath}`);
  }

  const rootPortfolioEntries = rootPortfolio.entries;
  if (!Array.isArray(rootPortfolioEntries)) fail("root_portfolio_entries_invalid");
  const stardewRootPortfolioEntries = rootPortfolioEntries.filter(isStardewRootPortfolioEntry);
  if (stardewRootPortfolioEntries.length > 0) fail("stardew_root_portfolio_entries_present");

  const entryIds = packagePortfolio.entries?.map((entry) => entry?.id);
  if (JSON.stringify(entryIds) !== JSON.stringify(CANONICAL_PACKAGE_ENTRIES)) fail("package_portfolio_entries_invalid");
  if (FORBIDDEN_PACKAGE_COMMAND_TEXT.test(JSON.stringify(packagePortfolio))) fail("package_portfolio_live_or_target_mutation_present");

  return Object.freeze({
    schema: "gamebuddy-stardew-root-ci-disposition-audit/v1",
    status: "package-owned",
    workflowCommand: PACKAGE_WORKFLOW_COMMAND,
    workflowCommandOccurrences,
     rootStardewPortfolioEntryCount: stardewRootPortfolioEntries.length,
     retiredStaticFileCount: RETIRED_STATIC_FILES.length,
     packageEntries: CANONICAL_PACKAGE_ENTRIES,
    retiredRootEdges: Object.freeze([
      ...RETIRED_ROOT_SCRIPTS,
      RETIRED_ROOT_PORTFOLIO_ENTRY,
    ]),
    targetEvidencePolicy: Object.freeze({
      ordinaryCiMissingPublication: "blocked",
      blockedIsTargetPass: false,
      liveOrTargetMutationSelectable: false,
    }),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  auditRootStardewCiDisposition().then(
    (report) => process.stdout.write(`${JSON.stringify(report)}\n`),
    (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; },
  );
}
