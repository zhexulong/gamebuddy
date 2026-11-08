#!/usr/bin/env node
/**
 * Guard: the protected release lane READS live evidence instead of producing it.
 *
 * WHY (owner decision, 2026-11-07)
 *
 * `release-windows.yml` used to drive four live surfaces itself, each behind `secrets.CPA_OAI_API_KEY`:
 * the Tavern management operation evidence (three real embedded provider turns), the Tavern release live
 * gate, the Tavern frontend conformance gate and the Companion memory fold gate. A protected release
 * lane therefore could not run at all without a provider credential, and the credential sat in the one
 * job that publishes a player artifact. The lane is now credential-free: those steps are gone, and the
 * release claim they carried is read from committed evidence instead.
 *
 * The declaration is weaker than it was, and this file exists so the weakness is a reading rather than a
 * silence. The lane no longer proves "three real provider turns happened during this release"; it proves
 * "the newest evidence committed for this surface is sound, is attributable to this tree, and is not
 * older than `MAX_EVIDENCE_DRIFT_DAYS`". A surface nobody has measured says so by name, on every run, in
 * the summary line - it does not become a pass, and it does not become a silent omission either.
 *
 * THE POPULATION is `EVIDENCE_SURFACES`: one row per release surface, naming the file that carries its
 * evidence. It is this file's own declaration because the surfaces ARE the release claim's structure -
 * the removed steps are its members - and a directory scan of `tools/fixtures/live-evidence` could not
 * tell a new surface from a stray file. `examined N` prints the derived count, and a population of zero
 * is `blocked` rather than a vacuous pass: a gate that examined no surface has measured nothing.
 *
 * THE QUESTION, per surface: is the evidence a claim about THIS tree?
 *
 *   * `schema` must be `gamebuddy_release_live_evidence/v1` and `surface` must be the row's own name, so
 *     a file copied from the other surface is named rather than read as this one's.
 *   * `pinnedSha` must be a 40-hex commit that `git merge-base --is-ancestor` accepts for HEAD. A pin from
 *     a side branch is evidence about code this release does not contain; a pin git has never seen is a
 *     claim with no object behind it, and the two are reported apart because they are different repairs.
 *   * `capturedAt` must be within `MAX_EVIDENCE_DRIFT_DAYS` of the pinned commit's own committer date, in
 *     either direction. Before the pin, the evidence describes a tree older than the one it claims
 *     (`evidence_predates_pin`); long after it, the pin has stopped describing what was measured
 *     (`evidence_pin_stale`). Both are the same defect - the evidence is not attributable to the commit
 *     it names - and the window is symmetric because the drift is.
 *   * `verdict` is one of `passed`, `failed`, `not_measured`, and each reading's `result` uses the same
 *     three words. A `passed` surface whose readings record a `not_measured` or `failed` result is
 *     `evidence_verdict_contradicted`: the summary cannot be stronger than the rows under it.
 *   * `not_measured` must name its cause as `<code>: <the concrete thing>`; the code is what the summary
 *     line carries, so "which surface is unmeasured, and why" is one line of output rather than a
 *     paragraph nobody reads.
 *
 * WHAT THE VERDICT MEANS. `passed` and `not_measured` exit 0 - an unavailable measurement is not a
 * failure, and the release lane must be able to run on a machine with no provider credential at all.
 * `not_measured` prints, by name, every surface it applies to. A `failed` surface, any unreadable or
 * unattributable evidence, and an empty population all exit 1 with the member named.
 *
 * Usage:
 *   node tools/check-release-live-evidence.mjs [--root <dir>] [--evidence-root <dir>] [--quiet]
 *
 * Output is one compact JSON object on stdout: `{gate,population,surfaces,violations,status}`; the
 * human summary goes to stderr. Exit is 0 for `passed` or `not_measured`, 1 for `failed` or `blocked`,
 * and 2 for an error in the gate itself. `--root` and `--evidence-root` exist so the falsifier can point
 * the gate at a scratch `git init` repository; the defaults are this repository.
 *
 * red-proof: inject  a pin on a side branch that is not an ancestor of HEAD -> `evidence_pin_not_ancestor_of_head`
 *                    naming the surface and the commit (tools/check-release-live-evidence.test.mjs)
 * red-proof: inject  capturedAt 60 days before the pinned commit -> `evidence_predates_pin`; 60 days after
 *                    it -> `evidence_pin_stale` (tools/check-release-live-evidence.test.mjs)
 * red-proof: inject  a declaration with no surface -> `status:"blocked"` and exit 1, with `examined 0`
 *                    (tools/check-release-live-evidence.test.mjs)
 * red-proof: fixture one measured surface beside one `not_measured` surface -> exit 0, and the summary line
 *                    names only the unmeasured one (tools/check-release-live-evidence.test.mjs)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_DIRECTORY = join("tools", "fixtures", "live-evidence");

export const EVIDENCE_SCHEMA = "gamebuddy_release_live_evidence/v1";
/** The three words a surface verdict and a reading result share, so neither can invent a fourth state. */
export const RESULTS = Object.freeze(["passed", "failed", "not_measured"]);
/** How far `capturedAt` may sit from the pinned commit before the evidence stops describing that pin. */
export const MAX_EVIDENCE_DRIFT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const REASON = /^([a-z][a-z0-9_]*): \S/u;
/** The release surfaces and the file that carries each one's evidence. The population, declared once. */
export const EVIDENCE_SURFACES = Object.freeze([
  { surface: "memory", file: "memory.json" },
  { surface: "tavern", file: "tavern.json" },
  { surface: "player-survival", file: "player-survival.json" },
]);

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

