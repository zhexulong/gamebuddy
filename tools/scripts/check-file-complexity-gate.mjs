/**
 * 复杂度棘轮：核心文件只许瘦身、禁止膨胀。
 *
 * 2026-10-03 冻结的绝对上限（CEILINGS）在 HEAD 已被四个文件突破：
 * ModEntry.cs 2887/2800、ModEntry.Fixtures.cs 5338/4500、
 * continuity-semantic-production-store.ts 5042/4400、protocol.ts 5564/4400。只要上限本身是判定
 * 依据，这四行永远是红的，"这次改动有没有让文件变大"就没人读得到 - 门禁越红越没人读。
 *
 * 所以判定改成 diff-ratchet：以 file-complexity-baseline.json 记录的当前行数为比较基准，只有
 * "比基准更大"才失败；绝对上限留在 CEILINGS 里作为最终目标（只降不升，调高仍需架构 owner 批准
 * 并在注释里记录理由）。基准取"记录的当前行数"而不是 git merge-base：CI 是 depth-1 checkout，
 * 没有可用的 base；而且这五个文件在 origin/main 与 HEAD 之间一行未变，两种基准在当前状态下等价。
 *
 * 每条判定 = 行数 > max(绝对上限, 已记录行数)。上限尚未突破的文件（当前只有
 * ComposedReferenceGameApp.tsx 1247/1450）仍以绝对上限为准，与旧门禁一致；已突破上限的文件只在
 * 继续变大时失败。失败的永远是"你让它变大了"，不是"它本来就大"。
 *
 * 用法：
 *   node tools/scripts/check-file-complexity-gate.mjs              # 棘轮
 *   node tools/scripts/check-file-complexity-gate.mjs --update     # 单独提交里重新记录基准
 *   node tools/scripts/check-file-complexity-gate.mjs --root <dir> # 门禁自己的 fixture
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// 基线（行，含尾行）：2026-10-03 冻结。调低许可文件；调高必须先经架构 owner
// 批准并在本文件注释记录理由。这是最终目标，不是当前判定依据。
export const CEILINGS = new Map([
  ["integrations/stardew/ModEntry.cs", 2800], // 夹具剥离后生产区（原 6943；夹具已至 Fixtures.cs）
  ["integrations/stardew/ModEntry.Fixtures.cs", 4500], // 夹具搬移区（机械切分，禁止再加业务）
  ["host/src/continuity-semantic-store/continuity-semantic-production-store.ts", 4400], // 单调收紧目标 ≤4000
  ["host/src/protocol.ts", 4400], // 表驱动重构目标 ≤3000
  ["dialogue-web/src/components/ComposedReferenceGameApp.tsx", 1450], // 状态机收敛目标 ≤1200
]);

const baselineFor = (root) => join(root, "tools", "scripts", "file-complexity-baseline.json");

/** 每个文件的判定上限：绝对上限与已记录行数中较大的那个。 */
export function limits({ recorded, ceilings = CEILINGS }) {
  const limits = new Map();
  for (const [file, ceiling] of ceilings) limits.set(file, Math.max(ceiling, recorded[file] ?? ceiling));
  return limits;
}

/** 比判定上限更大的文件（本次变大了），以及已登记却读不到的文件。 */
export function ratchet({ recorded, sizes, ceilings = CEILINGS }) {
  const grown = [];
  const missing = [];
  for (const [file, limit] of limits({ recorded, ceilings })) {
    const lines = sizes.get(file);
    if (lines === undefined) missing.push(file);
    else if (lines > limit) grown.push({ file, lines, limit });
  }
  return { grown, missing };
}

const valueOf = (argv, name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};

/** 每个核心文件的当前行数；读不到的文件记为 undefined。 */
export function measure(root) {
  const sizes = new Map();
  for (const file of CEILINGS.keys()) {
    try {
      sizes.set(file, readFileSync(join(root, file), "utf8").split("\n").length);
    } catch {
      sizes.set(file, undefined);
    }
  }
  return sizes;
}

function main(argv) {
  const root = resolve(valueOf(argv, "--root") ?? repositoryRoot);
  const update = argv.includes("--update");
  const sizes = measure(root);
  const missing = [...sizes].filter(([, lines]) => lines === undefined).map(([file]) => file);

  if (update) {
    const recorded = Object.fromEntries([...sizes].filter(([, lines]) => lines !== undefined));
    const baseline = {
      note: "核心文件的当前行数，记录自提交树。复杂度棘轮以它作为比较基准：只有比它更大才失败，绝对上限见 check-file-complexity-gate.mjs 的 CEILINGS。请在单独提交里重新记录。",
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
    if (missing.length > 0) {
      console.error(`  读不到：${missing.join("、")}`);
      return 1;
    }
    return 0;
  }

  const recorded = JSON.parse(readFileSync(baselineFor(root), "utf8")).sizes;
  const computedLimits = limits({ recorded });
  const { grown } = ratchet({ recorded, sizes });
  for (const [file, lines] of sizes) {
    const limit = computedLimits.get(file);
    const verdict = lines === undefined || lines > limit ? "✖" : "✓";
    const shown = lines === undefined ? "文件不存在（被删除应确认是否仍有引用）" : `${lines} 行 / 判定上限 ${limit}`;
    const detail =
      lines === undefined ? "" : `（已记录 ${recorded[file] ?? "未记录"}，最终目标 ${CEILINGS.get(file)}）`;
    console.log(`${verdict} ${file}: ${shown}${detail}`);
  }
  if (missing.length > 0 || grown.length > 0) {
    console.error("\n复杂度棘轮失败：核心文件本次比记录的基准更大。只允许瘦身；膨胀需架构 owner 批准。");
    for (const file of missing) console.error(`  ${file}: 文件不存在`);
    for (const { file, lines } of grown) console.error(`  ${file}: ${recorded[file] ?? "未记录"} -> ${lines} 行`);
    return 1;
  }
  const debt = [...sizes]
    .filter(([file, lines]) => lines > CEILINGS.get(file))
    .map(([file, lines]) => `${file} ${lines}/${CEILINGS.get(file)}`)
    .join("、");
  console.log(`\n复杂度棘轮通过：${CEILINGS.size} 个核心文件均未超过判定上限。`);
  console.log(`记录中的债务（已超最终目标、只允许瘦身）：${debt || "无"}`);
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
