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
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
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

function collectScripts(pkgRoot) {
  const pkgPath = join(pkgRoot, "package.json");
  if (!existsSync(pkgPath)) return [];
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return Object.entries(pkg.scripts || {}).map(([name, cmd]) => ({ name, cmd, pkgRoot }));
}

/** The repo-relative, POSIX-separated form of one resolved reference. */
function repoRelative(ref) {
  return relative(root, resolve(root, ref.replace(/["'`]$/, "")))
    .split("\\")
    .join("/");
}

/** Whether git ignores this path, i.e. it is a build output rather than repository content. */
function isBuildOutput(ref) {
  // A directory pattern in .gitignore (`dist/`) only matches a path that exists as a directory: git answers
  // "not ignored" for `host/dist` when the build has not run, and "ignored" for the same path once it has.
  // That made this gate pass on a developer's machine (artifacts present) and fail on a fresh checkout
  // (`.:build:player-distribution -> host/dist`), which reads as a phantom script entry rather than as a
  // build output. Asking about the directory form as well makes the answer independent of the artifact.
  const candidates = [repoRelative(ref), `${repoRelative(ref)}/`];
  for (const candidate of candidates) {
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

function resolveRef(rootDir, ref) {
  // 去掉尾部引号/分号/重定向残留
  const clean = ref.replace(/["'`]$/, "");
  if (/[*?[\]]/.test(clean)) return null; // glob，跳过
  const full = resolve(rootDir, clean);
  const st = statSync(full, { throwIfNoEntry: false });
  if (!st) return null; // 不存在
  return full;
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
      const found = resolveRef(pkgRoot || root, ref);
      if (found) checked.push(ref);
      else if (isBuildOutput(ref)) checked.push(ref);
      else problems.push({ script: `${dir || "."}:${name}`, ref });
    }
  }
}

if (problems.length) {
  console.error("幽灵脚本入口（package.json scripts 引用了不存在的文件）:");
  for (const p of problems) console.error(`  ${p.script} → ${p.ref}`);
  process.exit(1);
}
console.log(`check-script-entry-existence: ${checked.length} 个路径引用全部存在 ✓`);
