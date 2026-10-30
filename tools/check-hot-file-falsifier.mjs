/**
 * 热文件 falsifier 报告（先报告，不拦截）。
 *
 * 为什么只出报告：这个仓里 feat 提交有 75.9% 在 72 小时内被 fix 打补丁，但分层对照后
 * 那 76% 几乎全落在一小撮文件上（只碰"同期 <=3 次提交"的冷文件的 feat 只有 23.3%）。
 * 也就是说问题不是"提交太快"，而是"同一批文件被反复改，而每次改动都没有一个能在本地
 * 变红的判据"。这一批文件就是腐化清单。
 *
 * 判据从哪里来：不手维护名单。每次都从 git 历史派生命题——
 *   1. 近 N 天里，某文件出现在多少个 fix 提交里；
 *   2. 达到阈值就算"处在反复修复周期中"。
 * 阈值取 90 天 / >=10 次（当前会选中 68 个文件；>=5 次会选中 197 个，太吵）。
 * 名单会随代码变化自己移动，不需要谁记得来更新。
 *
 * 它读什么：本次提交实际改到的路径 vs 从历史派生的热文件集合。
 * 它不读什么：commit message 里的话对不对。报告只问一个问题——
 * "你改了这批一直在漏的文件，那么这次你手里有没有一个能让它变红的判据？"
 *
 * 因为先报告，退出码恒为 0；等到误报率被真实使用压到可接受后，再把 --enforce 打开。
 *
 * 用法：
 *   node tools/check-hot-file-falsifier.mjs                 # 报告 staged 改动
 *   node tools/check-hot-file-falsifier.mjs --range HEAD~1  # 报告某个提交范围
 *   node tools/check-hot-file-falsifier.mjs --enforce       # 缺 falsifier 时失败
 *   node tools/check-hot-file-falsifier.mjs --json          # 机器可读
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const POLICY = {
  windowDays: 90,
  hotFixCommits: 10,
  minBodyChars: 12,
};

const FALSIFIER_KEYS =
  /(falsifier|seen red|red first|verified red|变红|先红|可证伪|regression proof|failing test|fails without|fails when|reverting .* fails|disabling .* fails|removing .* fails)/i;

export function parseCli(argv) {
  const options = {
    range: null,
    enforce: false,
    json: false,
    staged: true,
    windowDays: POLICY.windowDays,
    hotFixCommits: POLICY.hotFixCommits,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--range") {
      options.range = argv[++i] ?? null;
      options.staged = false;
    } else if (a === "--enforce") options.enforce = true;
    else if (a === "--json") options.json = true;
    else if (a === "--window-days") options.windowDays = Number(argv[++i]);
    else if (a === "--hot-fix-commits") options.hotFixCommits = Number(argv[++i]);
    else throw new Error(`unknown_argument:${String(a)}`);
  }
  return options;
}

const git = (args, cwd = repositoryRoot) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 29 }).toString();

/** 从历史派生热文件集合：文件 -> 近 windowDays 天内落在 fix 提交里的次数。 */
export function deriveHotFiles({ cwd = repositoryRoot, windowDays, hotFixCommits }) {
  const since = `${windowDays}.days`;
  const subjects = git(["log", `--since=${since}`, "--pretty=tformat:%h %s"], cwd).split("\n");
  const fixShas = new Set(
    subjects.filter((line) => /^[0-9a-f]{7,} fix[:(]/.test(line)).map((line) => line.split(" ")[0]),
  );

  const counts = new Map();
  let current = null;
  const raw = git(["log", `--since=${since}`, "--pretty=tformat:@@%h", "--name-only"], cwd);
  for (const line of raw.split("\n")) {
    if (line.startsWith("@@")) {
      current = line.slice(2);
      continue;
    }
    const path = line.trim();
    if (!path || !current || !fixShas.has(current)) continue;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }

  const hot = new Map([...counts].filter(([, n]) => n >= hotFixCommits));
  return { hot, fixCommitCount: fixShas.size, filesSeen: counts.size };
}

export function changedPaths({ cwd = repositoryRoot, range, staged }) {
  const args = staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]
    : ["diff", "--name-only", "--diff-filter=ACMR", range ?? "HEAD~1"];
  return git(args, cwd)
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
}

export function hasFalsifier(body) {
  const text = String(body ?? "");
  if (!text.trim()) return false;
  for (const line of text.split("\n")) {
    if (!FALSIFIER_KEYS.test(line)) continue;
    if (line.trim().length >= POLICY.minBodyChars) return true;
  }
  return false;
}

/** 判定：改动里是否含热文件，以及这些热文件缺不缺 falsifier。 */
export function assess({ hot, paths, body }) {
  const touched = paths.filter((p) => hot.has(p));
  const ok = hasFalsifier(body);
  return {
    hotFilesTouched: touched.map((p) => ({ path: p, fixCommits: hot.get(p) })),
    falsifierPresent: ok,
    needsFalsifier: touched.length > 0 && !ok,
  };
}

function main() {
  const options = parseCli(process.argv.slice(2));
  const derived = deriveHotFiles({
    windowDays: options.windowDays,
    hotFixCommits: options.hotFixCommits,
  });
  const paths = changedPaths({ range: options.range, staged: options.staged });
  const body = options.staged ? "" : git(["log", "-1", "--pretty=tformat:%B", options.range ?? "HEAD"]);
  const result = assess({ hot: derived.hot, paths, body });
  const failing = result.needsFalsifier;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          policy: { windowDays: options.windowDays, hotFixCommits: options.hotFixCommits },
          derived: { hotFiles: derived.hot.size, fixCommits: derived.fixCommitCount, filesSeen: derived.filesSeen },
          changed: paths.length,
          ...result,
          enforced: options.enforce,
          status: failing ? (options.enforce ? "failed" : "reported") : "passed",
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `check-hot-file-falsifier: ${derived.hot.size} 个热文件（近 ${options.windowDays} 天 >=${options.hotFixCommits} 次 fix 提交）；本次改动 ${paths.length} 个文件`,
    );
    if (result.hotFilesTouched.length === 0) {
      console.log("check-hot-file-falsifier: 未触及热文件");
    } else {
      console.log(`check-hot-file-falsifier: 触及 ${result.hotFilesTouched.length} 个热文件`);
      for (const h of result.hotFilesTouched.slice(0, 12)) {
        console.log(`  ${String(h.fixCommits).padStart(3)}x fix  ${h.path}`);
      }
      if (result.hotFilesTouched.length > 12) {
        console.log(`  …以及 ${result.hotFilesTouched.length - 12} 个`);
      }
      if (!result.falsifierPresent) {
        console.log("");
        console.log("check-hot-file-falsifier: commit body 里没有找到可证伪的判据。");
        console.log("  需要一行说明「哪个测试/gate 会因为这个改动变红」，例如：");
        console.log("  Falsifier: reverting the guard fails tests/foo.spec.ts (3 pass / 1 fail)");
        console.log(`  这是报告，不是拦截${options.enforce ? "" : "（暂不阻断；--enforce 才失败）"}。`);
      }
    }
  }

  if (failing && options.enforce) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
