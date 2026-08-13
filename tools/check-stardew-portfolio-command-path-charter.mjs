import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assessPortfolioCommandPathCharter } from "./lib/stardew-portfolio-command-path-charter.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
}

async function main() {
  const modelPath = resolve(option("--model") ?? "tools/stardew-portfolio-command-path-charter.json");
  const model = JSON.parse(await readFile(modelPath, "utf8"));
  const authorityPath = resolve(model.scopeAuthority?.document ?? "");
  const authorityBytes = await readFile(authorityPath);
  const authorityHash = createHash("sha256").update(authorityBytes).digest("hex");
  if (authorityHash !== model.scopeAuthority?.sha256) {
    const error = new Error(
      "Portfolio scope authority hash is stale; update the charter only through an explicit scope revision.",
    );
    error.code = "portfolio_command_path_authority_hash_mismatch";
    throw error;
  }
  const assessment = assessPortfolioCommandPathCharter(model);
  process.stdout.write(`${JSON.stringify(assessment, null, 2)}\n`);
  if (assessment.state === "blocked_pending_source_impact_disposition") process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.code ?? "portfolio_command_path_charter_check_failed"}: ${error.message}\n`);
  process.exitCode = 1;
});
