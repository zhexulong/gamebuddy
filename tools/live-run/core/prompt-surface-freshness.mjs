import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

/**
 * The prompt a run is about to measure, and the product branch that owns it.
 *
 * WHY. A live run's numbers belong to the prompt it measured, and the prompt is not all in this checkout. Round 47
 * and round 48 were launched from a worktree whose `assets/tavern/presets/amber-game.json` was byte-identical to
 * `4210d14e^`, while `main` held two commits that withdraw the chatter-forcing sentences those rounds were then
 * blamed for ("第一拍本能接话", "8~25 字以内收尾", "一句话说清就停"). Nothing refused to start: the artifact
 * freshness gate beside this one compares `host/dist-test` against `host/src` and is blind to `assets/`, so the run
 * spent a game launch, a fixture prepare and a session measuring a prompt that had already been fixed. The
 * measurement was not wrong; it belonged to a different prompt than the one the reading was attributed to.
 *
 * POPULATION (derived from the launched revision's own tree with `git ls-tree -r`, never a hand list; the count is
 * printed and zero is a refusal). A path belongs when one of `PROMPT_SURFACE_RULES` accepts it:
 *   1. `assets/tavern/presets/**` - the shipped cards, presets and world books: the text itself.
 *   2. `host/src/games/<game>/prompt/**` - the per-game conduct and plan description the floor splices in.
 *   3. a production module whose name segment is `prompt-floor`, `identity-profile`, `post-history-instructions` or
 *      `persona`, under `host/src/` or `tools/live-run/` - the modules that compose, carry or provision that text.
 * A new card, a new game's conduct file or a renamed prompt module therefore joins by existing. Tests and
 * test-support files are excluded: they assert about the prompt, they are not read by the model.
 *
 * STATED LIMIT. Preset *plumbing* (`host/src/tavern/preset-store.ts`, `preset-placement.ts`, `preset-sampling.ts`)
 * is deliberately outside the population. A change there is a change in behaviour, which a live run legitimately
 * measures; a change in the text is a change in what the run was about.
 *
 * THE CONDITION is content, not commit identity. For every population path the launched revision is compared with
 * each existing product ref (`origin/main`, `main`) and a commit is counted against it only when the ref holds a
 * commit touching that path whose PATCH the revision does not already carry. Identity was the first thing tried and
 * it is wrong twice over: a worktree that cherry-picked the prompt commits holds their content under new hashes and
 * would stay red forever, and a local `origin/main` that has not been fetched holds older content and would report a
 * revision that is AHEAD as behind. Patch equivalence says "this work is in the revision" whether it arrived by
 * merge, rebase or cherry-pick; the content comparison that decides whether a path is even worth asking about says
 * "the revision is not ahead on this file". Both existing refs are examined and their findings are unioned, because a
 * stale remote is not a licence to launch on a tree that is missing prompt work the local branch holds.
 *
 * THE COST, and why it is now measured here. `git log --cherry-pick --right-only <revision>...<ref> -- <path>` asks
 * the right question and pays for the whole history to answer it: it computes a patch id for every commit in the
 * symmetric difference, whatever the pathspec says, because a cherry-picked copy can sit anywhere in the range. On
 * this repository (3580 tracked paths, 380 commits of divergence) one such call measured 9,500-10,300 ms and was
 * made once per differing path per ref; a launch on a GOOD tree spent 46,767 ms here between `launcher_start` and
 * `prompt_surface_checked`, every launch. The same answer costs less when the question is asked per commit instead of
 * per range: a commit counts against the revision only if it touches the path, so its patch id is only needed for
 * the handful of commits that do. Measured on the same tree: 46,767 ms -> see `prompt_surface_check` below, printed
 * by the check itself with every term in it, so the next reading of this file does not have to time the launcher.
 *
 * WHAT IS NOT MEASURED. No product ref (`no_product_ref`), a shallow clone (the branch's history is exactly what is
 * missing, so the question cannot be answered), an unresolvable revision, no git at all, or a derived population of
 * zero are all refusals with a named reason, never a pass. Detachment is NOT one of them: the launched commit is
 * what the run reads, and naming it needs no branch.
 */

