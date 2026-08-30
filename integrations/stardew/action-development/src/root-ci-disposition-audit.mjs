import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_ROOT = path.resolve(PACKAGE_DIRECTORY, "../../..");
const ROOT_WORKFLOW = path.join(REPOSITORY_ROOT, ".github", "workflows", "ci.yml");
const ROOT_PORTFOLIO = path.join(REPOSITORY_ROOT, ".ci", "test-portfolio-manifest.v1.json");
const PACKAGE_PORTFOLIO = path.join(PACKAGE_DIRECTORY, "portfolio.json");
const ROOT_PACKAGE = path.join(REPOSITORY_ROOT, "package.json");

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
]);
const RETIRED_ROOT_PORTFOLIO_ENTRY = "p7-p9-stardew-static-portfolio";
const CANONICAL_PACKAGE_ENTRIES = Object.freeze([
  "equip-tool-contract-check",
  "scaffold-contract",
  "action-surface-check",
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

export async function auditRootStardewCiDisposition() {
  let workflowText;
  let rootPortfolio;
  let packagePortfolio;
  let rootPackage;
  try {
    [workflowText, rootPortfolio, packagePortfolio, rootPackage] = await Promise.all([
      readFile(ROOT_WORKFLOW, "utf8"),
      readFile(ROOT_PORTFOLIO, "utf8").then(JSON.parse),
      readFile(PACKAGE_PORTFOLIO, "utf8").then(JSON.parse),
      readFile(ROOT_PACKAGE, "utf8").then(JSON.parse),
    ]);
  } catch {
    fail("inputs_unreadable");
  }

  const workflowCommandOccurrences = occurrenceCount(workflowText, PACKAGE_WORKFLOW_COMMAND);
  if (workflowCommandOccurrences !== 1) fail("package_workflow_command_not_unique");
  for (const command of RETIRED_WORKFLOW_COMMANDS) {
    if (workflowText.includes(command)) fail(`retired_workflow_command_present:${command}`);
  }
  for (const script of RETIRED_ROOT_SCRIPTS) {
    if (Object.hasOwn(rootPackage.scripts ?? {}, script)) fail(`retired_root_script_present:${script}`);
  }
  for (const command of RETIRED_WORKFLOW_COMMANDS) {
    if (Object.values(rootPackage.scripts ?? {}).some((script) => typeof script === "string" && script.includes(command))) {
      fail(`retired_root_script_reference_present:${command}`);
    }
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
