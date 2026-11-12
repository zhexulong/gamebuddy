/**
 * The format ratchet's predicate, planted against.
 *
 * `check-format-ratchet.mjs` is only worth wiring in place of the repo-wide formatter run if the
 * comparison it makes really is "no file newly joins the red set": a recorded file that still fails
 * must not be a finding, a file that neither the baseline nor the tree knows must be, and a run that
 * never scanned anything must not read as clean.
 *
 * red-proof: inject  `ratchet()` reporting every mis-formatted file as newly grown, recorded or not ->
 *                    `✖ ratchet.1: a file the baseline never recorded is the finding`, `✖ ratchet.2: a recorded file
 *                    that still fails is not a finding`, `✖ planted.2: a recorded mis-formatted file is legacy debt,
 *                    not a finding`, exit 1; the unmodified predicate passes, exit 0
 *                    (tools/scripts/check-format-ratchet.test.mjs)
 * red-proof: inject  the `unstaged` subtraction dropped from the verdict population in `main`, so files whose worktree
 *                    bytes differ from the index count -> `✖ planted.7: a tracked file's uncommitted edit is published
 *                    and inert, and counts the moment it is staged`, exit 1; unmodified, exit 0
 *                    (tools/scripts/check-format-ratchet.test.mjs)
 * red-proof: inject  the `carried` filter emptied in `--update`, so an entry whose bytes are in flight is dropped ->
 *                    `✖ planted.8: an entry whose bytes are in flight is kept, and is not reported as fixed`, exit 1;
 *                    unmodified, exit 0 (tools/scripts/check-format-ratchet.test.mjs)
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cleanOutputLines } from "../lib/subprocess-output.mjs";
import { parseSummary, parseViolations, ratchet } from "./check-format-ratchet.mjs";

const SCRIPTS_ROOT = dirname(fileURLToPath(import.meta.url));
const GATE = join(SCRIPTS_ROOT, "check-format-ratchet.mjs");

test("parseViolations.1: only the `<path> format ━` headers are files, not the diff body", () => {
  const output = [
    "tools\\legacy.mjs format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "  × Formatter would have printed the following content:",
    "    1 │ - const  x = 1",
    "      │ + const x = 1;",
    "",
    "host/src/clean.ts format ━━━━━━━━━━━━━━━━━",
    "",
    "format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  ].join("\n");
  assert.deepEqual(parseViolations(output), ["host/src/clean.ts", "tools/legacy.mjs"]);
});

test("parseViolations.2: a structural line that names a file is not a violation", () => {
  assert.deepEqual(parseViolations("Some errors were emitted while running checks.\n"), []);
});

test("parseSummary.1: a scan that reported no file count is not a clean scan", () => {
  assert.equal(parseSummary("Found 7 errors.\n").checked, undefined);
  assert.equal(parseSummary("Checked 1115 files in 187ms. No fixes applied.\n").checked, 1115);
});

test("ratchet.1: a file the baseline never recorded is the finding", () => {
  const result = ratchet({ baselineFiles: ["tools/legacy.mjs"], files: ["tools/legacy.mjs", "tools/planted.mjs"] });
  assert.deepEqual(result.grown, ["tools/planted.mjs"]);
  assert.deepEqual(result.fixed, []);
});

test("ratchet.2: a recorded file that still fails is not a finding, and a file that recovers is not either", () => {
  assert.deepEqual(ratchet({ baselineFiles: ["tools/legacy.mjs"], files: ["tools/legacy.mjs"] }).grown, []);
  const recovered = ratchet({ baselineFiles: ["tools/legacy.mjs"], files: [] });
  assert.deepEqual(recovered.grown, [], "a ratchet only turns one way");
  assert.deepEqual(recovered.fixed, ["tools/legacy.mjs"]);
});

test("ratchet.3: an empty baseline is a rule, not a disarmed gate", () => {
  assert.deepEqual(ratchet({ baselineFiles: [], files: ["tools/legacy.mjs"] }).grown, ["tools/legacy.mjs"]);
});

const fixture = (build) => {
  const root = mkdtempSync(join(tmpdir(), "gb-format-ratchet-"));
  for (const relativePath of ["tools", "host/src", "dialogue-web/src", "vendor/pi-koe/src", "tools/scripts"]) {
    mkdirSync(join(root, relativePath), { recursive: true });
  }
  writeFileSync(
    join(root, "biome.json"),
    `${JSON.stringify({ files: { includes: ["tools/**/*.mjs", "host/src/**/*.ts", "dialogue-web/src/**/*.{ts,tsx}", "vendor/pi-koe/src/**/*.ts"] } }, null, 2)}\n`,
  );
  writeFileSync(join(root, "tools", "clean.mjs"), "const value = 1;\n");
  for (const [relativePath, contents] of Object.entries(build)) writeFileSync(join(root, relativePath), contents);
  // The ignore rule has to exist before the index does, or a scratch file would be staged by the fixture itself.
  writeFileSync(join(root, ".gitignore"), "/tools/_*\n");
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, windowsHide: true, stdio: "ignore" });
  // The gate's population is the index, so a fixture has to have one: `build` is what the tree already carries.
  execFileSync("git", ["add", "-A"], { cwd: root, windowsHide: true, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=format-ratchet",
      "-c",
      "user.email=format-ratchet@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { cwd: root, windowsHide: true, stdio: "ignore" },
  );
  writeFileSync(
    join(root, "tools", "scripts", "format-baseline.json"),
    `${JSON.stringify({ note: "fixture", revision: "0000000", files: [] }, null, 2)}\n`,
  );
  return root;
};

