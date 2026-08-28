import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ACTION_SOURCE_PROJECTION_PRODUCER_DIRECTORY,
  ACTION_SOURCE_SNAPSHOT_RELATIVE_PATH,
} from "../src/action-source-projection-producer.mjs";

const repositoryRoot = path.resolve(ACTION_SOURCE_PROJECTION_PRODUCER_DIRECTORY, "../../../..");
const producerScriptPath = path.join(
  ACTION_SOURCE_PROJECTION_PRODUCER_DIRECTORY,
  "action-source-projection-producer.mjs",
);
const artifactPath = path.join(repositoryRoot, ACTION_SOURCE_SNAPSHOT_RELATIVE_PATH);

/**
 * Spawn the actual-source producer exactly like the release flow does: no
 * arguments, no shell, cwd at the repository root, stdout/stderr captured as
 * raw bytes. The producer must be its own authority: nothing in this test
 * recomputes the projection.
 */
function spawnProducer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [producerScriptPath], {
      cwd: repositoryRoot,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    });
  });
}

test("spawned producer emits the checked artifact byte-for-byte", async () => {
  const { code, signal, stdout, stderr } = await spawnProducer();
  assert.equal(code, 0, "producer must exit zero");
  assert.equal(signal, null, "producer must not be killed by a signal");
  assert.equal(stderr.length, 0, "producer must not write to stderr");

  const artifact = await readFile(artifactPath);
  assert.equal(stdout.length, artifact.length, "spawned stdout length must match the checked artifact");
  assert.equal(
    Buffer.compare(stdout, artifact),
    0,
    "spawned stdout must be byte-identical to the checked artifact",
  );
});

test("spawned producer stdout rejects BOM and newline-policy drift", async () => {
  const { code, signal, stdout, stderr } = await spawnProducer();
  assert.equal(code, 0, "producer must exit zero");
  assert.equal(signal, null, "producer must not be killed by a signal");
  assert.equal(stderr.length, 0, "producer must not write to stderr");

  assert.equal(stdout[0], 0x7b, "stdout must start with '{'");
  assert.equal(stdout[1], 0x0a, "stdout must open with a JSON line terminated by LF");
  assert.ok(
    !(stdout[0] === 0xef && stdout[1] === 0xbb && stdout[2] === 0xbf),
    "stdout must not carry a UTF-8 BOM",
  );
  assert.equal(stdout.includes(0x0d), false, "stdout must be LF-only (no CR bytes)");
  assert.equal(stdout[stdout.length - 1], 0x0a, "stdout must end with a trailing LF");
  assert.notEqual(stdout[stdout.length - 2], 0x0a, "stdout must carry exactly one trailing newline");

  const artifact = await readFile(artifactPath);
  assert.equal(artifact.includes(0x0d), false, "checked artifact must be LF-only (no CR bytes)");
  assert.equal(artifact[artifact.length - 1], 0x0a, "checked artifact must end with a trailing LF");
  assert.notEqual(artifact[artifact.length - 2], 0x0a, "checked artifact must carry exactly one trailing newline");
});