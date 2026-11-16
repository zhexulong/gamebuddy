/**
 * The marker every gate prints is `✖` (U+2716); `×` (U+00D7) in a marker position is a marker the formatter rewrote.
 *
 * This suite is the gate's falsifier. It holds the RULE (which `×` are markers, and which are multiplication, a
 * character class or biome's own diagnostic glyph), the BASELINE's two directions (an entry excuses its line, and an
 * entry whose line is fixed is stale and fails), the POPULATION's floor (no file, no pass), and the revision mode that
 * makes "this is what the commit carried" a reading rather than an opinion.
 *
 * The glyphs are written as escapes on purpose: this file is in the gate's own population, and a suite whose source
 * bytes are marker positions would have to be baselined against itself.
 *
 * The integration cases run the REAL gate - the file is copied into a fixture repository beside its baseline, exactly
 * as a checkout carries it - so a gate that only agrees with itself here cannot pass.
 *
 * red-proof: inject  the corrupted-line report dropped from `scanMarkerCorruption`, so the gate exits 0 over a fixture
 *   ledger holding one corrupted marker -> `✖ the gate names the file and the line, and exits 1` (0 !== 1), 3 of 7
 *   cases red, `the population is every file that carries either glyph` among them
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { corruptedLines, holdsEitherGlyph, loadBaseline, scanMarkerCorruption } from "./check-red-proof-markers.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = "gates/meta/check-red-proof-markers.mjs";
const BASELINE = "tools/baselines/red-proof-markers.json";

const MARKER = "\u2716";
const CORRUPT = "\u00d7";

const corrupted = (text) => corruptedLines(text).map((site) => site.line);

test("a marker position is reported, and a multiplication is not", () => {
  const text = [
    `//  -> \`${CORRUPT} a commit carries the staged bytes\` (\`exit 1\`)`,
    ` *                    \`${CORRUPT} a marker on a code line is not a marker\``,
    `${CORRUPT} a proof's pointer is executed when a runner names the file`,
    `| \`harvest_crop\` | 5 | 2${CORRUPT}2 tiles | - |`,
    `Measured: \`door_not_available\` ${CORRUPT}6, \`row_target_identity_unavailable\` ${CORRUPT}6`,
    `floor(usableSoft ${CORRUPT} executeThreshold)`,
    `| \`${CORRUPT} the committed registry and the action surface agree\` |`,
    `    "  ${CORRUPT} Formatter would have printed the following content:",`,
    `    const bareStyle = line.match(/^\\s*[${MARKER.replace(MARKER, "\u2717")}${CORRUPT}]\\s+(.+?)\\s*$/u);`,
    `//  -> \`${MARKER} the marker this tree prints\``,
  ].join("\n");

  assert.deepEqual(
    corrupted(text),
    [1, 2, 3, 7],
    `a ${CORRUPT} after a backtick, after \`-> \` or at the start of a line is a corrupted marker; 2${CORRUPT}2, ${CORRUPT}6, a product, a character class, biome's own glyph and a correct ${MARKER} are not`,
  );
});

test("the population is every file that carries either glyph", () => {
  assert.equal(holdsEitherGlyph(`a ${MARKER} b`), true);
  assert.equal(holdsEitherGlyph(`a ${CORRUPT} b`), true);
  assert.equal(holdsEitherGlyph("neither"), false);

  const files = ["corrupt.mjs", "clean.mjs", "multiplication.md"];
  const texts = new Map([
    ["corrupt.mjs", `// -> \`${CORRUPT} a thing\`\n`],
    ["clean.mjs", `// -> \`${MARKER} a thing\`\n`],
    ["multiplication.md", `| 2${CORRUPT}2 |\n`],
  ]);
  const reading = scanMarkerCorruption({ files, read: (path) => texts.get(path) ?? null, baseline: { entries: [] } });
  assert.equal(reading.examined, 3, "every file holding either glyph is examined");
  assert.deepEqual(
    reading.violations.map((site) => `${site.path}:${site.line}`),
    ["corrupt.mjs:1"],
  );
});

test("a baseline entry excuses its own line and its expiry is a finding", () => {
  const files = ["ledger.md"];
  const corruptLine = `| \`${CORRUPT} the gate reads the tree\` |`;
  const fixedLine = `| \`${MARKER} the gate reads the tree\` |`;
  const baseline = { entries: [{ path: "ledger.md", text: corruptLine }] };

  const excused = scanMarkerCorruption({ files, read: () => `${corruptLine}\n`, baseline });
  assert.equal(excused.baselined, 1);
  assert.equal(excused.violations.length, 0);
  assert.equal(excused.stale.length, 0);

  const expired = scanMarkerCorruption({ files, read: () => `${fixedLine}\n`, baseline });
  assert.equal(expired.baselined, 0);
  assert.deepEqual(
    expired.stale.map((entry) => `${entry.path}: ${entry.text}`),
    [`ledger.md: ${corruptLine}`],
    "an entry whose line no longer exists is stale, so the list cannot outlive the damage it excuses",
  );

  assert.throws(() => loadBaseline({ entries: [{ path: "ledger.md" }] }), /not \{ path, text \}/u);
  assert.deepEqual(loadBaseline(null), { entries: [] });
});

/** A fixture repository: the real gate and baseline, copied where a checkout carries them. */
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "red-proof-markers-"));
  const write = (relative, content) => {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), content);
  };
  write(GATE, readFileSync(join(REPOSITORY_ROOT, GATE)));
  write(BASELINE, JSON.stringify({ why: "fixture", entries: [] }));
  const git = (args) =>
    spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 26,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
  const ok = (args) => {
    const result = git(args);
    assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
    return result.stdout.trim();
  };
  ok(["init", "-q", "-b", "main"]);
  ok(["config", "core.autocrlf", "false"]);
  // Only the fixture's own content is staged: the copied gate and baseline stay untracked, so the population under
  // test is exactly what each case wrote.
  const run = (args) => spawnSync("node", [GATE, ...args], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  const stage = (path) => ok(["add", "--", path]);
  return { root, write, git, ok, run, stage };
};

