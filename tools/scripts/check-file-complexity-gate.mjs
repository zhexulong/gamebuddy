/**
 * 复杂度棘轮：仓库里每一个源码文件都按扩展名有自己的上限，只有"比记录的基准更大"才失败。
 *
 * 2026-10-03 冻结的五个绝对上限在 HEAD 已被四个文件突破（ModEntry.cs 2926/2800、ModEntry.Fixtures.cs
 * 5083/4500、continuity-semantic-production-store.ts 5178/4400、protocol.ts 5786/4400）。只要上限本身是
 * 判定依据，这四行永远红，"这次改动有没有让文件变大"就没人读得到 - 门禁越红越没人读。所以判定分成两件事，
 * 这是本文件唯一的分工：
 *
 *   - CEILINGS_BY_EXTENSION 是目标：一个文件大到该拆开的界线；
 *   - file-complexity-baseline.json 是判定：已在上限之上的文件被记录在当前行数，只有比记录更大才失败。
 *
 * 被测文件集不再是一张手写清单。旧版把五个文件写进 CEILINGS 并且只读那五个，作者没想到的文件永远不被量：
 * integrations/stardew/farmhandexecutioncontroller*.cs 是 46 个分片、29,080 行，一行都没进过这个门禁。
 * 现在的文件集是 git 自己的回答 - `git ls-files --cached --others --exclude-standard`：已跟踪的文件，
 * 加上还没提交的新文件（旧清单最容易漏掉的正是这个），减去 .gitignore 排除的临时/生成/依赖目录；submodule
 * （vendor/）是别的仓库的源码，git 只给一个 gitlink，不是文件，因此不进样本。
 *
 * 为什么按扩展名分上限，而不是一个数字：`.cs` 的一行是声明加括号，`.ts` 的一行可以是一整条链式调用，
 * 同一个数字要么把 C# 逼到不可能，要么把 TypeScript 放到没人需要拆。每个数字都取自这棵树自己的分布：该扩展名
 * 文件行数的第 99 百分位，向上取整到百位（2026-11-11 实测，逐行注明）。百分位就是"这棵树里 1% 的文件已经在
 * 这条线之上"，所以它把今天的债务原样交出来，而不是发明一个没人达得到的圆整数。样本很小的扩展名（.mts 2 个、
 * .py 12 个文件）百分位就是样本的最大值本身，300 行地板接住它们：任何语言 300 行都还不到必须拆的程度。
 *
 * 判定与失败码：
 *   file_over_ceiling:<path>:<lines>:<ceiling>          未登记，且超过本扩展名上限
 *   baselined_file_grew:<path>:<lines>:<recorded>       已登记，且比记录的行数更大
 *   stale_file_ceiling_baseline:<path>                  已登记，但文件已删除或已回到上限之内 - 基准只许收紧
 *   expired_file_ceiling_extension:<ext>                上限还在，树里已经没有这种文件
 *   status=blocked file_complexity_population_empty     一个文件都没量到（exit 2，绝不当通过）
 *
 * 用法：
 *   node tools/scripts/check-file-complexity-gate.mjs              # 棘轮
 *   node tools/scripts/check-file-complexity-gate.mjs --update     # 单独提交里重新记录基准
 *   node tools/scripts/check-file-complexity-gate.mjs --root <dir> # 门禁自己的 fixture（必须是一个 git 工作树）
 *
 * red-proof: inject  一个 351 行的 `.py` 新文件（上限 300）进 git 工作树 ->
 *                    `file_over_ceiling:src/wide.py:351:300`、`files examined 9 · over ceiling 1 · baselined 0`，exit 1；
 *                    同一工作树在加这个文件之前打印「复杂度棘轮通过」，exit 0（tools/scripts/check-file-complexity-gate.mjs）
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 单一文件的物理行数（含尾行）上限，每个扩展名一个，理由见文件头。 */
export const CEILINGS_BY_EXTENSION = new Map([
  [".ts", 4900], // 837 个文件，p99 4828
  [".mjs", 1700], // 1293 个文件，p99 1677
  [".cs", 2000], // 682 个文件，p99 1926
  [".tsx", 2100], // 37 个文件，p99 2080
  [".ps1", 800], // 57 个文件，p99 738
  [".cjs", 900], // 28 个文件，p99 801
  [".py", 300], // 12 个文件，p99 206（地板）
  [".mts", 300], // 2 个文件，p99 33（地板）
]);

const baselineFor = (root) => join(root, "tools", "scripts", "file-complexity-baseline.json");

const valueOf = (argv, name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};

