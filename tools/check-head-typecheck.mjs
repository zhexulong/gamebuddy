/**
 * Typecheck HEAD itself, not the working tree.
 *
 * A whole class of defect survives review in this repository: one lane commits half of a change,
 * another lane's uncommitted work supplies the other half, and the working tree compiles while the
 * commit that was just pushed does not. `pnpm typecheck` cannot see it — it reads the working tree,
 * so it is green for a HEAD that does not build. This check closes that gap by checking out the
 * exact revision into a throwaway `git worktree` and running the host's own typecheck there, with
 * no working-tree file able to mask a missing committed one.
 *
 * The dependency layout is junctioned rather than reinstalled: the throwaway worktree gets
 * `node_modules` and `host/node_modules` as junctions to this checkout's, which is enough for
 * `tsc` (it resolves through the reparse point to a real path inside this repository). The
 * repository's own builder would reject a junctioned `typescript` entry because it realpath-checks
 * containment, so this script invokes `tsc` directly instead of going through the builder.
 *
 * Usage:
 *   node tools/check-head-typecheck.mjs [--rev <rev>] [--projects a.json,b.json]
 *                                       [--worktree <dir>] [--keep]
 *
 * Set `GAMEBUDDY_HEAD_TYPECHECK_DIR` to put the throwaway worktree somewhere other than the system
 * temporary directory (on a machine whose `C:` is full, point it at another drive).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage =
  "usage: node tools/check-head-typecheck.mjs [--rev <rev>] [--projects <tsconfig.json,...>] [--worktree <dir>] [--keep]";
// Production only. `tsconfig.test.json` is available through `--projects` and adds real coverage, but
// the committed test project is already red at HEAD for reasons that have nothing to do with this
// guard (unused locals and strict-mode violations inside committed `*.test.ts` files), so making it
// the default would give a gate that is red on arrival and gets ignored. Widen it once that is green.
const HOST_PROJECTS = ["tsconfig.json"];

const parseArguments = (argv) => {
  const options = { rev: "HEAD", projects: HOST_PROJECTS, worktree: undefined, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--keep") {
      options.keep = true;
    } else if (argument === "--rev" || argument === "--projects" || argument === "--worktree") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} needs a value\n${usage}`);
      index += 1;
      if (argument === "--rev") options.rev = value;
      else if (argument === "--projects")
        options.projects = value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
      else options.worktree = resolve(value);
    } else {
      throw new Error(`unknown argument: ${argument}\n${usage}`);
    }
  }
  if (options.projects.length === 0) throw new Error(`--projects named no project\n${usage}`);
  return options;
};

const git = (args, cwd = repositoryRoot) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

/** A junction is removed with `unlink` (never recursively): recursion through a reparse point would
 * delete this checkout's real `node_modules`. */
const removeJunction = (path) => {
  try {
    unlinkSync(path);
  } catch {
    // Nothing to unlink: the entry was never created or is already gone.
  }
};

const rmdir = (path) => {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
};

const resolveRevision = (rev) => {
  try {
    return git(["rev-parse", "--verify", `${rev}^{commit}`]).trim();
  } catch {
    throw new Error(`cannot resolve revision ${rev}`);
  }
};

const typecheck = (hostRoot, project) =>
  execFileSync(
    process.execPath,
    [join(hostRoot, "node_modules", "typescript", "lib", "tsc.js"), "--project", project, "--noEmit"],
    {
      cwd: hostRoot,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

const diagnose = (hostRoot, project) => {
  try {
    typecheck(hostRoot, project);
    return [];
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    if (typeof error.status !== "number")
      throw new Error(`could not run tsc for ${project}: ${output || error.message}`);
    if (error.status !== 1 && error.status !== 2)
      throw new Error(`tsc for ${project} failed to run (exit ${error.status}): ${output}`);
    return output
      .split(/\r?\n/)
      .map((line) => /^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\): (?<code>error TS\d+): (?<message>.*)$/.exec(line))
      .filter((match) => match !== null)
      .map((match) => ({
        file: match.groups.file,
        line: match.groups.line,
        column: match.groups.column,
        code: match.groups.code,
        message: match.groups.message,
      }));
  }
};

const main = () => {
  const options = parseArguments(process.argv.slice(2));
  const revision = resolveRevision(options.rev);
  const shortRevision = revision.slice(0, 12);
  const container = process.env.GAMEBUDDY_HEAD_TYPECHECK_DIR ?? tmpdir();
  const worktree = options.worktree ?? join(container, `gb-head-typecheck-${process.pid}`);
  if (existsSync(worktree)) throw new Error(`refusing to reuse an existing path: ${worktree}`);
  mkdirSync(container, { recursive: true });

  const hostRoot = join(worktree, "host");
  const junctions = [];
  try {
    git(["worktree", "add", "--detach", worktree, revision]);
    for (const [link, target] of [
      [join(worktree, "node_modules"), join(repositoryRoot, "node_modules")],
      [join(hostRoot, "node_modules"), join(repositoryRoot, "host", "node_modules")],
    ]) {
      if (!existsSync(target)) continue;
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link, "junction");
      junctions.push(link);
    }
    if (!existsSync(join(hostRoot, "node_modules", "typescript", "lib", "tsc.js")))
      throw new Error(`the throwaway worktree has no typescript to run: ${join(hostRoot, "node_modules")}`);

    const failures = new Map();
    for (const project of options.projects) {
      const errors = diagnose(hostRoot, project);
      if (errors.length > 0) failures.set(project, errors);
    }
    if (failures.size === 0) {
      process.stdout.write(`head_typecheck_ok rev=${shortRevision} projects=${options.projects.join(",")}\n`);
      return 0;
    }
    const total = [...failures.values()].reduce((count, errors) => count + errors.length, 0);
    process.stdout.write(`head_typecheck_failed rev=${shortRevision} errors=${total}\n`);
    for (const [project, errors] of failures) {
      process.stdout.write(`  ${project}\n`);
      for (const error of errors) {
        process.stdout.write(`    ${error.file}:${error.line}:${error.column} ${error.code}: ${error.message}\n`);
      }
    }
    process.stderr.write("HEAD does not compile; the working tree compiling is not evidence about HEAD\n");
    return 1;
  } finally {
    if (options.keep) {
      process.stdout.write(`kept_worktree ${worktree}\n`);
    } else {
      for (const junction of junctions) removeJunction(junction);
      try {
        git(["worktree", "remove", "--force", worktree]);
      } catch {
        rmdir(worktree);
      }
      if (existsSync(worktree)) rmdir(worktree);
    }
  }
};

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
