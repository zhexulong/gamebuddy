import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { validatePortfolioM10MuseumSourceAudit } from "./lib/stardew-portfolio-m10-museum-source-audit.mjs";
const root = resolve("."),
  modelPath = resolve(root, "tools/stardew-portfolio-m10-museum-source-audit.json"),
  scopePath = resolve(root, "design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md"),
  provenancePath = resolve(root, "design/13_STARDEW_NATIVE_PROVENANCE.md"),
  sourceRoot = resolve(root, "ref/external/StardewValleyDecompiled/Stardew Valley"),
  sha = (b) => createHash("sha256").update(b).digest("hex");
try {
  const m = JSON.parse(await readFile(modelPath, "utf8"));
  if (sha(await readFile(scopePath)) !== m.charterAuthority.scopeDocumentSha256)
    throw Object.assign(new Error("M10 source audit Charter authority hash drifted."), {
      code: "portfolio_m10_source_audit_authority_hash_mismatch",
    });
  const p = await readFile(provenancePath, "utf8");
  for (const x of [m.auditSource.localSnapshotContentManifestSha256, m.auditSource.targetAssemblySha256])
    if (!p.includes(x))
      throw Object.assign(new Error("M10 source audit provenance hash is not recorded in design/13."), {
        code: "portfolio_m10_source_audit_provenance_mismatch",
      });
  const files = Object.fromEntries(
    await Promise.all(
      m.anchors.map(async ({ relativePath }) => {
        const path = resolve(sourceRoot, relativePath),
          r = relative(sourceRoot, path);
        if (
          r === "" ||
          r === ".." ||
          r.startsWith(`..${sep}`) ||
          r.startsWith("..") ||
          r.startsWith("/") ||
          r.startsWith("\\")
        )
          throw Object.assign(new Error(`M10 source audit anchor escapes source root: ${relativePath}.`), {
            code: "portfolio_m10_source_audit_path_escape",
          });
        return [relativePath, await readFile(path)];
      }),
    ),
  );
  process.stdout.write(
    `${JSON.stringify({ ...validatePortfolioM10MuseumSourceAudit(m, files), authorityHashVerified: true, provenanceMetadataVerified: true }, null, 2)}\n`,
  );
} catch (e) {
  process.stderr.write(`${e.code ?? "portfolio_m10_source_audit_check_failed"}: ${e.message}\n`);
  process.exitCode = 1;
}
