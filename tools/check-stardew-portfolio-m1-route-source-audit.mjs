import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  validatePortfolioM1RouteCharterBinding,
  validatePortfolioM1RouteProvenance,
  validatePortfolioM1RouteSourceAudit,
} from "./lib/stardew-portfolio-m1-route-source-audit.mjs";

const root = resolve(".");
const modelPath = resolve(root, "tools/stardew-portfolio-m1-route-source-audit.json");
const scopePath = resolve(root, "design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md");
const provenancePath = resolve(root, "design/13_STARDEW_NATIVE_PROVENANCE.md");
const charterPath = resolve(root, "tools/stardew-portfolio-command-path-charter.json");
const sourceRoot = resolve(root, "ref/external/StardewValleyDecompiled/Stardew Valley");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

try {
  const model = JSON.parse(await readFile(modelPath, "utf8"));
  if (sha256(await readFile(scopePath)) !== model.charterAuthority.scopeDocumentSha256)
    throw Object.assign(new Error("M1 source audit Charter authority hash drifted."), {
      code: "portfolio_m1_source_audit_authority_hash_mismatch",
    });
  const provenance = await readFile(provenancePath, "utf8");
  validatePortfolioM1RouteProvenance(model, provenance);
  validatePortfolioM1RouteCharterBinding(model, JSON.parse(await readFile(charterPath, "utf8")));
  const sourceFiles = Object.fromEntries(
    await Promise.all(
      model.anchors.map(async ({ relativePath }) => {
        const sourcePath = resolve(sourceRoot, relativePath);
        const rel = relative(sourceRoot, sourcePath);
        if (
          rel === "" ||
          rel === ".." ||
          rel.startsWith(`..${sep}`) ||
          rel.startsWith("..") ||
          rel.startsWith("/") ||
          rel.startsWith("\\")
        )
          throw Object.assign(new Error(`M1 source audit anchor escapes source root: ${relativePath}.`), {
            code: "portfolio_m1_source_audit_path_escape",
          });
        return [relativePath, await readFile(sourcePath)];
      }),
    ),
  );
  process.stdout.write(
    `${JSON.stringify({ ...validatePortfolioM1RouteSourceAudit(model, sourceFiles), authorityHashVerified: true, charterBindingVerified: true, provenanceMetadataVerified: true }, null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(`${error.code ?? "portfolio_m1_source_audit_check_failed"}: ${error.message}\n`);
  process.exitCode = 1;
}