/** The commit's own committer date, or null when git cannot read the object as a commit. */
function commitDate(cwd, sha) {
  const result = git(cwd, ["log", "-1", "--format=%cI", sha]);
  if (result.status !== 0) return null;
  const value = String(result.stdout ?? "").trim();
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? null : { value, milliseconds };
}

/** schema, surface name and verdict word: is this file the claim it is filed under? */
function judgeIdentity({ document, surface }) {
  const findings = [];
  if (document?.schema !== EVIDENCE_SCHEMA)
    findings.push(`evidence_schema_unknown:${surface}:${String(document?.schema)}`);
  if (document?.surface !== surface) findings.push(`evidence_surface_mismatch:${surface}:${String(document?.surface)}`);
  if (!RESULTS.includes(document?.verdict))
    findings.push(`evidence_verdict_unknown:${surface}:${String(document?.verdict)}`);
  // A `failed` surface is the release claim's own red, and it is a finding here so the lane cannot pass over
  // it: the reading and the pass have to disagree somewhere, and this is where.
  if (document?.verdict === "failed") findings.push(`evidence_verdict_failed:${surface}`);
  return findings;
}

/** The rows under the verdict: identified, uniquely spelled, and never stronger than the summary above them. */
function judgeReadings({ document, surface, verdict }) {
  const readings = Array.isArray(document?.readings) ? document.readings : null;
  if (readings === null) return [`evidence_readings_missing:${surface}`];
  const findings = [];
  if ((verdict === "passed" || verdict === "failed") && readings.length === 0)
    findings.push(`evidence_readings_empty:${surface}`);
  const seen = new Set();
  for (const reading of readings) {
    const id = typeof reading?.id === "string" ? reading.id.trim() : "";
    if (id === "") {
      findings.push(`evidence_reading_unidentified:${surface}`);
      continue;
    }
    if (seen.has(id)) findings.push(`evidence_reading_duplicated:${surface}:${id}`);
    seen.add(id);
    if (!RESULTS.includes(reading?.result)) {
      findings.push(`evidence_reading_result_unknown:${surface}:${id}:${String(reading?.result)}`);
      continue;
    }
    // Only the direction that matters: a surface claiming a pass cannot carry a row that says the thing was
    // not measured. A `not_measured` surface may legitimately hold a measured row beside the gap.
    if (verdict === "passed" && reading.result !== "passed")
      findings.push(`evidence_verdict_contradicted:${surface}:${id}:${reading.result}`);
  }
  return findings;
}

