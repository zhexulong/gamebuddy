import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * 未覆盖出口展开的校准测试。
 *
 * 保护的核心事实：一个未覆盖出口 ≠ 一个 action。
 *   `checkForAction`         17 个实现 → 3 个产出候选（其余被 P2/P3/P4/P6/P7 拒）
 *   `performAction`          18 个实现 → 4 个产出候选，其中基类含 127 个 selector（解释器）
 *   `performObjectDropInAction` 10 个实现 → 6 个产出候选
 *   `rotate` / `animateSpecialMove` 各 1 个实现 → 单实现
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..", "..");
const SOURCE_ROOT = path.join(ROOT, "ref", "external", "StardewValleyDecompiled", "Stardew Valley");
const REGISTER = "integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json";
const CATALOG = "design/gameplay-capability-catalog.json";
const execFileAsync = promisify(execFile);

async function run(script, args) {
  const { stdout } = await execFileAsync(process.execPath, [path.join(HERE, "..", "src", "analysis", script), ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: ROOT,
  });
  return JSON.parse(stdout);
}

let artifactPromise = null;
function expansion() {
  artifactPromise ??= (async () => {
    const tmp = path.join(HERE, `.tmp-expansion-${process.pid}.json`);
    const reconTmp = path.join(HERE, `.tmp-recon-${process.pid}.json`);
    const exits = await run("stardew-player-reachable-exits.mjs", [
      "--source-root",
      SOURCE_ROOT,
      "--action-register",
      REGISTER,
      "--max-depth",
      "4",
    ]);
    await writeFile(tmp, JSON.stringify(exits));
    await run("stardew-reachable-exit-reconciliation.mjs", [
      "--exits",
      tmp,
      "--action-register",
      REGISTER,
      "--catalog",
      CATALOG,
      "--game-source-root",
      SOURCE_ROOT,
      "--out",
      reconTmp,
    ]);
    const result = await run("stardew-uncovered-exit-expansion.mjs", [
      "--source-root",
      SOURCE_ROOT,
      "--exits",
      reconTmp,
    ]);
    await rm(tmp, { force: true });
    await rm(reconTmp, { force: true });
    return result;
  })();
  return artifactPromise;
}

test("只展开未覆盖的 gameplay 出口（4 个）", async () => {
  const a = await expansion();
  assert.equal(a.artifactKind, "stardew_uncovered_exit_expansion");
  // `canBePlacedHere` 在 2e9e13e 之前因 place_wood_fence 的错误 seam 引用被算作已覆盖；
  // 修正为真实变异点 placementAction 后，它诚实地回到未覆盖集。
  //
  // 6 → 4：`checkForAction` 与 `performObjectDropInAction` 已随其他 lane 的 action 注册
  // （register 里的 seam 现在能承载这两个出口）退出未覆盖集，而不是被静默丢弃。
  assert.equal(a.counts.uncoveredExits, 4);
  const names = a.expansions.map((e) => e.nativeMember).sort();
  assert.deepEqual(names, ["animateSpecialMove", "canBePlacedHere", "performAction", "rotate"]);
});

test("单实现出口 vs 多实现出口被区分", async () => {
  const a = await expansion();
  const byName = new Map(a.expansions.map((e) => [e.nativeMember, e]));
  assert.equal(byName.get("rotate").shape, "single_implementor");
  assert.equal(byName.get("rotate").implementorCount, 1);
  assert.equal(byName.get("animateSpecialMove").shape, "single_implementor");
  assert.equal(byName.get("canBePlacedHere").shape, "multi_implementor");
  assert.ok(byName.get("canBePlacedHere").implementorCount >= 4);
});

test("解释器形态被识别（selector 数超阈值）", async () => {
  const a = await expansion();
  const byName = new Map(a.expansions.map((e) => [e.nativeMember, e]));
  // `checkForAction` 已随其他 lane 的 action 注册退出未覆盖集（见上一个测试的注释），
  // `performAction` 仍是在场最强的解释器证据。
  assert.equal(byName.get("performAction").shape, "interpreter");
  const performAction = byName.get("performAction");
  const big = performAction.units.find((u) => u.selectorCount >= 100);
  assert.ok(big, "应找到含 100+ selector 的基类实现");
  assert.equal(big.class, "GameLocation");
});

test("多实现出口不把实现数当成 action 数", async () => {
  const a = await expansion();
  // `performObjectDropInAction` 已退出未覆盖集，`canBePlacedHere` 接手同一命题。
  // 实测 4 个实现（Item / Object / Furniture / Wallpaper）里只有 Furniture 产出候选：
  // 一个出口有 N 个实现，不等于 N 个 action。
  const e = a.expansions.find((x) => x.nativeMember === "canBePlacedHere");
  assert.equal(e.shape, "multi_implementor");
  assert.equal(e.implementorCount, 4);
  assert.equal(e.candidateUnitCount, 1);
  assert.ok(
    e.candidateUnitCount < e.implementorCount,
    `候选实现数应严格小于实现总数：${e.candidateUnitCount}/${e.implementorCount}`,
  );
  // 非空实现必须给出判决（候选分支或有名的拒绝谓词）。`Item.canBePlacedHere` 是
  // 空实现，既无分支也无拒绝谓词——那是诚实的“这里无东西可判”，不是缺失证据。
  for (const u of e.units.filter((unit) => unit.candidateCount > 0 || unit.branchCount > 0)) {
    const hasVerdict = u.candidateCount > 0 || u.rejectedBy.length > 0 || u.extractionError !== null;
    assert.ok(hasVerdict, `${u.class} 必须有候选分支或被拒谓词`);
  }
});

test("每个展开单元都带源码锚点与归属类", async () => {
  const a = await expansion();
  for (const e of a.expansions)
    for (const u of e.units) {
      assert.ok(u.file.endsWith(".cs"), `${e.nativeMember} 的单元必须有源码文件`);
      assert.ok(u.methodLine > 0, `${e.nativeMember} 的单元必须有方法行号`);
      assert.ok(u.class !== "(unknown)", `${e.nativeMember} 的单元必须有类名`);
    }
});

test("产物声明一实现不等于一 action", async () => {
  const a = await expansion();
  for (const g of [
    "no_action_identity_inferred",
    "one_implementor_does_not_imply_one_action",
    "selector_count_is_a_heuristic_for_interpreter_shape_not_a_proof",
    "candidate_branch_is_a_derivation_input_not_a_publishable_action",
  ])
    assert.ok(a.nonGuarantees.includes(g), `产物必须声明 ${g}`);
});
