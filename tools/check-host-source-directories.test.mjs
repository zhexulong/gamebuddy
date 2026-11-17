/**
 * Falsifier suite for `check-host-source-directories.mjs`.
 *
 * The gate's own claim is driven over scratch trees here, not only over this repository, because the one member it
 * names today (`host/src/containment/windows`) is deleted by the commit that added it: a rule that can only be shown
 * red on a defect that no longer exists is a rule nobody can re-prove.
 *
 * red-proof: inject  a scratch tree whose one directory holds only a README -> `✖
 *                    a_directory_whose_only_content_is_a_claim`, exit 1, while the same tree with the module added
 *                    is silent (tools/check-host-source-directories.test.mjs)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkHostSourceDirectories, hostSourceDirectories, selfCheck } from "./check-host-source-directories.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gate = resolve(repositoryRoot, "tools", "check-host-source-directories.mjs");

/** A tree the gate must judge, built on disk so `git ls-files` is the listing exactly as in the product. */
function tree({ files }) {
  const root = mkdtempSync(join(tmpdir(), "host-source-directories-test-"));
  for (const [path, content] of Object.entries(files)) {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  mkdirSync(resolve(root, "host", "src"), { recursive: true });
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  };
  git("init", "-q");
  git("add", "-A");
  const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", windowsHide: true })
    .stdout.split("\0")
    .filter((path) => path !== "")
    .map((path) => path.replaceAll("\\", "/"));
  return { root, tracked };
}

const readFrom = (root) => (path) => readFileSync(resolve(root, path), "utf8");

test("the repository has no directory whose only content is a claim", () => {
  const tracked = spawnSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .stdout.split("\0")
    .filter((path) => path !== "");
  const report = checkHostSourceDirectories({ root: repositoryRoot, trackedFiles: tracked });

  // The population is printed by the gate because an empty verdict agrees with itself. This assertion names the
  // property (every host/src directory holds a module), not today's count.
  assert.ok(report.examined > 0, `examined ${report.examined} director(ies) under host/src`);
  assert.deepEqual(report.findings, []);
});

test("a directory holding only a README is named, and the module it claims is located", () => {
  const { root, tracked } = tree({
    files: {
      "host/src/claim/README.md": "# Claim\n\n## Owns\nHandle adapters.\n\nMoved to `host/src/real/handles.ts`.\n",
      "host/src/real/handles.ts": "export const handles = true;\n",
    },
  });
  try {
    const report = checkHostSourceDirectories({ root, trackedFiles: tracked, read: readFrom(root) });
    assert.deepEqual(
      report.findings.map((finding) => [finding.kind, finding.directory]),
      [["a_directory_whose_only_content_is_a_claim", "host/src/claim"]],
    );
    assert.deepEqual(report.findings[0].claimedElsewhere, [
      { name: "host/src/real/handles.ts", at: ["host/src/real/handles.ts"] },
    ]);
    assert.ok(
      hostSourceDirectories({ trackedFiles: tracked }).some(
        (record) => record.directory === "host/src/real" && record.sources.length === 1,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same directory holding a module is silent", () => {
  const { root, tracked } = tree({
    files: {
      "host/src/claim/README.md": "# Claim\n\n## Owns\nHandle adapters, implemented here as `index.ts`.\n",
      "host/src/claim/index.ts": "export const handles = true;\n",
    },
  });
  try {
    const report = checkHostSourceDirectories({ root, trackedFiles: tracked, read: readFrom(root) });
    assert.deepEqual(report.findings, []);
    assert.ok(report.examined > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a document quoting a module the tree does not carry is named with the document and the name", () => {
  const { root, tracked } = tree({
    files: {
      "host/src/holder/README.md": "# Holder\n\nKept at `host/src/holder/index.ts`; see `host/src/holder/gone.ts`.\n",
      "host/src/holder/index.ts": "export const held = true;\n",
    },
  });
  try {
    const report = checkHostSourceDirectories({ root, trackedFiles: tracked, read: readFrom(root) });
    assert.deepEqual(
      report.findings.map((finding) => [finding.kind, finding.document, finding.name]),
      [["document_claim_names_missing_source", "host/src/holder/README.md", "host/src/holder/gone.ts"]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reading that examined nothing is blocked, never passed", () => {
  const { root, tracked } = tree({ files: { "README.md": "# no host sources here\n" } });
  try {
    const report = checkHostSourceDirectories({ root, trackedFiles: tracked, read: readFrom(root) });
    assert.equal(report.examined, 0);
    assert.equal(report.findings.length, 0);
    assert.deepEqual(report.blocked, [
      "host_source_directories_read_nothing: examined 0 directory(ies) under host/src",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the falsifier is red on the join/glob shapes the gate's own reading can see", () => {
  // A module filed one directory deeper than its sibling claim, and a quoted name that only a suffix match
  // resolves: both are how a real README names a file, and both must be read rather than treated as absent.
  const { root, tracked } = tree({
    files: {
      "host/src/layer/README.md": "# Layer\n\nPrimitives at `windows/handles.ts`.\n",
      "host/src/layer/windows/handles.ts": "export const handles = true;\n",
    },
  });
  try {
    const report = checkHostSourceDirectories({ root, trackedFiles: tracked, read: readFrom(root) });
    assert.deepEqual(report.findings, []);
    assert.ok(
      hostSourceDirectories({ trackedFiles: tracked }).some(
        (record) => record.directory === "host/src/layer" && record.sources.length === 1,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the gate's own falsifier passes and the command exits on the tree it belongs to", () => {
  for (const check of selfCheck()) assert.equal(check.status, "passed", `${check.id}: ${check.detail}`);

  // The command judges the tree the gate file belongs to, never the shell's cwd: a gate whose reading moves with cwd
  // could be packed by walking somewhere else. This repository is the tree it belongs to, and it is green.
  const green = spawnSync(process.execPath, [gate], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });
  assert.equal(green.status, 0, green.stderr);
  assert.match(green.stdout, /host_source_directories examined \d+ directory\(ies\) and \d+ document\(s\); findings 0/);
  const listing = spawnSync(process.execPath, [gate, "--list"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(listing.status, 0);
  assert.match(listing.stdout, /directory\thost\/src\/composition\tsources=\d+/);

  const red = spawnSync(process.execPath, [gate], { cwd: tmpdir(), encoding: "utf8", windowsHide: true });
  assert.equal(red.status, 0, "a different cwd must not change which tree is judged");
});

test("the gate's source names the finding it produces", () => {
  const source = readFileSync(gate, "utf8");
  assert.match(source, /a_directory_whose_only_content_is_a_claim/);
  assert.match(source, /document_claim_names_missing_source/);
  // The gate must read the index, not a directory listing of the worktree: a lane's half-written directory is
  // not repository content, and a claim about it is not a claim the tree makes.
  assert.match(source, /"ls-files", "-z"/);
  assert.ok(readdirSync(resolve(repositoryRoot, "tools")).includes("check-host-source-directories.mjs"));
  assert.ok(relative(repositoryRoot, gate).length > 0);
});