/** The product branches, in the order they are named in a refusal. A ref that does not exist is skipped by name. */
export const PRODUCT_REFS = Object.freeze(["origin/main", "main"]);

const TEST_PATH = /(?:\.test|\.private\.test|\.test-support|\.spec)\.[cm]?[jt]s$/u;
const PROMPT_NAME_SEGMENT =
  /(?:^|[.\-/])(?:prompt-floor|identity-profile|post-history-instructions|persona)(?:[.\-/]|$)/u;
const PROMPT_MODULE_ROOTS = Object.freeze(["host/src/", "tools/live-run/core/"]);
const PROMPT_MODULE_SUFFIX = /\.(?:ts|mts|mjs)$/u;
const GAME_PROMPT_TEXT = /^host\/src\/games\/[^/]+\/prompt\/.+\.(?:ts|mjs)$/u;
const PRESET_TEXT = "assets/tavern/presets/";

/**
 * The derivation, as data: each rule names itself so a refusal can say which rule admitted a path.
 * `matches` receives a repo-relative, forward-slashed path.
 */
export const PROMPT_SURFACE_RULES = Object.freeze([
  Object.freeze({
    id: "preset_text",
    matches: (path) => path.startsWith(PRESET_TEXT),
  }),
  Object.freeze({
    id: "game_prompt_text",
    matches: (path) => GAME_PROMPT_TEXT.test(path),
  }),
  Object.freeze({
    id: "prompt_module",
    matches: (path) =>
      PROMPT_MODULE_SUFFIX.test(path) &&
      !TEST_PATH.test(path) &&
      PROMPT_MODULE_ROOTS.some((root) => path.startsWith(root)) &&
      PROMPT_NAME_SEGMENT.test(path.slice(path.lastIndexOf("/") + 1)),
  }),
]);

/** Which rule admits a path, or null. Exported so the falsifier suite can prove the rules apart. */
export function promptSurfaceRuleFor(path) {
  return PROMPT_SURFACE_RULES.find((rule) => rule.matches(path))?.id ?? null;
}

// One counter for the process this check runs in: every git invocation goes through `git`, and the count is part of
// what the check reports, because "how long did it take" on a machine is a different fact from "how much work is it".
let gitCalls = 0;

const git = (repositoryRoot, args, input) => {
  gitCalls += 1;
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
};

const gitLines = (repositoryRoot, args) =>
  git(repositoryRoot, args)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/**
 * `path -> blob id` for every tracked path in `revision`.
 *
 * Blob ids, not paths, because the first question about a population path is whether the content is the same: a path
 * whose blob matches the product branch's is current, and asking the history about it would buy nothing. One tree
 * read answers that for all sixteen paths; sixteen `rev-parse <rev>:<path>` calls answered it one path at a time.
 */
const readTree = (repositoryRoot, revision) => {
  const blobs = new Map();
  for (const line of gitLines(repositoryRoot, ["ls-tree", "-r", revision])) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const path = line.slice(tab + 1).trim();
    if (path.length === 0) continue;
    blobs.set(path, line.slice(0, tab).split(" ")[2]);
  }
  return blobs;
};

/**
 * Every tracked path in `revision` that decides what the model reads, in tree order.
 * Reads the REVISION's tree, not the index: a staged deletion or a neighbour's rebase must not reshape the
 * population the run is judged against.
 */
export function promptSurfacePopulation({ repositoryRoot, revision = "HEAD" }) {
  const tree = gitLines(repositoryRoot, ["ls-tree", "-r", "--name-only", revision]);
  return Object.freeze(tree.filter((path) => promptSurfaceRuleFor(path) !== null));
}

const resolveCommit = (repositoryRoot, revision) => {
  try {
    return git(repositoryRoot, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]).trim();
  } catch {
    return null;
  }
};

/**
 * The commits `revision` holds, that `notRevision` does not, that touch any of `paths` - each with the paths it
 * touched, so a caller can attribute them per path without a second history walk.
 *
 * This is the symmetric difference restricted twice: to the side that matters and to the commits that can possibly
 * matter. A commit that does not touch a population path cannot be the missing prompt work on that path.
 */
