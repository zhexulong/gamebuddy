import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCanonicalDirectory,
  cleanupTransactionalOutput,
  collectUntrackedCandidates,
  commitTransactionalOutput,
  createSourceManifest,
  prepareTransactionalOutput,
  readRequiredInputs,
  SNAPSHOT_SCHEMA,
  sha256,
  writeSnapshotManifest,
} from "./ci-snapshot-lib.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fail(code) {
  throw new Error(`ci_snapshot_${code}`);
}
function outside(root, candidate, code) {
  const relation = relative(root, candidate);
  if (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`)) fail(code);
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
function parseOptions(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) fail("create_usage");
    values.set(key, value);
  }
  if ([...values.keys()].some((key) => key !== "--root" && key !== "--output")) fail("create_usage");
  return values;
}
async function untrackedReport(root, inputs) {
  const classified = await collectUntrackedCandidates(root, inputs);
  return Object.freeze({
    excluded: classified.filter((entry) => entry.classification === "excluded").map((entry) => entry.path),
    unclassified: classified.filter((entry) => entry.classification === "unclassified").map((entry) => entry.path),
    candidateInventory: classified,
    classified,
  });
}

/** Creates a transportable, uncommitted snapshot. It never modifies the active index. */
export async function createCiSnapshot({ root = defaultRoot, outputRoot } = {}) {
  const sourceRoot = await assertCanonicalDirectory(resolve(root), "source_root_invalid");
  if (outputRoot === undefined) fail("create_usage");
  const destination = resolve(outputRoot);
  outside(sourceRoot, destination, "output_inside_source");
  const transaction = await prepareTransactionalOutput(destination, "output_root_invalid");
  try {
    const inputs = await readRequiredInputs(sourceRoot);
    const source = await createSourceManifest(sourceRoot);
    const baseCommit = (await git(sourceRoot, ["rev-parse", "HEAD"])).toString("utf8").trim();
    if (!/^[0-9a-f]{40}$/.test(baseCommit)) fail("base_commit_invalid");
    const patch = await git(sourceRoot, ["diff", "--binary", "HEAD"]);
    const patchPath = resolve(transaction.temporary, "tracked.patch");
    await writeFile(patchPath, patch, { mode: 0o600, flag: "wx" });
    const report = await untrackedReport(sourceRoot, inputs);
    const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    const manifest = Object.freeze({
      schema: SNAPSHOT_SCHEMA,
      baseCommit,
      trackedPatchSha256: sha256(patch),
      untrackedReportSha256: sha256(reportBytes),
      requiredInputsConfig: source.requiredInputsConfig,
      requiredInputs: inputs,
      source: Object.freeze({ digest: source.digest, entries: source.entries }),
    });
    await writeSnapshotManifest(resolve(transaction.temporary, "snapshot-manifest.json"), manifest);
    await writeFile(resolve(transaction.temporary, "untracked-input-report.json"), reportBytes, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await commitTransactionalOutput(transaction);
    return Object.freeze({
      manifest,
      report,
      outputRoot: destination,
      patchPath: resolve(destination, "tracked.patch"),
    });
  } catch (error) {
    await cleanupTransactionalOutput(transaction);
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = await createCiSnapshot({
      root: options.get("--root") ?? defaultRoot,
      outputRoot: options.get("--output"),
    });
    process.stdout.write(
      `${JSON.stringify({ outputRoot: result.outputRoot, sourceDigest: result.manifest.source.digest, baseCommit: result.manifest.baseCommit, unclassified: result.report.unclassified }, null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
