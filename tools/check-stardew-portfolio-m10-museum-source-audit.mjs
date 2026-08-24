import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertContainedNoReparse,
  readContainedFile,
} from "./lib/stardew-portfolio-m10-donate-museum-source-boundary.mjs";
import { validatePortfolioM10MuseumSourceAudit } from "./lib/stardew-portfolio-m10-museum-source-audit.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function strictRelativePath(relativePath, name) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    relativePath.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail(
      `M10 source audit ${name} is not a strict relative path: ${relativePath}.`,
      "portfolio_m10_source_audit_path_escape",
    );
  return relativePath;
}

export async function checkPortfolioM10MuseumSourceAudit({
  repoRoot = resolve("."),
  modelPath = "tools/stardew-portfolio-m10-museum-source-audit.json",
  scopePath = "design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md",
  provenancePath = "design/13_STARDEW_NATIVE_PROVENANCE.md",
  sourceRoot = "ref/external/StardewValleyDecompiled/Stardew Valley",
} = {}) {
  const root = resolve(repoRoot);
  for (const [name, relativePath] of Object.entries({ modelPath, scopePath, provenancePath, sourceRoot }))
    strictRelativePath(relativePath, name);
  const modelCandidate = resolve(root, modelPath);
  const scopeCandidate = resolve(root, scopePath);
  const provenanceCandidate = resolve(root, provenancePath);
  const sourceCandidate = resolve(root, sourceRoot);
  await assertContainedNoReparse(root, sourceCandidate, {
    missingCode: "portfolio_m10_source_audit_source_root_missing",
    reparseCode: "portfolio_m10_source_audit_reparse_detected",
  });
  const readInput = (candidate, options) => readContainedFile(root, candidate, options);
  const model = JSON.parse(
    (
      await readInput(modelCandidate, {
        missingCode: "portfolio_m10_source_audit_model_missing",
        reparseCode: "portfolio_m10_source_audit_reparse_detected",
      })
    ).toString("utf8"),
  );
  if (
    sha(
      await readInput(scopeCandidate, {
        missingCode: "portfolio_m10_source_audit_scope_missing",
        reparseCode: "portfolio_m10_source_audit_reparse_detected",
      }),
    ) !== model.charterAuthority.scopeDocumentSha256
  )
    fail("M10 source audit Charter authority hash drifted.", "portfolio_m10_source_audit_authority_hash_mismatch");
  const provenance = (
    await readInput(provenanceCandidate, {
      missingCode: "portfolio_m10_source_audit_provenance_missing",
      reparseCode: "portfolio_m10_source_audit_reparse_detected",
    })
  ).toString("utf8");
  for (const value of [model.auditSource.localSnapshotContentManifestSha256, model.auditSource.targetAssemblySha256])
    if (!provenance.includes(value))
      fail(
        "M10 source audit provenance hash is not recorded in design/13.",
        "portfolio_m10_source_audit_provenance_mismatch",
      );
  const files = Object.fromEntries(
    await Promise.all(
      model.anchors.map(async ({ relativePath }) => {
        const safeRelativePath = strictRelativePath(relativePath, "anchor relativePath");
        const candidate = resolve(sourceCandidate, safeRelativePath);
        const relation = relativePathFor(sourceCandidate, candidate);
        if (
          relation === "" ||
          relation === ".." ||
          relation.startsWith(`..${sep}`) ||
          relation.startsWith("..") ||
          relation.startsWith("/") ||
          relation.startsWith("\\")
        )
          fail(
            `M10 source audit anchor escapes source root: ${relativePath}.`,
            "portfolio_m10_source_audit_path_escape",
          );
        return [
          relativePath,
          await readInput(candidate, {
            missingCode: "portfolio_m10_source_audit_anchor_missing",
            reparseCode: "portfolio_m10_source_audit_reparse_detected",
          }),
        ];
      }),
    ),
  );
  return {
    ...validatePortfolioM10MuseumSourceAudit(model, files),
    authorityHashVerified: true,
    provenanceMetadataVerified: true,
  };
}

function relativePathFor(root, candidate) {
  return resolve(candidate)
    .slice(resolve(root).length)
    .replace(/^[/\\]+/, "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(await checkPortfolioM10MuseumSourceAudit(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code ?? "portfolio_m10_source_audit_check_failed"}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