const commitsTouching = ({ repositoryRoot, revision, notRevision, paths }) => {
  if (paths.length === 0) return [];
  const lines = gitLines(repositoryRoot, [
    "log",
    "--no-merges",
    `--format=%H%x09%h%x09%s`,
    "--name-only",
    revision,
    "--not",
    notRevision,
    "--",
    ...paths,
  ]);
  const commits = [];
  for (const line of lines) {
    const header = /^([0-9a-f]{40})\t([0-9a-f]+)\t(.*)$/u.exec(line);
    if (header !== null) {
      commits.push({ sha: header[1], name: `${header[2]} ${header[3]}`.trim(), paths: [] });
      continue;
    }
    if (commits.length > 0) commits[commits.length - 1].paths.push(line);
  }
  return commits;
};

/**
 * The patch ids of exactly these commits, in one `git patch-id` run, limited to `path`.
 *
 * This is the same identity `--cherry-pick` uses - a commit's patch of the paths in question, hashed - but computed
 * for the commits the caller already knows touch the path rather than for every commit in the range. The pathspec is
 * not optional: `--cherry-pick` hashes each commit's patch AS THE PATHSPEC LIMITS IT, so a commit that also changed
 * other files is the same work only when the change to this path is the same. `--stable` because the answer must not
 * depend on the order hunks happen to be emitted in.
 */
const patchIdsOf = ({ repositoryRoot, shas, path }) => {
  const ids = new Map();
  if (shas.length === 0) return ids;
  const patches = git(repositoryRoot, [
    "log",
    "--no-walk=unsorted",
    "--no-merges",
    "--patch",
    "--format=commit %H",
    ...shas,
    "--",
    path,
  ]);
  if (patches.trim().length === 0) return ids;
  for (const line of git(repositoryRoot, ["patch-id", "--stable"], patches).split("\n")) {
    const [patchId, sha] = line.trim().split(" ");
    if (patchId !== undefined && sha !== undefined) ids.set(sha, patchId);
  }
  return ids;
};

/** The commits that touch each path, keyed by the population path they were gathered for. */
const commitsByPath = (commits, wanted) => {
  const byPath = new Map();
  for (const commit of commits)
    for (const path of commit.paths) {
      if (wanted !== undefined && !wanted.has(path)) continue;
      if (!byPath.has(path)) byPath.set(path, []);
      byPath.get(path).push(commit);
    }
  return byPath;
};

/** A per-term clock, so the check reports its own cost instead of being timed from outside by a stopwatch. */
const createClock = () => {
  const terms = { resolveMs: 0, lsTreeMs: 0, historyMs: 0, patchIdMs: 0, diffMs: 0 };
  return {
    phase(term, work) {
      const startedAt = performance.now();
      try {
        return work();
      } finally {
        terms[term] += performance.now() - startedAt;
      }
    },
    report(paths, refs) {
      const rounded = {};
      for (const [term, ms] of Object.entries(terms)) rounded[term] = Math.round(ms);
      const totalMs = Math.round(Object.values(terms).reduce((sum, ms) => sum + ms, 0));
      return Object.freeze({ ...rounded, gitCalls, paths, refs, totalMs });
    },
  };
};

/**
 * The reading. Never throws for a condition it can name: a caller that gets `status: "not_measured"` must refuse.
 *
 * @returns {{
 *   status: "current" | "behind" | "dirty" | "not_measured",
 *   revision: string,
 *   examined: number,
 *   population: readonly string[],
 *   refs: readonly string[],
 *   reason: string | null,
 *   findings: readonly {kind: "behind" | "dirty", path: string, count: number, subjects: readonly string[]}[],
 *   timings: {lsTreeMs: number, historyMs: number, patchIdMs: number, diffMs: number, resolveMs: number,
 *             gitCalls: number, paths: number, refs: number, totalMs: number},
 * }}
 */
