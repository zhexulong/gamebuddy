import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REQUIRED_INPUTS = Object.freeze([
  "inputs/devkit/game-action-devkit-0.1.0.tgz",
  "inputs/stardew-contract-export/ActionDevelopmentContractExport.csproj",
  "inputs/stardew-core/GameBuddy.Stardew.Core.csproj",
  "inputs/stardew-core/src/Core",
  "inputs/stardew-scaffold/integrations/stardew/GameBuddy.Stardew.csproj",
  "inputs/stardew-scaffold/integrations/stardew/farmhandexecutioncontroller.cs",
  "inputs/package.json",
  "inputs/global.json",
  "inputs/pnpm-lock.yaml",
]);

function fail(code) {
  throw new Error(`stardew_action_extraction_audit_${code}`);
}

async function requirePackageInput(relativePath) {
  const absolutePath = path.join(PACKAGE_DIRECTORY, ...relativePath.split("/"));
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch {
    fail("input_missing");
  }
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) fail("input_invalid");
  return relativePath;
}

export async function auditStandaloneCoupling() {
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(path.join(PACKAGE_DIRECTORY, "package.json"), "utf8"));
  } catch {
    fail("package_unreadable");
  }
  if (packageJson.dependencies?.["@gamebuddy/game-action-devkit"] !== "file:inputs/devkit/game-action-devkit-0.1.0.tgz") {
    fail("devkit_not_packed");
  }
  if (packageJson.scripts?.["action:ci"] !== "node src/portfolio.mjs --ci") fail("action_ci_missing");

  const inputs = Object.freeze(await Promise.all(REQUIRED_INPUTS.map(requirePackageInput)));
  return Object.freeze({
    schema: "gamebuddy-stardew-extraction-audit/v1",
    status: "standalone-ready",
    rootReadPolicy: "reject-former-monorepo-root",
    inputs,
    blockers: Object.freeze([]),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  auditStandaloneCoupling().then(
    (report) => process.stdout.write(`${JSON.stringify(report)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