/**
 * A surface may carry its content from a second file instead of copying it. The copy is the defect this checks
 * for: the readings and the release claim are the same fact, and a hand-maintained second spelling of a count
 * is a disagreement scheduled for later. So `source` names the file and declares the counts, and the gate reads
 * that file and requires the two to agree.
 */
function judgeSource({ document, surface, root }) {
  const source = document?.source;
  if (source === undefined) return { findings: [], source: null };
  const file = typeof source?.file === "string" ? source.file : "";
  if (file === "" || !existsSync(join(root, file)))
    return { findings: [`evidence_source_missing:${surface}:${file}`], source: null };
  let carried;
  try {
    carried = JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch {
    return { findings: [`evidence_source_unparseable:${surface}:${file}`], source: null };
  }
  const findings = [];
  for (const field of ["examined", "agreed", "disagreements"])
    if (field in source && source[field] !== carried?.[field])
      findings.push(
        `evidence_source_mismatch:${surface}:${field}:${String(source[field])} declared, ${String(carried?.[field])} in ${file}`,
      );
  // The source's own unproven list is not optional reading: it is what the verdict does NOT cover.
  const notProven = Array.isArray(carried?.notProven) ? carried.notProven : [];
  return {
    findings,
    source: { file, examined: carried?.examined ?? null, disagreements: carried?.disagreements ?? null, notProven },
  };
}

/**
 * Is the pin still describing this tree? A pin behind HEAD is fine when nothing it covers moved since: that is a
 * difference analysis rather than a re-run, and it says so instead of asserting freshness it did not measure.
 */
function judgeScope({ document, surface, pin, root }) {
  const scope = Array.isArray(document?.scope) ? document.scope.filter((p) => typeof p === "string" && p !== "") : [];
  if (scope.length === 0) return { findings: [`evidence_scope_unstated:${surface}`], moved: null };
  if (pin === null) return { findings: [], moved: null };
  const head = String(git(root, ["rev-parse", "HEAD"]).stdout ?? "").trim();
  if (head === pin.sha) return { findings: [], moved: { commits: 0, paths: [] } };
  const behind = git(root, ["rev-list", "--count", `${pin.sha}..HEAD`]);
  const commits = Number.parseInt(String(behind.stdout ?? "").trim(), 10);
  const changed = git(root, ["rev-list", "--count", `${pin.sha}..HEAD`, "--", ...scope]);
  const inScope = Number.parseInt(String(changed.stdout ?? "").trim(), 10);
  if (!Number.isFinite(inScope)) return { findings: [`evidence_scope_unreadable:${surface}`], moved: null };
  if (inScope > 0) {
    const paths = String(git(root, ["diff", "--name-only", `${pin.sha}..HEAD`, "--", ...scope]).stdout ?? "")
      .trim()
      .split("\n")
      .filter(Boolean);
    return {
      findings: [
        `evidence_scope_changed_since_pin:${surface}:${String(inScope)} commit(s) touched ${String(paths.length)} file(s), ` +
          `first being ${paths[0] ?? "(unreadable)"}`,
      ],
      moved: { commits: Number.isFinite(commits) ? commits : null, paths },
    };
  }
  return {
    findings: [],
    moved: { commits: Number.isFinite(commits) ? commits : null, paths: [], inScope },
  };
}

/** An unmeasured surface must name its cause; the code before the colon is what the summary line carries. */
function judgeReason({ document, surface, verdict }) {
  if (verdict !== "not_measured") return [];
  return typeof document?.reason === "string" && REASON.test(document.reason)
    ? []
    : [`evidence_reason_unstated:${surface}`];
}

/** The commit the evidence describes: present, an ancestor of HEAD, and readable as a dated commit. */
function judgePin({ document, surface, root }) {
  const sha = typeof document?.pinnedSha === "string" ? document.pinnedSha : "";
  if (!COMMIT_SHA.test(sha)) return { sha: null, pin: null, findings: [`evidence_pin_malformed:${surface}:${sha}`] };
  if (git(root, ["cat-file", "-e", `${sha}^{commit}`]).status !== 0)
    return { sha, pin: null, findings: [`evidence_pin_unknown:${surface}:${sha}`] };
  // A pin from a side branch is evidence about code this release does not contain.
  if (git(root, ["merge-base", "--is-ancestor", sha, "HEAD"]).status !== 0)
    return { sha, pin: null, findings: [`evidence_pin_not_ancestor_of_head:${surface}:${sha}`] };
  const date = commitDate(root, sha);
  return date === null
    ? { sha, pin: null, findings: [`evidence_pin_date_unreadable:${surface}:${sha}`] }
    : { sha, pin: { ...date, sha }, findings: [] };
}

/** How far the capture sits from the commit it names, in either direction, because the drift is. */
function judgeCapturedAt({ document, surface, pin }) {
  const captured = typeof document?.capturedAt === "string" ? Date.parse(document.capturedAt) : Number.NaN;
  if (Number.isNaN(captured)) return [`evidence_captured_at_invalid:${surface}:${String(document?.capturedAt)}`];
  if (pin === null) return [];
  const drift = Math.round((captured - pin.milliseconds) / DAY_MS);
  const findings = [];
  if (drift > MAX_EVIDENCE_DRIFT_DAYS) findings.push(`evidence_pin_stale:${surface}:${drift}d after ${pin.sha}`);
  if (drift < -MAX_EVIDENCE_DRIFT_DAYS) findings.push(`evidence_predates_pin:${surface}:${-drift}d before ${pin.sha}`);
  return findings;
}

/**
 * One surface's evidence, judged. Every finding starts with the surface name, because the surface is the thing
 * a release reader has to open; the code follows so the member is greppable.
 */
function judgeSurface({ entry, evidenceRoot, root, report }) {
  const path = join(evidenceRoot, entry.file);
  if (!existsSync(path)) return { ...report, findings: [`evidence_missing:${entry.surface}:${entry.file}`] };
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ...report, findings: [`evidence_unparseable:${entry.surface}:${entry.file}`] };
  }
  const verdict = RESULTS.includes(document?.verdict) ? document.verdict : null;
  const committed = judgePin({ document, surface: entry.surface, root });
  const carried = judgeSource({ document, surface: entry.surface, root });
  const scoped = judgeScope({ document, surface: entry.surface, pin: committed.pin, root });
  const findings = [
    ...judgeIdentity({ document, surface: entry.surface }),
    ...judgeReadings({ document, surface: entry.surface, verdict }),
    ...judgeReason({ document, surface: entry.surface, verdict }),
    ...committed.findings,
    ...judgeCapturedAt({ document, surface: entry.surface, pin: committed.pin }),
    ...carried.findings,
    ...scoped.findings,
  ];
  return {
    ...report,
    verdict,
    reason: typeof document?.reason === "string" ? (document.reason.match(REASON)?.[1] ?? null) : null,
    pinnedSha: committed.sha,
    capturedAt: typeof document?.capturedAt === "string" ? document.capturedAt : null,
    readings: Array.isArray(document?.readings) ? document.readings.length : 0,
    source: carried.source,
    moved: scoped.moved,
    findings,
  };
}