export function assessPromptSurfaceFreshness({ repositoryRoot, revision = "HEAD", productRefs = PRODUCT_REFS }) {
  gitCalls = 0;
  const clock = createClock();
  // Carried forward as each step learns something, so a refusal still prints what it did manage to read: a
  // `not_measured` that forgets the population it derived is a reading that cannot be argued with.
  const state = {
    revision,
    examined: 0,
    population: Object.freeze([]),
    refs: Object.freeze([]),
    findings: Object.freeze([]),
  };
  const notMeasured = (reason) =>
    Object.freeze({
      ...state,
      status: "not_measured",
      reason,
      timings: clock.report(state.examined, state.refs.length),
    });

  let root;
  try {
    root = git(repositoryRoot, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return notMeasured("no_git");
  }
  try {
    if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true") return notMeasured("shallow_clone");
  } catch {
    return notMeasured("no_git");
  }
  const commit = clock.phase("resolveMs", () => resolveCommit(root, revision));
  if (commit === null) return notMeasured(`revision_unresolved:${revision}`);
  const refs = clock.phase("resolveMs", () => productRefs.filter((ref) => resolveCommit(root, ref) !== null));
  state.revision = commit;
  state.refs = Object.freeze(refs);
  if (refs.length === 0) return notMeasured(`no_product_ref:${productRefs.join(",")}`);

  const launchedTree = clock.phase("lsTreeMs", () => readTree(root, commit));
  const population = Object.freeze([...launchedTree.keys()].filter((path) => promptSurfaceRuleFor(path) !== null));
  state.population = population;
  state.examined = population.length;
  if (population.length === 0) return notMeasured("empty_population");

  // Behind: only a path whose CONTENT differs is worth asking the history about, and the history - not the content
  // difference - decides, so a revision that is AHEAD of the branch is silent rather than red.
  const findings = [];
  const missingByPath = new Map();
  for (const ref of refs) {
    const refTree = clock.phase("lsTreeMs", () => readTree(root, ref));
    const differing = population.filter((path) => refTree.get(path) !== launchedTree.get(path));
    if (differing.length === 0) continue;
    const refSide = clock.phase("historyMs", () =>
      commitsTouching({ repositoryRoot: root, revision: ref, notRevision: commit, paths: differing }),
    );
    const onRefSide = commitsByPath(refSide);
    if (onRefSide.size === 0) continue;
    const launchedSide = clock.phase("historyMs", () =>
      commitsTouching({ repositoryRoot: root, revision: commit, notRevision: ref, paths: [...onRefSide.keys()] }),
    );
    const onLaunchedSide = commitsByPath(launchedSide);
    for (const [path, candidates] of onRefSide) {
      const counterparts = onLaunchedSide.get(path) ?? [];
      // No commit of the revision's own touches this path, so no patch of the revision's can be an equivalent copy of
      // one of these: every one of them is work the revision does not have.
      let missing = candidates;
      if (counterparts.length > 0) {
        const candidateIds = clock.phase("patchIdMs", () =>
          patchIdsOf({ repositoryRoot: root, shas: candidates.map((entry) => entry.sha), path }),
        );
        const counterpartIds = clock.phase("patchIdMs", () =>
          patchIdsOf({ repositoryRoot: root, shas: counterparts.map((entry) => entry.sha), path }),
        );
        const carried = new Set(counterpartIds.values());
        missing = candidates.filter((entry) => !carried.has(candidateIds.get(entry.sha)));
      }
      if (missing.length === 0) continue;
      const held = missingByPath.get(path) ?? { refs: [], subjects: [] };
      // The refs that actually hold the missing work, not the refs that were examined: it is `main` that has these
      // commits here, and `origin/main` is two commits behind it. Naming both would send the operator to a branch
      // that has neither.
      if (!held.refs.includes(ref)) held.refs.push(ref);
      for (const entry of missing) if (!held.subjects.includes(entry.name)) held.subjects.push(entry.name);
      missingByPath.set(path, held);
    }
  }
  // Tree order, because a refusal is read top to bottom and the population's order is the one the launch printed:
  // findings that arrive in whatever order the history walk produced are a second, implicit ordering of the same fact.
  for (const path of population) {
    const held = missingByPath.get(path);
    if (held === undefined) continue;
    findings.push(
      Object.freeze({
        kind: "behind",
        path,
        count: held.subjects.length,
        refs: Object.freeze(held.refs),
        subjects: Object.freeze(held.subjects),
      }),
    );
  }

  // The run reads the CHECKOUT - the persona provisioner opens `assets/tavern/presets/default-companion` from the
  // worktree - so an uncommitted edit to the prompt is measured by the run even though no commit owns it, and a run
  // whose prompt no commit owns cannot be attributed to a review.
  const worktree = clock.phase("diffMs", () => {
    try {
      git(root, ["diff", "--quiet", "--no-ext-diff", commit, "--", ...population]);
      return { measured: true, paths: [] };
    } catch {
      try {
        return {
          measured: true,
          paths: gitLines(root, ["diff", "--name-only", "--no-ext-diff", commit, "--", ...population]),
        };
      } catch {
        return { measured: false, paths: [] };
      }
    }
  });
  if (!worktree.measured) return notMeasured("worktree_unreadable");
  for (const path of worktree.paths)
    findings.push(
      Object.freeze({ kind: "dirty", path, count: 0, refs: Object.freeze([]), subjects: Object.freeze([]) }),
    );

  const behind = findings.some((finding) => finding.kind === "behind");
  let status = "current";
  if (findings.length > 0) status = behind ? "behind" : "dirty";
  return Object.freeze({
    revision: commit,
    examined: population.length,
    population,
    refs: Object.freeze(refs),
    status,
    reason: null,
    findings: Object.freeze(findings),
    timings: clock.report(population.length, refs.length),
  });
}

/**
 * The refusal text. One `live_run_prompt_surface_behind:<path>:<n> commits` line per path, each followed by the
 * subjects that are missing, because "you are behind" without "behind on what" sends the operator to `git log`.
 */
export function promptSurfaceRefusal(assessment) {
  if (assessment.status === "not_measured")
    return `live_run_prompt_surface_not_measured:${assessment.reason} — a run whose prompt cannot be shown to be current is a run whose numbers cannot be attributed (revision ${assessment.revision})`;
  const lines = [];
  for (const finding of assessment.findings) {
    if (finding.kind === "dirty") {
      lines.push(
        `live_run_prompt_surface_dirty:${finding.path} — the run reads the worktree, and this path differs from revision ${assessment.revision}`,
      );
      continue;
    }
    lines.push(`live_run_prompt_surface_behind:${finding.path}:${finding.count} commits`);
    lines.push(`  missing from revision ${assessment.revision}, held by ${finding.refs.join(",")}:`);
    for (const subject of finding.subjects) lines.push(`  ${subject}`);
  }
  return lines.join("\n");
}

/**
 * What the check cost, printed by the check. A gate that dominates startup and cannot say what it spent is a gate
 * nobody can argue with: `lsTreeMs` is the tree reads, `historyMs` the per-ref commit attribution, `patchIdMs` the
 * patch-equivalence hashes for the commits that touch a differing path, `diffMs` the worktree comparison.
 */
export const promptSurfaceCheckReport = (assessment) => `prompt_surface_check ${JSON.stringify(assessment.timings)}`;

/**
 * Refuse to start a run whose prompt surface is not current, or is not measurable.
 * The message IS the failure code: `live_run_prompt_surface_behind:<path>:<n> commits`, or
 * `live_run_prompt_surface_not_measured:<reason>`.
 */
export function assertPromptSurfaceFresh(options = {}) {
  const assessment = assessPromptSurfaceFreshness(options);
  process.stderr.write(`${promptSurfaceCheckReport(assessment)}\n`);
  if (assessment.status === "not_measured") throw new Error(promptSurfaceRefusal(assessment));
  if (assessment.findings.length > 0) throw new Error(promptSurfaceRefusal(assessment));
  return assessment;
}

/** `node tools/live-run/core/prompt-surface-freshness.mjs [--repository-root <dir>] [--revision <rev>]` */
const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const argument = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
  };
  const repositoryRoot = argument("--repository-root", process.cwd());
  const revision = argument("--revision", "HEAD");
  const assessment = assessPromptSurfaceFreshness({ repositoryRoot, revision });
  process.stderr.write(`${promptSurfaceCheckReport(assessment)}\n`);
  const verdict =
    assessment.status === "current"
      ? `prompt_surface_current: examined ${assessment.examined} path(s) against ${assessment.refs.join(",")}`
      : promptSurfaceRefusal(assessment);
  process.stdout.write(`${verdict}\n`);
  if (assessment.status !== "current") process.exitCode = 1;
}
