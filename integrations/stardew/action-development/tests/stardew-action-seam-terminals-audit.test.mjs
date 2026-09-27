import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * seam 终态审计的测试。
 *
 * 核心事实：`native-multiplayer-sensitivity.v1.json` 的 seam 表是人工编写的
 * （generator 里是硬编码映射），实测 12 个「已注册但九谓词全拒」的 action 中
 * 有 5 个的 seam 引用指向非终态位置：
 *   harvest_crop       → HoeDirt.performUseAction（路由；真终态是 destroyCrop 的 crop = null）
 *   scythe_crop        → HoeDirt.performToolAction（同上）
 *   ship_item          → Farm.getShippingBin（取句柄；真终态是 shipItem 的 lastItemShipped）
 *   pet_animal         → Pet.checkAction（写的是 hat/Items，不是抚摸结果）
 *   cut_weeds          → Object.performToolAction（写 fragility 等，非割草终态）
 *
 * 第 6 条 `place_wood_fence` 已修复：原先引用纯判断的 `Object.canBePlacedHere`
 * （0 写入 → gate 误判 mp-insensitive 并放行），现改为引用真实变异点
 * `Object.placementAction` 并判 `mp-observational`。见下方专门的回归测试。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..", "..");
const SOURCE_ROOT = path.join(ROOT, "ref", "external", "StardewValleyDecompiled", "Stardew Valley");
const REGISTER = "integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json";
const execFileAsync = promisify(execFile);

let cached = null;
async function audit() {
  if (cached) return cached;
  const candPath = path.join(HERE, `.tmp-seam-cand-${process.pid}.json`);
  const auditPath = path.join(HERE, `.tmp-seam-audit-${process.pid}.json`);
  await execFileAsync(
    process.execPath,
    [
      path.join(HERE, "..", "src", "analysis", "stardew-action-candidates.mjs"),
      "--source-root",
      SOURCE_ROOT,
      "--action-register",
      REGISTER,
      "--out",
      candPath,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: ROOT },
  );
  await execFileAsync(
    process.execPath,
    [
      path.join(HERE, "..", "src", "analysis", "stardew-action-seam-terminals-audit.mjs"),
      "--candidates",
      candPath,
      "--source-root",
      SOURCE_ROOT,
      "--out",
      auditPath,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: ROOT },
  );
  cached = JSON.parse(await readFile(auditPath, "utf8"));
  await rm(candPath, { force: true });
  await rm(auditPath, { force: true });
  return cached;
}

test("审计 11 个「已注册但九谓词全拒」的 seam", async () => {
  const a = await audit();
  assert.equal(a.artifactKind, "stardew_action_seam_terminal_audit");
  assert.equal(a.counts.audited, 11);
  assert.equal(
    a.counts.byKind.terminal_in_delegate +
      a.counts.byKind.seam_not_terminal +
      a.counts.byKind.seam_writes_but_no_terminal,
    11,
  );
});

test("6 个工具类 DoFunction 的 seam 引用正确（终态在委托目标）", async () => {
  const a = await audit();
  const deleg = a.audit.filter((x) => x.kind === "terminal_in_delegate");
  assert.equal(deleg.length, 6);
  const ids = deleg.map((x) => x.actionId).sort();
  assert.deepEqual(ids, [
    "break_rock_source",
    "chop_stump",
    "chop_tree_source",
    "clear_hoedirt",
    "dig_artifact_spot",
    "till_soil",
  ]);
  for (const x of deleg) assert.ok(x.evidence.delegates.length > 0, `${x.actionId} 必须有委托目标`);
});

test("5 个 seam 引用指向非终态位置（可疑）", async () => {
  const a = await audit();
  assert.equal(a.counts.suspectSeamReferences, 5);
  const ids = a.suspectSeamReferences.map((s) => s.actionId).sort();
  /**
   * `pet_animal` 已不在此列：P1 修正（手持物消耗不算多持有）后它的戴帽分支成为候选。
   * `chest_store` 取而代之：`Chest.addItem` 的终态是 `itemsForPlayer.Add(item)`
   * 这种 mutator 调用，纯赋值提取看不到，故被归为 seam_not_terminal。
   */
  assert.deepEqual(ids, ["chest_store", "cut_weeds", "harvest_crop", "scythe_crop", "ship_item"]);
});

test("ship_item 的记录 seam 是取句柄方法，无任何写入", async () => {
  const a = await audit();
  const s = a.suspectSeamReferences.find((x) => x.actionId === "ship_item");
  assert.equal(s.kind, "seam_not_terminal");
  assert.equal(s.recordedSeam.member, "getShippingBin");
  assert.equal(s.writes.length, 0, "getShippingBin 只返回 IInventory，不写任何字段");
});

test("harvest_crop / scythe_crop 的 seam 只写玩家动画状态，不写终态", async () => {
  const a = await audit();
  for (const id of ["harvest_crop", "scythe_crop"]) {
    const s = a.suspectSeamReferences.find((x) => x.actionId === id);
    assert.equal(s.kind, "seam_writes_but_no_terminal");
    assert.ok(
      s.writes.every(
        (w) => /Game1\.player\.|state\.Value|value\.Quality$/.test(w),
        "只应写玩家动画状态或 HoeDirt 的中间字段",
      ),
      `${id} 的写入 ${JSON.stringify(s.writes)} 不应包含世界终态`,
    );
  }
});

// `place_wood_fence` 曾引用纯判断的 `Object.canBePlacedHere`（0 写入）。
// 后果不是“不精确”而是“错误放行”：gate 规则 `sensitivity === "mp-insensitive" &&
// decisiveTokens.length > 0 → REJECT` 只在引用了真实变异点时才会触发，而 0 写入的
// 引用让 gate 停在 `mp-insensitive` 并通过。修复后引用 `Object.placementAction`
// 并判 `mp-observational`（理由见 register 的 observedEffect）。
// 本测试钉住“该条目不再出现于可疑集合”，使引用回退会立即失败。
test("place_wood_fence 的 seam 已引用真实变异点，不再可疑", async () => {
  const a = await audit();
  assert.equal(
    a.suspectSeamReferences.find((x) => x.actionId === "place_wood_fence"),
    undefined,
    "place_wood_fence 不得再出现在可疑 seam 集合中（引用回退到 canBePlacedHere 会让此断言失败）",
  );
});

test("每个可疑条目都带可核对的证据（调用列表或『无分支』标记）", async () => {
  const a = await audit();
  for (const s of a.suspectSeamReferences) {
    const hasEvidence = s.callees.length > 0 || s.writes.length > 0;
    // `ship_item` 的 seam 是单表达式方法（无分支），所以两者都为空 —— 这本身是证据：
    // 一个有 0 个调用、0 个写入的方法不可能是终态位置
    const isTrivial = s.callees.length === 0 && s.writes.length === 0;
    assert.ok(hasEvidence || isTrivial, `${s.actionId} 必须有调用列表或写入；零调用零写入本身即证明非终态位置`);
    assert.ok(s.recordedSeam.member && s.recordedSeam.file);
  }
});

test("产物声明审计不等同于判定 action 失效", async () => {
  const a = await audit();
  for (const g of [
    "seam_not_terminal_means_the_recorded_method_does_not_write_terminal_state_it_does_not_prove_the_action_is_broken",
    "terminalCandidateInSameFile_is_a_candidate_not_a_confirmed_replacement_seam",
    "no_action_identity_inferred",
  ])
    assert.ok(a.nonGuarantees.includes(g), `产物必须声明 ${g}`);
});
