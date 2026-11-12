// red-proof: fixture  one byte changed in an input the artifact's manifest records, in a copy of the tree ->
//   `perf_budget_not_measured:artifact_stale:artifact_content_mismatch:<the input>` naming its mtime, the artifact's
//   build stamp and `worktree=modified`, exit 1 (tools/perf/artifact-readiness.test.mjs)
/**
 * What the perf gate says when it cannot measure at all.
 *
 * The fixture is a whole tree in a temp directory: the Host inputs the build manifest walks, an emitted module, and a
 * manifest written by the build's own writer - so the freshness authority decides this test the way it decides a real
 * `host/dist-test`, and nothing here re-implements the rule it is checking. Editing an input then has to produce a
 * reading that names the file, its modification time, the stamp the artifact was built at and whether the file is
 * dirty, because those four facts are the difference between "rebuild" and "another lane is mid-flight".
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { writeTestArtifactBuildManifest } from "../../host/scripts/test-artifact-build-manifest.mjs";
import { assessBenchmarkArtifact, describeArtifactStaleness, worktreeState } from "./artifact-readiness.mjs";

/** The stamp the artifact is built at, so the assertion can name it rather than a clock reading. */
const BUILT_AT_MS = Date.UTC(2026, 10, 12, 12, 46, 19, 233);

/** Every input the build walks, so the manifest this test writes covers a tree the check can walk too. */
const TREE = Object.freeze({
  "host/package.json": '{ "name": "fixture-host" }\n',
  "host/tsconfig.json": '{ "compilerOptions": {} }\n',
  "host/tsconfig.test.json": '{ "extends": "./tsconfig.json" }\n',
  "host/resources/windows-named-mutex-broker.ps1": "Write-Output 'broker'\n",
  "host/src/test-fixtures/windows-named-mutex-abandon-child.ps1": "Write-Output 'child'\n",
  "host/src/test-fixtures/windows-named-mutex-broker-test-sidecar.ps1": "Write-Output 'sidecar'\n",
  "host/src/test-fixtures/windows-named-mutex-retained-abandon.ps1": "Write-Output 'retained'\n",
  "host/src/protocol.ts": "export const protocol = 'the bytes the artifact was built from';\n",
  "host/src/run-trace.ts": "export const trace = 'a second measured input';\n",
});

const git = (root, ...args) =>
  execFileSync("git", ["-c", "user.name=perf fixture", "-c", "user.email=perf@example.invalid", ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** A tree whose artifact matches its sources, committed so that "dirty" is a real distinction and not a guess. */
async function committedTree(root) {
  for (const [path, content] of Object.entries(TREE)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const outputRoot = join(root, "host", "dist-test");
  await mkdir(outputRoot, { recursive: true });
  await writeTestArtifactBuildManifest({ repositoryRoot: root, outputRoot, builtAtMs: BUILT_AT_MS });
  await writeFile(join(outputRoot, "protocol.js"), "export const protocol = 'emitted';\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "the tree the artifact was built from");
}

const lineWith = (lines, pattern) => lines.find((line) => pattern.test(line));

test("a tree whose artifact matches its sources is ready to measure", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-perf-artifact-"));
  try {
    await committedTree(root);
    const readiness = await assessBenchmarkArtifact({ root, benchFiles: 6 });
    assert.equal(readiness.ready, true);
    assert.equal(readiness.verdict.stale, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale artifact names the input, its mtime, the build stamp and that the input is dirty", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-perf-stale-"));
  try {
    await committedTree(root);
    await writeFile(
      join(root, "host", "src", "protocol.ts"),
      "export const protocol = 'another lane is mid-flight';\n",
    );
    await writeFile(join(root, "host", "src", "run-trace.ts"), "export const trace = 'and a second one';\n");
    const mtimeMs = statSync(join(root, "host", "src", "protocol.ts")).mtimeMs;

    const readiness = await assessBenchmarkArtifact({ root, benchFiles: 6 });
    assert.equal(readiness.ready, false);
    // The population it never measured, beside the reason and the file the reason is about.
    assert.equal(
      readiness.lines[0],
      "perf_budget_not_measured:artifact_stale:artifact_content_mismatch:host/src/protocol.ts compared=0 benchFiles=6",
    );
    assert.match(
      lineWith(readiness.lines, /^ {2}input /u),
      new RegExp(`^ {2}input host/src/protocol.ts mtime=${new Date(mtimeMs).toISOString()} worktree=modified: `, "u"),
    );
    assert.match(
      lineWith(readiness.lines, /^ {2}artifact /u),
      new RegExp(
        `^ {2}artifact host/dist-test/build-manifest.json built=${new Date(BUILT_AT_MS).toISOString()} inputs=9$`,
        "u",
      ),
    );
    // Never a rebuild: the gate states the staleness and stops.
    assert.match(lineWith(readiness.lines, /never rebuilds/u), /the tree is yours: cd host && pnpm build:test/u);
    // The second drifting input is named with its own state, so a lane can see the whole set it is waiting on.
    assert.match(lineWith(readiness.lines, /^ {2}drift /u), /artifact_content_mismatch:host\/src\/run-trace\.ts/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an input that matches HEAD reads as an old artifact, not as a lane mid-flight", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-perf-committed-"));
  try {
    await committedTree(root);
    // The source change is committed, so nothing is dirty: the artifact is simply older than the committed tree.
    await writeFile(join(root, "host", "src", "protocol.ts"), "export const protocol = 'a committed change';\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "a source change the artifact does not describe");

    const readiness = await assessBenchmarkArtifact({ root, benchFiles: 6 });
    assert.equal(readiness.ready, false);
    assert.match(
      lineWith(readiness.lines, /^ {2}input /u),
      /worktree=clean: it matches HEAD, so the artifact is simply older/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a tree with no Host sources has nothing to be stale", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-perf-nohost-"));
  try {
    const readiness = await assessBenchmarkArtifact({ root, benchFiles: 6 });
    assert.equal(readiness.ready, true);
    assert.equal(readiness.verdict.reason, "no_source_root");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a tree git cannot place is reported as unknown rather than guessed clean", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-perf-nogit-"));
  try {
    await writeFile(join(root, "input.ts"), "export const value = 1;\n");
    assert.equal(worktreeState(root, "input.ts"), "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the reading says which lines belong to the freshness authority and which to this gate", () => {
  // Two rules share one message: the authority's own sentence is carried through unchanged, never re-worded here.
  const lines = describeArtifactStaleness({
    verdict: { reason: "artifact_missing", detail: "host/dist-test does not exist" },
    manifest: undefined,
    inspections: [],
    benchFiles: 6,
  });
  assert.equal(lines[0], "perf_budget_not_measured:artifact_stale:artifact_missing compared=0 benchFiles=6");
  assert.equal(lines[1], "  host/dist-test does not exist");
  assert.match(lineWith(lines, /^ {2}artifact /u), /is absent, so freshness falls back to modification times$/u);
});
