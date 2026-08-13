import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createCiSnapshot } from "./create-ci-snapshot.mjs";
import { materializeCiSnapshot } from "./materialize-ci-snapshot.mjs";

function fail(code) {
  throw new Error(`ci_snapshot_wrapper_${code}`);
}

function parseOptions(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) fail("usage");
    values.set(key, value);
  }
  const expected = ["--repository", "--snapshot", "--output"];
  if (values.size !== expected.length || expected.some((key) => !values.has(key))) fail("usage");
  if ([...values.keys()].some((key) => !expected.includes(key))) fail("usage");
  return values;
}

function absoluteOption(values, key) {
  const value = values.get(key);
  if (!isAbsolute(value) || value.includes("\0")) fail("path_invalid");
  return resolve(value);
}

function assertOutside(root, candidate, code) {
  const relation = relative(root, candidate);
  if (relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))) fail(code);
}

async function assertNewExternalDirectory(path, code) {
  try {
    await lstat(path);
    fail(code);
  } catch (error) {
    if (error?.message === `ci_snapshot_wrapper_${code}`) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function runCiSnapshot(argv = process.argv.slice(2), environment = process.env) {
  const values = parseOptions(argv);
  if (environment.CI !== undefined && !["1", "true"].includes(environment.CI.toLowerCase()))
    fail("environment_invalid");
  const repository = resolve(absoluteOption(values, "--repository"));
  const snapshot = absoluteOption(values, "--snapshot");
  const output = absoluteOption(values, "--output");
  assertOutside(repository, snapshot, "snapshot_inside_repository");
  assertOutside(repository, output, "output_inside_repository");
  if (snapshot === output) fail("paths_not_distinct");
  await assertNewExternalDirectory(snapshot, "snapshot_exists");
  await assertNewExternalDirectory(output, "output_exists");

  const created = await createCiSnapshot({ root: repository, outputRoot: snapshot });
  if (created.report.unclassified.length !== 0) fail("unclassified_input");
  const materialized = await materializeCiSnapshot({
    sourceRoot: repository,
    snapshotRoot: snapshot,
    repositoryRoot: repository,
    outputRoot: output,
  });
  if (materialized.outputRoot !== output || materialized.staged !== true) fail("materialization_invalid");
  return Object.freeze({
    snapshotRoot: snapshot,
    outputRoot: output,
    sourceDigest: materialized.sourceDigest,
    baseCommit: materialized.baseCommit,
    unclassified: created.report.unclassified,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await runCiSnapshot(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