/** `failed` outranks `not_measured`, which outranks `passed`: a finding is never renamed by a quieter row. */
function statusOf({ violations, surfaces }) {
  if (violations.length > 0) return "failed";
  return surfaces.some((surface) => surface.verdict === "not_measured") ? "not_measured" : "passed";
}

/**
 * The reading over the declared surfaces. `root` is where git runs and `evidenceRoot` is where the files are,
 * so a falsifier can drive a scratch repository while the CLI reads this one.
 */
export function auditReleaseLiveEvidence({
  root = REPOSITORY_ROOT,
  evidenceRoot = join(root, EVIDENCE_DIRECTORY),
  surfaces = EVIDENCE_SURFACES,
} = {}) {
  const judged = surfaces.map((entry) =>
    judgeSurface({
      entry,
      evidenceRoot,
      root,
      report: { surface: entry.surface, verdict: null, reason: null, pinnedSha: null, capturedAt: null, readings: 0 },
    }),
  );
  const population = judged.length;
  if (population === 0)
    return { gate: "release-live-evidence", population: 0, surfaces: [], violations: [], status: "blocked" };
  const violations = judged.flatMap((surface) => surface.findings).sort();
  const surfacesRead = judged.map(({ findings, ...surface }) => surface);
  return {
    gate: "release-live-evidence",
    population,
    surfaces: surfacesRead,
    violations,
    status: statusOf({ violations, surfaces: surfacesRead }),
  };
}

