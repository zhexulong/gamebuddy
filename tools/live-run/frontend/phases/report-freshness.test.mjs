/*
 * red-proof: inject  with the G-D gate removed from report.mjs (the `examineEvidence` call and its
 * refusal branch), this suite fails on
 *
 *   "115 PNGs dated two days before the run is a refusal, not a pin"
 *     expected 5, received 0 — and README.txt then carries `pinned commit <sha>` above screenshots
 *     that never came from it, which is the 2026-11-05 report verbatim: `--commit HEAD` into the
 *     reused --out D:\gb-modcheck\frontend-h wrote `pinned 250bd142` above 115 PNGs dated 11-04.
 *
 * The provenance is that real run; the stage below is forged in a temp directory, so the gate is
 * exercised without a 20-minute live run and without touching the real out root.
 *
 * The two halves are asserted apart, because neither implies the other: the sha half refuses a report
 * whose claim is not the tree the artifacts were built from, the mtime half refuses artifacts that
 * belong to an earlier batch. The 2026-11-05 run is caught by the mtime half only - its worktree
 * really was at 250bd142 and the pin was written from it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { defaultStageFor, KIT_ROOT, REPO_ROOT, runPaths, saveRunConfig } from "../lib/config.mjs";

const PHASE = join(KIT_ROOT, "phases", "report.mjs");
const SOURCE = readFileSync(PHASE, "utf8");

// Read from the phase, not written here a second time: the boundary the suite asserts must be the
// boundary the phase applies.
const WINDOW_MS = (SOURCE.match(/const STALE_BATCH_WINDOW_MS = ([^;]+);/u)?.[1] ?? "")
  .match(/\d+/gu)
  .map(Number)
  .reduce((product, factor) => product * factor, 1);

const DAY_MS = 24 * 60 * 60 * 1000;
const touch = (path, ms) => utimesSync(path, new Date(ms), new Date(ms));

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${(result.stderr ?? "").slice(0, 400)}`);
  return (result.stdout ?? "").trim();
}

/**
 * A stage shaped like a real run's, forged under a temp root: a pinned worktree that is a real git
 * repository (so `git -C <worktree> rev-parse HEAD` answers with a real commit), the run config, the
 * pin log that dates the run, and an out root holding the artifacts the report would cite.
 */
async function fabricate({ runStartMs, claimedSha = null, files = [], wire = null }) {
  const root = await mkdtemp(join(tmpdir(), "frontend-report-freshness-"));
  const outRoot = join(root, "out");
  const run = {
    tag: "report-freshness",
    outRoot,
    stageRoot: defaultStageFor(outRoot),
    // The keys the README prints unconditionally, at the values a real run.json carries; a stage without
    // them is not a stage this phase can be run against.
    runtimeFixture: join(root, "runtime"),
    gameDir: join(root, "game"),
    edgeExe: join(root, "msedge.exe"),
    homeLocalAppData: join(root, "localappdata"),
    credentialPresent: false,
  };
  const paths = runPaths(run);

  mkdirSync(paths.worktree, { recursive: true });
  git(["init", "-q"], paths.worktree);
  git(
    ["-c", "user.email=gate@example.invalid", "-c", "user.name=gate", "commit", "-q", "--allow-empty", "-m", "pin"],
    paths.worktree,
  );
  const worktreeSha = git(["rev-parse", "HEAD"], paths.worktree);

  const pinned = { ...run, commit: claimedSha ?? worktreeSha, shortCommit: (claimedSha ?? worktreeSha).slice(0, 12) };
  saveRunConfig(paths, pinned);

  mkdirSync(paths.logsDir, { recursive: true });
  writeFileSync(paths.pinLog, "=== PIN: detached worktree (NO OVERLAY EVER) ===\nDONE-PIN\n", "utf8");
  touch(paths.pinLog, runStartMs);
  writeFileSync(
    paths.launchStateFile,
    JSON.stringify({ kind: "mounted", mounted: true, port: 1, cdpPort: 1, title: "t", stderrBytes: 0 }, null, 1),
    "utf8",
  );
  touch(paths.launchStateFile, runStartMs + 60_000);

  mkdirSync(outRoot, { recursive: true });
  for (const file of files) {
    const path = join(outRoot, file.name);
    writeFileSync(path, file.body ?? "measured\n", "utf8");
    touch(path, file.mtimeMs);
  }
  if (wire !== null) {
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(paths.wireRequestsFile, `${JSON.stringify({ source: "capture" })}\n`, "utf8");
    touch(paths.wireRequestsFile, wire.mtimeMs);
  }

  return { root, outRoot, paths, worktreeSha, examined: files.length + (wire === null ? 0 : 1) };
}

