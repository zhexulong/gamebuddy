import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeTileActionSelectors, createSelectorParser } from "../src/analysis/stardew-tile-action-selectors.mjs";

/**
 * 地图瓦片 Action 选择器分析的校准测试。
 *
 * 保护的核心事实：per-method 九谓词对 `performAction` 的 selector 层失效
 * （`MinecartTransport` 只调 `ShowMineCartMenu`，无字段写入、无 DELEGATE 匹配，
 * P4 会拒绝它）。本分析器以 selector 为单位做信号驱动的分类，并对 helper
 * 做同文件有界追踪来读取 Data/* 表。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.join(HERE, "..", "..", "..", "..", "ref", "external", "StardewValleyDecompiled", "Stardew Valley");

const parser = await createSelectorParser();

const runOn = async (relPath, member, className) =>
  analyzeTileActionSelectors({ sourceRoot: SOURCE_ROOT, relPath, member, className, parser });

// ---- 真实树校准：GameLocation.performAction（127 个 selector）---------------

test("GameLocation.performAction：127 个 selector 且分类完整", async () => {
  const a = await runOn("StardewValley/GameLocation.cs", "performAction", "GameLocation");
  assert.equal(a.artifactKind, "stardew_tile_action_selector_analysis");
  assert.equal(a.counts.selectors, 127, "selector 数应等于地图 Action 词表的实测规模");
  const { menuBound, dialogueOrEventBound, warpTransition, plainWorldEffect, unknown } = a.counts;
  assert.equal(menuBound + dialogueOrEventBound + warpTransition + plainWorldEffect + unknown, 127);
  // 每行都有表达力的列
  for (const s of a.selectors) {
    assert.ok(s.selector.length > 0 && s.sectionLines.length > 0, `${s.selector} 必须有源码锚点`);
    assert.ok(typeof s.category === "string");
    assert.ok(Array.isArray(s.aliases), `${s.selector} 必须有 aliases 列表`);
  }
});

test("MinecartTransport：menu-bound，且同文件 helper 追踪读到 DataLoader.Minecarts", async () => {
  const a = await runOn("StardewValley/GameLocation.cs", "performAction", "GameLocation");
  const s = a.selectors.find((x) => x.selector === "MinecartTransport");
  assert.ok(s, "MinecartTransport 应在 selector 列表里");
  assert.equal(s.category, "menu-bound");
  assert.ok(s.signals.includes("menu"));
  assert.ok(s.helperEffects.some((h) => h.helper === "ShowMineCartMenu"), "应追踪到 ShowMineCartMenu");
  assert.ok(s.dataTables.includes("DataLoader.Minecarts"), "helper 链应解析出 DataLoader.Minecarts");
  assert.deepEqual(s.guardChain, ["who.IsLocalPlayer"], "selector 挂在外层 `if (who.IsLocalPlayer)` 下");
});

test("BuildingToggleAnimalDoor：plain-world-effect，跨类委托只记录不解析", async () => {
  const a = await runOn("StardewValley/GameLocation.cs", "performAction", "GameLocation");
  const s = a.selectors.find((x) => x.selector === "BuildingToggleAnimalDoor");
  assert.equal(s.category, "plain-world-effect");
  assert.ok(s.delegatedCalls.includes("buildingAt.ToggleAnimalDoor"), "应记录跨类委托调用");
});

test("连续 case 标签是别名：kitchen/Kitchen 共享同一 body", async () => {
  const a = await runOn("StardewValley/GameLocation.cs", "performAction", "GameLocation");
  const kitchen = a.selectors.find((x) => x.selector === "kitchen");
  const upper = a.selectors.find((x) => x.selector === "Kitchen");
  assert.ok(kitchen && upper, "kitchen/Kitchen 都应是独立 selector 行");
  assert.deepEqual(kitchen.aliases, ["Kitchen"], "小写 kitchen 是 Kitchens 的别名");
  assert.equal(kitchen.category, "menu-bound", "别名共享 body：ActivateKitchen 是菜单开放器");
});

test("Mine/NextMineLevel：plain，终态在 Game1.enterMine", async () => {
  const a = await runOn("StardewValley/GameLocation.cs", "performAction", "GameLocation");
  const s = a.selectors.find((x) => x.selector === "Mine");
  assert.equal(s.category, "plain-world-effect");
  assert.ok(s.directCalls.includes("Game1.enterMine"), "应看到 enterMine 调用");
});

test("warp / plain / unknown 三类都有代表性行", async () => {
  const a = await runOn("StardewValley/GameLocation.cs", "performAction", "GameLocation");
  const warp = a.selectors.find((x) => x.selector === "Warp");
  assert.equal(warp?.category, "warp-transition");
  const none = a.selectors.find((x) => x.selector === "None");
  assert.equal(none?.category, "unknown", "`case \"None\": return true;` 是空壳");
});

test("产物声明它不做什么", async () => {
  const a = await runOn("StardewValley/GameLocation.cs", "performAction", "GameLocation");
  for (const g of [
    "classification_is_signal_based_not_a_semantic_proof",
    "helper_following_is_same_file_and_bounded_depth",
    "cross_class_delegation_is_recorded_but_not_resolved",
    "content_driven_effects_resolve_through_data_tables_or_runtime_state_and_are_not_enumerated",
    "virtual_dispatch_targets_are_not_resolved",
    "no_action_identity_inferred",
    "plain_world_effect_is_a_review_class_not_an_action_authorization",
  ])
    assert.ok(a.nonGuarantees.includes(g), `产物必须声明 ${g}`);
});

// ---- 合成 fixture：分类器规则可独立验证，不依赖反编译树 -----------------------

const FIXTURE = `
namespace StardewValley
{
    public class GameLocation
    {
        public virtual bool performAction(string[] action, Farmer who, Location tileLocation)
        {
            if (who.IsLocalPlayer)
            {
                switch (action[0])
                {
                    case "MenuThing":
                        Game1.activeClickableMenu = new ForgeMenu();
                        return true;
                    case "TalkThing":
                        Game1.drawObjectDialogue("hello");
                        return true;
                    case "WarpThing":
                        Game1.warpFarmer("Farm", 0, 0, 0);
                        return true;
                    case "DataThing":
                        return DoDataThing();
                    case "AliasA":
                    case "AliasB":
                        return DoShared();
                    case "EmptyThing":
                        return true;
                }
            }
            return false;
        }

        private bool DoDataThing()
        {
            var minecart = DataLoader.Minecarts(Game1.content);
            return minecart != null;
        }

        private bool DoShared()
        {
            building.ToggleAnimalDoor(who);
            return true;
        }
    }
}
`;

test("合成 fixture：分类器五类 + 别名共享 + helper 数据表回填", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-selector-"));
  try {
    const rel = "StardewValley/GameLocation.cs";
    await mkdir(path.join(dir, "StardewValley"), { recursive: true });
    await writeFile(path.join(dir, rel), FIXTURE);
    const a = await analyzeTileActionSelectors({ sourceRoot: dir, relPath: rel, member: "performAction", parser });
    assert.equal(a.counts.selectors, 7);
    assert.equal(a.counts.menuBound, 1);
    assert.equal(a.counts.dialogueOrEventBound, 1);
    assert.equal(a.counts.warpTransition, 1);
    assert.equal(a.counts.plainWorldEffect, 3);
    assert.equal(a.counts.unknown, 1);
    const byName = new Map(a.selectors.map((s) => [s.selector, s]));
    assert.equal(byName.get("MenuThing").category, "menu-bound");
    assert.equal(byName.get("TalkThing").category, "dialogue-or-event-bound");
    assert.equal(byName.get("WarpThing").category, "warp-transition");
    const data = byName.get("DataThing");
    assert.equal(data.category, "plain-world-effect");
    assert.ok(data.dataTables.includes("DataLoader.Minecarts"), "helper 内的数据表访问应回填到 selector 行");
    assert.deepEqual(byName.get("AliasA").aliases.sort(), ["AliasB"], "别名与 body 共享");
    assert.equal(byName.get("AliasA").category, "plain-world-effect");
    assert.ok(byName.get("AliasA").delegatedCalls.includes("building.ToggleAnimalDoor"));
    assert.equal(byName.get("EmptyThing").category, "unknown");
    assert.deepEqual(byName.get("MenuThing").guardChain, ["who.IsLocalPlayer"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("helper 追踪深度有界：--helper-depth 参数不爆炸", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-selector-depth-"));
  try {
    const rel = "StardewValley/GameLocation.cs";
    await mkdir(path.join(dir, "StardewValley"), { recursive: true });
    await writeFile(path.join(dir, rel), FIXTURE);
    const a = await analyzeTileActionSelectors({ sourceRoot: dir, relPath: rel, member: "performAction", parser, helperDepth: 1 });
    assert.equal(a.helperDepth, 1);
    assert.equal(a.counts.selectors, 7);
    // DataThing 的直接 helper DoDataThing 在 depth 1 内仍应回填数据表
    const data = a.selectors.find((s) => s.selector === "DataThing");
    assert.ok(data.dataTables.includes("DataLoader.Minecarts"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});