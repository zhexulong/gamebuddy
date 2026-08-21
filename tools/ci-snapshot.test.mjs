import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import nodeTest from "node:test";
import { promisify } from "node:util";
import {
  cleanupTransactionalOutput,
  commitTransactionalOutput,
  prepareTransactionalOutput,
  REQUIRED_INPUTS_PATH,
  REQUIRED_INPUTS_SCHEMA,
  sha256,
} from "./ci-snapshot-lib.mjs";
import { createCiSnapshot } from "./create-ci-snapshot.mjs";
import { materializeCiSnapshot } from "./materialize-ci-snapshot.mjs";
import { runCiSnapshot } from "./run-ci-snapshot.mjs";

const execFile = promisify(execFileCallback);
// Transactional directory finalization is intentionally Windows-only: Node's
// POSIX rename can replace a competing empty destination. Keep the rest of
// this behavior suite visible on the supported platform while the explicit
// unsupported-platform test below remains active everywhere.
const test = (name, ...args) =>
  process.platform === "win32" ||
  name === "fails closed when a competing destination appears before transactional commit"
    ? nodeTest(name, ...args)
    : nodeTest(name, { skip: "transactional snapshot output is unsupported on non-Windows" }, ...args);
async function git(root, args) {
  return await execFile("git", args, { cwd: root, windowsHide: true });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-ci-snapshot-"));
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Snapshot Test"]);
  await git(root, ["config", "user.email", "snapshot@example.invalid"]);
  await mkdir(join(root, ".ci"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "base\n");
  await writeFile(join(root, "src", "main.txt"), "base source\n");
  await writeFile(
    join(root, REQUIRED_INPUTS_PATH),
    `${JSON.stringify({ schema: REQUIRED_INPUTS_SCHEMA, inputs: [] })}\n`,
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  return root;
}
async function withFixture(run) {
  const root = await fixture();
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
async function setInputs(root, inputs) {
  await writeFile(
    join(root, REQUIRED_INPUTS_PATH),
    `${JSON.stringify({ schema: REQUIRED_INPUTS_SCHEMA, inputs }, null, 2)}\n`,
  );
}
async function input(root, path, content, mode = 0o644) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, { mode });
  await chmod(join(root, path), mode);
  await writeFile(
    join(root, "README.md"),
    `${await readFile(join(root, "README.md"), "utf8")}gamebuddy-snapshot-input:${path}\n`,
  );
  const gitMode = (mode & 0o111) === 0 ? 0o644 : 0o755;
  return {
    path,
    owner: "test",
    purpose: "fixture input",
    type: "file",
    mode: gitMode,
    sha256: sha256(Buffer.from(content)),
    referencedBy: [{ path: "README.md", marker: `gamebuddy-snapshot-input:${path}` }],
    referenceRequirement: "fixture test reference is explicit and reviewable",
  };
}

test("materializes a reproducible no-commit frozen index from the local object store", async () =>
  withFixture(async (root) => {
    await writeFile(join(root, "src", "main.txt"), "tracked patch\n");
    const required = await input(root, "runtime/local-input.txt", "opaque config\n");
    await setInputs(root, [required]);
    const snapshotOne = join(root, "..", `snapshot-one-${Date.now()}`);
    const snapshotTwo = join(root, "..", `snapshot-two-${Date.now()}`);
    const one = await createCiSnapshot({ root, outputRoot: snapshotOne });
    const two = await createCiSnapshot({ root, outputRoot: snapshotTwo });
    await assert.rejects(createCiSnapshot({ root, outputRoot: snapshotOne }), /ci_snapshot_output_exists/);
    assert.equal(one.manifest.source.digest, two.manifest.source.digest);
    assert.equal(one.manifest.trackedPatchSha256, two.manifest.trackedPatchSha256);
    assert.deepEqual(one.report.unclassified, []);
    assert.deepEqual(one.report, two.report);
    assert.equal(one.report.classified.find((entry) => entry.path === "runtime/local-input.txt").owner, "test");
    const materialized = join(root, "..", `materialized-${Date.now()}`);
    const result = await materializeCiSnapshot({
      sourceRoot: root,
      snapshotRoot: snapshotOne,
      repositoryRoot: root,
      outputRoot: materialized,
    });
    assert.equal(result.sourceDigest, one.manifest.source.digest);
    assert.equal(await readFile(join(materialized, "src", "main.txt"), "utf8"), "tracked patch\n");
    assert.equal(await readFile(join(materialized, "runtime", "local-input.txt"), "utf8"), "opaque config\n");
    const { stdout } = await git(materialized, ["status", "--porcelain=v1"]);
    assert.deepEqual(stdout.trim().split("\n").sort(), [
      "A  runtime/local-input.txt",
      "M  .ci/required-snapshot-inputs.json",
      "M  README.md",
      "M  src/main.txt",
    ]);
    await rm(snapshotOne, { recursive: true, force: true });
    await rm(snapshotTwo, { recursive: true, force: true });
    await rm(materialized, { recursive: true, force: true });
  }));

test("rejects wrapper argument and environment drift before touching external paths", async () => {
  await assert.rejects(
    runCiSnapshot(
      ["--repository", "C:/repo", "--repository", "C:/repo", "--snapshot", "C:/snapshot", "--output", "C:/output"],
      {
        CI: "false",
      },
    ),
    /ci_snapshot_wrapper_usage/,
  );
  await assert.rejects(
    runCiSnapshot(["--repository", "C:/repo", "--snapshot", "C:/snapshot", "--output", "C:/output"], { CI: "false" }),
    /ci_snapshot_wrapper_environment_invalid/,
  );
});

test("rejects output paths equal to repository, active, or snapshot roots", async () =>
  withFixture(async (root) => {
    const snapshot = join(root, "..", `snapshot-${Date.now()}`);
    await createCiSnapshot({ root, outputRoot: snapshot });
    for (const outputRoot of [root, join(root, "nested-output"), snapshot, join(snapshot, "nested-output")]) {
      await assert.rejects(
        materializeCiSnapshot({
          sourceRoot: root,
          snapshotRoot: snapshot,
          repositoryRoot: root,
          outputRoot,
        }),
        /ci_snapshot_output_inside_(repository|source|snapshot)/,
      );
    }
    await rm(snapshot, { recursive: true, force: true });
  }));

test("classifies excluded paths with stable metadata while leaving unknown candidates blocking", async () =>
  withFixture(async (root) => {
    await input(root, "docs/review-note.txt", "excluded\n");
    await input(root, "runtime/unknown-build-input.txt", "unknown\n");
    const snapshot = join(root, "..", `snapshot-${Date.now()}`);
    const result = await createCiSnapshot({ root, outputRoot: snapshot });
    assert.deepEqual(result.report.excluded, ["docs/review-note.txt"]);
    assert.deepEqual(result.report.unclassified, ["runtime/unknown-build-input.txt"]);
    assert.deepEqual(result.report.candidateInventory, result.report.classified);
    assert.deepEqual(result.report.classified, [
      {
        path: "docs/review-note.txt",
        classification: "excluded",
        owner: null,
        purpose: null,
        referenceRequirement: "must be proven by a tracked build or CI reference before admission",
      },
      {
        path: "runtime/unknown-build-input.txt",
        classification: "unclassified",
        owner: null,
        purpose: null,
        referenceRequirement: "must be proven by a tracked build or CI reference before admission",
      },
    ]);
    await rm(snapshot, { recursive: true, force: true });
  }));

test("rejects a symlinked output parent before creating snapshot evidence", async () =>
  withFixture(async (root) => {
    const realParent = join(root, "..", `real-output-parent-${Date.now()}`);
    const linkedParent = join(root, "..", `linked-output-parent-${Date.now()}`);
    await mkdir(realParent);
    try {
      await symlink(realParent, linkedParent, "junction");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") return;
      throw error;
    }
    const output = join(linkedParent, "snapshot");
    await assert.rejects(createCiSnapshot({ root, outputRoot: output }), /ci_snapshot_output_root_invalid/);
    await assert.rejects(readFile(output), /ENOENT/);
  }));

test("rejects an existing snapshot directory rather than mixing evidence", async () =>
  withFixture(async (root) => {
    const output = join(root, "..", `existing-snapshot-${Date.now()}`);
    await mkdir(output);
    await assert.rejects(createCiSnapshot({ root, outputRoot: output }), /ci_snapshot_output_exists/);
    await rm(output, { recursive: true, force: true });
  }));

test("fails closed when a competing destination appears before transactional commit", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gamebuddy-ci-transaction-"));
  const output = join(parent, "snapshot");
  const transaction = await prepareTransactionalOutput(output);
  try {
    // Simulate another creator winning the destination between prepare and
    // commit. The destination marker proves the failed commit never replaced
    // or removed the competing directory.
    await mkdir(output);
    await writeFile(join(output, "competitor.txt"), "competitor\n");
    await assert.rejects(
      commitTransactionalOutput(transaction),
      new RegExp(
        process.platform === "win32"
          ? "ci_snapshot_output_exists"
          : "ci_snapshot_transactional_output_unsupported_platform",
      ),
    );
    assert.equal(await readFile(join(output, "competitor.txt"), "utf8"), "competitor\n");
    await lstat(transaction.temporary);
  } finally {
    await cleanupTransactionalOutput(transaction);
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("rejects undeclared untracked inputs rather than silently copying them", async () =>
  withFixture(async (root) => {
    await input(root, "runtime/undeclared.txt", "not allowlisted\n");
    const snapshot = join(root, "..", `snapshot-${Date.now()}`);
    const result = await createCiSnapshot({ root, outputRoot: snapshot });
    assert.deepEqual(result.report.unclassified, ["runtime/undeclared.txt"]);
    await assert.rejects(
      materializeCiSnapshot({
        sourceRoot: root,
        snapshotRoot: snapshot,
        repositoryRoot: root,
        outputRoot: join(root, "..", `materialized-${Date.now()}`),
      }),
      /ci_snapshot_unclassified_input_blocked/,
    );
    await rm(snapshot, { recursive: true, force: true });
  }));

test("rejects a new untracked unknown candidate added after snapshot creation", async () =>
  withFixture(async (root) => {
    const snapshot = join(root, "..", `snapshot-${Date.now()}`);
    await createCiSnapshot({ root, outputRoot: snapshot });
    await writeFile(join(root, "runtime-unknown.txt"), "appeared after snapshot\\n");
    await assert.rejects(
      materializeCiSnapshot({
        sourceRoot: root,
        snapshotRoot: snapshot,
        repositoryRoot: root,
        outputRoot: join(root, "..", `materialized-${Date.now()}`),
      }),
      /ci_snapshot_untracked_candidate_inventory_mismatch/,
    );
    await rm(snapshot, { recursive: true, force: true });
  }));

test("rejects an injected manifest required input that is missing from the active source", async () =>
  withFixture(async (root) => {
    const snapshot = join(root, "..", `snapshot-${Date.now()}`);
    await createCiSnapshot({ root, outputRoot: snapshot });
    const injected = {
      path: "runtime/injected-missing.txt",
      owner: "test",
      purpose: "injected fixture input",
      type: "file",
      mode: 0o644,
      sha256: sha256(Buffer.from("missing\n")),
      referencedBy: [{ path: "README.md", marker: "gamebuddy-snapshot-input:runtime/injected-missing.txt" }],
      referenceRequirement: "fixture test reference is explicit and reviewable",
    };
    const manifestPath = join(snapshot, "snapshot-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.requiredInputs = [injected];
    const reportPath = join(snapshot, "untracked-input-report.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const entry = {
      path: injected.path,
      classification: "snapshot_input",
      owner: injected.owner,
      purpose: injected.purpose,
      referenceRequirement: injected.referenceRequirement,
    };
    report.classified = [entry];
    report.candidateInventory = [entry];
    report.excluded = [];
    report.unclassified = [];
    const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    manifest.untrackedReportSha256 = sha256(reportBytes);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\\n`);
    await writeFile(reportPath, reportBytes);
    await assert.rejects(
      materializeCiSnapshot({
        sourceRoot: root,
        snapshotRoot: snapshot,
        repositoryRoot: root,
        outputRoot: join(root, "..", `materialized-${Date.now()}`),
      }),
      /ci_snapshot_manifest_invalid/,
    );
    await rm(snapshot, { recursive: true, force: true });
  }));

test("rejects an allowlisted input whose bytes or mode drift after snapshot creation", async () =>
  withFixture(async (root) => {
    const required = await input(root, "runtime/local-input.txt", "expected\n", 0o644);
    await setInputs(root, [required]);
    const snapshot = join(root, "..", `snapshot-${Date.now()}`);
    await createCiSnapshot({ root, outputRoot: snapshot });
    await writeFile(join(root, "runtime", "local-input.txt"), "tampered\n");
    await assert.rejects(
      materializeCiSnapshot({
        sourceRoot: root,
        snapshotRoot: snapshot,
        repositoryRoot: root,
        outputRoot: join(root, "..", `materialized-${Date.now()}`),
      }),
      /ci_snapshot_required_input_identity_mismatch/,
    );
    await rm(snapshot, { recursive: true, force: true });
  }));

test("rejects secret-like allowlist paths and private-key content", async () =>
  withFixture(async (root) => {
    const secret = await input(root, "runtime/token.txt", "not a token\n");
    await setInputs(root, [secret]);
    await assert.rejects(
      createCiSnapshot({ root, outputRoot: join(root, "..", `snapshot-${Date.now()}`) }),
      /ci_snapshot_required_input_secret_path_forbidden/,
    );
    const keyMarker = ["PRIVATE", "KEY"].join(" ");
    const key = await input(root, "runtime/allowed.txt", [`-----BEGIN ${keyMarker}-----\nprivate\n`]);
    await setInputs(root, [key]);
    await assert.rejects(
      createCiSnapshot({ root, outputRoot: join(root, "..", `snapshot-${Date.now()}`) }),
      /ci_snapshot_required_input_secret_content_forbidden/,
    );
  }));

test("preserves a tracked deletion in its source identity and materialized index", async () =>
  withFixture(async (root) => {
    await (await import("node:fs/promises")).unlink(join(root, "src", "main.txt"));
    const snapshot = join(root, "..", `snapshot-${Date.now()}`);
    const created = await createCiSnapshot({ root, outputRoot: snapshot });
    assert.ok(!created.manifest.source.entries.some((entry) => entry.path === "src/main.txt"));
    const materialized = join(root, "..", `materialized-${Date.now()}`);
    await materializeCiSnapshot({
      sourceRoot: root,
      snapshotRoot: snapshot,
      repositoryRoot: root,
      outputRoot: materialized,
    });
    await assert.rejects(readFile(join(materialized, "src", "main.txt")), /ENOENT/);
    const { stdout } = await git(materialized, ["status", "--porcelain=v1"]);
    assert.match(stdout, /D {2}src\/main\.txt/);
    await rm(snapshot, { recursive: true, force: true });
    await rm(materialized, { recursive: true, force: true });
  }));

test("rejects a report snapshot-input set that differs in either direction", async () =>
  withFixture(async (root) => {
    const required = await input(root, "runtime/local-input.txt", "expected\n");
    await setInputs(root, [required]);
    const snapshot = join(root, "..", `snapshot-${Date.now()}`);
    await createCiSnapshot({ root, outputRoot: snapshot });
    const reportPath = join(snapshot, "untracked-input-report.json");
    const manifestPath = join(snapshot, "snapshot-manifest.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const extra = {
      path: "runtime/extra.txt",
      classification: "snapshot_input",
      owner: "test",
      purpose: "extra",
      referenceRequirement: required.referenceRequirement,
    };
    report.classified.push(extra);
    report.candidateInventory = report.classified;
    const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    manifest.untrackedReportSha256 = sha256(reportBytes);
    await writeFile(reportPath, reportBytes);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      materializeCiSnapshot({
        sourceRoot: root,
        snapshotRoot: snapshot,
        repositoryRoot: root,
        outputRoot: join(root, "..", `materialized-${Date.now()}`),
      }),
      /ci_snapshot_untracked_report_invalid/,
    );
    await rm(snapshot, { recursive: true, force: true });
  }));

test("rejects a tampered report whose digest no longer matches the manifest", async () =>
  withFixture(async (root) => {
    const snapshot = join(root, "..", `snapshot-${Date.now()}`);
    await createCiSnapshot({ root, outputRoot: snapshot });
    await writeFile(join(snapshot, "untracked-input-report.json"), "{}\n");
    await assert.rejects(
      materializeCiSnapshot({
        sourceRoot: root,
        snapshotRoot: snapshot,
        repositoryRoot: root,
        outputRoot: join(root, "..", `materialized-${Date.now()}`),
      }),
      /ci_snapshot_untracked_report_digest_mismatch/,
    );
    await rm(snapshot, { recursive: true, force: true });
  }));

test("rejects injected or invalid required-input references", async () =>
  withFixture(async (root) => {
    const required = await input(root, "runtime/local-input.txt", "expected\n");
    required.referencedBy = [
      { path: "runtime/not-tracked.txt", marker: "gamebuddy-snapshot-input:runtime/local-input.txt" },
    ];
    await setInputs(root, [required]);
    await assert.rejects(
      createCiSnapshot({ root, outputRoot: join(root, "..", `snapshot-${Date.now()}`) }),
      /ci_snapshot_required_input_reference_untracked/,
    );
  }));

test("requires the declared marker rather than an incidental input path reference", async () =>
  withFixture(async (root) => {
    const required = await input(root, "runtime/local-input.txt", "expected\n");
    await writeFile(join(root, "README.md"), "base\nruntime/local-input.txt\n");
    await setInputs(root, [required]);
    await assert.rejects(
      createCiSnapshot({ root, outputRoot: join(root, "..", `snapshot-${Date.now()}`) }),
      /ci_snapshot_required_input_reference_missing/,
    );
  }));

test("rejects a symlinked report before reading its bytes", async () =>
  withFixture(async (root) => {
    const snapshot = join(root, "..", `snapshot-${Date.now()}`);
    await createCiSnapshot({ root, outputRoot: snapshot });
    const reportPath = join(snapshot, "untracked-input-report.json");
    const targetPath = join(snapshot, "report-target.json");
    await cp(reportPath, targetPath);
    await unlink(reportPath);
    try {
      await symlink(targetPath, reportPath);
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") return;
      throw error;
    }
    const destination = join(root, "..", `materialized-${Date.now()}`);
    await assert.rejects(
      materializeCiSnapshot({
        sourceRoot: root,
        snapshotRoot: snapshot,
        repositoryRoot: root,
        outputRoot: destination,
      }),
      /ci_snapshot_untracked_report_invalid/,
    );
    await assert.rejects(readFile(destination), /ENOENT/);
    await rm(snapshot, { recursive: true, force: true });
  }));

test("rejects a hardlinked report before reading its bytes", async () =>
  withFixture(async (root) => {
    const snapshot = join(root, "..", `snapshot-${Date.now()}`);
    await createCiSnapshot({ root, outputRoot: snapshot });
    const reportPath = join(snapshot, "untracked-input-report.json");
    const hardlinkPath = join(snapshot, "report-hardlink.json");
    await link(reportPath, hardlinkPath);
    const destination = join(root, "..", `materialized-${Date.now()}`);
    await assert.rejects(
      materializeCiSnapshot({
        sourceRoot: root,
        snapshotRoot: snapshot,
        repositoryRoot: root,
        outputRoot: destination,
      }),
      /ci_snapshot_untracked_report_invalid/,
    );
    await assert.rejects(readFile(destination), /ENOENT/);
    await rm(snapshot, { recursive: true, force: true });
  }));

test("rejects a tampered binary patch before creating a clone", async () =>
  withFixture(async (root) => {
    await writeFile(join(root, "README.md"), "changed\n");
    const snapshot = join(root, "..", `snapshot-${Date.now()}`);
    await createCiSnapshot({ root, outputRoot: snapshot });
    await writeFile(join(snapshot, "tracked.patch"), "tampered\n");
    const destination = join(root, "..", `materialized-${Date.now()}`);
    await assert.rejects(
      materializeCiSnapshot({
        sourceRoot: root,
        snapshotRoot: snapshot,
        repositoryRoot: root,
        outputRoot: destination,
      }),
      /ci_snapshot_patch_digest_mismatch/,
    );
    await assert.rejects(readFile(destination), /ENOENT/);
    await rm(snapshot, { recursive: true, force: true });
  }));
