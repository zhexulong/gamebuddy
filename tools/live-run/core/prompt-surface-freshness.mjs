import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
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
 * commit touching that path whose PATCH the revision does not already carry (`git log --cherry-pick --right-only`).
 * Identity was the first thing tried and it is wrong twice over: a worktree that cherry-picked the prompt commits
 * holds their content under new hashes and would stay red forever, and a local `origin/main` that has not been
 * fetched holds older content and would report a revision that is AHEAD as behind. Patch equivalence says "this
 * work is in the revision" whether it arrived by merge, rebase or cherry-pick; the content comparison that decides
 * whether a path is even worth asking about says "the revision is not ahead on this file". Both existing refs are
 * examined and their findings are unioned, because a stale remote is not a licence to launch on a tree that is
 * missing prompt work the local branch holds.
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

const git = (repositoryRoot, args) =>
  execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    stdio: ["ignore", "pipe", "pipe"],
  });

const gitLines = (repositoryRoot, args) =>
  git(repositoryRoot, args)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

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

const blobAt = (repositoryRoot, commit, path) => {
  try {
    return git(repositoryRoot, ["rev-parse", "--verify", "--quiet", `${commit}:${path}`]).trim();
  } catch {
    return null;
  }
};

/**
 * The commits `ref` holds that touch `path` and whose patch `commit` does not already carry.
 * `--cherry-pick --right-only` is the whole point: a cherry-picked or rebased copy of a commit is the same work
 * under a different hash, and only patch equivalence says so.
 */
const missingCommits = ({ repositoryRoot, commit, ref, path }) =>
  gitLines(repositoryRoot, [
    "log",
    "--no-merges",
    "--cherry-pick",
    "--right-only",
    "--format=%h %s",
    `${commit}...${ref}`,
    "--",
    path,
  ]);

/**
 * What the worktree holds at the population paths, against the launched revision.
 *
 * `git diff <commit>` runs the worktree through the same filters the commit went through, so a CRLF checkout is not
 * reported as a changed prompt. The run reads the CHECKOUT - the persona provisioner opens
 * `assets/tavern/presets/default-companion` from the worktree - so an uncommitted edit to the prompt is measured by
 * the run even though no commit owns it, and a run whose prompt no commit owns cannot be attributed to a review.
 */
const dirtyPaths = ({ repositoryRoot, commit, population }) => {
  if (population.length === 0) return { measured: true, paths: [] };
  try {
    git(repositoryRoot, ["diff", "--quiet", "--no-ext-diff", commit, "--", ...population]);
    return { measured: true, paths: [] };
  } catch {
    try {
      return {
        measured: true,
        paths: gitLines(repositoryRoot, ["diff", "--name-only", "--no-ext-diff", commit, "--", ...population]),
      };
    } catch {
      return { measured: false, paths: [] };
    }
  }
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
 * }}
 */
export function assessPromptSurfaceFreshness({ repositoryRoot, revision = "HEAD", productRefs = PRODUCT_REFS }) {
  // Carried forward as each step learns something, so a refusal still prints what it did manage to read: a
  // `not_measured` that forgets the population it derived is a reading that cannot be argued with.
  const state = {
    revision,
    examined: 0,
    population: Object.freeze([]),
    refs: Object.freeze([]),
    findings: Object.freeze([]),
  };
  const notMeasured = (reason) => Object.freeze({ ...state, status: "not_measured", reason });

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
  const commit = resolveCommit(root, revision);
  if (commit === null) return notMeasured(`revision_unresolved:${revision}`);
  const refs = productRefs.filter((ref) => resolveCommit(root, ref) !== null);
  state.revision = commit;
  state.refs = Object.freeze(refs);
  if (refs.length === 0) return notMeasured(`no_product_ref:${productRefs.join(",")}`);

  const population = promptSurfacePopulation({ repositoryRoot: root, revision: commit });
  state.population = population;
  state.examined = population.length;
  if (population.length === 0) return notMeasured("empty_population");

  const findings = [];
  // Behind: only a path whose content differs is worth asking the history about, and the history - not the content
  // difference - decides, so a revision that is AHEAD of the branch is silent rather than red.
  const refBlobs = new Map(refs.map((ref) => [ref, population.map((path) => blobAt(root, ref, path))]));
  population.forEach((path, index) => {
    const launched = blobAt(root, commit, path);
    const behind = refs.filter((ref) => refBlobs.get(ref)[index] !== launched);
    if (behind.length === 0) return;
    // The refs that actually hold the missing work, not the refs that were examined: it is `main` that has these
    // commits here, and `origin/main` is two commits behind it. Naming both would send the operator to a branch
    // that has neither.
    const holders = [];
    const subjects = [];
    for (const ref of behind) {
      const found = missingCommits({ repositoryRoot: root, commit, ref, path });
      if (found.length === 0) continue;
      holders.push(ref);
      for (const subject of found) if (!subjects.includes(subject)) subjects.push(subject);
    }
    if (subjects.length > 0)
      findings.push(
        Object.freeze({
          kind: "behind",
          path,
          count: subjects.length,
          refs: Object.freeze(holders),
          subjects: Object.freeze(subjects),
        }),
      );
  });
  const worktree = dirtyPaths({ repositoryRoot: root, commit, population });
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
 * Refuse to start a run whose prompt surface is not current, or is not measurable.
 * The message IS the failure code: `live_run_prompt_surface_behind:<path>:<n> commits`, or
 * `live_run_prompt_surface_not_measured:<reason>`.
 */
export function assertPromptSurfaceFresh(options = {}) {
  const assessment = assessPromptSurfaceFreshness(options);
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
  const verdict =
    assessment.status === "current"
      ? `prompt_surface_current: examined ${assessment.examined} path(s) against ${assessment.refs.join(",")}`
      : promptSurfaceRefusal(assessment);
  process.stdout.write(`${verdict}\n`);
  if (assessment.status !== "current") process.exitCode = 1;
}