const record = (root, files) =>
  writeFileSync(
    join(root, "tools", "scripts", "format-baseline.json"),
    `${JSON.stringify({ note: "fixture", revision: "0000000", files }, null, 2)}\n`,
  );

const runGate = (root) => spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8", windowsHide: true });

const withFixture = (build, run) => {
  const root = fixture(build);
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
};

const stage = (root, relativePath) =>
  execFileSync("git", ["add", "--", relativePath], { cwd: root, windowsHide: true, stdio: "ignore" });

test("planted.1: a tracked file the baseline does not record that fails to format fails the gate", () => {
  withFixture({}, (root) => {
    assert.equal(runGate(root).status, 0, "a clean fixture with an empty baseline is green");
    writeFileSync(join(root, "tools", "planted.mjs"), "const  planted  =  1\n");
    stage(root, "tools/planted.mjs");
    const result = runGate(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /format_ratchet_failed new=1/);
    assert.match(result.stdout, /tools\/planted\.mjs/);
    process.stdout.write(
      `planted.1: planted a mis-formatted tools/planted.mjs -> ${cleanOutputLines(result.stdout)[0]}\n`,
    );
  });
});

test("planted.6: an untracked file is published and inert, and counts the moment it is staged", () => {
  withFixture({}, (root) => {
    writeFileSync(join(root, "tools", "inflight.mjs"), "const  inflight  =  1\n");

    // The defect this pins: another lane writing a file used to move this gate's baseline. It is neither counted nor
    // hidden - the reading names it, so a reader can see what the verdict could not see.
    const untracked = runGate(root);
    assert.equal(untracked.status, 0, untracked.stdout);
    assert.match(
      untracked.stdout,
      /format_ratchet_ok debt: files=0 .* · untracked_not_counted 1: tools\/inflight\.mjs/,
    );

    stage(root, "tools/inflight.mjs");
    const tracked = runGate(root);
    assert.equal(tracked.status, 1, tracked.stdout);
    assert.match(tracked.stdout, /format_ratchet_failed new=1/);
    assert.doesNotMatch(tracked.stdout, /untracked_not_counted/);
    process.stdout.write(`planted.6: staged tools/inflight.mjs -> ${cleanOutputLines(tracked.stdout)[0]}\n`);
  });
});

