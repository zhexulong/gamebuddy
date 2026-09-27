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

test("只展开未覆盖的 gameplay 出口（6 个）", async () => {
  const a = await expansion();
  assert.equal(a.artifactKind, "stardew_uncovered_exit_expansion");
  // `canBePlacedHere` 在 2e9e13e 之前因 place_wood_fence 的错误 seam 引用被算作已覆盖；
  // 修正为真实变异点 placementAction 后，它诚实地回到未覆盖集（见 reconcile 测试里的同类注释）。
  assert.equal(a.counts.uncoveredExits, 6);
  const names = a.expansions.map((e) => e.nativeMember).sort();
  assert.deepEqual(names, [
    "animateSpecialMove",
    "canBePlacedHere",
    "checkForAction",
    "performAction",
    "performObjectDropInAction",
    "rotate",
  ]);
});

test("单实现出口 vs 多实现出口被区分", async () => {
  const a = await expansion();
  const byName = new Map(a.expansions.map((e) => [e.nativeMember, e]));
  assert.equal(byName.get("rotate").shape, "single_implementor");
  assert.equal(byName.get("rotate").implementorCount, 1);
  assert.equal(byName.get("animateSpecialMove").shape, "single_implementor");
  assert.equal(byName.get("performObjectDropInAction").shape, "multi_implementor");
  assert.ok(byName.get("performObjectDropInAction").implementorCount >= 9);
});

test("解释器形态被识别（selector 数超阈值）", async () => {
  const a = await expansion();
  const byName = new Map(a.expansions.map((e) => [e.nativeMember, e]));
  assert.equal(byName.get("checkForAction").shape, "interpreter");
  assert.equal(byName.get("performAction").shape, "interpreter");
  const performAction = byName.get("performAction");
  const big = performAction.units.find((u) => u.selectorCount >= 100);
  assert.ok(big, "应找到含 100+ selector 的基类实现");
  assert.equal(big.class, "GameLocation");
});

test("checkForAction 的 17 个实现里只有少数产出候选", async () => {
  const a = await expansion();
  const e = a.expansions.find((x) => x.nativeMember === "checkForAction");
  assert.equal(e.implementorCount, 17);
  assert.ok(
    e.candidateUnitCount > 0 && e.candidateUnitCount < e.implementorCount,
    `候选实现数应严格小于实现总数：${e.candidateUnitCount}/${e.implementorCount}`,
  );
  // 每个实现都必须有被拒谓词或候选分支之一，不能两者皆空
  for (const u of e.units) {
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