test("the gate names the file and the line, and exits 1", () => {
  const { write, run, stage } = fixture();
  write("ledger.md", `# ledger\n| \`${CORRUPT} the gate reads the tree\` |\n`);
  stage("ledger.md");

  const result = run([]);
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /✖ red_proof_marker_corrupted:ledger\.md:2 /u, "the finding names the file and its line");
  assert.match(result.stdout, /examined 1 file\(s\) · corrupted 1 marker line\(s\) in 1 file\(s\)/u);
});

test("a baselined tree is clean, and the same tree read from its commit still fires", () => {
  const { write, run, ok, stage } = fixture();
  const corruptLine = `| \`${CORRUPT} the gate reads the tree\` |`;
  write("ledger.md", `# ledger\n${corruptLine}\n`);
  stage("ledger.md");
  ok(["commit", "-q", "-m", "corrupted"]);
  const corruptedSha = ok(["rev-parse", "HEAD"]);

  // The baseline records what is corrupted, which is the only way this gate can be wired while the wave is repaired.
  assert.equal(run(["--write-baseline"]).status, 0);
  const clean = run([]);
  assert.equal(clean.status, 0, `${clean.stdout}${clean.stderr}`);
  assert.match(clean.stdout, /baselined 1 · violations 0 · stale 0/u);

  // A clean worktree does not make the commit clean: the revision is read from its own tree. The baseline is re-recorded
  // against the repaired worktree first, so nothing excuses the commit's line.
  write("ledger.md", `# ledger\n| \`${MARKER} the gate reads the tree\` |\n`);
  assert.equal(run(["--write-baseline"]).status, 0);
  const fromRevision = run(["--revision", corruptedSha]);
  assert.equal(fromRevision.status, 1, `${fromRevision.stdout}${fromRevision.stderr}`);
  assert.match(fromRevision.stderr, /✖ red_proof_marker_corrupted:ledger\.md:2 /u);
});

test("a baselined entry whose line is repaired is stale, and the run fails until it is deleted", () => {
  const { write, run, stage } = fixture();
  write("ledger.md", `# ledger\n| \`${CORRUPT} the gate reads the tree\` |\n`);
  stage("ledger.md");
  assert.equal(run(["--write-baseline"]).status, 0);

  write("ledger.md", `# ledger\n| \`${MARKER} the gate reads the tree\` |\n`);
  const expired = run([]);
  assert.equal(expired.status, 1, `${expired.stdout}${expired.stderr}`);
  assert.match(expired.stderr, /✖ red_proof_marker_baseline_stale:ledger\.md /u);
});

test("a tree holding neither glyph is blocked, never passed", () => {
  const { write, run, stage } = fixture();
  write("plain.md", "# nothing to see\n");
  stage("plain.md");

  const result = run([]);
  assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /red_proof_marker_no_population: examined 0 file\(s\)/u);
});