test("planted.7: a tracked file's uncommitted edit is published and inert, and counts the moment it is staged", () => {
  withFixture({ "tools/edited.mjs": "const edited = 1;\n" }, (root) => {
    // A shared checkout: the index holds bytes that format, the worktree holds a neighbour's edit that does not.
    writeFileSync(join(root, "tools", "edited.mjs"), "const  edited  =  1\n");

    const unstaged = runGate(root);
    assert.equal(unstaged.status, 0, unstaged.stdout);
    assert.match(unstaged.stdout, /format_ratchet_ok debt: files=0 .* · unstaged_not_counted 1: tools\/edited\.mjs/);

    stage(root, "tools/edited.mjs");
    const indexed = runGate(root);
    assert.equal(indexed.status, 1, indexed.stdout);
    assert.match(indexed.stdout, /format_ratchet_failed new=1/);
    assert.match(indexed.stdout, /tools\/edited\.mjs/);
    assert.doesNotMatch(indexed.stdout, /unstaged_not_counted/);
    process.stdout.write(`planted.7: staged the edit to tools/edited.mjs -> ${cleanOutputLines(indexed.stdout)[0]}\n`);
  });
});

test("planted.8: an entry whose bytes are in flight is kept, and is not reported as fixed", () => {
  withFixture({ "tools/legacy.mjs": "const  legacy  =  1\n" }, (root) => {
    record(root, ["tools/legacy.mjs"]);
    // The reformat that would retire this entry exists only in the worktree, so the index still owes it.
    writeFileSync(join(root, "tools", "legacy.mjs"), "const legacy = 1;\n");

    const held = runGate(root);
    assert.equal(held.status, 0, held.stdout);
    assert.doesNotMatch(held.stdout, /recorded file\(s\) now format/);
    assert.match(held.stdout, /format only in uncommitted edits, so the entry is kept: tools\/legacy\.mjs/);

    const updated = spawnSync(process.execPath, [GATE, "--root", root, "--update"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(updated.status, 0, updated.stdout);
    assert.match(updated.stdout, /format_ratchet_recorded files=1 checked=\d+ carried=1/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "tools", "scripts", "format-baseline.json"), "utf8")).files, [
      "tools/legacy.mjs",
    ]);
    process.stdout.write(`planted.8: edit in flight over tools/legacy.mjs -> ${cleanOutputLines(held.stdout)[0]}\n`);
  });
});

test("planted.2: a recorded mis-formatted file is legacy debt, not a finding", () => {
  withFixture({ "tools/legacy.mjs": "const  legacy  =  1\n" }, (root) => {
    assert.equal(runGate(root).status, 1, "the legacy file is red before it is recorded");
    record(root, ["tools/legacy.mjs"]);
    const result = runGate(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /format_ratchet_ok/);
    process.stdout.write(`planted.2: recorded tools/legacy.mjs -> ${cleanOutputLines(result.stdout)[0]}\n`);
  });
});

test("planted.3: a git-ignored scratch file is not repository content and is not a finding", () => {
  withFixture({ "tools/_scratch.mjs": "const  scratch  =  1\n" }, (root) => {
    const result = runGate(root);
    assert.equal(result.status, 0, result.stdout);
    process.stdout.write(`planted.3: ignored tools/_scratch.mjs -> ${cleanOutputLines(result.stdout)[0]}\n`);
  });
});

test("planted.4: --update records the red set, and the recorded run is then green", () => {
  withFixture({ "tools/legacy.mjs": "const  legacy  =  1\n" }, (root) => {
    const updated = spawnSync(process.execPath, [GATE, "--root", root, "--update"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(updated.status, 0, updated.stdout);
    assert.match(updated.stdout, /format_ratchet_recorded files=1/);
    assert.equal(runGate(root).status, 0);
  });
});

test("planted.5: the gate's default root is this repository, and its baseline is recorded there", () => {
  const baseline = JSON.parse(readFileSync(resolve(SCRIPTS_ROOT, "format-baseline.json"), "utf8"));
  assert.ok(Array.isArray(baseline.files) && baseline.files.length > 0);
});
