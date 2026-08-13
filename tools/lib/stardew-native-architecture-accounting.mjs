import { createHash } from "node:crypto";

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function assertNormalizedPath(value, kind) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail("architecture_path_invalid", `Invalid ${kind} path.`, { value });
  }
}

function sourceOwnerCluster(relativePath) {
  assertNormalizedPath(relativePath, "source");
  const parts = relativePath.split("/");
  if (parts[0] === "StardewValley") return `source-owner:${parts.slice(0, Math.min(parts.length, 2)).join("/")}`;
  return `supporting-owner:${parts.slice(0, Math.min(parts.length, 2)).join("/")}`;
}

function contentOwnerCluster(relativePath) {
  assertNormalizedPath(relativePath, "content");
  return `content-owner:${relativePath.split("/")[0]}`;
}

export function accountExactPaths({ paths, ownerForPath, kind }) {
  if (!Array.isArray(paths) || paths.length === 0) fail("architecture_paths_empty", `No ${kind} paths were supplied.`);
  for (const relativePath of paths) assertNormalizedPath(relativePath, kind);
  const normalized = [...paths].sort((left, right) => left.localeCompare(right));
  if (new Set(normalized.map((value) => value.toLowerCase())).size !== normalized.length) {
    fail("architecture_paths_not_unique", `${kind} paths are not unique under case-insensitive comparison.`);
  }
  const rows = normalized.map((relativePath) =>
    Object.freeze({ relativePath, ownerCluster: ownerForPath(relativePath) }),
  );
  if (rows.some((row) => !row.ownerCluster))
    fail("architecture_path_unaccounted", `An input ${kind} path has no ownership cluster.`);
  const clusters = new Map();
  for (const row of rows) clusters.set(row.ownerCluster, (clusters.get(row.ownerCluster) ?? 0) + 1);
  return Object.freeze({
    rows: Object.freeze(rows),
    clusters: Object.freeze(
      [...clusters]
        .map(([ownerCluster, pathCount]) => Object.freeze({ ownerCluster, pathCount }))
        .sort((a, b) => a.ownerCluster.localeCompare(b.ownerCluster)),
    ),
    unaccountedPathCount: 0,
    multiplyAccountedPathCount: 0,
  });
}

function indexSources(sourceRecords) {
  const paths = new Map();
  for (const source of sourceRecords) {
    assertNormalizedPath(source.relativePath, "source");
    if (paths.has(source.relativePath))
      fail("architecture_source_duplicate", "Duplicate source record.", { relativePath: source.relativePath });
    paths.set(source.relativePath, source);
  }
  return paths;
}

function assertAnchoredRecord(record, sourceByPath, kind) {
  if (!record?.id || !record?.family || !record?.sourcePath || !record?.anchor)
    fail("architecture_register_invalid", `Invalid ${kind} register row.`, { record });
  const source = sourceByPath.get(record.sourcePath);
  if (!source)
    fail("architecture_register_source_missing", `${kind} source is outside the attested source universe.`, {
      id: record.id,
      sourcePath: record.sourcePath,
    });
  if (!source.text.includes(record.anchor))
    fail("architecture_register_anchor_missing", `${kind} anchor was not found in the exact target source.`, {
      id: record.id,
      sourcePath: record.sourcePath,
      anchor: record.anchor,
    });
  return Object.freeze({
    id: record.id,
    family: record.family,
    sourcePath: record.sourcePath,
    ownerCluster: sourceOwnerCluster(record.sourcePath),
    anchorSha256: sha256Text(record.anchor),
  });
}

export function deriveArchitectureAccounting({
  sourceRecords,
  contentPaths,
  rootRegister,
  boundaryRegister,
  requiredRootFamilies,
}) {
  if (!Array.isArray(rootRegister) || !Array.isArray(boundaryRegister) || !Array.isArray(requiredRootFamilies))
    fail("architecture_register_required", "Architecture registers and required root families must be arrays.");
  const sourceByPath = indexSources(sourceRecords);
  const sourceAccounting = accountExactPaths({
    paths: [...sourceByPath.keys()],
    ownerForPath: sourceOwnerCluster,
    kind: "source",
  });
  const contentAccounting = accountExactPaths({
    paths: contentPaths,
    ownerForPath: contentOwnerCluster,
    kind: "content",
  });
  const roots = rootRegister.map((record) => assertAnchoredRecord(record, sourceByPath, "root"));
  const boundaries = boundaryRegister.map((record) => assertAnchoredRecord(record, sourceByPath, "boundary"));
  if (
    new Set(roots.map((root) => root.id)).size !== roots.length ||
    new Set(boundaries.map((boundary) => boundary.id)).size !== boundaries.length
  )
    fail("architecture_register_duplicate", "Root or boundary IDs must be unique.");
  const rootFamilies = new Set(roots.map((root) => root.family));
  const missingRootFamilies = requiredRootFamilies.filter((family) => !rootFamilies.has(family));
  if (missingRootFamilies.length > 0)
    fail("architecture_root_family_missing", "The architecture root register is missing a required family.", {
      missingRootFamilies,
    });
  return Object.freeze({
    sourceAccounting,
    contentAccounting,
    rootRegister: Object.freeze(roots),
    boundaryRegister: Object.freeze(boundaries),
    missingRootFamilies: Object.freeze(missingRootFamilies),
    inputAccountingState: "source_and_content_input_accounting_complete",
    architectureAccountingState: "incomplete_pending_exhaustive_root_and_handoff_review",
  });
}
