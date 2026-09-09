import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_ROOT = path.resolve(PACKAGE_DIRECTORY, "../../..");
const CORE_EXPORTER = path.join(REPOSITORY_ROOT, "integrations", "stardew", "tests", "ActionDevelopmentContractExport", "ActionDevelopmentContractExport.csproj");
const CORE_PROJECT = path.join(REPOSITORY_ROOT, "integrations", "stardew", "src", "Core", "GameBuddy.Stardew.Core.csproj");
const CORE_SOURCE_DIRECTORY = path.join(REPOSITORY_ROOT, "integrations", "stardew", "src", "Core");
const DEVKIT_PACKAGE = path.join(REPOSITORY_ROOT, "packages", "game-action-devkit", "package.json");

function fail(code) {
  throw new Error(`stardew_action_extraction_audit_${code}`);
}

async function present(file) {
  try { await access(file); return true; } catch { return false; }
}

export async function auditStandaloneCoupling() {
  let packageJson;
  try { packageJson = JSON.parse(await readFile(path.join(PACKAGE_DIRECTORY, "package.json"), "utf8")); } catch { fail("package_unreadable"); }
  const workspaceDevkit = packageJson.dependencies?.["@gamebuddy/game-action-devkit"] === "workspace:*";
  const items = Object.freeze([
    Object.freeze({ id: "devkit-workspace-link", present: workspaceDevkit && await present(DEVKIT_PACKAGE), reason: "the production package resolves devkit through monorepo workspace:* rather than a packed dependency" }),
    Object.freeze({ id: "stardew-contract-exporter-project", present: await present(CORE_EXPORTER), reason: "equip_tool contract drift check executes this Stardew-owned exporter project outside action-development/" }),
    Object.freeze({ id: "stardew-core-source-closure", present: await present(CORE_PROJECT) && await present(CORE_SOURCE_DIRECTORY), reason: "the exporter ProjectReference targets GameBuddy.Stardew.Core; SDK default compile items require the Stardew-owned src/Core/** closure, not just the exporter project" }),
  ]);
  const blockers = Object.freeze(items.filter((item) => item.present));
  return Object.freeze({
    schema: "gamebuddy-stardew-extraction-audit/v1",
    status: blockers.length === 0 ? "standalone-ready" : "blocked",
    blockers,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  auditStandaloneCoupling().then((report) => process.stdout.write(`${JSON.stringify(report)}\n`), (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
