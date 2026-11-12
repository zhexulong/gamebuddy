/**
 * Whether the microbenchmark half can measure at all, and - when it cannot - which bytes are not the code under review.
 *
 * WHY THIS EXISTS (measured 2026-11-12). `tools/check-perf-budget.mjs` reported the half as
 * `perf_suite_failed:exits=1` above six module-load stack traces: every bench file reaches the Host's emitted test
 * artifact through `tools/lib/host-test-module.mjs`, and that seam refused it with `artifact_content_mismatch` on inputs
 * another lane was editing. The refusal was right and the reading was not: six stack traces name no file, no
 * modification time, no build stamp and no worktree state, so a lane could not tell "rebuild and measure" from "another
 * lane is mid-flight, come back later" - and the gate paid six processes to say it. The facts a reader needs are exactly
 * those four, and the rule that decided the refusal is `tools/lib/live-run-artifact-freshness.mjs`'s (content, never
 * modification time). This module asks that authority and only adds the attribution around its verdict.
 *
 * WHAT IT DOES NOT DO: rebuild. A gate that rebuilds its own input and then compares numbers against itself is
 * measuring its own escape hatch, so the rebuild command is printed for a human who knows whether the tree is theirs.
 *
 * `worktree=modified` and `worktree=clean` are the two cases that matter, and they are different verdicts: a mismatched
 * input that still matches HEAD means the artifact is simply older than committed source (rebuild when convenient),
 * while one that differs from HEAD means somebody's work in progress is sitting in the tree (rebuilding now would
 * compile an unfinished lane into the numbers).
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  readTestArtifactBuildManifest,
  TEST_ARTIFACT_BUILD_MANIFEST,
} from "../../host/scripts/test-artifact-build-manifest.mjs";
import { assessLiveRunArtifactFreshness, REBUILD_COMMAND } from "../lib/live-run-artifact-freshness.mjs";

/** How many drifting inputs after the first the line names; the rest are counted, never dropped. */
const MAX_LISTED_DRIFT = 4;

const iso = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : "unknown");

const slash = (value) => value.replaceAll("\\", "/");

/** What each worktree state means for the reader deciding whether to rebuild, said once. */
const WORKTREE_MEANING = Object.freeze({
  modified:
    "it differs from HEAD in this checkout, so a lane is mid-flight and rebuilding now would compile its unfinished work",
  clean: "it matches HEAD, so the artifact is simply older than the committed sources",
  unknown:
    "git did not say whether it matches HEAD, so whether a rebuild would make the artifact current is unknown too",
});

/**
 * What one input's bytes are doing in this checkout: `modified` when it differs from HEAD or is untracked, `clean` when
 * it matches HEAD, and `unknown` when git cannot answer - a fixture tree outside a repository answers nothing, and that
 * is stated rather than guessed.
 */
export function worktreeState(root, path) {
  let output;
  try {
    output = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", path], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "unknown";
  }
  return output.trim() === "" ? "clean" : "modified";
}

function inspectInput(root, path) {
  const state = statSync(join(root, path), { throwIfNoEntry: false });
  return { path, mtimeMs: state?.mtimeMs, worktree: worktreeState(root, path) };
}

function artifactLine(manifest) {
  if (manifest === undefined)
    return `  artifact host/dist-test/${TEST_ARTIFACT_BUILD_MANIFEST} is absent, so freshness falls back to modification times`;
  return `  artifact host/dist-test/${TEST_ARTIFACT_BUILD_MANIFEST} built=${iso(manifest.builtAtMs)} inputs=${
    Object.keys(manifest.inputs).length
  }`;
}

/**
 * The reading, as the lines the gate prints: the reason and the population it never measured, the freshness authority's
 * own sentence, then the input's modification time and worktree state, the rest of the drift, the stamp the artifact was
 * built at, and the fact that this gate will not rebuild.
 */
export function describeArtifactStaleness({ verdict, manifest, inspections, benchFiles }) {
  const lines = [`perf_budget_not_measured:artifact_stale:${verdict.reason} compared=0 benchFiles=${benchFiles}`];
  lines.push(`  ${verdict.detail}`);
  const [first, ...rest] = inspections;
  if (first !== undefined)
    lines.push(
      `  input ${first.path} mtime=${iso(first.mtimeMs)} worktree=${first.worktree}: ${WORKTREE_MEANING[first.worktree]}`,
    );
  if (rest.length > 0) {
    const listed = rest
      .slice(0, MAX_LISTED_DRIFT)
      .map(
        (entry) =>
          `${entry.code === undefined ? "" : `${entry.code}:`}${entry.path} mtime=${iso(entry.mtimeMs)} worktree=${entry.worktree}`,
      );
    const remaining = rest.length - MAX_LISTED_DRIFT;
    lines.push(`  drift ${listed.join(" · ")}${remaining > 0 ? `, and ${remaining} more` : ""}`);
  }
  lines.push(artifactLine(manifest));
  lines.push(
    `  this gate never rebuilds before comparing, because an artifact it rebuilt itself would be compared against itself; ` +
      `rebuild when the tree is yours: ${REBUILD_COMMAND}`,
  );
  return lines;
}

/**
 * The verdict for one tree: `{ready: true}` when the artifact describes these sources, otherwise `{ready: false, lines}`
 * with every fact a reader needs to decide between rebuilding and waiting.
 */
export async function assessBenchmarkArtifact({ root, benchFiles }) {
  const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot: root });
  if (!verdict.stale) return { ready: true, verdict };
  let manifest;
  try {
    manifest = await readTestArtifactBuildManifest({ outputRoot: join(root, "host", "dist-test") });
  } catch {
    // An unreadable manifest is already in `verdict.detail`; this module only reports it.
    manifest = undefined;
  }
  const drift = verdict.drift ?? [];
  const paths =
    drift.length > 0
      ? drift
      : verdict.inputs?.path === undefined
        ? []
        : [{ path: slash(relative(root, verdict.inputs.path)) }];
  const inspections = paths.map((entry) => ({ ...entry, ...inspectInput(root, entry.path) }));
  return {
    ready: false,
    verdict,
    lines: describeArtifactStaleness({ verdict, manifest, inspections, benchFiles }),
  };
}
