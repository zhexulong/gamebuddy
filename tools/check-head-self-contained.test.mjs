/**
 * Falsifiers for `tools/check-head-self-contained.mjs`, each on a real `git init` repository.
 *
 * The defect this gate exists for is a commit that imports a module the commit does not contain. It cannot
 * be planted in a directory: the whole question is the difference between the index, the working tree and
 * the commit, so every case below writes files, stages what it means to stage, commits what it means to
 * commit, and then asks the gate about the repository that resulted.
 *
 * red-proof: inject  a committed importer whose target is staged and never committed -> `untracked_import_target`
 *                    ("a staged module is not a committed one"; the same case prints `git ls-files` and
 *                    `git ls-tree` so the reason the index would miss it is visible in the reading)
 * red-proof: inject  a committed importer of a file that was never written -> `missing_from_head` ("a target
 *                    that was never written is a finding, not a skip")
 * red-proof: inject  a commit holding no source file at all -> `status:"blocked"` and exit 1 ("an empty
 *                    population is blocked, not passed")
 * red-proof: inject  a committed importer of a gitignored build output -> held ("a gitignored build output is
 *                    not a missing commit")
 * red-proof: inject  a module graph written as fixture text inside a committed test -> held ("a module
 *                    written as fixture text is not an import")
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditHeadSelfContained, describeViolation } from "./check-head-self-contained.mjs";

const gatePath = join(dirname(fileURLToPath(import.meta.url)), "check-head-self-contained.mjs");
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A git command in a fixture repository, insulated from this machine's own git configuration. */
function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "no-global-gitconfig") },
  });
}

function makeRepository(files) {
  const root = mkdtempSync(join(tmpdir(), "head-self-contained-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return root;
}

function commit(root, paths) {
  git(root, ["add", "--", ...paths]);
  git(root, [
    "-c",
    "user.name=head-self-contained-gate",
    "-c",
    "user.email=head-self-contained@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--no-verify",
    "-m",
    "planted",
  ]);
}

test("a staged module is not a committed one", () => {
  const root = makeRepository({
    "host/src/consumer.ts": 'import { read } from "./definition.js";\n\nexport const value = read();\n',
    "host/src/definition.ts": "export const read = () => 1;\n",
  });
  commit(root, ["host/src/consumer.ts"]);
  // The shipped shape: `git add`ed, never committed. The index is what `git ls-files` reads, which is why the
  // gate's authority is the commit and the two readings are printed here rather than assumed.
  git(root, ["add", "--", "host/src/definition.ts"]);
  assert.equal(git(root, ["ls-files", "--", "host/src/definition.ts"]).trim(), "host/src/definition.ts");
  assert.equal(git(root, ["ls-tree", "-r", "--name-only", "HEAD"]).trim(), "host/src/consumer.ts");

  const reading = auditHeadSelfContained({ repositoryRoot: root });
  assert.deepEqual(reading.violations, [
    "untracked_import_target:host/src/consumer.ts:./definition.js:host/src/definition.ts",
  ]);
  assert.equal(reading.status, "failed");
  assert.equal(reading.population, 1);
  assert.match(describeViolation(reading.violations[0]), /exists on disk but is in no commit/u);
});

test("a module committed with its importer is held", () => {
  const root = makeRepository({
    "host/src/consumer.ts": 'import { read } from "./definition.js";\n\nexport const value = read();\n',
    "host/src/definition.ts": "export const read = () => 1;\n",
  });
  commit(root, ["host/src/consumer.ts", "host/src/definition.ts"]);

  const reading = auditHeadSelfContained({ repositoryRoot: root });
  assert.deepEqual(reading.violations, []);
  assert.equal(reading.status, "passed");
  assert.equal(reading.population, 2);
});

test("a target that was never written is a finding, not a skip", () => {
  const root = makeRepository({
    "host/src/consumer.ts": 'import { read } from "./never-written.js";\n\nexport const value = read();\n',
  });
  commit(root, ["host/src/consumer.ts"]);

  const reading = auditHeadSelfContained({ repositoryRoot: root });
  assert.deepEqual(reading.violations, ["missing_from_head:host/src/consumer.ts:./never-written.js"]);
  assert.equal(reading.status, "failed");
});

test("an empty population is blocked, not passed", () => {
  const root = makeRepository({ "README.md": "# nothing here imports anything\n" });
  commit(root, ["README.md"]);

  const run = spawnSync(process.execPath, [gatePath, "--root", root], { encoding: "utf8", windowsHide: true });
  assert.deepEqual(JSON.parse(run.stdout), {
    gate: "head-self-contained",
    population: 0,
    violations: [],
    status: "blocked",
  });
  assert.equal(run.status, 1);
});

test("a gitignored build output is not a missing commit", () => {
  const root = makeRepository({
    ".gitignore": "dist/\n",
    "tools/runner.mjs": 'import { generated } from "./dist/generated.mjs";\n\nexport const value = generated;\n',
    "tools/dist/generated.mjs": "export const generated = 1;\n",
  });
  commit(root, [".gitignore", "tools/runner.mjs"]);

  const reading = auditHeadSelfContained({ repositoryRoot: root });
  assert.deepEqual(reading.violations, []);
  assert.equal(reading.status, "passed");
});

test("a module written as fixture text is not an import", () => {
  const root = makeRepository({
    "tools/gate.test.mjs": [
      'const fixture = `import { ghost } from "./ghost.js";`;',
      '// import { commented } from "./ghost-comment.js";',
      "export const text = fixture;",
      "",
    ].join("\n"),
  });
  commit(root, ["tools/gate.test.mjs"]);

  const reading = auditHeadSelfContained({ repositoryRoot: root });
  assert.deepEqual(reading.violations, []);
  assert.equal(reading.status, "passed");
});
