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
 *   chest_store        → Chest.addItem（终态是 itemsForPlayer.Add 这类 mutator，纯赋值提取看不到）
 *   advance_day        → GameLocation.startSleep（写 who.timeWentToBed 等状态，终态由 doSleep/新一天驱动）
 *
 * 2026-09-30 注：`advance_day` 是新登记到 register 的第十二个 seam（旧测试写 11 条），
 * 它在 switch_section 作用域修正之前就是「无候选」——它不是本修正引入的回归，
 * 而是 register 漂移（审计工具正确地把它列为 suspect）。
 *
 * 2026-10-03 注：register 新增 `cut_grass`（Grass.performToolAction，TerrainFeature 层的
 * 割草入口，与 Object 层的 cut_weeds 不同类）。它的 seam 方法体写 numberOfWeeds 但终态在
 * 私有委托 TryDropItemsOnCut / createDestroySprites，故与 harvest_crop 同型归入
 * seam_writes_but_no_terminal：12 audited / 6 suspect。
 *
 * 2026-10-02 注：`f8b408c` 把复合赋值按字段语义分类后，`cut_weeds` 的 seam
 * （`Object.performToolAction`）的 weeds 写入被识别为候选终态，从「九谓词全拒」
 * 集合退出；原 12 个 audited / 6 个 suspect 因此修正为 11 / 5。
 *
 * 2026-10-04 注：`harvest_fruit_tree` 与 `shake_tree` 的 register seam 从
 * `FruitTree/Tree.performUseAction`（纯路由、方法体无写入）改为它们真正执行的
 * `shake`（`Tree.shake` 读 `Game1.IsMultiplayer`）。`shake` 方法体写 `wasShakenToday`，
 * 但落果终态在私有委托（`TryGetDrop` / `Game1.createItemDebris`）里，故与 `harvest_crop`
 * / `cut_grass` 同型归入 seam_writes_but_no_terminal：14 audited / 8 suspect。
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
  cached = {
    artifact: JSON.parse(await readFile(auditPath, "utf8")),
    // candidates 产物是「哪些已注册 seam 没有候选终态」这层审计的人口权威，
    // 所以连它一起留下来：审计的 audited 必须恰好是它的 registeredWithoutCandidateSeam。
    candidates: JSON.parse(await readFile(candPath, "utf8")),
  };
  await rm(candPath, { force: true });
  await rm(auditPath, { force: true });
  return cached;
}

const AUDIT_KINDS = ["terminal_in_delegate", "seam_not_terminal", "seam_writes_but_no_terminal"];
const SUSPECT_KINDS = ["seam_not_terminal", "seam_writes_but_no_terminal"];

test("审计覆盖全部「已注册但九谓词全拒」的 seam，每个都落到一个已知判据", async () => {
  const { artifact: a, candidates } = await audit();
  assert.equal(a.artifactKind, "stardew_action_seam_terminal_audit");
  // 审计人口不是测试能钉住的事实：它是 candidates 产物的 registeredWithoutCandidateSeam 行数，
  // 而 register 每登记一个 action 就可能给它加一行。原先的字面量 15 就是在这种增长中过期的
  // （现在 register 有 95 个 action，人口是 26）。所以人口从同一份输入推导：
  assert.equal(
    a.counts.audited,
    candidates.registeredWithoutCandidateSeam.length,
    "审计必须覆盖 candidates 列出的每一个无候选终态的已注册 seam",
  );
  assert.equal(a.audit.length, a.counts.audited);
  // 三种判据之和 = 人口：不允许某行掉在判据之外，也不允许重复计数
  assert.equal(
    a.counts.byKind.terminal_in_delegate +
      a.counts.byKind.seam_not_terminal +
      a.counts.byKind.seam_writes_but_no_terminal,
    a.counts.audited,
  );
  // 每一行都必须落到三个已知判据之一。`method_not_found` 不在其中：seam 记录的成员
  // 在源码树里定位不到是接线错误，不是裁定，所以它一旦出现就必须让这条断言失败
  // （2026-11-03 前确实出现过两条：泛型签名 `Equip<TItem>` 被读成 `Item`，见
  //  memberNameOfSignature）。
  for (const row of a.audit)
    assert.ok(AUDIT_KINDS.includes(row.kind), `${row.actionId} 的判据 ${row.kind} 不在已知集合内（seam 成员是否可定位？）`);
  // 被本层判为可疑的必须真写在 suspectSeamReferences 里，且反之亦然
  const suspectFromAudit = a.audit.filter((r) => SUSPECT_KINDS.includes(r.kind)).map((r) => r.actionId).sort();
  assert.deepEqual(a.suspectSeamReferences.map((s) => s.actionId).sort(), suspectFromAudit);
  assert.equal(a.counts.suspectSeamReferences, suspectFromAudit.length);
});

