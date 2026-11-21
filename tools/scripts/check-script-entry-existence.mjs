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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const USE_INDEX = process.argv.includes("--index");
const RATCHET_HEAD = process.argv.includes("--ratchet");
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

const WORKFLOW_REF = /node\s+(tools\/[A-Za-z0-9._/-]+\.mjs)/gu;
const PACKAGE_DIRS = [
  "",
  "host",
  "dialogue-web",
  "packages/voice-protocol",
  "packages/game-action-program",
  "integrations/stardew/action-development",
  "voice-gateway",
];

function repoRelative(ref, base = root) {
  return relative(root, resolve(base, ref.replace(/["'`]$/, "")))
    .split("\\")
    .join("/");
}

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
      if (error?.status !== 1) throw new Error(`could not ask git what it ignores: ${error?.message ?? error}`);
    }
  }
  return false;
}

function trackedPaths(fromIndex = USE_INDEX) {
  const gitArgs = fromIndex ? ["ls-files", "-z"] : ["ls-tree", "-r", "--name-only", "-z", "HEAD"];
  const listing = execFileSync("git", gitArgs, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  return new Set(listing.split("\0").filter(Boolean));
}

function readPackageManifest(pkgRel, { fromIndex, fromGitHead }) {
  if (!(fromIndex || fromGitHead)) {
    const pkgPath = join(root, pkgRel);
    return existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : null;
  }
  const ref = fromIndex ? `:${pkgRel}` : `HEAD:${pkgRel}`;
  try {
    const raw = execFileSync("git", ["show", ref], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveRef(tracked, ref, base) {
  const clean = ref.replace(/["'`]$/, "");
  if (/[*?[\]]/.test(clean)) return null;
  return tracked.has(repoRelative(clean, base)) ? clean : null;
}

function scanPackageScripts(tracked, { fromIndex, fromGitHead }) {
  const problems = [];
  const checked = [];
  for (const dir of PACKAGE_DIRS) {
    const pkg = readPackageManifest(dir ? `${dir}/package.json` : "package.json", { fromIndex, fromGitHead });
    if (pkg === null) continue;
    const pkgRoot = dir ? join(root, dir) : root;
    for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
      for (const m of cmd.matchAll(PATHISH)) {
        const ref = m[1];
        if (!KNOWN_LEADERS.some((k) => ref.startsWith(k))) continue;
        if (resolveRef(tracked, ref, pkgRoot) || isBuildOutput(ref, pkgRoot)) checked.push(ref);
        else problems.push({ script: `${dir || "."}:${name}`, ref });
      }
    }
  }
  return { problems, checked };
}

function scanWorkflowRefs(tracked, fromIndex) {
  const workflowProblems = [];
  const workflowChecked = [];
  const refPrefix = fromIndex ? "" : "HEAD";
  for (const workflow of [...tracked].filter(
    (path) => path.startsWith(".github/workflows/") && /\.ya?ml$/u.test(path),
  )) {
    const body = execFileSync("git", ["show", `${refPrefix}:${workflow}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    for (const match of body.matchAll(WORKFLOW_REF)) {
      const ref = match[1];
      if (tracked.has(ref)) workflowChecked.push(ref);
      else workflowProblems.push({ workflow, ref });
    }
  }
  return { workflowProblems, workflowChecked };
}

function scanReferenceProblems({ fromIndex, fromGitHead = false }) {
  const tracked = trackedPaths(fromIndex);
  return {
    ...scanPackageScripts(tracked, { fromIndex, fromGitHead }),
    ...scanWorkflowRefs(tracked, fromIndex),
  };
}

const current = scanReferenceProblems({ fromIndex: USE_INDEX });
let problems = current.problems;
let workflowProblems = current.workflowProblems;
if (RATCHET_HEAD) {
  let baseline = { problems: [], workflowProblems: [] };
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, stdio: "ignore" });
    baseline = scanReferenceProblems({ fromIndex: false, fromGitHead: true });
  } catch {
    baseline = { problems: [], workflowProblems: [] };
  }
  const priorScripts = new Set(baseline.problems.map((p) => `${p.script}->${p.ref}`));
  const priorWorkflows = new Set(baseline.workflowProblems.map((p) => `${p.workflow}->${p.ref}`));
  problems = current.problems.filter((p) => !priorScripts.has(`${p.script}->${p.ref}`));
  workflowProblems = current.workflowProblems.filter((p) => !priorWorkflows.has(`${p.workflow}->${p.ref}`));
}

if (problems.length) {
  console.error("幽灵脚本入口（package.json scripts 引用了不存在的文件）:");
  for (const p of problems) console.error(`  ${p.script} → ${p.ref}`);
}
if (workflowProblems.length) {
  console.error("幽灵工作流步骤（workflow 运行了不在 HEAD 里的脚本）:");
  for (const p of workflowProblems) console.error(`  ${p.workflow} → ${p.ref}`);
}
if (!RATCHET_HEAD && current.workflowChecked.length === 0) {
  console.error("check-script-entry-existence: examined 0 workflow invocation(s), so nothing was verified");
  process.exit(1);
}

if (problems.length || workflowProblems.length) process.exit(1);
console.log(
  `check-script-entry-existence: ${current.checked.length} 个 scripts 路径引用与 ${current.workflowChecked.length} 个 workflow 脚本引用全部校验通过 ✓`,
);
