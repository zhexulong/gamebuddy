import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { validatePortfolioM3ForageSourceAudit } from "./lib/stardew-portfolio-m3-forage-source-audit.mjs";

const root = resolve(".");
const modelPath = resolve(root, "tools/stardew-portfolio-m3-forage-source-audit.json");
const scopePath = resolve(root, "design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md");
const provenancePath = resolve(root, "design/13_STARDEW_NATIVE_PROVENANCE.md");
const sourceRoot = resolve(root, "ref/external/StardewValleyDecompiled/Stardew Valley");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  const model = JSON.parse(await readFile(modelPath, "utf8"));
  if (sha256(await readFile(scopePath)) !== model.charterAuthority.scopeDocumentSha256)
    throw Object.assign(new Error("M3 source audit Charter authority hash drifted."), {
      code: "portfolio_m3_source_audit_authority_hash_mismatch",
    });
  const provenanceText = await readFile(provenancePath, "utf8");
  for (const expected of [model.auditSource.localSnapshotContentManifestSha256, model.auditSource.targetAssemblySha256])
    if (!provenanceText.includes(expected))
      throw Object.assign(new Error("M3 source audit provenance hash is not recorded in design/13."), {
        code: "portfolio_m3_source_audit_provenance_mismatch",
      });
  const sourceFiles = Object.fromEntries(
    await Promise.all(
      model.anchors.map(async ({ relativePath }) => {
        const sourcePath = resolve(sourceRoot, relativePath);
        const relativeSourcePath = relative(sourceRoot, sourcePath);
        if (
          relativeSourcePath === "" ||
          relativeSourcePath === ".." ||
          relativeSourcePath.startsWith(`..${sep}`) ||
          relativeSourcePath.startsWith("..") ||
          relativeSourcePath.startsWith("/") ||
          relativeSourcePath.startsWith("\\")
        )
          throw Object.assign(new Error(`M3 source audit anchor escapes source root: ${relativePath}.`), {
            code: "portfolio_m3_source_audit_path_escape",
          });
        return [relativePath, await readFile(sourcePath)];
      }),
    ),
  );
  const result = validatePortfolioM3ForageSourceAudit(model, sourceFiles);
  process.stdout.write(
    `${JSON.stringify({ ...result, authorityHashVerified: true, provenanceMetadataVerified: true }, null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(`${error.code ?? "portfolio_m3_source_audit_check_failed"}: ${error.message}\n`);
  process.exitCode = 1;
}