const runPhase = (paths) =>
  spawnSync(process.execPath, [PHASE, paths.runConfigFile], { encoding: "utf8", timeout: 120_000 });

const screenshots = (count, mtimeMs) =>
  Array.from({ length: count }, (_, index) => ({ name: `${String(index + 1).padStart(2, "0")}-surface.png`, mtimeMs }));

const readmeOf = (outRoot) => readFileSync(join(outRoot, "README.txt"), "utf8");

test("the freshness window is a real positive number read from the phase", () => {
  assert.ok(Number.isFinite(WINDOW_MS) && WINDOW_MS > 0, `could not read STALE_BATCH_WINDOW_MS from ${PHASE}`);
});

test("115 PNGs dated two days before the run is a refusal, not a pin", async () => {
  const runStartMs = Date.now() - 60 * 60 * 1000;
  const stage = await fabricate({
    runStartMs,
    files: [...screenshots(115, runStartMs - 2 * DAY_MS), { name: "a-surfaces.txt", mtimeMs: runStartMs - 2 * DAY_MS }],
  });
  try {
    const result = runPhase(stage.paths);

    assert.equal(
      result.status,
      5,
      `expected exit 5 (stale evidence), got ${result.status}: ${(result.stdout ?? "").slice(-400)}`,
    );
    assert.match(result.stdout, /report_evidence_predates_run:01-surface\.png:/u);
    assert.match(result.stdout, /STALE_ARTIFACT_CONTAMINATION: \d+ cited artifact\(s\)/u);
    assert.match(result.stdout, /report_evidence_predates_run:01-surface\.png:[^\n]+ < /u);

    const readme = readmeOf(stage.outRoot);
    assert.match(readme, /REPORT REFUSED/u);
    assert.doesNotMatch(
      readme,
      /pinned commit/u,
      "a refused report must not name a commit above artifacts it did not produce",
    );
    assert.doesNotMatch(readme, /SCREENSHOTS/u, "the refusal must not re-publish the suspect set's measurements");
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
});

test("artifacts this run produced are pinned, with the count, the oldest mtime and the run start", async () => {
  const runStartMs = Date.now() - 60 * 60 * 1000;
  const stage = await fabricate({
    runStartMs,
    files: [
      ...screenshots(3, runStartMs + 30_000),
      { name: "a-surfaces.txt", mtimeMs: runStartMs + 20_000 },
      { name: "b-characters.txt", mtimeMs: runStartMs + 21_000 },
    ],
    wire: { mtimeMs: runStartMs + 40_000 },
  });
  try {
    const result = runPhase(stage.paths);

    assert.equal(
      result.status,
      0,
      `expected a pinned report, got ${result.status}: ${(result.stdout ?? "").slice(-600)}`,
    );
    assert.match(result.stdout, new RegExp(`examined ${stage.examined} artifacts`, "u"));
    assert.ok(stage.examined > 0, "the passing run must have examined at least one artifact");
    assert.match(result.stdout, /DONE-REPORT/u);

    const readme = readmeOf(stage.outRoot);
    assert.match(readme, new RegExp(`pinned commit +${stage.worktreeSha}`, "u"));
    assert.match(readme, new RegExp(`evidence +${stage.examined} cited artifacts · oldest mtime `, "u"));
    assert.match(readme, /run start = mtime of \S*pin\.log/u);
    // The main checkout's HEAD is a reading, not a verdict: this fixture pins a temp repository's
    // commit, which is not main HEAD, and the pin is still written.
    assert.match(readme, /HEAD now +[0-9a-f]{40}/u);
    assert.match(readme, /observation only, NOT a verdict/u);
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
});

test("no cited artifacts at all refuses in its own words", async () => {
  const runStartMs = Date.now() - 60 * 60 * 1000;
  const stage = await fabricate({ runStartMs, files: [] });
  try {
    const result = runPhase(stage.paths);

    assert.equal(result.status, 5, `expected exit 5, got ${result.status}`);
    assert.match(result.stdout, /report_no_artifacts:no_cited_evidence_under_/u);
    assert.match(result.stdout, /examined 0 /u);
    assert.doesNotMatch(readmeOf(stage.outRoot), /pinned commit/u);
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
});

test("a claim that is not the pinned tree refuses even when every artifact is fresh", async () => {
  const runStartMs = Date.now() - 60 * 60 * 1000;
  const claimed = "250bd142".padEnd(40, "0");
  const stage = await fabricate({
    runStartMs,
    claimedSha: claimed,
    files: [...screenshots(2, runStartMs + 30_000), { name: "a-surfaces.txt", mtimeMs: runStartMs + 30_000 }],
  });
  try {
    const result = runPhase(stage.paths);

    assert.equal(result.status, 5, `expected exit 5, got ${result.status}`);
    assert.match(result.stdout, new RegExp(`report_pinned_sha_mismatch:${claimed}!=${stage.worktreeSha}`, "u"));
    assert.doesNotMatch(
      result.stdout,
      /report_evidence_predates_run/u,
      "the mtime half is satisfied here by construction",
    );
    assert.doesNotMatch(readmeOf(stage.outRoot), /pinned commit/u);
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
});

test("the ten-minute window decides 'resumed batch' from 'another run's leftovers'", async () => {
  const runStartMs = Date.now() - 60 * 60 * 1000;
  const inside = await fabricate({ runStartMs, files: screenshots(1, runStartMs - WINDOW_MS) });
  try {
    const result = runPhase(inside.paths);
    assert.equal(result.status, 5, "an artifact before the run's start is refused even inside the window");
    assert.match(result.stdout, /report_evidence_predates_run:01-surface\.png:/u);
    assert.doesNotMatch(
      result.stdout,
      /STALE_ARTIFACT_CONTAMINATION/u,
      "exactly at the window is a resumed batch, not a leftover",
    );
  } finally {
    await rm(inside.root, { recursive: true, force: true });
  }

  const beyond = await fabricate({ runStartMs, files: screenshots(1, runStartMs - WINDOW_MS - 60_000) });
  try {
    const result = runPhase(beyond.paths);
    assert.equal(result.status, 5, "an artifact older than the window is refused");
    assert.match(result.stdout, /STALE_ARTIFACT_CONTAMINATION/u);
  } finally {
    await rm(beyond.root, { recursive: true, force: true });
  }
});

test("the refusal names what is missing and what appeared, against the capture phase's own table", async () => {
  const runStartMs = Date.now() - 60 * 60 * 1000;
  const stage = await fabricate({
    runStartMs,
    files: [
      ...screenshots(1, runStartMs - 2 * DAY_MS),
      { name: "a-surfaces.txt", mtimeMs: runStartMs - 2 * DAY_MS },
      { name: "witness-extra.txt", mtimeMs: runStartMs - 2 * DAY_MS },
    ],
  });
  try {
    const result = runPhase(stage.paths);

    assert.equal(result.status, 5, `expected exit 5, got ${result.status}`);
    assert.match(result.stdout, /\+ newly added: witness-extra\.txt/u);
    assert.match(result.stdout, /- missing: .*\bb-characters\.txt\b/u);
    // Two drivers only the capture phase's table knows: a population taken from this report's own
    // reader list could never name them.
    assert.match(result.stdout, /- missing: .*\bs-avatar-upload\.txt\b/u);
    assert.match(result.stdout, /- missing: .*\bt-installation-discovery\.txt\b/u);
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
});

test("the worktree reading is taken from the stage, not from the repository the tool is checked out in", async () => {
  const stage = await fabricate({ runStartMs: Date.now(), files: screenshots(1, Date.now()) });
  try {
    const worktreeSha = stage.worktreeSha;
    const mainSha = git(["rev-parse", "HEAD"], REPO_ROOT);
    assert.notEqual(
      worktreeSha,
      mainSha,
      "the fixture worktree must not be the main checkout, or the reading proves nothing",
    );
    assert.equal(git(["rev-parse", "HEAD"], stage.paths.worktree), worktreeSha);
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
});