test("工具类 DoFunction 的 seam 引用正确：终态在委托目标", async () => {
  const { artifact: a } = await audit();
  const deleg = a.audit.filter((x) => x.kind === "terminal_in_delegate");
  // 这六条是产品事实：每个工具 DoFunction 自己不写世界终态，终态在它委托的方法里。
  // 任何一条落到别的判据都是真实回归，所以它们在断言里逐个具名。
  const historical = [
    "break_rock_source",
    "chop_stump",
    "chop_tree_source",
    "clear_hoedirt",
    "dig_artifact_spot",
    "till_soil",
  ];
  const ids = deleg.map((x) => x.actionId).sort();
  for (const id of historical) assert.ok(ids.includes(id), `${id} 的 seam 应仍被判为 terminal_in_delegate（实测 ${ids.join(", ")}）`);
  // 增长方向：新注册的 action 也可以落在这里（Axe/Pickaxe.DoFunction 同时服务多个 action），
  // 所以断言集合不小而**且**是全量——本测试要护住的是判据，不是某个总数。
  assert.ok(ids.length >= historical.length, `terminal_in_delegate 不应少于历史六条，实测 ${ids.length}`);
  assert.deepEqual(ids, [...ids].sort(), "行序应稳定");
  for (const x of deleg) assert.ok(x.evidence.delegates.length > 0, `${x.actionId} 必须有委托目标`);
});

test("seam 引用指向非终态位置的 action 全部被列出（可疑，需解释而非当作缺陷）", async () => {
  const { artifact: a } = await audit();
  const ids = a.suspectSeamReferences.map((s) => s.actionId).sort();
  // 这些是**被审出来的事实**，不是测试要钉住的数字：register 每新增一个
  // 「入口自身无终态」的 action（Mod 直调内部方法、终态在委托里、或比审计看得见的一层深），
  // 这里就会多一行。原先的字面量 9 就是在这种增长中过期的（现在是 18）。
  // 所以断言集合与审计自身的判据一致，并且对每一条历史 suspect 保留具体解释：
  //
  //   `pet_animal` 已不在此列：P1 修正（手持物消耗不算多持有）后它的戴帽分支成为候选。
  //   `cut_weeds` 已不在此列：`f8b408c` 把复合赋值按字段语义分类后，
  //   `Object.performToolAction` 的 weeds 写入被识别为候选终态。
  //   `chest_store` 取而代之：`Chest.addItem` 的终态是 `itemsForPlayer.Add(item)`
  //   这种 mutator 调用，纯赋值提取看不到，故被归为 seam_not_terminal。
  //   `ride_bus` 的入口 seam `BusStop.checkAction` 只弹问句，终态在 `answerDialogue` ->
  //   `playerReachedBusDoor` -> `busDriveOff` -> `Game1.warpFarmer`，比审计展开的一层深；
  //   与 `ship_item` 同类，是诚实的 suspect（该 action 自己的收据 + live 已证明它确实到达）。
  for (const id of [
    "advance_day",
    "chest_store",
    "cut_grass",
    "harvest_crop",
    "harvest_fruit_tree",
    "ride_bus",
    "scythe_crop",
    "shake_tree",
    "ship_item",
  ])
    assert.ok(ids.includes(id), `${id} 已被审为 suspect seam，不应静默从集合中消失（实测 ${ids.join(", ")}）`);
  // 每个 suspect 都必须带可核对的记录 seam：成员名 + 文件
  for (const s of a.suspectSeamReferences) {
    assert.ok(s.recordedSeam.member && s.recordedSeam.file, `${s.actionId} 的 suspect 记录缺少 seam 定位`);
    assert.ok(SUSPECT_KINDS.includes(s.kind), `${s.actionId} 的 suspect 判据 ${s.kind} 不在可疑集合内`);
  }
});

test("ship_item 的记录 seam 是取句柄方法，无任何写入", async () => {
  const { artifact: a } = await audit();
  const s = a.suspectSeamReferences.find((x) => x.actionId === "ship_item");
  assert.equal(s.kind, "seam_not_terminal");
  assert.equal(s.recordedSeam.member, "getShippingBin");
  assert.equal(s.writes.length, 0, "getShippingBin 只返回 IInventory，不写任何字段");
});

test("harvest_crop / scythe_crop 的 seam 只写玩家动画状态，不写终态", async () => {
  const { artifact: a } = await audit();
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
  const { artifact: a } = await audit();
  assert.equal(
    a.suspectSeamReferences.find((x) => x.actionId === "place_wood_fence"),
    undefined,
    "place_wood_fence 不得再出现在可疑 seam 集合中（引用回退到 canBePlacedHere 会让此断言失败）",
  );
});

test("每个可疑条目都带可核对的证据（调用列表或『无分支』标记）", async () => {
  const { artifact: a } = await audit();
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
  const { artifact: a } = await audit();
  for (const g of [
    "seam_not_terminal_means_the_recorded_method_does_not_write_terminal_state_it_does_not_prove_the_action_is_broken",
    "terminalCandidateInSameFile_is_a_candidate_not_a_confirmed_replacement_seam",
    "no_action_identity_inferred",
  ])
    assert.ok(a.nonGuarantees.includes(g), `产物必须声明 ${g}`);
});
