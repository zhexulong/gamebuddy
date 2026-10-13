/**
 * The format ratchet's predicate, planted against.
 *
 * `check-format-ratchet.mjs` is only worth wiring in place of the repo-wide formatter run if the
 * comparison it makes really is "no file newly joins the red set": a recorded file that still fails
 * must not be a finding, a file that neither the baseline nor the tree knows must be, and a run that
 * never scanned anything must not read as clean.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, windowsHide: true, stdio: "ignore" });
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
  writeFileSync(join(root, ".gitignore"), "/tools/_*\n");
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

test("planted.1: a file the tree does not record that fails to format fails the gate", () => {
  withFixture({}, (root) => {
    assert.equal(runGate(root).status, 0, "a clean fixture with an empty baseline is green");
    writeFileSync(join(root, "tools", "planted.mjs"), "const  planted  =  1\n");
    const result = runGate(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /format_ratchet_failed new=1/);
    assert.match(result.stdout, /tools\/planted\.mjs/);
    process.stdout.write(`planted.1: planted a mis-formatted tools/planted.mjs -> ${result.stdout.split("\n")[0]}\n`);
  });
});

test("planted.2: a recorded mis-formatted file is legacy debt, not a finding", () => {
  withFixture({ "tools/legacy.mjs": "const  legacy  =  1\n" }, (root) => {
    assert.equal(runGate(root).status, 1, "the legacy file is red before it is recorded");
    record(root, ["tools/legacy.mjs"]);
    const result = runGate(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /format_ratchet_ok/);
    process.stdout.write(`planted.2: recorded tools/legacy.mjs -> ${result.stdout.split("\n")[0]}\n`);
  });
});

test("planted.3: a git-ignored scratch file is not repository content and is not a finding", () => {
  withFixture({ "tools/_scratch.mjs": "const  scratch  =  1\n" }, (root) => {
    const result = runGate(root);
    assert.equal(result.status, 0, result.stdout);
    process.stdout.write(`planted.3: ignored tools/_scratch.mjs -> ${result.stdout.split("\n")[0]}\n`);
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
