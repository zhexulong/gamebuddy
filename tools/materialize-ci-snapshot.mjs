import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertCanonicalDirectory,
  assertFrozenSnapshotIndex,
  assertSafeRelativePath,
  assertSnapshotManifest,
  cleanupTransactionalOutput,
  collectUntrackedCandidates,
  commitTransactionalOutput,
  copyVerifiedRequiredInputs,
  createSourceManifest,
  prepareTransactionalOutput,
  readRequiredInputs,
  sha256,
} from "./ci-snapshot-lib.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fail(code) {
  throw new Error(`ci_snapshot_${code}`);
}
function assertOutside(root, candidate, code) {
  const relation = relative(root, candidate);
  if (relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))) fail(code);
}
async function regularFile(path, code) {
  let state;
  try {
    state = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") fail(code);
    throw error;
  }
  if (state.isSymbolicLink() || !state.isFile() || state.nlink !== 1) fail(code);
}
async function git(root, args) {
  return await new Promise((resolveOutput, rejectOutput) => {
    const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", rejectOutput);
    child.once("close", (code) =>
      code === 0
        ? resolveOutput(Buffer.concat(stdout))
        : rejectOutput(new Error(`ci_snapshot_git_${args[0]}_failed:${Buffer.concat(stderr).toString("utf8")}`)),
    );
  });
}
function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}
async function readJsonFile(path, code) {
  await regularFile(path, code);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(code);
  }
}
function parseOptions(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) fail("materialize_usage");
    values.set(key, value);
  }
  if ([...values.keys()].some((key) => key !== "--snapshot" && key !== "--repository" && key !== "--output"))
    fail("materialize_usage");
  return values;
}
async function readSnapshot(snapshotRoot) {
  const manifestPath = resolve(snapshotRoot, "snapshot-manifest.json");
  const patchPath = resolve(snapshotRoot, "tracked.patch");
  const reportPath = resolve(snapshotRoot, "untracked-input-report.json");
  const manifest = assertSnapshotManifest(await readJsonFile(manifestPath, "manifest_invalid"));
  await regularFile(patchPath, "patch_invalid");
  const patch = await readFile(patchPath);
  if (sha256(patch) !== manifest.trackedPatchSha256) fail("patch_digest_mismatch");
  await regularFile(reportPath, "untracked_report_invalid");
  const reportBytes = await readFile(reportPath);
  if (sha256(reportBytes) !== manifest.untrackedReportSha256) fail("untracked_report_digest_mismatch");
  let report;
  try {
    report = JSON.parse(reportBytes);
  } catch {
    fail("untracked_report_invalid");
  }
  if (
    !exactKeys(report, ["excluded", "unclassified", "candidateInventory", "classified"]) ||
    !Array.isArray(report.excluded) ||
    !Array.isArray(report.unclassified) ||
    !Array.isArray(report.candidateInventory) ||
    !Array.isArray(report.classified) ||
    !report.excluded.every((path) => typeof path === "string") ||
    !report.unclassified.every((path) => typeof path === "string") ||
    !report.classified.every(
      (entry) =>
        exactKeys(entry, ["path", "classification", "owner", "purpose", "referenceRequirement"]) &&
        typeof entry.path === "string" &&
        typeof entry.classification === "string" &&
        ["snapshot_control", "snapshot_input", "excluded", "unclassified"].includes(entry.classification) &&
        (entry.owner === null || typeof entry.owner === "string") &&
        (entry.purpose === null || typeof entry.purpose === "string") &&
        typeof entry.referenceRequirement === "string" &&
        entry.referenceRequirement.length > 0,
    )
  )
    fail("untracked_report_invalid");
  const paths = report.classified.map((entry) => entry.path);
  if (
    new Set(paths).size !== paths.length ||
    new Set(paths.map((path) => path.toLocaleLowerCase("en-US"))).size !== paths.length ||
    paths.some((path, index) => index > 0 && path < paths[index - 1]) ||
    !report.classified.every((entry) => {
      try {
        assertSafeRelativePath(entry.path, "untracked_report_invalid");
        return true;
      } catch {
        return false;
      }
    }) ||
    JSON.stringify(report.candidateInventory) !== JSON.stringify(report.classified) ||
    JSON.stringify(report.excluded) !==
      JSON.stringify(
        report.classified.filter((entry) => entry.classification === "excluded").map((entry) => entry.path),
      ) ||
    JSON.stringify(report.unclassified) !==
      JSON.stringify(
        report.classified.filter((entry) => entry.classification === "unclassified").map((entry) => entry.path),
      )
  )
    fail("untracked_report_invalid");
  const reportSnapshotInputs = report.classified.filter((entry) => entry.classification === "snapshot_input");
  const manifestSnapshotInputs = manifest.requiredInputs.map((input) => ({
    path: input.path,
    classification: "snapshot_input",
    owner: input.owner,
    purpose: input.purpose,
    referenceRequirement: input.referenceRequirement,
  }));
  if (
    JSON.stringify(reportSnapshotInputs) !== JSON.stringify(manifestSnapshotInputs) ||
    new Set(reportSnapshotInputs.map((entry) => entry.path)).size !== reportSnapshotInputs.length
  )
    fail("untracked_report_invalid");
  if (report.unclassified.length !== 0) fail("unclassified_input_blocked");
  return Object.freeze({ manifest, patchPath, report });
}