/** git 回答"这个工作树里哪些文件属于本仓库"：已跟踪 + 未忽略的未跟踪文件。 */
function ownedFiles(root) {
  try {
    return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
      .split("\0")
      .filter((file) => file !== "");
  } catch (error) {
    throw new Error(
      `file_complexity_population_unreadable:${root}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 被扫描文件的当前行数，外加两笔清点：每个扩展名各贡献了多少个文件，以及树里有文件却没有上限的扩展名
 * （后者每次运行都打印出来 - 新语言出现时，缺失的上限必须是看得见的，而不是悄无声息地不参与判定）。
 */
export function measure(root, { ceilings = CEILINGS_BY_EXTENSION } = {}) {
  const sizes = new Map();
  const extensions = new Map();
  const unmeasured = new Map();
  for (const file of ownedFiles(root)) {
    const extension = extname(file);
    if (!ceilings.has(extension)) {
      unmeasured.set(extension, (unmeasured.get(extension) ?? 0) + 1);
      continue;
    }
    let stat;
    try {
      stat = statSync(join(root, file));
    } catch {
      continue; // 已删除但仍在索引里
    }
    if (!stat.isFile()) continue;
    sizes.set(file, readFileSync(join(root, file), "utf8").split("\n").length);
    extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
  }
  return { sizes, extensions, unmeasured };
}

/**
 * 三类判定，每类只报它自己。
 *
 * `recorded` 里的文件以记录值为上限（它已经在上限之上，那正是它被记录的原因），其余文件以本扩展名上限为准；
 * `stale` 是反方向：记录还在，但文件没了或已经回到上限之内，基准必须删掉这一条。
 */
export function verdict({ recorded, sizes, ceilings = CEILINGS_BY_EXTENSION }) {
  const overCeiling = [];
  const grew = [];
  const stale = [];
  for (const [file, lines] of sizes) {
    const ceiling = ceilings.get(extname(file));
    const baseline = recorded[file];
    if (baseline === undefined) {
      if (lines > ceiling) overCeiling.push({ file, lines, ceiling });
    } else if (lines > baseline) {
      grew.push({ file, lines, recorded: baseline, ceiling });
    }
  }
  for (const [file, baseline] of Object.entries(recorded)) {
    const lines = sizes.get(file);
    if (lines === undefined || lines <= ceilings.get(extname(file)))
      stale.push({ file, lines, ceiling: ceilings.get(extname(file)), recorded: baseline });
  }
  const byFile = (left, right) => left.file.localeCompare(right.file);
  return { overCeiling: overCeiling.sort(byFile), grew: grew.sort(byFile), stale: stale.sort(byFile) };
}

/** 上限还在、树里已经没有这种文件的扩展名。 */
export function expired({ extensions, ceilings = CEILINGS_BY_EXTENSION }) {
  return [...ceilings].filter(([extension]) => !extensions.has(extension)).map(([extension]) => extension);
}

function main(argv) {
  const root = resolve(valueOf(argv, "--root") ?? repositoryRoot);
  const update = argv.includes("--update");
  const { sizes, extensions, unmeasured } = measure(root);

  if (sizes.size === 0) {
    console.error(`status=blocked file_complexity_population_empty:${root}`);
    console.error("  什么也没量到的运行不是通过：样本来自 git ls-files，先确认 root 是一个工作树。");
    return 2;
  }

  if (update) {
    const recorded = {};
    for (const [file, lines] of [...sizes].sort(([left], [right]) => left.localeCompare(right))) {
      if (lines > CEILINGS_BY_EXTENSION.get(extname(file))) recorded[file] = lines;
    }
    const baseline = {
      note: "已在上限之上的文件及其当前行数，记录自提交树。棘轮以它作为比较基准：只有比记录更大才失败；文件回到上限之内或消失时必须删掉对应条目。扩展名上限见 check-file-complexity-gate.mjs 的 CEILINGS_BY_EXTENSION。请在单独提交里重新记录。",
      revision: execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      sizes: recorded,
    };
    writeFileSync(baselineFor(root), `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(
      `complexity_ratchet_recorded files=${Object.keys(recorded).length} revision=${baseline.revision}\n`,
    );
    return 0;
  }

  const { sizes: recorded } = JSON.parse(readFileSync(baselineFor(root), "utf8"));
  const { overCeiling, grew, stale } = verdict({ recorded, sizes });
  // 失效的上限只有本仓库自己的树能判：fixture 是仓库的一个样本，它没有 .cs 文件不代表这个仓库不再写 C#。
  const expiredExtensions = root === repositoryRoot ? expired({ extensions }) : [];

  for (const [extension, count] of [...extensions].sort((left, right) => right[1] - left[1]))
    console.log(`${extension} ${count} 个文件 · 上限 ${CEILINGS_BY_EXTENSION.get(extension)} 行`);
  if (unmeasured.size > 0)
    console.log(
      `未设上限（不参与判定）：${[...unmeasured]
        .sort((left, right) => right[1] - left[1])
        .map(([extension, count]) => `${extension === "" ? "(无扩展名)" : extension} ${count}`)
        .join(" · ")}`,
    );

  const debt = [...sizes]
    .filter(([file, lines]) => lines > CEILINGS_BY_EXTENSION.get(extname(file)))
    .sort((left, right) => right[1] - left[1]);
  const [largestFile, largestLines] = [...sizes].sort((left, right) => right[1] - left[1])[0];
  console.log(
    `\nfiles examined ${sizes.size} · over ceiling ${debt.length} · baselined ${Object.keys(recorded).length} · largest ${largestFile} @ ${largestLines}`,
  );
  for (const [file, lines] of debt) {
    const ceiling = CEILINGS_BY_EXTENSION.get(extname(file));
    console.log(`  ${lines} / ${ceiling} ${file}${recorded[file] === undefined ? "" : "（已登记）"}`);
  }

  for (const { file, lines, ceiling } of overCeiling) console.error(`file_over_ceiling:${file}:${lines}:${ceiling}`);
  for (const { file, lines, recorded: baseline } of grew)
    console.error(`baselined_file_grew:${file}:${lines}:${baseline}`);
  for (const { file } of stale) console.error(`stale_file_ceiling_baseline:${file}`);
  for (const extension of expiredExtensions) console.error(`expired_file_ceiling_extension:${extension}`);

  if (overCeiling.length + grew.length + stale.length + expiredExtensions.length > 0) {
    console.error("\n复杂度棘轮失败：只允许瘦身。新文件超上限请拆开；已登记文件回到上限之内请删掉该条目。");
    return 1;
  }
  console.log("\n复杂度棘轮通过：没有文件超过判定上限，也没有失效的基准条目。");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
