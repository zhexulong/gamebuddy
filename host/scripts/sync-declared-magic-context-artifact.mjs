import { cp, lstat, realpath, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(hostRoot, "..");
const repositoryNodeModulesRoot = resolve(repositoryRoot, "node_modules");
const sourceDist = resolve(repositoryRoot, "vendor", "magic-context", "packages", "pi-plugin", "dist");
const declaredPackagePath = resolve(hostRoot, "node_modules", "@cortexkit", "pi-magic-context");

function isContained(root, path) {
  const remainder = relative(root, path);
  return remainder !== "" && !remainder.startsWith(`..${sep}`) && remainder !== "..";
}

async function main() {
  const [sourceInfo, declaredPackageRoot] = await Promise.all([
    lstat(sourceDist),
    realpath(declaredPackagePath),
  ]);
  if (!sourceInfo.isDirectory()) throw new Error("magic_context_source_artifact_missing");
  if (!isContained(repositoryNodeModulesRoot, declaredPackageRoot))
    throw new Error("magic_context_declared_package_outside_repository_node_modules");
  const targetDist = resolve(declaredPackageRoot, "dist");
  if (!isContained(declaredPackageRoot, targetDist)) throw new Error("magic_context_declared_artifact_target_invalid");
  await rm(targetDist, { recursive: true, force: true });
  await cp(sourceDist, targetDist, { recursive: true, force: true, verbatimSymlinks: true });
}

await main();
