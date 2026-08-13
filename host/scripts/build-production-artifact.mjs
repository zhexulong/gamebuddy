import { lstat, readFile, realpath, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { publishProductionArtifact } from "./production-artifact.mjs";
import { runBoundedChild } from "./test-supervisor.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const hostRoot = resolve(dirname(scriptPath), "..");
const repositoryRoot = resolve(hostRoot, "..");
const magicContextPackage = "@cortexkit/pi-magic-context";
const magicContextSourceRoot = resolve(repositoryRoot, "vendor", "magic-context", "packages", "pi-plugin");
const magicContextSourceEntry = resolve(magicContextSourceRoot, "dist", "index.js");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function isContained(root, path) {
  const remainder = relative(root, path);
  return remainder !== "" && !isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`);
}

/**
 * Verify that the declared local Magic Context package resolves to the freshly
 * built, approved plugin artifact.  The package remains a normal Host
 * dependency; this check refuses stale pnpm file-package copies rather than
 * falling back to a vendor source path at runtime.
 */
export async function verifyDeclaredMagicContextArtifact({
  root = hostRoot,
  sourceEntry = magicContextSourceEntry,
} = {}) {
  let resolvedEntry;
  try {
    // This module resides under host/scripts, so resolution is anchored to the
    // declared Host dependency rather than the caller's cwd or user state.
    resolvedEntry = fileURLToPath(import.meta.resolve(magicContextPackage));
  } catch (error) {
    throw new Error("magic_context_declared_package_unresolvable", { cause: error });
  }
  const resolvedRoot = resolve(root);
  const declaredPackagePath = resolve(resolvedRoot, "node_modules", "@cortexkit", "pi-magic-context");
  let declaredPackageRoot;
  let canonicalResolvedEntry;
  let sourceState;
  let resolvedState;
  try {
    [declaredPackageRoot, canonicalResolvedEntry, sourceState, resolvedState] = await Promise.all([
      realpath(declaredPackagePath),
      realpath(resolvedEntry),
      stat(sourceEntry),
      stat(resolvedEntry),
    ]);
  } catch (error) {
    throw new Error("magic_context_declared_package_artifact_missing", { cause: error });
  }
  if (
    !isContained(declaredPackageRoot, canonicalResolvedEntry) ||
    relative(declaredPackageRoot, canonicalResolvedEntry) !== `dist${sep}index.js`
  ) throw new Error("magic_context_declared_package_entry_invalid");
  if (!sourceState.isFile() || !resolvedState.isFile()) throw new Error("magic_context_declared_package_artifact_invalid");
  const [source, resolved] = await Promise.all([readFile(sourceEntry), readFile(resolvedEntry)]);
  const sourceSha256 = sha256(source);
  const resolvedSha256 = sha256(resolved);
  if (sourceSha256 !== resolvedSha256) throw new Error("magic_context_declared_package_artifact_stale");
  return Object.freeze({ entry: resolvedEntry, sha256: resolvedSha256 });
}

/** Resolve the repository's TypeScript entry without a shell wrapper. */
export async function resolveTypeScriptInvocation({ root = hostRoot, project }) {
  if (typeof project !== "string" || project.length === 0 || project.includes("\0")) {
    throw new Error("invalid_typescript_project");
  }
  const resolvedRoot = resolve(root);
  const repositoryRoot = resolve(resolvedRoot, "..");
  const projectPath = resolve(resolvedRoot, project);
  if (!isContained(resolvedRoot, projectPath)) throw new Error("typescript_project_outside_host_root");
  let projectDetails;
  try {
    projectDetails = await lstat(projectPath);
  } catch (error) {
    throw new Error("typescript_project_missing", { cause: error });
  }
  if (projectDetails.isSymbolicLink() || !projectDetails.isFile()) throw new Error("typescript_project_not_regular_file");
  const tscPath = resolve(resolvedRoot, "node_modules", "typescript", "lib", "tsc.js");
  if (!isContained(resolvedRoot, tscPath)) throw new Error("typescript_entry_outside_host_root");
  let details;
  try {
    details = await lstat(tscPath);
  } catch (error) {
    throw new Error("typescript_entry_missing", { cause: error });
  }
  if (details.isSymbolicLink() || !details.isFile()) throw new Error("typescript_entry_not_regular_file");
  let canonicalPath;
  try {
    canonicalPath = await realpath(tscPath);
  } catch (error) {
    throw new Error("typescript_entry_unresolvable", { cause: error });
  }
  if (!isContained(repositoryRoot, canonicalPath)) throw new Error("typescript_entry_escapes_repository_root");
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([canonicalPath, "--project", project]),
    cwd: resolvedRoot,
  });
}

async function main() {
  const stagingRoot = resolve(hostRoot, `.dist-production-emitted-${process.pid}-${randomUUID()}`);
  const outputRoot = resolve(hostRoot, "dist");
  await rm(stagingRoot, { recursive: true, force: true });
  try {
    // A source build alone is insufficient: pnpm's file-package virtual store
    // can retain an older artifact. Refuse publication until the declared Host
    // dependency resolves to the exact reviewed plugin output.
    await verifyDeclaredMagicContextArtifact();
    // Compile into a per-run private directory. The configured emit root remains
    // untouched until successful publication so an unsuccessful build cannot
    // erase a concurrent verifier's input.
    const invocation = await resolveTypeScriptInvocation({ project: "tsconfig.production.json" });
    await runBoundedChild({ ...invocation, args: [...invocation.args, "--outDir", stagingRoot] });
    await lstat(stagingRoot);
    await publishProductionArtifact({ hostRoot, emittedRoot: stagingRoot, outputRoot });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === scriptPath) await main();
