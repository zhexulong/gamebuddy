/**
 * A commit may not land a test source that does not compile.
 *
 * <p>
 * This is the smallest honest form of that rule, and it exists because the rule was broken in exactly this shape:
 * `32a13440` added three wire-agreement gates and 30 type errors with them. Two of those files have never run, and
 * `pnpm build:test` (`noEmitOnError`) has republished the last artifact that did since - so every reading taken with
 * `node --test dist-test/...` since then has executed code the tree no longer contains.
 * </p>
 *
 * <h2>Why the existing gates did not catch it</h2>
 * <p>
 * There are two, and both are sound; neither covers this moment.
 * </p>
 * <ul>
 *   <li>`check-test-typecheck-ratchet.mjs` counts errors PER `TSxxxx` CODE against a recorded baseline. `32a13440`
 *       added 30 errors and the ratchet named 3 of them, all `TS7006`: the rest landed inside allowance the baseline
 *       had banked from earlier decreases in the same codes, so a budget recorded for a different purpose absorbed
 *       them.</li>
 *   <li>That same ratchet EXCLUDES files git reports as changed or untracked, on purpose, because this repository is
 *       worked by several lanes in one worktree and a neighbour's in-flight edit must not fire on your commit. The
 *       consequence is structural: at the moment of committing, every file you are about to commit is excluded. The
 *       ratchet cannot see the commit it is about to describe.</li>
 *   <li>The pre-commit hook formats, and prints the tree-wide ratchets as information. It ran no typecheck at all.</li>
 * </ul>
 *
 * <h2>What this checks, and what it deliberately does not</h2>
 * <p>
 * Every error whose FILE is in this commit fails the commit, named with its first errors. Errors in files this commit
 * does not touch are counted and do not block - the repository carries a recorded backlog, and blocking one author for
 * a neighbour's file is how a hook gets uninstalled.
 * </p>
 * <p>
 * It therefore does NOT catch "my source change breaks a test file I did not stage". That is the ratchet's and CI's
 * job, and it is a different defect from the one that happened here.
 * </p>
 *
 * <p>
 * The compile itself is `compileTestProject` from the ratchet - imported, not re-implemented, so the two gates can
 * never disagree about which project they describe.
 * </p>
 *
 * Usage:
 *   node scripts/check-staged-test-typecheck.mjs               # the staged set (what the hook runs)
 *   node scripts/check-staged-test-typecheck.mjs --rev HEAD~1 # the files a revision changed
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileTestProject } from "./check-test-typecheck-ratchet.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(hostRoot, "..");

/** How many errors are printed before the rest are counted rather than listed. */
const PRINT_LIMIT = 20;

const git = (args) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", windowsHide: true }).trim();

/**
 * The path filters `tsconfig.test.json` compiles, read from the project itself.
 *
 * Not a filename convention and not a second copy of the list: `include`/`exclude` are the only authority on which
 * files the project describes, and a path this gate checks that the project does not compile would be a false
 * accusation. A `*` is the only wildcard the two entries use today, and the two kinds of pattern appear in the shape
 * the project writes them: `src/**\/*.ts` and `src/main.ts`.
 */
function projectFilters() {
  const project = JSON.parse(readFileSync(join(hostRoot, "tsconfig.test.json"), "utf8"));
  if (!Array.isArray(project.include) || !Array.isArray(project.exclude))
    throw new Error("tsconfig.test.json must declare both `include` and `exclude` for this gate to know its population");
  return { include: project.include.map((entry) => patternOf(entry)), exclude: project.exclude.map((entry) => patternOf(entry)) };
}

/** A project path pattern as a predicate over a `host/`-relative path. */
function patternOf(pattern) {
  const special = /[.+^${}()|[\]\\]/gu;
  const source = pattern
    .replace(/\\/gu, "/")
    .replace(special, "\\$&")
    .replace(/\*\*\//gu, "(?:.*/)?")
    .replace(/\*/gu, "[^/]*");
  const expression = new RegExp(`^${source}$`, "u");
  return (path) => expression.test(path);
}

/**
 * The paths in this commit that the Host test project compiles, `host/`-relative.
 *
 * Exported because it is the whole of the gate's judgement: the suite plants a path list against it, and a predicate
 * that quietly returned an empty list would turn this gate green over every commit.
 */
export function hostProjectFiles(paths) {
  const { include, exclude } = projectFilters();
  return paths
    .filter((path) => path.startsWith("host/"))
    .map((path) => path.slice("host/".length))
    .filter((path) => include.some((matches) => matches(path)) && !exclude.some((matches) => matches(path)));
}

function committedPaths(range) {
  return git(["diff", "--name-only", "--diff-filter=ACMR", ...range])
    .split(/\r?\n/u)
    .filter((path) => path.length > 0);
}

/**
 * The files in this commit whose WORKING TREE differs from what is staged.
 *
 * `compileTestProject` reads the working tree - that is the only thing a compiler can read - so a file staged in one
 * state and edited to another is checked in the state that is NOT being committed. The set is reported rather than
 * resolved: staging the working-tree copy to check it would rewrite the index, and this gate may not touch staged work
 * that belongs to this commit's author on purpose.
 */
function stagedBehindWorktree(paths) {
  const unstaged = new Set(committedPaths([]));
  return paths.filter((path) => unstaged.has(path));
}

function main(argv) {
  const revisionIndex = argv.indexOf("--rev");
  if (revisionIndex >= 0 && argv[revisionIndex + 1] === undefined) throw new Error("--rev needs a value");
  const fromRevision = revisionIndex >= 0;
  const committed = fromRevision ? committedPaths([`${argv[revisionIndex + 1]}..HEAD`]) : committedPaths(["--cached"]);
  const files = hostProjectFiles(committed);

  if (files.length === 0) {
    process.stdout.write("staged_test_typecheck_skipped: no path this commit touches is compiled by tsconfig.test.json\n");
    return 0;
  }

  if (!fromRevision) {
    const behind = stagedBehindWorktree(files.map((file) => `host/${file}`));
    if (behind.length > 0)
      process.stdout.write(
        `staged_test_typecheck_reads_worktree: ${behind.length} of these have further unstaged edits, so they are ` +
          `checked in their working-tree state [${behind.join(", ")}]\n`,
      );
  }

  const errors = compileTestProject();
  const mine = errors.filter((error) => files.includes(error.file));
  const others = errors.length - mine.length;

  if (mine.length === 0) {
    process.stdout.write(
      `staged_test_typecheck_ok files=${files.length}` +
        `${others > 0 ? ` (${others} error(s) in files this commit does not touch are not its own)` : ""}\n`,
    );
    return 0;
  }

  process.stdout.write(
    `staged_test_typecheck_failed errors=${mine.length} files=${new Set(mine.map((error) => error.file)).size}\n`,
  );
  for (const error of mine.slice(0, PRINT_LIMIT))
    process.stdout.write(`  ${error.file}:${error.line}:${error.column} ${error.code}: ${error.message}\n`);
  if (mine.length > PRINT_LIMIT) process.stdout.write(`  …and ${mine.length - PRINT_LIMIT} more\n`);
  process.stdout.write(
    "this commit adds sources that do not compile, so `pnpm build:test` will republish the previous artifact instead of\n" +
      "this one - and every later `node --test dist-test/...` reading will describe code that no longer exists\n",
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