/** `surface(verdict code)` - which surface, and the word or cause code its evidence carries. */
function describe(surface) {
  const detail = surface.verdict === "not_measured" ? surface.reason : null;
  return `${surface.surface}(${surface.verdict ?? "unreadable"}${detail === null ? "" : ` ${detail}`})`;
}

/**
 * The human summary, and the exit status that goes with it. `out` is a parameter so a falsifier can read
 * the lines instead of printing them into its own output; the CLI leaves it at stderr.
 */
export function reportReading(reading, out = process.stderr) {
  if (reading.status === "blocked") {
    out.write(
      "release_live_evidence blocked: examined 0 - EVIDENCE_SURFACES declares no surface, so no release claim was read\n",
    );
    return 1;
  }
  out.write(
    `release_live_evidence examined ${reading.population} surface(s): ${reading.surfaces.map(describe).join(", ")}\n`,
  );
  const unmeasured = reading.surfaces.filter((surface) => surface.verdict === "not_measured");
  if (unmeasured.length > 0)
    out.write(
      `release_live_evidence not_measured: ${unmeasured.length} of ${reading.population} surface(s) carry no measured ` +
        `verdict - ${unmeasured.map((surface) => `${surface.surface} (${surface.reason ?? "no reason given"})`).join(", ")}\n`,
    );
  // What the evidence itself did not cover. A green release reading must not be readable as full coverage: the
  // surfaces name their own gaps, and this line repeats them where the release reader is looking.
  const gaps = reading.surfaces.flatMap((surface) =>
    (surface.source?.notProven ?? []).map((item) => `${surface.surface}: ${item}`),
  );
  if (gaps.length > 0)
    out.write(
      `release_live_evidence not_proven: ${gaps.length} declared gap(s)\n${gaps.map((gap) => `  ${gap}\n`).join("")}`,
    );
  // A pin behind HEAD is a difference analysis, not a fresh measurement, and it is reported as one.
  for (const surface of reading.surfaces)
    if (
      surface.verdict !== null &&
      surface.moved !== null &&
      surface.moved.commits !== null &&
      surface.moved.commits > 0
    )
      out.write(
        `release_live_evidence behind: ${surface.surface} was measured at ${String(surface.pinnedSha).slice(0, 8)}, ` +
          `${surface.moved.commits} commit(s) before HEAD, and nothing it covers changed since\n`,
      );
  if (reading.violations.length > 0) {
    out.write(`release_live_evidence failed: ${reading.violations.length} finding(s)\n`);
    for (const violation of reading.violations) out.write(`  ${violation}\n`);
    return 1;
  }
  return 0;
}

function main(argv) {
  const argumentValue = (name) => {
    const index = argv.indexOf(name);
    const value = index >= 0 ? argv[index + 1] : undefined;
    return typeof value === "string" && !value.startsWith("--") ? value : undefined;
  };
  const root = argumentValue("--root");
  const evidenceRoot = argumentValue("--evidence-root");
  const resolvedRoot = root === undefined ? REPOSITORY_ROOT : resolve(root);
  const reading = auditReleaseLiveEvidence({
    root: resolvedRoot,
    evidenceRoot: evidenceRoot === undefined ? join(resolvedRoot, EVIDENCE_DIRECTORY) : resolve(evidenceRoot),
  });
  process.stdout.write(`${JSON.stringify(reading)}\n`);
  // `--quiet` keeps stdout, which is the reading itself; the summary and its exit status are the same
  // judgement either way, so quiet cannot turn a failure into a pass.
  return reportReading(reading, argv.includes("--quiet") ? { write: () => true } : process.stderr);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`release_live_evidence error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