/** Materializes a non-committed frozen index from an exact local Git object store. */
export async function materializeCiSnapshot({
  sourceRoot = defaultRoot,
  snapshotRoot,
  repositoryRoot = sourceRoot,
  outputRoot,
} = {}) {
  if (snapshotRoot === undefined || outputRoot === undefined) fail("materialize_usage");
  const activeRoot = await assertCanonicalDirectory(resolve(sourceRoot), "source_root_invalid");
  const snapshot = await assertCanonicalDirectory(resolve(snapshotRoot), "snapshot_root_invalid");
  const repository = await assertCanonicalDirectory(resolve(repositoryRoot), "repository_root_invalid");
  const output = resolve(outputRoot);
  assertOutside(repository, output, "output_inside_repository");
  assertOutside(activeRoot, output, "output_inside_source");
  assertOutside(snapshot, output, "output_inside_snapshot");

  const { manifest, patchPath, report } = await readSnapshot(snapshot);
  const activeCandidates = await collectUntrackedCandidates(activeRoot, manifest.requiredInputs);
  if (JSON.stringify(activeCandidates) !== JSON.stringify(report.classified))
    fail("untracked_candidate_inventory_mismatch");
  const transaction = await prepareTransactionalOutput(output, "output_root_invalid", { create: false });
  try {
    // The full hash is resolved from this local repository. No remote ref is
    // consulted and clone --no-local prevents accidental local working-tree reuse.
    await git(transaction.parent, ["clone", "--no-local", pathToFileURL(repository).href, transaction.temporary]);
    await git(transaction.temporary, ["checkout", "--detach", manifest.baseCommit]);
    await git(transaction.temporary, ["apply", "--index", "--binary", patchPath]);
    await copyVerifiedRequiredInputs({
      sourceRoot: activeRoot,
      destinationRoot: transaction.temporary,
      inputs: manifest.requiredInputs,
      control: manifest.requiredInputsConfig,
    });
    const copiedInputs = await readRequiredInputs(transaction.temporary);
    if (JSON.stringify(copiedInputs) !== JSON.stringify(manifest.requiredInputs))
      fail("required_inputs_config_mismatch");
    const source = await createSourceManifest(transaction.temporary);
    if (
      source.digest !== manifest.source.digest ||
      JSON.stringify(source.entries) !== JSON.stringify(manifest.source.entries)
    )
      fail("source_manifest_mismatch");
    await git(transaction.temporary, ["add", "-A"]);
    await assertFrozenSnapshotIndex(transaction.temporary);
    await commitTransactionalOutput(transaction);
    return Object.freeze({
      outputRoot: output,
      sourceDigest: source.digest,
      baseCommit: manifest.baseCommit,
      staged: true,
    });
  } catch (error) {
    await cleanupTransactionalOutput(transaction);
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = await materializeCiSnapshot({
      sourceRoot: defaultRoot,
      snapshotRoot: options.get("--snapshot"),
      repositoryRoot: options.get("--repository") ?? defaultRoot,
      outputRoot: options.get("--output"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
