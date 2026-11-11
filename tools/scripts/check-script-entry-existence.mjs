// check-script-entry-existence.mjs — 门禁：package.json scripts 引用的仓库内文件必须存在。
// 防"幽灵入口"（如 test:unit 指向已删除的 main-entry.test.mjs 被 node --test 静默放行）。
// 只检查明确以仓库相对路径（tools/、scripts/、tests/、src/、integrations/、fixtures/ 开头）出现的引用；
// 命令名（pnpm/node/dotnet/tsc 等）、glob、shell 语法片段不检查。
//
// A script may also name a BUILD OUTPUT as an argument (`build:player-distribution`
// hands `host/dist` to the packaging script). Those paths are git-ignored by
// construction and exist only after a build, so requiring them on a clean
// checkout would make the gate demand the artifact it is meant to produce. A
// git-ignored path is not repository content — the same rule the lint and format
// ratchets already apply — while a TRACKED path that has gone missing still
// fails, which is the defect this gate exists for.
// red-proof: inject  a commit that deletes the file `check:tavern-references` still names ->
//                    `幽灵脚本入口` naming `.:check:tavern-references -> tools/verify-tavern-semantic-references.mjs`, exit 1
//                    (tools/scripts/check-script-entry-existence.mjs, this gate)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KNOWN_LEADERS = [
  "tools/",
  "host/",
  "dialogue-web/",
  "packages/",
  "integrations/",
  "fixtures/",
  "scripts/",
  ".github/",
];
const PATHISH =
  /(?:^|\s)(?:"?)((?:tools|host|dialogue-web|packages|integrations|fixtures|scripts|\.github)\/[^\s"'`|&;<>()]+)/g;
/** Extensions that only ever name repository content, so an ignore rule on one of them is never a build output. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", ".css"]);

function collectScripts(pkgRoot) {
  const pkgPath = join(pkgRoot, "package.json");
  if (!existsSync(pkgPath)) return [];
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return Object.entries(pkg.scripts || {}).map(([name, cmd]) => ({ name, cmd, pkgRoot }));
}

/** The repo-relative, POSIX-separated form of one reference, resolved from the package that declares it. */
function repoRelative(ref, base = root) {
  return relative(root, resolve(base, ref.replace(/["'`]$/, "")))
    .split("\\")
    .join("/");
}

/** Whether git ignores this path, i.e. it is a build output rather than repository content. */
function isBuildOutput(ref, base = root) {
  const relativePath = repoRelative(ref, base);
  const dot = relativePath.lastIndexOf(".");
  const extension = dot < 0 ? "" : relativePath.slice(dot).toLowerCase();
  if (SOURCE_EXTENSIONS.has(extension)) return false;
  for (const candidate of [relativePath, `${relativePath}/`]) {
    try {
      execFileSync("git", ["check-ignore", "--quiet", "--no-index", candidate], {
        cwd: root,
        windowsHide: true,
        stdio: "ignore",
      });
      return true;
    } catch (error) {
      // Exit 1 is "not ignored"; only a missing exit code is a run failure.
      if (error?.status !== 1) throw new Error(`could not ask git what it ignores: ${error?.message ?? error}`);
    }
  }
  return false;
}

/**
 * The tracked paths in `HEAD`, which is the population this gate is about.
 *
 * It used to ask the filesystem (`statSync`), and that made it lie in the one direction that matters: a script
 * naming a file that exists only in the developer's worktree - a submodule checkout, an ignored build, a file that
 * was never committed - passed here and failed on a clean checkout. Measured 2026-11-07: CI reported
 * `.:test:stardew-wire-agreement -> host/src/plan-compiler-binding-agreement.test.ts` while this gate printed
 * `419 paths all exists` on the machine where an earlier `git add` had left the file's fate ambiguous. A check
 * whose boundary is the disk cannot answer a question about the commit.
 */
function trackedPaths() {
  const listing = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  return new Set(listing.split("\0").filter(Boolean));
}

const TRACKED = trackedPaths();

function resolveRef(ref, base = root) {
  const clean = ref.replace(/["'`]$/, "");
  if (/[*?[\]]/.test(clean)) return null; // glob, skipped
  // A path is a script entry when the commit holds it. The worktree is not asked: a file that exists only here is
  // exactly the defect this gate exists to name. `base` is the package that declared the script, because a package's
  // own scripts name paths relative to itself (`scripts/build-test-artifact.mjs` from `host/`).
  return TRACKED.has(repoRelative(clean, base)) ? clean : null;
}

const problems = [];
const checked = [];
for (const dir of [
  "",
  "host",
  "dialogue-web",
  "packages/voice-protocol",
  "packages/game-action-program",
  "integrations/stardew/action-development",
  "voice-gateway",
]) {
  for (const { name, cmd, pkgRoot } of collectScripts(join(root, dir))) {
    for (const m of cmd.matchAll(PATHISH)) {
      const ref = m[1];
      if (!KNOWN_LEADERS.some((k) => ref.startsWith(k))) continue;
      const found = resolveRef(ref, pkgRoot ?? root);
      if (found) checked.push(ref);
      else if (isBuildOutput(ref, pkgRoot ?? root)) checked.push(ref);
      else problems.push({ script: `${dir || "."}:${name}`, ref });
    }
  }
}

if (problems.length) {
  console.error("幽灵脚本入口（package.json scripts 引用了不存在的文件）:");
  for (const p of problems) console.error(`  ${p.script} → ${p.ref}`);
}

/**
 * The workflows' own `node tools/<x>.mjs` invocations, checked against the same tracked set.
 *
 * WHY: on 2026-11-08 CI failed two jobs - `host` and `gates` - with the same sentence,
 *
 *   Error: Cannot find module 'D:\a\gamebuddy\gamebuddy\tools\check-vendor-build-artifacts.mjs'
 *
 * because `ci.yml` invoked a script that existed on this machine's disk and in no commit; a commit deleted the file and
 * the step stayed. The population above is `package.json` scripts only, so the workflow's own invocations were the half
 * of the same fact nobody read. Both halves are now read, from `HEAD` rather than the filesystem.
 */
const WORKFLOW_REF = /node\s+(tools\/[A-Za-z0-9._/-]+\.mjs)/gu;
const workflowProblems = [];
const workflowChecked = [];
for (const workflow of [...TRACKED].filter((path) => path.startsWith(".github/workflows/") && /\.ya?ml$/u.test(path))) {
  const body = execFileSync("git", ["show", `HEAD:${workflow}`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  for (const match of body.matchAll(WORKFLOW_REF)) {
    const ref = match[1];
    if (TRACKED.has(ref)) workflowChecked.push(ref);
    else workflowProblems.push({ workflow, ref });
  }
}
if (workflowProblems.length) {
  console.error("幽灵工作流步骤（workflow 运行了不在 HEAD 里的脚本）:");
  for (const p of workflowProblems) console.error(`  ${p.workflow} → ${p.ref}`);
}
if (workflowChecked.length === 0) {
  console.error("check-script-entry-existence: examined 0 workflow invocation(s), so nothing was verified");
  process.exit(1);
}

if (problems.length || workflowProblems.length) process.exit(1);
console.log(
  `check-script-entry-existence: ${checked.length} 个 scripts 路径引用与 ${workflowChecked.length} 个 workflow 脚本引用全部存在 ✓`,
);
