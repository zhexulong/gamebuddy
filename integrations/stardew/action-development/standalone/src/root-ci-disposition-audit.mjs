import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_ROOT = path.resolve(PACKAGE_DIRECTORY, "../../..");
const ROOT_WORKFLOW = path.join(REPOSITORY_ROOT, ".github", "workflows", "ci.yml");
const ROOT_PORTFOLIO = path.join(REPOSITORY_ROOT, ".ci", "test-portfolio-manifest.v1.json");

// Full target verification remains a retained root portfolio edge, but is deliberately
// absent from GitHub's no-target workflow: missing licensed assemblies are blocked
// evidence rather than a passing CI result.
const DIRECT_WORKFLOW_COMMANDS = Object.freeze([
  "pnpm test:stardew-action-projection",
  "pnpm check:stardew-action-surface",
  "pnpm test:stardew:static",
]);
const ROOT_PORTFOLIO_ENTRY = "p7-p9-stardew-static-portfolio";
const PACKAGE_WORKFLOW_COMMAND = "pnpm --dir integrations/stardew/action-development action:ci";

function fail(code) {
  throw new Error(`stardew_action_root_ci_disposition_${code}`);
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === expected.join(",");
}

export async function auditRootStardewCiDisposition() {
  let workflowText;
  let rootPortfolio;
  try {
    [workflowText, rootPortfolio] = await Promise.all([
      readFile(ROOT_WORKFLOW, "utf8"),
      readFile(ROOT_PORTFOLIO, "utf8").then(JSON.parse),
    ]);
  } catch {
    fail("root_inputs_unreadable");
  }

  const missingCommands = DIRECT_WORKFLOW_COMMANDS.filter((command) => !workflowText.includes(command));
  if (missingCommands.length > 0) fail(`workflow_command_missing:${missingCommands.join(",")}`);
  if (!workflowText.includes(PACKAGE_WORKFLOW_COMMAND)) fail("workflow_package_action_ci_missing");
  const portfolioEntry = rootPortfolio.entries?.find((entry) => entry?.id === ROOT_PORTFOLIO_ENTRY);
  if (!exactKeys(portfolioEntry, ["command", "evidenceKind", "id", "liveGate", "owner", "requiredOn", "requires", "retryPolicy", "riskId", "timeoutSeconds", "triggerPaths"]))
    fail("root_portfolio_entry_invalid");

  const blocked = Object.freeze([
    ...DIRECT_WORKFLOW_COMMANDS.map((command) => Object.freeze({
      location: ".github/workflows/ci.yml",
      command,
      disposition: "retain_until_package_parity",
      reason: "standalone action:ci proves only the frozen deterministic closure; current Host/Core codec wire parity and target-assembly/static-verifier checks remain separate root-package evidence",
    })),
    Object.freeze({
      location: ".ci/test-portfolio-manifest.v1.json",
      command: portfolioEntry.command,
      disposition: "retain_until_package_parity",
      reason: "root portfolio static verifier still owns package-unmigrated deterministic leaves and target-assembly blocked-state reporting",
    }),
  ]);

  return Object.freeze({
    schema: "gamebuddy-stardew-root-ci-disposition-audit/v1",
    status: "blocked",
    blocked,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  auditRootStardewCiDisposition().then(
    (report) => process.stdout.write(`${JSON.stringify(report)}\n`),
    (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; },
  );
}
