#!/usr/bin/env node
/**
 * 三方对账：地图 Action **selector 层** × 九谓词**方法层** × **已注册 action**。
 *
 * 为什么需要这一层：selector 层（`stardew-tile-action-selectors`）与方法层
 * （`stardew-action-candidates` + `stardew-remaining-actions-report`）此前各跑各的，
 * 结论从未合并。实际失效案例是 `ride_minecart`——它由基类 `performAction` 的
 * `case "MinecartTransport"` 触达，该方法体只调 `ShowMineCartMenu(...)`（无字段写入、
 * 无 DELEGATE 匹配），九谓词的 P4 直接拒绝，所以方法层**永远看不到**它。
 *
 * 本工具把两层按「实现单位」对齐后给出**一个**可复跑的数字：
 *
 *   selector 层：一行 = 一个地图 Action 词（`Class.selector`）
 *   方法层    ：一行 = 一个 (出口, 实现类) 单元
 *   已注册    ：register 的 native seam 成员名
 *
 * **裁定规则是显式的、可重跑的，且必须完备**（每个 selector 恰好落一组）：
 *   1. `registered_by_seam`   —— 机械：selector 的 helper/委托解析链命中已注册 native seam 成员
 *   2. `selector_verdicts`    —— 逐条裁定表（理由 + 源码锚点）
 *   3. `categoryDefaults`     —— 分类级默认（对话/菜单/传送/空壳）
 * 未出现在 1/2/3 的 selector 会落 `needs_adjudication`，并被完备性断言暴露——
 * 不允许静默丢弃。
 *
 * **边界纪律**（见 `design/domains/stardew/action-inventory-method.md` §四）：
 * 分类是**证据**，不是裁定。`menu-bound` 不等于自动排除（`MinecartTransport` 是
 * menu-bound 却已成真 action，因为 payload `MinecartWarp` 是 public 且无 UI）；
 * `plain-world-effect` 也不等于新 primitive（多数是内容操作）。
 *
 * 用法：
 *   node .../stardew-action-inventory-reconciliation.mjs \
 *     --source-root <decompiled-root> \
 *     --action-register <register.json> \
 *     --remaining <remaining-actions-report.json> \
 *     --catalog <catalog.json> [--out <file>] [--pretty] [--fail-on-ungranted]
 *
 * 本产物同时是**观测缺口报告**：collections / tileChannels / addressability /
 * postconditionMutations / publicationGating / consumption / quadrant / fieldLevel 八个 section 在
 * `observationGaps` 键下追加，
 * 人读部分写 stderr，stdout 的 JSON 不变。`--fail-on-ungranted` 只在新 section 有未登记缺口时置 exit 1；
 * 默认仍然是「写产物即成功」，因为既有消费方依赖这个语义。
 *
 * **输入是 remaining report，不是 candidates artifact**：方法层的分档（`tiers`）只存在于
 * `stardew-remaining-actions-report` 的产物里。传错会在入口 fail fast（
 * `input_is_candidates_artifact_not_remaining_report`），不会掉进无信息的 TypeError。
 * remaining report 的 `inputs.candidates` 字段记录了它是从哪份 candidates 产物派生的，
 * 该路径会原样带进本产物的 `provenance`。
 *
 * `--candidates` 是接受的历史别名（本工具最初写成这个名字），它**没有**自己的语义：
 * 无论从哪个名字进来，值都必须是 remaining report，形状检查一视同仁。
 */

import { REJECTED_LAYER_VERDICTS } from "./stardew-rejected-layer-verdicts.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTileActionSelectorTree, createSelectorParser } from "./stardew-tile-action-selectors.mjs";
import { memberNameOfSignature } from "../stardew-source-analysis-vocabulary.mjs";
import {
  bodyAfterParameters,
  codeOnly,
  collectionsRead,
  matchingBracket,
  methodBody,
  parseDiscoveries,
  readModSources,
  REPOSITORY_ROOT,
  withoutComments,
} from "./stardew-mod-csharp-source.mjs";
import { TARGET_FIELD } from "../../../../../tools/audit-stardew-discovery-channels.mjs";
import { resolveStardewDecompileRoot } from "../../../../../tools/lib/stardew-decompile-root.mjs";

// ---------------------------------------------------------------------------
// 规则 3：分类级默认
// ---------------------------------------------------------------------------
/**
 * 分类级默认裁定。分类本身是信号驱动的证据（见 selector 分析器 nonGuarantees），
 * 因此每条默认都写明它为什么在这个分类上成立，以及它引用哪条已声明的 UI/input 边界。
 */
export const CATEGORY_DEFAULTS = Object.freeze({
  "dialogue-or-event-bound": {
    group: "content_operation",
    reason: "terminal is the dialogue/event system the map script drives (drawObjectDialogue / createQuestionDialogue / PlayEvent); the map Action string itself is content data",
    anchor: "action-inventory-method.md 4.1 L2",
  },
  "menu-bound": {
    group: "explicit_exclusion",
    boundary: "B1a_menu_owned_inline",
    reason: "terminal is a game-owned menu. The pre-2026-10 phrasing - \"the transaction only exists inside the menu, so binding it would require menu-stack or input ingress\" - is retired as over-broad: it reads as a UI-stack claim while the real question is whether a callable settlement exists. Use the split forms (B1a/B1b/B1c) and carry the caller scan.",
    anchor: "gameplay-capability-expansion.md 7.4.1 / 8.1",
  },
  "warp-transition": {
    group: "merge_into_existing",
    actionIds: ["travel", "enter_exit"],
    reason: "terminal is Game1.warpFarmer, the same native transition `enter_exit` registers; a warp is not a new intent",
    anchor: "stardew-source-analysis-vocabulary.mjs STARDEW_SEMANTIC_EQUIVALENT_EXITS (warpFarmer -> enter_exit)",
  },
  unknown: {
    group: "explicit_exclusion",
    boundary: "B5_no_effect",
    reason: "empty shell body (e.g. `case \"None\": return true;`): no world effect to bind",
    anchor: "selectors reader bodyCaptured/body evidence column",
  },
});

/**
 * 已声明的边界。B1-B4 是四条 UI/input 边界（selector 层只能引用，不新造分类）；
 * B5/B6 不是 UI 边界：B5 是「没有可绑定的世界效果」（空壳 / 仅音效），
 * B6 是「出货内容里根本没有该 action 的瓦片」，即 selector 无原生入口可绑。
 */
// A boundary text that needs a sentence or two reads badly as one enormous object entry, so the split B1 vocabulary
// (and the restated B2/B3) wrap theirs in this identity function purely for line length. It changes no value.
const line = (text) => text;
export const UI_INPUT_BOUNDARIES = Object.freeze({
  // B1 is THREE different claims, and conflating them is what let this vocabulary over-refuse. Every example the
  // single-form text used to name has since been built or overturned (ShopMenu -> shop_purchase, CraftingPage ->
  // craft_item, MineElevatorMenu -> select_mine_elevator_floor, SpecialOrdersBoard/MuseumMenu -> the Basis rows a
  // recon lane has re-tested; BobberBar was excluded by a PRODUCT ruling, not a seam one). A B1 verdict must now
  // say WHICH form it is and carry the evidence for it.
  B1a_menu_owned_inline:
    line(
      "B1a inline: the world write is a STATEMENT SEQUENCE inside a handler and no callable unit exists - reproduced by reading the code, not asserted (e.g. JojaCDMenu.cs:115 debits Money and then runs a five-case mail switch; there is no purchase method). Reproducing it means maintaining a copy of the game's own content table.",
    ),
  B1b_choice_in_ui:
    line(
      "B1b choice-in-UI: a callable unit EXISTS, but the CHOICE comes from UI-only state. This form is often BUILDABLE after all, because the choice is frequently re-derivable from public game state - select_mine_elevator_floor re-derives the floor domain from MineShaft.lowestLevelReached. Refusing on this form requires naming the exact unreachable fact.",
    ),
  B1c_private_only:
    line(
      "B1c private-only: the only callable path is private. NOT an absolute wall in this repo - ModEntry already reflects into Multiplayer.StartServer for the HostAutomation lane - so it is a per-case policy decision, not a refusal by itself.",
    ),
  B1_evidence_required:
    line(
      "every B1 verdict must carry the EXHAUSTIVE caller scan for the candidate settlement (the whole decompiled tree, callers listed verbatim), the public-member inventory at the write site, and the name of the form. A verdict without the scan is a hypothesis, not a boundary: the mine-elevator correction was caused by exactly such a scan finding public UI-free faces.",
    ),
  B2_input_edge_gated_branch:
    line("input-edge gated branch: the native SELECTOR only fires on a real mouse/keyboard edge (Game1.didPlayerJustRightClick) that the companion cannot manufacture. This is a boundary on driving the SELECTOR, not on the CAPABILITY: its one named example, BuildingToggleAnimalDoor, ships as toggle_animal_door by driving the public Building.ToggleAnimalDoor (Building.cs:915). So a B2 verdict must name the public settlement that was looked for and not found, or the row is really about input ingress rather than about the world write."),
  B3_subjective_text_input:
    line("subjective text input. Its named example, NamingMenu naming, was APPROVED by the owner as the name_entity capability (a name is saved state, not presentation, and the Basis already declares the primitive), so the row is a candidate rather than a boundary. What remains here is free-form dialogue text, where the input is the player's own words rather than a bounded choice."),
  B4_realtime_minigame: "real-time minigame / reeling contest (MiniGames, festival minigames, fishing reel)",
  B5_no_effect:
    "no bound effect (empty selector shell, sound-only selector, presentation/animation-only writes such as HoeDirt.shake's crop-shake state)",
  B6_unreachable_in_shipped_content:
    "unreachable in shipped content: the selector's case body exists in code, but no map asset in the shipped game carries a tile with that action, so there is no native entry to bind (evidence: a full Content/Maps scan for the action value)",
});

// ---------------------------------------------------------------------------
// 规则 2：逐条 selector 裁定（理由 + 锚点）
// （文件内按定义顺序排，所以规则 3 在上、规则 2 在下；编号对应文件头的规则表。）
// ---------------------------------------------------------------------------

const plainContent = (reason, anchor) => ({ group: "content_operation", reason, anchor, plainWorldEffect: true });
const keyOf = (s) => `${s.className}.${s.selector}`;
const implemented = (reason, ref) => ({ group: "already_implemented", reason, ref });
const merge = (actionIds, reason, ref) => ({ group: "merge_into_existing", actionIds, reason, ref });
const newPrimitive = (actionId, reason, anchor, ref) => ({ group: "new_primitive_needed", actionId, reason, anchor, ref });
const pending = (question, anchor) => ({ group: "needs_adjudication", question, anchor });
const contentFromSelector = (reason, ref) => ({ group: "content_operation", reason, ref });

/**
 * 为什么需要手写表：这一层的裁定是**语义**判断（菜单 payload 是否 UI-free、
 * 世界写入是内容操作还是玩家操作），词法无法决定。表的作用不是枚举 selector
 * （枚举是机械的），而是把裁定写成可复核、可重跑的形式：每条都带理由与锚点，
 * 且完备性由断言保证。`at` 用于同名跨类 selector（如 BananaShrine）。
 */
export const SELECTOR_VERDICTS = Object.freeze({
  // MineElevator is reachable (a MineElevator action tile on Maps/Mine) and its
  // selection path performs the transition through PUBLIC Game1.enterMine(level)
  // plus Farmer.ridingMineElevator — the same shape that made MinecartTransport
  // (public MinecartWarp behind a menu) a real action. It is therefore a missing
  // primitive: choosing an already-reached level is not expressible by entering
  // the mine at deepestLevel + 1.
  // Menu-owned, not a missing primitive. I first read this as a candidate because
  // MineElevatorMenu.receiveLeftClick performs the transition through public
  // Game1.enterMine(level); the loop-closure gate refused that reading, and it is
  // right: the *choice* only exists inside MineElevatorMenu (its only public
  // selection entry is receiveLeftClick(x, y)), so a level-selecting action could
  // only be built by driving that menu or by reproducing its three statements as a
  // shadow of native logic. Game1.enterMine(level) alone bypasses the player's
  // choice, which is what enter_mine already does for the descent.
  // CORRECTED 2026-10-06. This entry used to say explicit_exclusion / B1_menu_owned_transaction
  // ("binding the action would require the menu stack or input ingress"). That was wrong, and the
  // action now ships: select_mine_elevator_floor is registered, LiveVerified and gated. The menu is
  // not required because the terminal is two PUBLIC UI-FREE faces — Game1.enterMine(level) plus the
  // public Farmer.ridingMineElevator field — and the level domain is a pure function of
  // MineShaft.lowestLevelReached, so the menu never had to be driven. Kept in the record because the
  // mistake is instructive: "the only vanilla entry opens a menu" does not imply "the only possible
  // seam is the menu".
  MineElevator: {
    at: "GameLocation",
    group: "already_registered",
    actionIds: ["select_mine_elevator_floor"],
    reason:
      "the menu is not the seam: Game1.enterMine(mineLevel) (Game1.cs:10569) is public and UI-free, Farmer.ridingMineElevator is a public field, and the floor domain is derived from MineShaft.lowestLevelReached. Shipped as select_mine_elevator_floor (registered + LiveVerified + gated)",
    anchor: "GameLocation.cs:9797 -> Game1.cs:10569 / Farmer.ridingMineElevator",
  },
  // Both of these case bodies exist but shipped content cannot reach them: the
  // action string occurs exactly once in the whole tree (the case itself), no map
  // declares the tile, and no source file writes it dynamically (unlike
  // BedFurniture's Sleep TouchAction). Same class as Lamp (B6).
  SpiritAltar: {
    at: "GameLocation",
    group: "explicit_exclusion",
    boundary: "B6_unreachable_in_shipped_content",
    reason:
      "the case body is a real gameplay write (consumes a held item with Price >= 60 and sets team.sharedDailyLuck to +/-0.12), but the action string exists only as this case: no map declares a SpiritAltar tile and no source writes the property, so there is no native entry to bind",
    anchor: "GameLocation.cs:9972 (case only)",
  },
  // [SUPERSEDED 2026-10-06 — see the corrected MineElevator entry, which is now group
  // already_registered. The verdict below is kept only as the record of a mistake.]
  // The B6 claim that used to live here was WRONG, and the reason is instructive:
  // it scanned maps, and this entry is not a map tile. The action string comes from
  // `Data/Buildings` ActionTiles (mill Input/Output etc.), reached through
  // Building.doAction -> BuildingData.GetActionAtTile -> GameLocation.performAction.
  // So the selector IS reachable in shipped content.
  //
  // It still is not a new public action *shape*: the reachable branch delegates to
  // Building.PerformBuildingChestAction, a container transaction. But the merge is
  // partial and the shortfall is real, so it is recorded rather than hidden: the
  // Load branch runs Building.IsValidObjectForChest / GetItemConversionForItem and
  // quantises by RequiredCount, and the Collect branch is UI-free only while the
  // output holds exactly one stack — at two or more it opens ItemGrabMenu. Neither
  // chest_store/chest_retrieve (ordinary owned Chests and fridges, via Chest.addItem
  // and GetItemsForPlayer) nor machine_load covers
  // that. A future load_building_chest / collect_building_chest_output pair would
  // have to register first, because this table rejects unregistered action ids
  // (see the unknown_action_id assertion).
  //
  // [SUPERSEDED 2026-11-04 — `machine_load` is no longer pinned. See the replacement note below.]
  // SCOPE NOTE on machine_load, added by ruling 1 (2026-10-06): that action's acceptance pins
  // expectedQualifiedItemId to exactly "(O)433" via FarmhandActionDefinitions.cs:120
  // (SlotItemTarget), i.e. it covers ONE machine rule — Default_CoffeeBeans on (BC)12 — out of the
  // 39 recorded in tools/stardew-native-local-machine-content-contract.mjs:60. That pin is a FROZEN,
  // hash-bound contract (EXPECTED_XNB_SHA256 / EXPECTED_MACHINE_DIGEST, enforced by the
  // machine_rule_trigger_mismatch comparison), so widening it would claim conservation evidence for
  // machine rules nobody has measured. The boundary is intentional; this note exists because a reader
  // searching this table for "what does machine_load actually cover" previously found the phrase
  // "pinned to a specific machine", which understates the restriction and hides where the rest of the
  // record lives.
  //
  // REPLACEMENT NOTE (2026-11-04, owner-approved): the pin is GONE, and the reasoning above is kept
  // only as the record of it. `machine_load` now asks the machine: the admission is
  // Object.performObjectDropInAction(item, probe: true) — the call GameLocation.checkAction makes
  // before it performs a drop-in (GameLocation.cs:7768-7772) — so the accepted inputs and the consumed
  // count are read from the machine's own Data/Machines rows at execution time rather than restated
  // here or in FarmhandActionDefinitions. The 39-rule table and its digest stay exactly as they were:
  // they measure game CONTENT, and nothing in them depended on the Mod pinning one of those rules.
  // The reason the pin was wrong is worth keeping too: it was invisible through the published surface
  // (a bare `string` argument) and it refused four machines the action's own name promised.
  BuildingChest: {
    at: "GameLocation",
    group: "merge_into_existing",
    actionIds: ["chest_store", "chest_retrieve"],
    reason:
      "reachable via Data/Buildings ActionTiles (Building.doAction -> GameLocation.cs:10128) and its terminal is Building.PerformBuildingChestAction; the container intent is already owned by chest_store/chest_retrieve, but the Load branch's conversion gate + RequiredCount quantisation and the Collect branch's >=2-stack ItemGrabMenu fallback are NOT covered by them",
    anchor: "GameLocation.cs:10128 -> Building.cs:746 (PerformBuildingChestAction)",
  },

  // ---- 新 primitive（方法层看不到的 selector 级发现）-----------------------
  Lamp: {
    at: "GameLocation",
    group: "explicit_exclusion",
    boundary: "B6_unreachable_in_shipped_content",
    reason: "the case body is a deterministic lightLevel.Value 0 <-> 0.6 toggle, but no map in the shipped 1.6.15 content carries a Lamp action tile, so the selector has no reachable native entry: a scan of every loadable map asset (563 candidates under Content/Maps, incl. tilesheet tile-index properties) reports 148 distinct Action values and no Lamp. The action built on it was withdrawn rather than kept unverifiable",
    anchor: "GameLocation.cs:9776 (case only; no map usage)",
  },
  Mine: {
    at: "GameLocation",
    group: "new_primitive_needed",
    actionId: "enter_mine",
    reason: "public UI-free native entry Game1.enterMine(mineLevel) (Game1.cs:10569) reached by a plain `Action Mine` tile; the nine predicates reject it (call-only branch, no field write)",
    anchor: "GameLocation.cs:9807 -> Game1.cs:10569",
  },
  NextMineLevel: {
    at: "GameLocation",
    group: "new_primitive_needed",
    actionId: "enter_mine",
    reason: "same case body as `Mine` (alias label on the same switch bucket)",
    anchor: "GameLocation.cs:9807",
  },

  // ---- 归并进现有 action ------------------------------------------------
  // 归并只表达「同一 warp 意图」，**不保证与原生门禁等价**（见 nonGuarantees）。
  // `gating` 如实标出该 selector 属于无门禁还是门禁分支。门禁由 action 执行与否
  // 单独用 `gateEnforcement` 标注；不再用 `gating` 隐含推断。
  LockedDoorWarp: {
    at: "GameLocation",
    group: "merge_into_existing",
    actionIds: ["travel", "enter_exit"],
    gating: "gated",
    gatingAnchor: "GameLocation.cs:9537 -> lockedDoorWarp 10319-10379",
    gatingNote:
      "lockedDoorWarp checks AreStoresClosedForFestival, the SeedShop Wednesday lock, the open/close time window and minFriendship; when the combined predicate is false it draws a locked-door dialogue and returns WITHOUT warping",
    gateEnforcement: "enter_exit_runs_the_native_entry",
    gateEnforcementAnchor: "integrations/stardew/farmhandexecutioncontroller.movementactions.cs DispatchNativeDoor",
    gateEnforcementNote:
      "enter_exit no longer resolves the door into a Warp and calls warpFarmer; it dispatches the same native entry a real player click uses (GameLocation.performAction for Buildings-layer Action doors, Building.doAction for building human doors), so every listed gate actually runs and a refusal becomes the terminal Rejected reasonCode door_gate_refused with the game's own dialogue text. `travel` is unaffected because it only serves location.warps records, never a Buildings-layer door tile.",
    reason: "lockedDoorWarp() terminal is Game1.warpFarmer; friendship/opening-hours checks are preconditions of the same warp intent",
    anchor: "GameLocation.cs:10319",
  },
  Warp: {
    at: "GameLocation",
    group: "merge_into_existing",
    actionIds: ["travel", "enter_exit"],
    gating: "ungated",
    gatingAnchor: "GameLocation.cs:9475-9489",
    gatingNote: "case \"Warp\" calls Game1.warpFarmer unconditionally; only the optional doorClose sound depends on the argument count",
    gateEnforcement: "not_applicable_no_gate",
    reason: "terminal is Game1.warpFarmer, the same native transition `enter_exit` registers; a warp is not a new intent",
    anchor: "GameLocation.cs:9475",
  },
  // MECHANISM RECORDED 2026-10-06, reachability OPEN. DispatchNativeDoor
  // (farmhandexecutioncontroller.movementactions.cs:427-476) admits a Buildings-layer Action only
  // when the tile is a key of location.doors (:447), and updateDoors builds that table from the FOURTH
  // token of the Action string (GameLocation.cs:17601-17638) — so a Warp-family Action with fewer than
  // four tokens is considered by updateDoors and then discarded. Such a tile reaches enter_exit only
  // through the resolver fallback (:473-475), not through the native performAction dispatch, so the
  // native gate that tile carries would not run. This narrowing is deliberate: reading the Action
  // property without the door table would also execute non-warp actions such as "Kitchen". A principled
  // widening exists (admit when the Action string contains "Warp", the same predicate updateDoors
  // uses), but it changes enter_exit's dispatch surface and needs a live re-run to accept, so it is
  // NOT applied. Whether any shipped map actually carries such a tile is UNVERIFIED: the decompiled
  // tree has no Content/ directory, so the map layer cannot be inspected here. The greenhouse door
  // that WAS exercised live goes through the building path (:439-445) and is correctly gated.
  // CORRECTED 2026-10-06: this was merge_into_existing -> [travel, enter_exit], which was a
  // COVERAGE CLAIM THE IMPLEMENTATION DOES NOT HONOR. Verified blockers, two independent ones:
  //   * enter_exit's building branch requires `building.HasIndoors() && getPointForHumanDoor() == source`
  //     (farmhandexecutioncontroller.movementactions.cs:437-445) and an obelisk has no indoors
  //     (Building.cs:1819-1826), so it is skipped outright;
  //   * its other branch admits only keys of location.doors, and updateDoors builds that table from
  //     MAP Buildings-layer Actions whose string contains "Warp" (GameLocation.cs:17586-17631),
  //     while this action string comes from Data/Buildings ActionTiles via
  //     Building.doAction -> GetActionAtTile -> performAction (Building.cs:981-991).
  // The public UI-free seam is Building.TryPerformObeliskWarp (Building.cs:1009) -> PerformObeliskWarp
  // (:1030) -> obeliskWarpForReal (:1067); TryPerformObeliskWarp maps building type -> destination.
  // Broadening enter_exit to any building footprint tile is NOT the fix: Building.doAction also runs
  // non-warp actions there (animal door :976-980, ActionTiles, drop-in :1000-1003), so enter_exit
  // could mutate the world and then report a failed warp.
  ObeliskWarp: {
    at: "GameLocation",
    group: "new_primitive_needed",
    actionId: "use_obelisk",
    reason:
      "reachable in shipped content as a Data/Buildings ActionTile, but NO registered action reaches it: travel serves only GameLocation.warps and enter_exit requires HasIndoors plus a location.doors key. Public UI-free seam Building.PerformObeliskWarp (Building.cs:1030 -> obeliskWarpForReal :1067). NOTE: TryPerformObeliskWarp (:1009) is NOT this seam — doAction reaches it only when GetData() == null (:994-999), so a modern data-driven obelisk never goes through it",
    anchor: "GameLocation.cs:9036 -> Building.cs:1030 (PerformObeliskWarp) / :1067",
  },
  // CORRECTED 2026-10-06, same false-coverage problem as ObeliskWarp above. This one is not even the
  // same seam: IslandWest overrides performAction and handles the "FarmObelisk" tile itself
  // (IslandWest.cs:184-199: temp sprites, wand sound, displayFarmer = false, freezePause,
  // DelayedAction.fadeAfterDelay), and its action string does NOT contain "Warp", so updateDoors could
  // never put it in the door table either. Same Agent-facing intent ("activate a fixed-point warp
  // structure"), different native seam — which is why it shares the proposed id rather than getting a
  // second one, and why the implementation must drive both seams.
  FarmObelisk: {
    at: "IslandWest",
    group: "new_primitive_needed",
    actionId: "use_obelisk",
    reason:
      "no registered action reaches it, and not via the same seam as ObeliskWarp either: IslandWest.performAction handles this tile itself, and the string lacks \"Warp\" so it is never in location.doors. Reachable only after the island obelisk upgrade applies the Island_W_Obelisk override (IslandWest.cs:425-440)",
    anchor: "IslandWest.cs:184-199",
  },

  // ---- plain-world-effect 里属内容操作的（分类默认只覆盖对话/菜单/传送）----
  AdventureShop: plainContent("adventureShop() -> Utility.TryOpenShopMenu; shop transaction is live-ineligible (8.1)", "GameLocation.cs:10853"),
  AnimalShop: plainContent("animalShop() -> shop/dialogue NPC interaction", "GameLocation.cs:11017"),
  Blacksmith: plainContent("blacksmith() -> shop/tool-upgrade menu", "GameLocation.cs:10948"),
  Buy: plainContent("HandleBuyAction -> Utility.TryOpenShopMenu", "GameLocation.cs:10751"),
  Carpenter: plainContent("carpenters() -> shop/construction menu", "GameLocation.cs:10871"),
  ClubComputer: plainContent("farmerFile() -> multipleDialogues stat readout", "GameLocation.cs:10595"),
  FarmerFile: plainContent("same body as ClubComputer (alias label)", "GameLocation.cs:10595"),
  Door: plainContent("friendship/mail-gated interior door openDoor()", "GameLocation.cs:9566"),
  ElliottPiano: plainContent("playElliottPiano() -> NPC emote/song", "GameLocation.cs:10381"),
  Garbage: plainContent("CheckGarbage -> DataLoader.GarbageCans + garbageRandom", "GameLocation.cs:8349"),
  HMTGF: plainContent("Mr Qi hidden-item chain: mail/quest gated item conversion", "GameLocation.cs:9243"),
  LumberPile: plainContent("Mr Qi quest chain: mail/quest writes + SpecialItem grant", "GameLocation.cs:9283"),
  MagicInk: plainContent("mailReceived.Add + setMapTile + SpecialItem grant", "GameLocation.cs:9198"),
  Notes: plainContent("readNote() -> letter + mailReceived", "GameLocation.cs:10532"),
  QiCat: plainContent("ShowQiCat() -> perfection statue grant + mail", "GameLocation.cs:8308"),
  Saloon: plainContent("saloon() -> Utility.TryOpenShopMenu", "GameLocation.cs:10832"),
  SpecialOrdersPrizeTickets: plainContent("specialOrderPrizeTickets content counter claim", "GameLocation.cs:9006"),
  SpecialWaterDroppable: plainContent("held (O)103 consume + temporary sprite + debris grant", "GameLocation.cs:8814"),
  Starpoint: plainContent("doStarpoint() item conversion for museum/collection points", "GameLocation.cs:8251"),
  BananaShrine: plainContent("banana offering -> event / shrine animation", "IslandEast.cs:290 / IslandSecret.cs:145"),
  Gourmand: plainContent("gourmandMutex -> TalkToGourmand dialogue/request line", "IslandFarmCave.cs:443"),
  FieldOfficeDesk: plainContent("safariGuyMutex -> office desk dialogue", "IslandFieldOffice.cs:724"),
  Parrot: plainContent("ShowNutHint() dialogue hint", "IslandHut.cs:51"),
  Crystal: plainContent("enterValueEvent.Fire / crystal cave phase state machine", "IslandWestCave1.cs:212"),
  CrystalCaveActivate: plainContent("netPhase state machine + activation visuals + event", "IslandWestCave1.cs:212"),
  // `Gunther` was ruled a content_operation here until the register grew seams into
  // LibraryMuseum: `claim_museum_reward` records `getRewardsForPlayer` (LibraryMuseum.cs:264),
  // which this tile's dialogue chain reaches, and `redeem_prize_ticket` records
  // `OnRewardCollected` in the same file. Rule 1 (registered_by_seam) claims the selector now,
  // so this row can no longer be matched - and completeness rule 1 below
  // (selector_verdict_not_matched_to_any_selector:Gunther) failed the run instead of keeping a
  // verdict the mechanical rule had overruled. Removed rather than reordered: letting a hand
  // verdict outrank a seam hit would let any row hide real coverage.
  LedgerBook: plainContent("readLedgerBook() ledger dialogue", "ManorHouse.cs:31"),
  LostAndFound: plainContent("CheckLostAndFound() item retrieval dialogue", "ManorHouse.cs:31"),
  LeoParrot: plainContent("Emily's parrot temporary sprite doAction()", "GameLocation.cs:9206"),
  Letter: plainContent("Game1.drawLetterMessage letter display", "GameLocation.cs:9755"),

  // ---- 显式排除 -----------------------------------------------------------
  Arcade_Prairie: {
    at: "GameLocation",
    group: "explicit_exclusion",
    boundary: "B4_realtime_minigame",
    reason: "showPrairieKingMenu() sets Game1.currentMinigame = AbigailGame",
    anchor: "GameLocation.cs:10195",
  },
  // RULING 2026-10-06: B2 excludes the SELECTOR, not the capability. The branch is unreachable
  // because it needs a right-click edge, but the capability behind it is a public UI-free seam —
  // Building.ToggleAnimalDoor (Building.cs:915) — and driving public seams rather than input
  // dispatchers is what dismiss_modal (DialogueBox.closeDialogue), ride_minecart (MinecartWarp) and
  // select_mine_elevator_floor (Game1.enterMine) already do. Keeping this excluded would make B2 say
  // something about the capability that contradicts those three.
  BuildingToggleAnimalDoor: {
    at: "GameLocation",
    group: "new_primitive_needed",
    actionId: "toggle_animal_door",
    reason:
      "the selector needs Game1.didPlayerJustRightClick (GameLocation.cs:10137-10148) so it is not an Agent entry point, but Building.ToggleAnimalDoor (Building.cs:915) is public and UI-free — no menu, no input, nothing to drive",
    anchor: "GameLocation.cs:10137 -> Building.cs:915 (ToggleAnimalDoor)",
  },
  playSound: {
    at: "GameLocation",
    group: "explicit_exclusion",
    boundary: "B5_no_effect",
    reason: "localSound only: no world state write to bind",
    anchor: "GameLocation.cs:9746",
  },
});

// ---------------------------------------------------------------------------
// 方法层裁定（继承 action-inventory-method.md 4.3/4.4，并把本 session 已完成的项移出）
// ---------------------------------------------------------------------------

/**
 * 方法层 B 档单元（有 gameplay 写入、catalog 无词形 intent）的逐条裁定。
 * 键 = `<Class>.<member>@<line>`，与 `stardew-remaining-actions-report` 的产物行一一对应；
 * 缺失或多余都会被完备性断言抓住。
 *
 * `gating: "ungated"` 表示该单元自身就是 warp 终态（不经门禁）；`"gated"` 的单元另有
 * `gatingAnchor`。归并只表达同一意图，不保证门禁等价（见产物 nonGuarantees）。
 */
export const METHOD_VERDICTS = Object.freeze({
  // 已登记的派生裁定在此退役：这些单元的 action 已注册（register 的 seam 表是
  // 现在的事实来源），单元因此退出候选池，保留条目会触发 method_verdict_not_in_candidate_pool。
  //   Cask.performToolAction@41 -> clear_cask · Horse.checkAction@599 -> mount_transport
  //   Lantern.DoFunction@36 -> toggle_tool_light · Mannequin.performObjectDropInAction@436 -> dress_mannequin
  //   Raft.DoFunction@29 -> use_raft · Sign.checkForAction@49 -> set_sign_display
  //   NPC.checkAction@2464 -> talk_to_npc（该单元随 talk_to_npc 登记退出候选池；其送礼一半由
  //     interact_npc_with_item 覆盖，聊天一半由新注册的 talk_to_npc 覆盖）
  //   BusStop.answerDialogue@132 -> ride_bus（该单元随 ride_bus 登记退出候选池；其
  //     Bus_Yes 分支的应答语义仍属 answer_dialogue，收钱 + 强制控制的编排由原生自己完成）
  "Game1.warpFarmer@9788": merge(["enter_exit"], "same Farmer.warpFarmer transition", "4.3"),
  "GameServer.warpFarmer@673": merge(["enter_exit"], "multiplayer-authoritative copy of the same warp transition", "4.3"),
  // CORRECTED 2026-10-06 (ruling 7). The old row said a plain merge into interact_npc_with_item,
  // which was a false coverage claim of the same kind as ObeliskWarp's. NPC.checkAction (NPC.cs:2464)
  // does TWO things and we cover one:
  //   * the GIFT branch routes into tryToReceiveActiveObject (NPC.cs:1712), which is what
  //     interact_npc_with_item mirrors — but that action REQUIRES a held item (slot +
  //     expectedQualifiedItemId; the handler refuses with item_not_owned_in_slot without one), so it
  //     covers gifting only;
  //   * the TALK branch (NPC.cs:2504-2506 and siblings: CurrentDialogue.Push + Game1.drawDialogue)
  //     has no caller at all.
  // The uncovered half is counted as the primitive it needs. A "partial merge" group would say this
  // better, but the verdict vocabulary here is fixed (merge / newPrimitive / pending / implemented /
  // plainContent / contentFromSelector) and inventing a helper name silently breaks the module — so
  // the covered half is named in the reason instead, and nothing is lost.
  "ShippingBin.shipItem@158": merge(["ship_item"], "private shipItem is the shipping transaction; Farm.shipItem is registered", "4.3"),
  "ShippingBin.leftClicked@182": merge(["ship_item"], "menu-free shipping entry point", "4.3"),
  "HoeDirt.shake@367": {
    group: "explicit_exclusion",
    boundary: "B5_no_effect",
    reason:
      "writes only the crop-shake animation state (maxShake, shakeRate, shakeRotation, shakeLeft) plus NeedsUpdate; it is presentation invoked by the harvest sequence itself, so there is no player intent to bind. The harvest is bound by harvest_crop on HoeDirt.performUseAction",
    anchor: "HoeDirt.cs:367",
  },
  "FarmHouse.checkAction@696": implemented("chest_store/chest_retrieve fridge target extension (live 2026-09-28)", "4.3"),
  "IslandFarmHouse.checkAction@199": implemented("chest_store/chest_retrieve fridge target extension (live 2026-09-28)", "4.3"),
  "IslandWest.leftClick@235": implemented("ship_item island bin target extension (live 2026-09-28)", "4.3"),
  "PetBowl.performToolAction@81": implemented("water_pet_bowl (live 2026-09-28)", "4.3"),
  "SlimeHutch.performToolAction@154": implemented("water_slime_hutch_trough (live 2026-09-28)", "4.3"),
  "Mannequin.performToolAction@358": newPrimitive("dress_mannequin", "place/dress/undress are the same intent", "Mannequin.cs:358", "4.3"),
  "Mannequin.checkForAction@400": newPrimitive("dress_mannequin", "same intent (cursed <0.001 branch counted here)", "Mannequin.cs:400", "4.3"),
  "Child.checkAction@737": contentFromSelector(
    "family/social flavour on the player's own child: friendship bookkeeping, talkToFriend + doEmote, or a hat swap when Age >= 3; no catalog intent and no gameplay loop the companion plans",
    "4.5",
  ),
  "JojaMart.checkAction@61": contentFromSelector(
    "gated on the JoinJoja tile action: Morris dialogue leading into the Joja membership story event (611439), the same mail/event content class as 4.4's other exclusions",
    "4.5",
  ),
  "IslandEast.performAction@290": contentFromSelector("selector `BananaShrine`: banana offering -> event", "4.4"),
  "IslandSecret.performAction@145": contentFromSelector("selector `BananaShrine`: shrine animation + reduceActiveItemByOne", "4.4"),
  "IslandSouthEastCave.performAction@124": contentFromSelector("selector `Bartender`/`DartsGame`: story dialogue", "4.4"),
  "IslandWestCave1.performAction@212": contentFromSelector("selector `Crystal`/`CrystalCaveActivate`: netPhase state machine", "4.4"),
  "IslandSecret.checkAction@112": contentFromSelector("birdieQuestBegun/Finished quest line + Event", "4.4"),
  // MineShaft.checkAction@3053 left the candidate pool when use_mine_ladder registered that method as a
  // native seam (98cd154c, retired 2026-11-05): a registered unit retires here, and the calico statue it used
  // to cover is decided by the selector layer instead.
  "Railroad.checkAction@130": contentFromSelector("witchStatueGone + xPeriodic animation", "4.4"),
  "GameLocation.performAction@8695": {
    group: "decomposed_by_selector_layer",
    reason: "the whole map Action interpreter; its 155 selectors carry the verdict for this unit (see selectorLayer groups)",
    anchor: "GameLocation.cs:8695",
  },
  // ---------------------------------------------------------------------------
  // TIER-B SWEEP 2026-10-11 (owner ruling: read-only -> observation surface; physical change -> typed
  // action). All 32 tier-B units were opened and read; every row quotes the native member it was decided
  // from, and the checker is the acceptance test.
  //
  // A B-tier unit means no catalog intent matched by WORD FORM, not that no intent exists, so each had to
  // be decided by asking whether the native member CHANGES WORLD STATE. Three of the owner example buckets
  // had to give way to that test, and those rows say so: a colour picker that writes a saved Net field, a
  // naming box whose callback saves an entity name, and three mini-games that move saved counters. Those,
  // plus the two members that live two different lives, are `pending` instead of invented - a verdict is
  // not the place to make a product decision the owner has not made.
  // ---------------------------------------------------------------------------
  "CarpenterMenu.receiveLeftClick@817": newPrimitive(
      "build_farm_building",
      "okButton branches into setUpForBuildingPlacement and the demolish/move/paint siblings (CarpenterMenu.cs:898, 858, 865, 872), which add, remove, relocate or recolour a Building on the farm - a permanent world structure plus the money for it. The menu is only where the player expresses it; the world write is the action.",
      "CarpenterMenu.cs:898 -> setUpForBuildingPlacement",
      "Menus/CarpenterMenu.cs:817",
    ),
  "JojaCDMenu.receiveLeftClick@98": {
      group: "explicit_exclusion",
      boundary: "B1_menu_owned_transaction",
      reason:
        "grouped as a candidate first, and the loop-closure gate corrected it: the write is INSIDE the menu own click handler (JojaCDMenu.cs:115 debits Game1.player.Money, then addMailForTomorrow unlocks the upgrades, all inside receiveLeftClick at :98), so the gate reads realtime input with no terminal write. No PUBLIC settlement was located for the purchase - the settlement IS this menu transaction - which is exactly B1. Revisitable: MineElevator carried the same verdict until Game1.enterMine was found, so this is a claim about the seam and not about the capability.",
      anchor: "Menus/JojaCDMenu.cs:115",
    },
  "MineElevatorMenu.receiveLeftClick@69": merge(
      ["select_mine_elevator_floor"],
      "the elevator branch sets Farmer.ridingMineElevator and calls the public Game1.enterMine(level) (MineElevatorMenu.cs:94-95, 86), which is exactly the seam select_mine_elevator_floor already drives - so this unit is covered, not a new primitive.",
      "Menus/MineElevatorMenu.cs:94",
    ),
  "JunimoNoteMenu.receiveLeftClick@430": newPrimitive(
      "donate_bundle_item",
      "HandlePartialDonation (JunimoNoteMenu.cs:459, defined :688) consumes the held item and credits the bundle, advancing a permanent community-centre chain. Nothing else in the surface can donate.",
      "JunimoNoteMenu.cs:688 -> HandlePartialDonation",
      "Menus/JunimoNoteMenu.cs:430",
    ),
  "CraftingPage.receiveLeftClick@376": merge(
      ["craft_item"],
      "the confirm path consumes ingredients and produces the item; craft_item is the registered action for exactly that transaction, so this menu is a route to it rather than a capability of its own.",
      "Menus/CraftingPage.cs:376",
    ),
  "DyeMenu.receiveLeftClick@339": newPrimitive(
      "dye_item",
      "confirming consumes the dye item and writes the garment's colour - a two-sided inventory/equipment change with no existing action.",
      "DyeMenu.cs:339",
      "Menus/DyeMenu.cs:339",
    ),
  "TailoringMenu.receiveLeftClick@399": {
      group: "explicit_exclusion",
      boundary: "B1_menu_owned_transaction",
      reason:
        "grouped as a candidate first, and the loop-closure gate corrected it: confirming consumes cloth plus the input and grants the tailored item, all inside the menu own receiveLeftClick (TailoringMenu.cs:399), so the gate reads realtime input with no terminal write. No PUBLIC settlement was located - the settlement is the menu transaction - which is B1. Per-body rather than a class rule: the sibling dye_item (DyeMenu.cs:339) is judged closable on the same kind of line, so whichever seam exists for one may not exist for the other.",
      anchor: "Menus/TailoringMenu.cs:399",
    },
  "PrizeTicketMenu.receiveLeftClick@145": newPrimitive(
      "redeem_prize_ticket",
      "the reward branch adds the prize to the inventory and reduces the PrizeTicket stack (PrizeTicketMenu.cs:180-185): a two-sided item exchange.",
      "PrizeTicketMenu.cs:180 -> addItemToInventoryBool",
      "Menus/PrizeTicketMenu.cs:145",
    ),
  "PondQueryMenu.receiveLeftClick@124": merge(
    ["clear_fish_pond"],
    "the confirm branch calls the public FishPond.ClearPond (PondQueryMenu.cs:135), and that seam is now the REGISTERED, live-verified `clear_fish_pond` action - measured live: the pond empties (occupants 1 -> 0, fish type -> none), the fish land on the ground as items, and a stale target is refused by name. The menu is only where a player expresses it, so this unit is COVERED rather than a missing primitive.",
    "Menus/PondQueryMenu.cs:135",
  ),
  // `DiscreteColorPicker.receiveLeftClick@57` was a `newPrimitive("color_placed_object", ...)` row here
  // ("the weakest entry, and the one whose bucket is most worth re-checking"). The bucket has now been
  // re-checked: `color_placed_object` is a REGISTERED action whose native seam IS
  // `StardewValley.Menus/DiscreteColorPicker.cs::receiveLeftClick` - the very unit this row proposed.
  // The candidates tool therefore lists that unit under `matchedWithRegistered`, it is no longer a row of
  // the remaining-actions report, and completeness rule 4 (method_verdict_not_in_candidate_pool) failed the
  // run rather than carrying a verdict for a unit that had left the pool. Same outcome as `clear_fish_pond`
  // below: the intent is covered, so it is no longer a missing primitive.
  "Billboard.receiveLeftClick@360": newPrimitive(
      "accept_daily_quest",
      "MIXED in one member: the board is mostly calendar/quest browsing, and the acceptQuestButton branch writes the quest log and acceptedDailyQuest (:371-372). The world-changing half is what an action would carry.",
      "Billboard.cs:371 -> questLog.Add",
      "Menus/Billboard.cs:360",
    ),
  "LetterViewerMenu.receiveLeftClick@699": merge(
      ["claim_mail_attachment"],
      "the itemsToGrab loop hands the letter's attachment into the inventory and clears it (LetterViewerMenu.cs:733-734) - the same transaction claim_mail_attachment performs; the rest of the member is reading.",
      "Menus/LetterViewerMenu.cs:733",
    ),
  "NumberSelectionMenu.receiveLeftClick@159": {
      group: "explicit_exclusion",
      boundary: "B5_no_effect",
      reason:
        "RULED 2026-10-11: not_an_affordance. The OK branch runs a CALLER-SUPPLIED behaviourFunction (NumberSelectionMenu.cs:192), so this member has no physical semantics of its own - its writes are the widget's presentation while the world effect belongs to whoever drives it (e.g. Event.cs:13284 buyStarTokens turns money into festivalScore). A generic shared control is not an action, and the affordance a caller creates is the caller's own business: the candidates are the CALLERS, and each would be its own row if one is ever wanted.",
      anchor: "Menus/NumberSelectionMenu.cs:192",
    },
  "NamingMenu.receiveLeftClick@152": newPrimitive(
      "name_entity",
      "RULED 2026-10-11 (owner): the capability is approved. textBoxEnter -> doneNaming (NamingMenu.cs:158, :92) writes the name of an entity the game just created (pet, horse, animal, baby - callers Event.cs:13092, Horse.cs:637, QuestionEvent.cs:123, BirthingEvent), and the Basis already names this primitive (`name_entity`). A name is SAVED state, so it is not pure UI, and the owner's answer settles the product question this row was holding.",
      "NamingMenu.cs:92 -> doneNaming",
      "Menus/NamingMenu.cs:152",
    ),
  "CharacterCustomization.receiveLeftClick@2018": {
      group: "explicit_exclusion",
      boundary: "B7_capability_without_an_action",
      reason:
        "RULED 2026-10-11 (owner): the capability should EXIST but must NOT be carried by an action, because it is being considered together with the character-card work. The native facts that put it outside ordinary action shape stand: from DyePots it writes the worn garment's colour (CharacterCustomization.cs:2138) while optionButtonClick (:2127, defined :1565) writes new-game world-generation fields such as Game1.whichFarm (:1592) - one member living two lives, one of them existing only before a world does. This is a boundary the action surface deliberately does not cross; it is not a missing primitive and not a pending question.",
      anchor: "Menus/CharacterCustomization.cs:2138",
    },
  "Slots.receiveLeftClick@238": pending(
      "DEFERRED 2026-10-11 (owner: not now) - deferred, NOT excluded, so the question stays open instead of being filed as 'the game cannot do this'. The facts that make it a question are unchanged: the spin buttons debit Game1.player.clubCoins (Slots.cs:250, :261-262) and the payout credits them (:225), so it moves SAVED state - the owner's 'mini-game' bucket and the 'has a world write' test still disagree here, and a gambling table is a product question besides. Revisit with the two other festival mini-games, as the TargetGame row argues.",
      "Minigames/Slots.cs:250",
    ),
  "StrengthGame.receiveLeftClick@35": pending(
      "DEFERRED 2026-10-11 (owner: not now) - deferred, NOT excluded. The member itself only sets CurrentToolIndex (StrengthGame.cs:40) while the persistent write is Game1.player.festivalScore++ in update (:115), so this is a festival mini-game that does move saved state - the same conflict as Slots, and the three belong in one decision rather than three.",
      "Menus/StrengthGame.cs:115",
    ),
  "TargetGame.receiveLeftClick@352": pending(
      "DEFERRED 2026-10-11 (owner: not now) - deferred, NOT excluded. pressUseToolButton is called (:356) and the persistent write is festivalScore += starTokensWon (:303): the same conflict as Slots and StrengthGame, and the three should be decided together rather than one at a time.",
      "Minigames/TargetGame.cs:303",
    ),
  "CollectionsPage.receiveLeftClick@510": {
      group: "explicit_exclusion",
      boundary: "B4_read_only_surface",
      reason: "the member only opens sub-readers (letterviewerSubMenu = new LetterViewerMenu(...), CollectionsPage.cs:561/576) and writes no player state; the facts it shows belong to the observation surface, so it needs no action.",
      anchor: "Menus/CollectionsPage.cs:561",
    },
  "ProfileMenu.receiveLeftClick@549": {
      group: "explicit_exclusion",
      boundary: "B4_read_only_surface",
      reason: "page/character/scroll changes plus a hidden emote whose only effect is a local timer (ProfileMenu.cs:573-593, :601). Nothing persistent changes.",
      anchor: "Menus/ProfileMenu.cs:573",
    },
  "ShippingMenu.receiveLeftClick@699": {
      group: "explicit_exclusion",
      boundary: "B4_read_only_surface",
      reason: "the class name says SHIPPING, but this member only closes the summary (okClicked sets outro and the music track, ShippingMenu.cs:690-695) and turns pages; it neither ships items nor advances the day - the shipping itself happened before the menu existed.",
      anchor: "Menus/ShippingMenu.cs:690",
    },
  "AdvancedGameOptions.receiveLeftClick@544": {
      group: "explicit_exclusion",
      boundary: "B5_pre_world_configuration",
      reason: "CloseAndApply only runs registered callbacks and closes (AdvancedGameOptions.cs:571, :235), and those callbacks write world-GENERATION fields; the screen is reachable only from the title/new-game flow, so it is pre-world configuration rather than a live-world capability.",
      anchor: "Menus/AdvancedGameOptions.cs:571",
    },
  "DayTimeMoneyBox.receiveLeftClick@106": {
      group: "explicit_exclusion",
      boundary: "B4_read_only_surface",
      reason: "it opens the read-only quest log and changes the client's zoom preference (DayTimeMoneyBox.cs:110, :119/:128): a HUD, with no world write.",
      anchor: "Menus/DayTimeMoneyBox.cs:110",
    },
  "GrandpaStory.receiveLeftClick@305": {
      group: "explicit_exclusion",
      boundary: "B2_input_edge",
      reason: "an IMinigame whose writes are the intro cutscene's own staging (Position/currentEyes/jitterStrength, GrandpaStory.cs:309-312 and :92/:207/:216/:256) - the player does not control a world capability here.",
      anchor: "Minigames/GrandpaStory.cs:309",
    },
  "OptionsCheckbox.receiveLeftClick@25": {
      group: "explicit_exclusion",
      boundary: "B3_client_preference",
      reason: "writes a game option (Game1.options.changeCheckBoxOption, OptionsCheckbox.cs:33) - client configuration, not world state.",
      anchor: "Menus/OptionsCheckbox.cs:33",
    },
  "OptionsInputListener.receiveLeftClick@32": {
      group: "explicit_exclusion",
      boundary: "B3_client_preference",
      reason: "keybinding state (OptionsInputListener.cs:40, :56). Nothing in the world changes.",
      anchor: "Menus/OptionsInputListener.cs:40",
    },
  "OptionsPage.receiveLeftClick@540": {
      group: "explicit_exclusion",
      boundary: "B3_client_preference",
      reason: "scroll plus forwarding to the option rows (OptionsPage.cs:572); it writes nothing itself.",
      anchor: "Menus/OptionsPage.cs:572",
    },
  "OptionsPlusMinus.receiveLeftClick@62": {
      group: "explicit_exclusion",
      boundary: "B3_client_preference",
      reason: "a dropdown option write (OptionsPlusMinus.cs:89).",
      anchor: "Menus/OptionsPlusMinus.cs:89",
    },
  "TitleMenu.receiveLeftClick@877": {
      group: "explicit_exclusion",
      boundary: "B3_client_preference",
      reason: "title-screen UI: mute, window mode and preference saves (TitleMenu.cs:881-891, :898/:904). There is no world to change yet.",
      anchor: "Menus/TitleMenu.cs:881",
    },
  "TitleTextInputMenu.receiveLeftClick@49": {
      group: "explicit_exclusion",
      boundary: "B3_client_preference",
      reason: "a text box that can paste from the clipboard (TitleTextInputMenu.cs:54-57); it feeds a title-screen flow, not the world.",
      anchor: "Menus/TitleTextInputMenu.cs:54",
    },
  "Toolbar.receiveLeftClick@40": {
      group: "explicit_exclusion",
      boundary: "B4_read_only_surface",
      reason: "the LEFT-click unit only selects a slot (CurrentToolIndex, Toolbar.cs:50). NOTE the sibling: receiveRightClick (:86) drops the item on the ground (Items[num] = null plus createItemDebris) and would be its own unit with its own verdict - judged here only for the line this row names.",
      anchor: "Menus/Toolbar.cs:50",
    },
  "TutorialMenu.receiveLeftClick@62": {
      group: "explicit_exclusion",
      boundary: "B4_read_only_surface",
      reason: "an overlay that changes tabs and closes (TutorialMenu.cs:70, :84). It advances an event pointer at :87, but that is the script's own progress, not a capability the actor exercises.",
      anchor: "Menus/TutorialMenu.cs:84",
    },

});

// ---------------------------------------------------------------------------
// 机械 join 1：selector 解析链 ∩ 已注册 native seam 成员
// ---------------------------------------------------------------------------

const GROUP_NAMES = Object.freeze([
  "already_registered",
  "merge_into_existing",
  "new_primitive_needed",
  "content_operation",
  "explicit_exclusion",
  "needs_adjudication",
  "already_implemented",
  "decomposed_by_selector_layer",
]);

/**
 * 被拒层的分组。
 *
 * 输入是 `stardew-method-resolution --rejected` 的产物（每个被九谓词拒掉的单元，
 * 带上它的委托链解析）。分档完全机械，且**先做 seam join**：
 *
 *   already_registered   该单元或其解析链命中已注册 native seam
 *                        （`HoeDirt.performUseAction` → `harvest_crop`）
 *   needs_adjudication   入口自身无 gameplay 效果、链上有，且**表里没有裁定**
 *   merge_into_existing / new_primitive_needed / content_operation
 *                        / explicit_exclusion  —— 表里的逐条裁定
 *   already_implemented  入口自身有效果（P4 看到了）
 *   explicit_exclusion   两侧都没有 → 内容/表现，不构成入口
 *
 * seam join 必须在前面：不做的话已覆盖的单元会虚报成缺口。
 * 链命中**只按 (文件, 成员)**，不得回退到成员名：成员名跨类碰撞正是这层要区分的
 * 东西 —— `cut_weeds` 的 seam 是 `Object.performToolAction`（`Object.cs`），
 * `Grass.performToolAction` 在 `Grass.cs`，两者是不同类上的不同实现（前者掉 Fiber，
 * 后者把 Hay 送进筒仓）。按成员名回退会把 Grass 报成已覆盖，正好把缺口藏掉。
 *
 * 剩下的 `needs_adjudication` 必须由 `REJECTED_LAYER_VERDICTS` 全部接住，
 * 否则抛 `rejected_unit_without_verdict`。
 */
export function groupRejectedUnits({ methodResolution, seamMembers, verdicts = REJECTED_LAYER_VERDICTS }) {
  const units = methodResolution?.units ?? [];
  const used = new Set();

  const rows = units.map((u) => {
    const ownHit = seamMembers ? ownersForUnit(seamMembers, u.file, u.member) : [];
    const chainHits = [];
    if (seamMembers) {
      for (const step of u.resolveChain ?? []) {
        const member = String(step).split("@")[0];
        for (const id of ownersForUnit(seamMembers, u.file, member)) {
          if (!chainHits.includes(id)) chainHits.push(id);
        }
      }
    }
    const seamActionIds = [...new Set([...ownHit, ...chainHits])].sort();

    let group;
    let reason;
    let actionIds = seamActionIds;
    let boundary = null;
    let anchor = (u.resolveChain ?? []).slice(0, 4).join(" -> ") || null;

    if (seamActionIds.length) {
      group = "already_registered";
      reason = ownHit.length
        ? "this unit is the registered seam itself"
        : "a member of this unit's resolution chain is a registered seam";
    } else if (u.chainReachesGameplay) {
      const key = `${u.className}.${u.member}@${u.line}`;
      const verdict = verdicts[key];
      if (!verdict) throw new Error(`rejected_unit_without_verdict:${key}`);
      used.add(key);
      group = verdict.group;
      reason = verdict.reason ?? verdict.question ?? null;
      actionIds = verdict.actionIds ?? (verdict.actionId ? [verdict.actionId] : []);
      boundary = verdict.boundary ?? null;
      anchor = verdict.anchor ?? anchor;
    } else if (u.ownTerminalWrite) {
      group = "already_implemented";
      reason = "entry body itself writes gameplay state";
    } else {
      group = "explicit_exclusion";
      reason = "neither the entry nor its chain reaches a gameplay effect";
    }

    return {
      key: `${u.className}.${u.member}@${u.line}`,
      kind: "rejected_unit",
      className: u.className,
      member: u.member,
      file: u.file,
      line: u.line,
      rejectedBy: u.rejectedBy ?? [],
      ownEffects: u.ownEffects ?? [],
      chainGameplayEffects: u.chainGameplayEffects ?? [],
      resolveChain: u.resolveChain ?? [],
      group,
      actionIds,
      boundary,
      reason,
      anchor,
    };
  });

  // 完备性①：表里每条裁定都必须被用到（捕捉类名/行号漂移或已消失的单元）
  const unused = Object.keys(verdicts).filter((k) => !used.has(k));
  if (unused.length) throw new Error(`rejected_layer_verdict_not_matched_to_any_unit:${unused.sort().join(",")}`);

  return rows;
}

/**
 * 先把单元解析到 owning action，**只按 (文件, 成员)**。
 *
 * 不得回退到成员名：rejected 层的解析链只在同文件展开，而且成员名跨类碰撞
 * 正是这一层要区分的东西 —— `cut_weeds` 的 seam 是 `Object.performToolAction`
 * （`Object.cs`），而 `Grass.performToolAction` 在 `Grass.cs` 里，两者是不同类上
 * 的**不同实现**（前者掉 Fiber，后者把 Hay 送进筒仓）。按成员名回退会把
 * `Grass` 报成已覆盖，正好把本次要发现的缺口藏掉。
 *
 * 真正的跨文件等价由 `STARDEW_SEMANTIC_EQUIVALENT_EXITS` 显式声明，
 * 不靠名字巧合。
 */
function ownersForUnit(seamMembers, file, member) {
  if (!member) return [];
  const base = String(file ?? "").split(/[\\/]/).pop().toLowerCase();
  const owners = seamMembers.byFileMember.get(`${base}\u0000${member}`);
  return owners ? [...owners] : [];
}

/**
 * Registered native seams, indexed by **both** keys:
 *
 *   - `${member}`            the historical member-only key
 *   - `${basename}\u0000${member}`  the file-scoped key
 *
 * Why both: `checkAction` is shared by six actions on six different classes, so a
 * member-only lookup marks every `SomeLocation.checkAction` as covered regardless of
 * what it does. Measured before this change: 32 selector/method units resolved to an
 * owner they do not actually share. A file-scoped key removes that, but a seam's
 * declared file and the artifact's file can legitimately differ (`ship_item`'s seam is
 * declared on `Farm.shipItem`, the mouse path lands on `ShippingBin.shipItem`), so the
 * member-only key is kept as a fallback and the cross-file cases are still handled by
 * declaring them explicitly (see STARDEW_SEMANTIC_EQUIVALENT_EXITS).
 */
function registeredSeamMembers(register) {
  const byMember = new Map();
  const byFileMember = new Map();
  for (const action of register.actions)
    for (const seam of action.seams ?? []) {
      if (seam.kind !== "native") continue;
      const m = memberNameOfSignature(seam.signature);
      if (!m) continue;
      if (!byMember.has(m)) byMember.set(m, new Set());
      byMember.get(m).add(action.actionId);
      const base = String(seam.file ?? "").split(/[\\/]/).pop().toLowerCase();
      if (!base) continue;
      const key = `${base}\u0000${m}`;
      if (!byFileMember.has(key)) byFileMember.set(key, new Set());
      byFileMember.get(key).add(action.actionId);
    }
  return { byMember, byFileMember };
}

/**
 * Resolve the actions a selector's resolve chain reaches.
 *
 * Walks `resolveChain` (the same-file helper chain the selector analyzer already
 * builds), plus the leaf helper/delegate names, and matches each against the
 * file-scoped index first. The file-scoped hit is the precise answer; the
 * member-only fallback keeps a seam whose declared file differs from the artifact's
 * (documented cross-file equivalences) from silently disappearing.
 */
function seamJoin(selector, seamMembers) {
  const hits = [];
  const consider = (text) => {
    const m = memberNameOfSignature(text);
    if (!m) return;
    const base = String(selector.file ?? "").split(/[\\/]/).pop().toLowerCase();
    const scoped = seamMembers.byFileMember.get(`${base}\u0000${m}`);
    const owners = scoped ?? seamMembers.byMember.get(m);
    if (!owners) return;
    hits.push({ via: text, actionIds: [...owners].sort(), scoped: Boolean(scoped) });
  };
  // resolveChain carries the full same-file chain (`Helper@line`), which is what
  // makes a selector that only routes into a helper discoverable.
  for (const step of selector.resolveChain ?? []) consider(String(step).split("@")[0]);
  for (const helper of selector.helpers ?? []) consider(helper);
  for (const delegate of selector.delegatedCalls ?? []) consider(delegate);
  return hits;
}

// ---------------------------------------------------------------------------
// 对账
// ---------------------------------------------------------------------------

function groupRows(rows) {
  const groups = Object.fromEntries(GROUP_NAMES.map((n) => [n, []]));
  for (const row of rows) {
    if (!groups[row.group]) throw new Error(`unknown_group:${row.group}`);
    groups[row.group].push(row);
  }
  return groups;
}

function selectorRow(selector, verdict, exit) {
  return {
    key: keyOf(selector),
    kind: "selector",
    selector: selector.selector,
    className: selector.className,
    file: selector.file,
    category: selector.category,
    site: selector.site,
    sectionLines: selector.sectionLines,
    guardChain: selector.guardChain,
    helpers: selector.helpers ?? [],
    dataTables: selector.dataTables ?? [],
    group: verdict.group,
    actionIds: verdict.actionIds ?? (verdict.actionId ? [verdict.actionId] : []),
    boundary: verdict.boundary ?? null,
    gating: verdict.gating ?? null,
    gatingAnchor: verdict.gatingAnchor ?? null,
    gatingNote: verdict.gatingNote ?? null,
    gateEnforcement: verdict.gateEnforcement ?? null,
    gateEnforcementAnchor: verdict.gateEnforcementAnchor ?? null,
    gateEnforcementNote: verdict.gateEnforcementNote ?? null,
    reason: verdict.reason ?? verdict.question ?? null,
    anchor: verdict.anchor ?? null,
    exit,
  };
}

/** 规则表的索引形状（`at` 消歧同名跨类 selector）。生产与测试走同一条构造路径。 */
export function buildVerdictIndex(selectorVerdicts) {
  const index = new Map();
  for (const [label, v] of Object.entries(selectorVerdicts)) {
    const key = v.at ? `${v.at}.${label}` : label;
    index.set(key, { key, label, verdict: v, used: false });
  }
  return index;
}

/**
 * selector 层的分组与两条完备性断言。
 *
 * 规则表作为参数注入（而不是直接读模块级常量），这样测试能拿最小合成输入逼出每条断言；
 * 生产调用传的就是模块级 SELECTOR_VERDICTS / CATEGORY_DEFAULTS。
 */
export function groupSelectors({ selectors, seamMembers, registeredActionIds, verdictIndex, categoryDefaults }) {
  const rows = [];
  for (const selector of selectors) {
    const key = keyOf(selector);
    const exits = seamJoin(selector, seamMembers);
    if (exits.length > 0) {
      const actionIds = [...new Set(exits.flatMap((e) => e.actionIds))].sort();
      for (const id of actionIds) if (!registeredActionIds.has(id)) throw new Error(`unknown_action_id:${id}`);
      rows.push(
        selectorRow(
          selector,
          {
            group: "already_registered",
            actionIds,
            reason: "resolve chain hits a registered native seam",
            anchor: exits.map((e) => e.via).join(", "),
          },
          exits,
        ),
      );
      continue;
    }
    const entry = verdictIndex.get(key) ?? verdictIndex.get(selector.selector);
    if (!entry) {
      const fallback = categoryDefaults[selector.category];
      if (!fallback) {
        rows.push(selectorRow(selector, { group: "needs_adjudication", question: `no rule covers category ${selector.category}` }, []));
        continue;
      }
      rows.push(selectorRow(selector, fallback, []));
      continue;
    }
    entry.used = true;
    rows.push(selectorRow(selector, entry.verdict, []));
  }

  // 完备性①：表里的每条逐条裁定都必须真的用到（捕捉改名/拼写漂移）
  const unused = [...verdictIndex.values()].filter((e) => !e.used);
  if (unused.length) throw new Error(`selector_verdict_not_matched_to_any_selector:${unused.map((e) => e.key).sort().join(",")}`);

  // 完备性②：每个 selector 必须落到一个已知组
  const ungrouped = rows.filter((r) => !GROUP_NAMES.includes(r.group));
  if (ungrouped.length) throw new Error(`selector_left_ungrouped:${ungrouped.map((r) => r.key).join(",")}`);

  return rows;
}

/**
 * 方法层的分组与两条完备性断言（`coveredMethodKeys` 注入，便于合成测试）。
 * 分档索引必须与 `unmatchedCandidateUnits` 一致，否则说明 remaining report 本身漂移了。
 */
export function groupMethodUnits({ remainingReport, methodVerdicts }) {
  const tierOf = new Map();
  for (const [tier, list] of Object.entries(remainingReport.tiers))
    for (const r of list) tierOf.set(`${r.class}@${r.line}`, tier);
  if (tierOf.size !== remainingReport.counts.unmatchedCandidateUnits) throw new Error("tier_index_incomplete");

  const rows = [];
  const covered = new Set();
  for (const [key, verdict] of Object.entries(methodVerdicts)) {
    const at = key.lastIndexOf("@");
    const dot = key.indexOf(".");
    const cls = key.slice(0, dot);
    const line = Number.parseInt(key.slice(at + 1), 10);
    covered.add(`${cls}@${line}`);
    rows.push({
      key,
      kind: "method_unit",
      className: cls,
      member: key.slice(dot + 1, at),
      line,
      tier: tierOf.get(`${cls}@${line}`) ?? null,
      group: verdict.group,
      actionIds: verdict.actionIds ?? (verdict.actionId ? [verdict.actionId] : []),
      boundary: verdict.boundary ?? null,
      gating: verdict.gating ?? null,
      gatingAnchor: verdict.gatingAnchor ?? null,
      gatingNote: verdict.gatingNote ?? null,
      reason: verdict.reason ?? verdict.question ?? null,
      anchor: verdict.anchor ?? null,
      ref: verdict.ref ?? null,
    });
  }

  // 完备性③：B 档每个单元都必须有裁定
  const tierBKeys = [...tierOf.entries()].filter(([, t]) => t === "B_no_catalog_intent").map(([k]) => k);
  const missing = tierBKeys.filter((k) => !covered.has(k)).sort();
  if (missing.length) throw new Error(`tier_b_unit_without_verdict:${missing.join(",")}`);

  // 完备性④：裁定表里的每个单元都必须在候选池里（行号/类名漂移）
  const stray = [...covered].filter((k) => !tierOf.has(k)).sort();
  if (stray.length) throw new Error(`method_verdict_not_in_candidate_pool:${stray.join(",")}`);

  return rows;
}

export function reconcile({ selectorArtifact, remainingReport, register, catalog, rules, methodResolution, observation }) {
  assertRemainingReport(remainingReport, "remainingReport");
  const selectorVerdicts = rules?.selectorVerdicts ?? SELECTOR_VERDICTS;
  const methodVerdicts = rules?.methodVerdicts ?? METHOD_VERDICTS;
  const categoryDefaults = rules?.categoryDefaults ?? CATEGORY_DEFAULTS;
  const seamMembers = registeredSeamMembers(register);
  const registeredActionIds = new Set(register.actions.map((a) => a.actionId));
  if (registeredActionIds.size === 0) throw new Error("action_register_has_no_actions");

  // ---- selector 层 ---------------------------------------------------------
  const selectorRows = groupSelectors({
    selectors: selectorArtifact.selectors,
    seamMembers,
    registeredActionIds,
    verdictIndex: buildVerdictIndex(selectorVerdicts),
    categoryDefaults,
  });

  const distinctLabels = new Set(selectorRows.map((r) => `${r.className}.${r.selector}`)).size;

  // ---- 方法层 -------------------------------------------------------------
  const methodRows = groupMethodUnits({ remainingReport, methodVerdicts });

  // ---- 被拒层（第三层）-----------------------------------------------------
  //
  // 九谓词把 109 个单元拒掉后，`unmatchedCandidates` 不含它们，"remaining
  // report" 也就没有行 —— 这一层是**只有方法解析能看到**的入口
  // （`Grass.performToolAction` 是典型：它拒绝后从所有下游分析里消失）。
  //
  // 这层**不产出 action identity**：它只把「入口自身无效果但链上有效果」的
  // 单元筛出来，交给人裁定。是否算新 action、是否并入现有 action，都不在这里定。
  const rejectedRows = methodResolution
    ? groupRejectedUnits({ methodResolution, seamMembers })
    : [];
  const rejectedGroups = groupRows(rejectedRows);

  // 参照列：A / C 档不参与计数（A 有 catalog intent，C 只有视觉/计时器写入）
  const referenceTiers = remainingReport.tiers;

  // ---- 合并计数 -----------------------------------------------------------
  const selectorGroups = groupRows(selectorRows);
  const methodGroups = groupRows(methodRows);
  const intentIds = (groups, kind) =>
    [...new Set(groups[kind].flatMap((r) => r.actionIds.filter((id) => !registeredActionIds.has(id))))].sort();

  // 三层合并：selector / method / rejected。
  // rejected 层必须参与：它是唯一能看到「入口体纯转发」的那层，不合并就会
  // 把 cut_grass / harvest_fruit_tree 这类真实缺口排除在最终数字之外。
  const newPrimitiveIntents = [
    ...new Set([
      ...intentIds(selectorGroups, "new_primitive_needed"),
      ...intentIds(methodGroups, "new_primitive_needed"),
      ...intentIds(rejectedGroups, "new_primitive_needed"),
    ]),
  ].sort();
  const pendingItems = [
    ...selectorGroups.needs_adjudication,
    ...methodGroups.needs_adjudication,
    ...rejectedGroups.needs_adjudication,
  ];

  /** 归并行的门禁标注：`merge_into_existing` 只说意图相同，不说门禁等价。 */
  const gatingAnnotations = [
    ...selectorGroups.merge_into_existing,
    ...methodGroups.merge_into_existing,
    ...rejectedGroups.merge_into_existing,
  ]
    .filter((r) => r.gating)
    .map((r) => ({
      key: r.key,
      actionIds: r.actionIds,
      gating: r.gating,
      gatingAnchor: r.gatingAnchor,
      gatingNote: r.gatingNote,
      gateEnforcement: r.gateEnforcement ?? null,
      gateEnforcementAnchor: r.gateEnforcementAnchor ?? null,
      gateEnforcementNote: r.gateEnforcementNote ?? null,
    }));

  const result = {
    artifactKind: "stardew_action_inventory_reconciliation",
    schemaVersion: 2,
    inputs: {
      selectorImplementations: selectorArtifact.implementations,
      selectorDispatcher: selectorArtifact.source.member,
      candidatesUnit: remainingReport.inputs?.candidates ?? null,
      remainingReportTiers: Object.keys(remainingReport.tiers),
      registeredActions: registeredActionIds.size,
    },
    provenance: {
      remainingReport: {
        artifactKind: remainingReport.artifactKind,
        candidatesPath: remainingReport.inputs?.candidates ?? null,
        catalogPath: remainingReport.inputs?.catalog ?? null,
      },
      note: "method-layer tiers come from the remaining-actions report; its inputs.candidates names the candidates artifact it was derived from",
    },
    counts: {
      selectorRows: selectorRows.length,
      selectorDistinctLabels: distinctLabels,
      selectorImplementations: selectorArtifact.implementations,
      selectorAlreadyRegistered: selectorGroups.already_registered.length,
      selectorMergeIntoExisting: selectorGroups.merge_into_existing.length,
      selectorNewPrimitive: selectorGroups.new_primitive_needed.length,
      selectorContentOperation: selectorGroups.content_operation.length,
      selectorExplicitExclusion: selectorGroups.explicit_exclusion.length,
      selectorNeedsAdjudication: selectorGroups.needs_adjudication.length,
      methodUnitsTotal: methodRows.length,
      methodNewPrimitiveUnits: methodGroups.new_primitive_needed.length,
      methodMergeIntoExistingUnits: methodGroups.merge_into_existing.length,
      methodAlreadyImplementedUnits: methodGroups.already_implemented.length,
      methodContentOperationUnits: methodGroups.content_operation.length,
      methodPendingUnits: methodGroups.needs_adjudication.length,
      rejectedLayerUnits: rejectedRows.length,
      rejectedLayerChainReachesGameplay: rejectedGroups.needs_adjudication.length,
      rejectedLayerAlreadyRegistered: rejectedGroups.already_registered.length,
      rejectedLayerNewPrimitive: rejectedGroups.new_primitive_needed.length,
      rejectedLayerMergeIntoExisting: rejectedGroups.merge_into_existing.length,
      rejectedLayerContentOperation: rejectedGroups.content_operation.length,
      rejectedLayerExplicitExclusion: rejectedGroups.explicit_exclusion.length,
      rejectedLayerNote:
        "units the nine predicates rejected; this is the only layer that can see an entry whose body is pure delegation",
      newPrimitiveIntents: newPrimitiveIntents.length,
      pendingAdjudicationItems: pendingItems.length,
      upperBoundIfAllPendingBecomePrimitives: newPrimitiveIntents.length + pendingItems.length,
      newPrimitivesRequired: newPrimitiveIntents.length,
    },
    newPrimitiveIntents,
    gatingAnnotations,
    groups: { selectorLayer: selectorGroups, methodLayer: methodGroups, rejectedLayer: rejectedGroups },
    reference: {
      methodTierA_catalogIntentExists: referenceTiers.A_catalog_intent_exists.length,
      methodTierC_nonGameplayWrites: referenceTiers.C_non_gameplay_writes.length,
      methodTierC_note: "tier C writes only visual/timer fields; it never counts as an action",
      catalogRecords: catalog.records.length,
      catalogNote: "the catalog is a reference column only; it is not a discovery input",
    },
    rules: {
      declaredRuleIds: ["registered_by_seam", "selector_verdicts", "category_defaults", "method_verdicts"],
      categoryDefaults,
      uiInputBoundaries: UI_INPUT_BOUNDARIES,
      uiInputBoundariesNote:
        "B1-B4 are the declared UI/input boundaries; B5_no_effect is a separate exclusion reason (no bindable world effect), not a UI boundary",
      mergeSemantics:
        "merge_into_existing means 'same native intent', not 'equivalent gate'. A merge row with gating:" +
        " 'gated' has a native pre-check the registered action does not execute; gatingAnnotations carries the anchors.",
      selectorVerdictCount: Object.keys(selectorVerdicts).length,
      methodVerdictCount: Object.keys(methodVerdicts).length,
    },
    nonGuarantees: Object.freeze([
      "selector_classification_is_signal_based_evidence_not_a_verdict",
      "menu_bound_is_not_an_automatic_exclusion (ride_minecart precedent)",
      "plain_world_effect_is_not_an_automatic_primitive (most are content operations)",
      "merge_into_existing_expresses_the_same_warp_intent_only_and_does_not_prove_gate_equivalence (see gatingAnnotations for the per-row gated/ungated label; the LockedDoorWarp gate mismatch is recorded there, precise reconciliation is left to a later adjudication)",
      "semantic_verdicts_are_curated_and_each_carries_its_own_reason_and_anchor",
      "cross_class_delegation_is_recorded_but_not_resolved",
      "selector_equality_is_matched_syntactically_so_computed_selectors_are_missed",
      "the_TouchAction_family_is_a_separate_dispatcher_and_is_not_enumerated_here",
      "the_catalog_is_a_reference_column_not_a_discovery_input",
      "counts_are_bound_to_the_decompiled_tree_snapshot",
    ]),
  };
  // The observation-gap sections are appended only when the caller measured them: the three-way
  // reconciliation above is a pure function of its four inputs, and a caller that does not have the
  // Mod sources or the decompiled assembly must still get the envelope it always got.
  if (observation !== undefined) {
    result.observationGaps = observation;
    result.counts.observationCollectionNeverRead = observation.collections.neverRead.length;
    result.counts.observationTileChannelNeverRead = observation.tileChannels.neverRead.length;
    result.counts.observationTargetBearingActions = observation.addressability.targetBearingActions;
    result.counts.observationActionsWithoutFamily = observation.addressability.withoutFamily.length;
    result.counts.observationMutationPairs = observation.postconditionMutations.mutations.length;
    result.counts.observationMutationNotObservable = observation.postconditionMutations.notObservable.length;
    result.counts.observationPublicationGates = observation.publicationGating.gates.length;
    result.counts.observationFamiliesGatedOff = observation.publicationGating.gatedOff.length;
    result.counts.observationFamiliesWithoutConsumer = observation.consumption.withoutConsumer.length;
    result.counts.observationFamiliesUnclassified = observation.consumption.unclassified.length;
    result.counts.observationQuadrantMapFixed = observation.quadrant.counts.mapFixed;
    result.counts.observationQuadrantActorOwned = observation.quadrant.counts.actorOwned;
    result.counts.observationQuadrantRed = observation.quadrant.counts.red;
    result.counts.observationQuadrantBaselined = observation.quadrant.counts.baselined;
    result.counts.observationFieldReadMembers = observation.fieldLevel.counts.readMembers;
    result.counts.observationFieldCarried = observation.fieldLevel.counts.carried;
    result.counts.observationFieldAbsent = observation.fieldLevel.counts.absent;
    result.counts.observationFieldRed = observation.fieldLevel.counts.red;
    result.counts.observationFieldBaselined = observation.fieldLevel.counts.baselined;
    result.counts.observationFieldUnparsed = observation.fieldLevel.unparsed.length;
    result.counts.observationGapFindings = observation.findings.length;
    result.counts.observationGapUngranted = observation.ungranted.length;
    result.counts.observationBaselineEntries = observation.baseline.entries;
    result.nonGuarantees = Object.freeze([
      ...result.nonGuarantees,
      "postcondition_mutation_matching_is_by_member_name_plus_one_declared_alias_and_is_a_ratchet_not_a_hard_red",
      "postcondition_mutations_are_read_one_call_hop_deep_from_the_request_method",
      "native_mutator_calls_that_write_a_whole_collection_are_not_named_mutations",
      "publication_gates_are_read_from_the_BridgeSnapshot_call_site_and_cross_checked_against_the_Discover_row_type",
      "families_delivered_only_by_a_solicited_observe_are_not_a_consumption_gap_and_the_advisory_count_is_not_a_backlog",
      "quadrant_is_derived_from_the_discovery_body_and_a_three_deep_call_closure_of_the_Mods_own_methods",
      "quadrant_evidence_for_a_family_no_Discover_publishes_is_a_declaration_at_its_build_site_not_a_derivation",
      "field_level_reads_are_extracted_from_if_while_switch_and_return_expressions_through_a_fixed_engine_type_vocabulary_and_are_a_ratchet_not_a_hard_red",
      "field_level_presence_reads_are_named_by_the_call_that_is_null_tested_not_by_a_resolved_return_type",
      "field_level_row_fields_come_from_the_wire_schema_and_are_cross_checked_against_the_Mod_record",
    ]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 观测缺口八段（observation gaps）
// ---------------------------------------------------------------------------

/**
 * The observation-gap sections: the question the three-way reconciliation could not ask.
 *
 * "The engine holds something, an action needs it, and no snapshot family publishes it." Four real
 * misses in one week, each a different shape, all the same defect class:
 *
 *   1. `location.furniture` - a `NetCollection<Furniture>` no `Discover*` read, so beds, chairs and
 *      rugs did not exist in any snapshot while `place_owned_object` could write into the same
 *      collection through the native placement path (fixed; this report is what keeps it fixed).
 *   2. the mine's exit ladder - a TILE PROPERTY / Buildings-layer tile index `MineShaft.checkAction`
 *      dispatches on, not an entity, so no collection scan could ever have seen it and the model was
 *      trapped in a level it had entered.
 *   3. `rotate_furniture` - the action turned a piece and nothing published the piece's rotation, so
 *      turning was unobservable and the postcondition could only report `uncertain`.
 *   4. watering-can refill - the family was scoped to radius 6 while ponds are 10-20 tiles away: an
 *      addressable family that cannot address the world it describes.
 *
 * Each section is derived from an authority, never from a list in this file:
 *
 *   A collections        the population is every public COLLECTION-TYPED member of the three owners the
 *                        engine keeps world and actor state on, read from the decompiled assembly:
 *                        `GameLocation` (instance), `Farmer` (instance - the pack, the friendships, the
 *                        quest log, the recipe books, the mail keys) and `Game1` (instance and STATIC,
 *                        because its statics ARE the world: `locations`, `objectData`). A member counts by
 *                        its DECLARED TYPE - an array, a type whose own name ends with a container genus
 *                        (`NetCollection`, `NetLongDictionary`, `NetVector2HashSet`, `Queue`), or a named
 *                        engine type that declares a collection interface itself (`Inventory :
 *                        IList<Item>`, resolved from the tree) - and a single-object holder
 *                        (`NetRef<Horse>`, `NetRoot<NetWorldState>`) is excluded by that same test.
 *                        The classification is one instrument: a collection is `read` when a `Discover*`
 *                        body names its member (`player.Items`, `location.objects`), or, for a `Game1`
 *                        member, names `Game1.<member>`. The test is the MEMBER NAME, so a read row says
 *                        "a publisher reads a member with this name", which is what a name-based scan can
 *                        honestly claim.
 *
 *                        THE OWNERS AND THE TYPE TEST ARE THE FIX FOR A REAL BLINDNESS. This population
 *                        used to be `GameLocation` members of the engine's NETWORKED types plus
 *                        `Game1.locations`; everything attached to the PLAYER was structurally outside
 *                        it, so `till_soil` needing a hoe the pack may not hold was never a question the
 *                        report could ask. Plain `List`/`Dictionary` members were excluded "as local
 *                        caches", and that type filter is precisely what hid the pack: `Farmer.Items` is
 *                        an `Inventory`, which names no container genus. The local caches (`critters`,
 *                        `temporarySprites`, `lightGlowLayerCache`, the `Data/*` content dictionaries, the
 *                        menu and scheduling queues) are IN the population now and each one is argued in
 *                        the baseline with the concrete fact that makes it unread, instead of being
 *                        excluded by a type rule nobody had to defend.
 *
 *                        Every row carries the declaration it came from (`GameLocation.cs:185`), which the
 *                        `collection_never_read` finding prints, so a reader opens the line rather than
 *                        trusting this report about it.
 *   B tile channels      the engine stores interaction in tile properties and layer indexes as well as
 *                        in collections. Each channel declares the engine site that dispatches on it,
 *                        and that declaration is verified against the decompiled source on every run
 *                        (`tile_channel_not_in_engine`), so the table cannot outlive the engine.
 *   C addressability     the population is the action surface's own `kind: "execution"` actions whose
 *                        arguments name a target; the family comes from the discovery audit's
 *                        `TARGET_FIELD` table (imported, never copied) and from the surface's own
 *                        `targetFamily`. When the two authorities disagree the report says so.
 *   D postconditions     for every action handler, the engine members its body ASSIGNS. Property-name
 *                        matching is a heuristic, so this section is a ratchet, not a hard red - see
 *                        `tools/stardew-observation-gap-baseline.json`.
 *   E publication        a family is published only while certain actions are advertised. The gates are
 *                        read out of the Mod's own `new BridgeSnapshot(...)` call site, the family name
 *                        from `record BridgeSnapshot(...)`, and "who needs that family" from the same
 *                        `TARGET_FIELD` table C uses. A family whose enabling set omits an action that
 *                        targets it cannot be seen by that action, ever - the silence reinforces itself.
 *   F consumption        for each published family, whether anything in the Host reads it at all: a HUD
 *                        line, one of the Host's projections, or a tool description. `family_without_
 *                        consumer` is ADVISORY and listed with everything else, because on-demand
 *                        delivery by a solicited `stardew_observe` is the documented delivery policy;
 *                        what is red is an unconsumed family an action also targets, and a family the
 *                        Host's own inventory does not classify at all.
 *   H field level        every action handler's DECISION READS (section H's header states the extraction
 *                        rule) against the fields of the row its target family publishes. The row type
 *                        comes from the schema's own `items.$ref` and the field list is cross-checked
 *                        against the Mod's `record Bridge*`; a read the row does not carry is the defect.
 *
 * THE HEURISTICS LIVE IN D, AND WHY A RATCHET IS THE HONEST INSTRUMENT THERE
 *
 * A, B and C are mechanical: a collection is read or it is not, a channel is consulted or it is not,
 * a family exists or it does not. D is not. `X.Member = value` inside a handler is evidence of a
 * mutation, but the NAME of the member is not the name of the snapshot row that publishes the same
 * fact (`Game1.player.CurrentToolIndex` is published as `currentToolSlot`), and a native mutator call
 * (`placementAction`) writes a whole collection and has no member name at all. A hard red on a name
 * comparison would fail on every alias and on every native call, and a gate that is red at HEAD runs
 * nowhere. So D records each unexplained mutation once in the baseline with the reading that
 * explains it, and fails only on NEW ones. The ratchet only tightens: an entry whose mutation no
 * longer appears - or whose member is now published - is `stale_baseline_entry` until it is deleted.
 *
 * The same ratchet excuses a collection or channel that is legitimately never read, with its reason.
 * `collection_never_read:largeTerrainFeatures` was deliberately NOT baselined, and the report naming it on
 * its first run is what closed it: the bush discovery walked `terrainFeatures`, where a bush cannot stand in a
 * saved game, so `DiscoverBushTargets` and `TryGetHarvestableBush` now read `location.largeTerrainFeatures`
 * (GameLocation.cs:17403-17421) and one bush reachable from both collections is published once.
 *
 * What the widened population then cost is worth stating where the next reader will look: 122 members, 102 of
 * them unread by any publisher, so this file's baseline grew by 95 collection entries in one pass. Each entry
 * states the concrete fact that makes the member unread - a draw-order cache the map itself rebuilds, a
 * content cache the handler reads through `DataLoader`, a `Data/*`-backed ledger no action chooses from, or a
 * family published by a body this section's `Discover*`-named scan does not match (`pendingLevelUpChoices`
 * from `DescribePendingLevelUps`, `NativeNotices` from `NativeNoticeObserver`). That is a larger excuse list
 * than this instrument had ever carried, and the honest reading of it is that section A now measures "every
 * engine collection" rather than "every collection an action can address": the owner-scoped split that would
 * turn 95 reasons into three rules is the next shape change, not something these entries pretend to have
 * solved.
 */

export const OBSERVATION_BASELINE_SCHEMA = "gamebuddy-stardew-observation-gap-baseline/v1";
export const OBSERVATION_BASELINE_PATH = "tools/stardew-observation-gap-baseline.json";
const OBSERVATION_SURFACE_PATH = "integrations/stardew/action-development/contracts/generated/action-surface.v1.json";
const OBSERVATION_MODELS_PATH = "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs";

/**
 * The container genus a collection type names in its own name: `NetCollection`, `NetLongDictionary`,
 * `NetVector2HashSet`, `NetObjectList`, `Queue`, `Stack`, `NetArray`, `OverlaidDictionary`.
 *
 * The genus is read off the TYPE, never off the member. `NETWORKED_COLLECTION_TYPE` used to be the whole
 * vocabulary, and it excluded every plain `List`/`IList` member by type - which is how `Farmer.Items`
 * (an `Inventory`, declared `IList<Item>`) stayed outside a report whose question is "can we see the world".
 */
const COLLECTION_TYPE_GENUS = /(?:List|Collection|Dictionary|Set|Queue|Stack|Array)$/u;

/** A BCL array (`int[]`, `EmoteType[]`) holds element values the way a list does. */
const ARRAY_TYPE = /\[\s*,*\s*\]$/u;

/** `StardewValley.Network.NetLongDictionary<FarmAnimal, NetRef<FarmAnimal>>` -> `NetLongDictionary`. */
function outerTypeName(declaredType) {
  const angle = declaredType.indexOf("<");
  const head = angle < 0 ? declaredType : declaredType.slice(0, angle);
  return head.slice(head.lastIndexOf(".") + 1).trim();
}

/**
 * Is `declaredType` a collection of some element type?
 *
 * Three shapes count, and they are the same three for every owner: an array, a type whose own name ends
 * with a container genus, and a NAMED engine type that declares a collection interface itself
 * (`Inventory : IList<Item>`), resolved from the decompiled tree - because `public Inventory Items` is the
 * pack and its declaration names no genus at all. A single-object holder is none of the three:
 * `NetRef<Horse>`, `NetRoot<NetWorldState>`, `NetEvent1Field<string, NetString>` and the scalar wrappers
 * (`NetInt`, `NetEnum`) are excluded by the same test that admits the collections, not by a skip list.
 */
export function isCollectionType(declaredType, collectionTypes) {
  const type = String(declaredType).replace(/\?$/u, "").trim();
  if (ARRAY_TYPE.test(type)) return true;
  const outer = outerTypeName(type);
  if (COLLECTION_TYPE_GENUS.test(outer)) return true;
  return collectionTypes.has(outer);
}

/** One type declaration line of a decompiled source: its name and its base list, if it has one. */
const TYPE_DECLARATION =
  /^\s*(?:(?:public|internal|private|protected|sealed|abstract|static|partial|readonly|unsafe|new)\s+)*(?:class|struct|interface|record)\s+(\w+)\s*(?:<[^>\n]*>)?\s*(?::\s*([^\n{]+))?$/gmu;

/** A base list split on its top-level commas: `IInventory, IList<Item>, ICollection<Item>` -> three. */
function splitBases(list) {
  const bases = [];
  let depth = 0;
  let current = "";
  for (const character of list) {
    if (character === "<") depth += 1;
    else if (character === ">") depth -= 1;
    if (character === "," && depth === 0) {
      if (current.trim() !== "") bases.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim() !== "") bases.push(current.trim());
  return bases;
}

/**
 * Every engine type that DECLARES itself a collection, read from the decompiled tree.
 *
 * This is what makes `public Inventory Items => netItems.Value;` a collection without naming `Inventory`
 * anywhere in this file: `Inventory : INetObject<NetFields>, IInventory, IList<Item>, ICollection<Item>`
 * says so itself, and a type deriving from a collection is a collection, so the set is closed transitively
 * rather than stopped at one level.
 */
export function engineCollectionTypeNames({ root }) {
  const declarations = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.name.endsWith(".cs")) continue;
      const source = readFileSync(absolute, "utf8");
      for (const match of source.matchAll(TYPE_DECLARATION))
        declarations.push({ name: match[1], bases: splitBases(match[2] ?? "") });
    }
  }
  const names = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const declaration of declarations) {
      if (names.has(declaration.name)) continue;
      if (declaration.bases.some((base) => isCollectionType(base, names))) {
        names.add(declaration.name);
        grew = true;
      }
    }
  }
  return names;
}

/** The type index, from the same fail-closed root every other section resolves. */
export function loadEngineCollectionTypeNames({ sourceRoot } = {}) {
  const root = resolveStardewDecompileRoot({ repositoryRoot: REPOSITORY_ROOT, root: sourceRoot });
  return engineCollectionTypeNames({ root });
}

/**
 * The collection population, derived from the decompiled assembly.
 *
 * Three owners, because the state lives in three places: a location's own members, the ACTOR's members
 * (the pack, the friendships, the quest log, the recipe books, the mail keys), and the game-wide members
 * on `Game1` - whose statics ARE the world (`Game1.locations`, `Game1.objectData`), so statics count
 * there and nowhere else: `Farmer.hairStyleMetadata` is class data, not this farmer's state.
 *
 * Two members whose names differ only in case are ONE collection: `animals` is the net field and
 * `Animals` the property over it, so reporting `Animals` as never read while `animals` is read
 * everywhere would be a finding about a spelling, not about the world.
 */
export function locationCollectionPopulation({ gameLocation, farmer = "", game1, collectionTypes = new Set() }) {
  const population = [];
  const seen = new Set();
  const add = (owner, file, source, { statics }) => {
    let lineNumber = 0;
    for (const text of source.split("\n")) {
      lineNumber += 1;
      const declared = declarationOf(text);
      if (declared === null) continue;
      if (!statics && declared.isStatic) continue;
      if (!isCollectionType(declared.type, collectionTypes)) continue;
      const id = owner === "GameLocation" ? declared.name : `${owner}.${declared.name}`;
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      population.push({
        id,
        owner,
        member: declared.name,
        type: declared.type,
        evidence: `${file}:${lineNumber}`,
      });
    }
  };
  add("GameLocation", "GameLocation.cs", gameLocation, { statics: false });
  add("Farmer", "Farmer.cs", farmer, { statics: false });
  add("Game1", "Game1.cs", game1, { statics: true });
  return population;
}

/**
 * One `public <modifiers> <type> <name>;` declaration as `{ type, name, isStatic }`, or null.
 *
 * The modifiers are stripped one at a time rather than matched as a prefix, because a generic type's
 * argument list contains spaces (`NetLongDictionary<FarmAnimal, NetRef<FarmAnimal>>`) and a single
 * `\S+` for the type would silently skip every multi-argument collection - which is how `animals`,
 * `terrainFeatures` and `doors` would drop out of the population without a word.
 */
function declarationOf(line) {
  const withoutVisibility = line.replace(/^\s*public\s+/u, "");
  if (withoutVisibility === line) return null;
  let rest = withoutVisibility;
  let isStatic = false;
  for (;;) {
    const modifier = /^(\w+)\s+/u.exec(rest);
    if (modifier === null) break;
    if (modifier[1] === "const") return null;
    if (modifier[1] === "static") isStatic = true;
    if (!["readonly", "static", "virtual", "override", "new", "sealed", "abstract", "event", "volatile", "unsafe", "extern", "partial", "required"].includes(modifier[1]))
      break;
    rest = rest.slice(modifier[0].length);
  }
  // A MEMBER's declared type is a type name, never a parameter list. A method signature reaches the `=`
  // of a DEFAULT PARAMETER value - `ShowPagedResponses(string prompt, List<...> responses, bool
  // auto_select_single_choice = false)` - and was read as a `List` member named `auto_select_single_choice`
  // until this test said a declared type may not open a parameter list.
  const declaration = /^(.+?)\s+(\w+)\s*(?:\{|;|=)/u.exec(rest);
  if (declaration === null || /[()]/u.test(declaration[1])) return null;
  return { type: declaration[1].trim(), name: declaration[2], isStatic };
}

/**
 * The read test for one population entry: a `Discover*` body that names the member.
 *
 * A `Game1` member is declared on the game-wide type, so only `Game1.locations` is that collection. A
 * location's or an actor's member is read through whatever holds it (`location.objects`, `player.Items`),
 * which is `collectionsRead`'s existing test - the classification is one instrument, not a new one.
 */
function game1ReadPattern(member) {
  return new RegExp(`\\bGame1\\s*\\??\\s*\\.\\s*${member}\\b`, "u");
}

/** Which discovery reads which collection, and which collection nothing reads. */
export function collectionCoverage({ discoveries, population }) {
  const memberNames = population.filter((entry) => entry.owner !== "Game1").map((entry) => entry.member);
  const game1Patterns = population
    .filter((entry) => entry.owner === "Game1")
    .map((entry) => [entry, game1ReadPattern(entry.member)]);
  const readers = new Map(population.map((entry) => [entry.id, []]));
  for (const discovery of discoveries) {
    const named = collectionsRead(discovery.body, memberNames);
    for (const entry of population)
      if (entry.owner !== "Game1" && named.has(entry.member)) readers.get(entry.id).push(discovery.name);
    for (const [entry, pattern] of game1Patterns)
      if (pattern.test(discovery.body)) readers.get(entry.id).push(discovery.name);
  }
  return population.map((entry) => ({
    id: entry.id,
    owner: entry.owner,
    member: entry.member,
    type: entry.type,
    evidence: entry.evidence,
    readBy: readers.get(entry.id).length,
    readers: [...new Set(readers.get(entry.id))].sort(),
  }));
}

/**
 * The engine's tile channels: what it holds that is not a collection member.
 *
 * `engine` is the decompiled site that dispatches on the channel, and the report re-checks that the
 * site is still there - a table of channels is only worth having if the engine still has them.
 * `reads` are the shapes a Mod read takes; a WRITE to the same property is not a read, which is why
 * the subscript form is followed by a not-an-assignment guard.
 */
export const TILE_CHANNELS = Object.freeze([
  Object.freeze({
    id: "Action",
    engine: {
      file: "GameLocation.cs",
      site: "GameLocation.checkAction (doesTileHaveProperty(..., \"Action\", \"Buildings\"))",
      evidence: /doesTileHaveProperty\([^;\n]{0,120}?"Action"/u,
    },
    reads: Object.freeze([
      /(?:Properties|properties)\s*\??\s*\[\s*"Action"\s*\]\s*(?!=[^=])/u,
      /\.\s*TryGetValue\(\s*"Action"/u,
      /\.\s*ContainsKey\(\s*"Action"/u,
      /doesTileHaveProperty\([^;\n]{0,160}?"Action"/u,
    ]),
  }),
  Object.freeze({
    id: "TouchAction",
    engine: {
      file: "GameLocation.cs",
      site: "GameLocation.performTouchAction (doesTileHaveProperty(..., \"TouchAction\", \"Back\"))",
      evidence: /doesTileHaveProperty\([^;\n]{0,120}?"TouchAction"/u,
    },
    reads: Object.freeze([
      /(?:Properties|properties)\s*\??\s*\[\s*"TouchAction"\s*\]\s*(?!=[^=])/u,
      /\.\s*TryGetValue\(\s*"TouchAction"/u,
      /\.\s*ContainsKey\(\s*"TouchAction"/u,
      /doesTileHaveProperty\([^;\n]{0,160}?"TouchAction"/u,
    ]),
  }),
  Object.freeze({
    id: "Buildings",
    engine: {
      file: "MineShaft.cs",
      site: 'MineShaft.checkAction (switch (getTileIndexAt(tileLocation, "Buildings", "mine")))',
      evidence: /getTileIndexAt\([^;\n]{0,80}?"Buildings"/u,
    },
    reads: Object.freeze([
      /GetLayer\(\s*"Buildings"\s*\)/u,
      /getTileIndexAt\([^;\n]{0,120}?"Buildings"/u,
      /doesTileHaveProperty\([^;\n]{0,160}?"Buildings"/u,
      /GetTilePropertySplitBySpaces\([^;\n]{0,120}?"Buildings"/u,
    ]),
  }),
]);

/** Which tile channel any Mod source consults, with the files that read it. */
export function tileChannelCoverage({ sources, decompiled, channels = TILE_CHANNELS }) {
  const findings = [];
  const rows = channels.map((channel) => {
    const engineSource = decompiled[channel.engine.file] ?? "";
    if (!channel.engine.evidence.test(engineSource))
      findings.push({
        code: `tile_channel_not_in_engine:${channel.id}`,
        kind: "channel",
        id: channel.id,
        detail: `${channel.id} declares ${channel.engine.site} as its engine site, and ${channel.engine.file} no longer contains it`,
      });
    const readers = sources
      .filter((source) => channel.reads.some((pattern) => pattern.test(withoutComments(source.source))))
      .map((source) => source.path);
    return { id: channel.id, engineSite: channel.engine.site, readBy: readers.length, readers };
  });
  return { rows, findings };
}

/**
 * The snapshot families the Mod publishes, the property names their rows carry, and the snapshot's OWN field names.
 *
 * `vocabulary` is the row properties (what a `Bridge*Target` record declares); `fields` is every parameter of
 * `record BridgeSnapshot(...)`, rows and scalars alike, from the same `snapshotParameterOrder` the publication-gating
 * section resolves gates with. The postcondition section needs both: a handler that swaps the actor's hand mutates
 * `Farmer.CurrentToolIndex`, which the snapshot publishes as the top-level `CurrentToolSlot` - a scalar no row
 * declares, so a row-only vocabulary called a published fact unobservable.
 */
export function publishedSnapshotSurface(models) {
  const families = [];
  for (const match of models.matchAll(/IReadOnlyList<(Bridge\w+)>\??\s+(\w+)/gu))
    families.push({ row: match[1], field: match[2] });
  const fields = new Set(
    snapshotParameterOrder(models)
      .map((parameter) => parameter.name?.toLowerCase())
      .filter(Boolean),
  );
  const vocabulary = new Set();
  for (const row of new Set(families.map((entry) => entry.row))) {
    const index = models.indexOf(`record ${row}(`);
    if (index < 0) continue;
    const open = models.indexOf("(", index);
    let depth = 0;
    let end = open;
    for (; end < models.length; end++) {
      if (models[end] === "(") depth++;
      else if (models[end] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    for (const parameter of models.slice(open + 1, end).split(/,(?![^<>()]*[>)])/u)) {
      const name = /^\s*(?:\[[^\]]*\]\s*)*[A-Za-z_][\w<>,\[\].?]*\s+(\w+)/u.exec(parameter);
      if (name) vocabulary.add(name[1].toLowerCase());
    }
  }
  return { families, vocabulary, fields };
}

/** The target arguments an action surface entry can carry. */
const TARGET_ARGUMENTS = Object.freeze(["expectedTargetId", "slot"]);

/**
 * Which target-bearing actions have a published family that carries their target.
 *
 * Two authorities name the family: the discovery audit's `TARGET_FIELD` (the snapshot field the
 * action's opaque target is published under) and the surface's own `targetFamily`. They are one fact
 * with two spellings, so a disagreement is reported instead of one silently winning.
 */
export function addressabilityCoverage({ surface, targetField = TARGET_FIELD, published }) {
  const rows = [];
  const findings = [];
  for (const action of surface.actions) {
    if (action.kind !== "execution") continue;
    const args = Object.keys(action.argumentSchema ?? {});
    const namesTarget = TARGET_ARGUMENTS.some((argument) => args.includes(argument)) || (args.includes("x") && args.includes("y"));
    if (!namesTarget) continue;
    const tableFamily = targetField[action.actionId] ?? null;
    const surfaceFamily = action.targetFamily ?? null;
    const family = tableFamily ?? surfaceFamily;
    const row = { actionId: action.actionId, tableFamily, surfaceFamily, family, published: family === null ? null : published.has(family.toLowerCase()) };
    rows.push(row);
    if (family === null)
      findings.push({
        code: `action_without_addressable_family:${action.actionId}`,
        kind: "addressability",
        id: action.actionId,
        detail: `${action.actionId} names a target (${args.join(",")}) and neither TARGET_FIELD nor the action surface publishes a snapshot family that carries it`,
      });
    else if (tableFamily !== null && surfaceFamily !== null && tableFamily.toLowerCase() !== surfaceFamily.toLowerCase())
      findings.push({
        code: `addressable_family_disagrees:${action.actionId}`,
        kind: "addressability",
        id: action.actionId,
        detail: `${action.actionId} publishes its target through ${tableFamily} (TARGET_FIELD) but the surface declares ${surfaceFamily}`,
      });
    else if (!row.published)
      findings.push({
        code: `addressable_family_not_published:${action.actionId}`,
        kind: "addressability",
        id: action.actionId,
        detail: `${action.actionId} names ${family} as its target family, which no snapshot field in ${OBSERVATION_MODELS_PATH} publishes`,
      });
  }
  return { rows, findings };
}

/** The action -> request method map, from the handlers' own dispatch arms. */
export function handlerDispatch(sources) {
  const dispatch = new Map();
  for (const source of sources) {
    if (!source.path.startsWith("integrations/stardew/Handlers/")) continue;
    for (const match of withoutComments(source.source).matchAll(/"([a-z0-9_]+)"\s*=>\s*this\.executions\.(\w+)\(/gu))
      dispatch.set(match[1], match[2]);
  }
  return dispatch;
}

/**
 * The engine members a published snapshot field carries under a different name.
 *
 * `Farmer.CurrentToolIndex` is published as the top-level `currentToolSlot` (`BridgeProtocolModels.cs:841-849`: "The
 * farmer's ACTIVE tool slot (`Farmer.CurrentToolIndex`) and what that slot holds"), so a handler that selects a slot
 * and puts it back mutates a fact the snapshot DOES carry, and name matching alone cannot see it. Seventeen handlers
 * were excused by baseline entries that all said the same sentence about this one pair; the pair is declared here
 * instead, so those entries are gone and the next handler that swaps the hand needs no entry at all.
 */
const PUBLISHED_MEMBER_ALIASES = Object.freeze({ currenttoolindex: "currenttoolslot" });

/** Whether a published snapshot field carries the engine member `member`, under its own name or a declared one. */
function isPublishedMember(member, vocabulary, fields) {
  const name = member.toLowerCase();
  if (vocabulary.has(name) || fields.has(name)) return true;
  const alias = PUBLISHED_MEMBER_ALIASES[name];
  return alias !== undefined && (vocabulary.has(alias) || fields.has(alias));
}

/**
 * The engine members each action handler ASSIGNS, and whether any published snapshot field carries them.
 *
 * `this.<field>` is the controller's own bookkeeping, not engine state, so it is not a mutation of
 * the world; `.Value` is the net wrapper, so the member is the wrapper's name. The body scanned is
 * the request method plus the `Execute*` methods it calls - the Mod's own convention for "the body
 * that touches the world" - which is one hop deep and no deeper (stated in the non-guarantees).
 */
export function postconditionMutationCoverage({ sources, vocabulary, fields = new Set(), dispatch = handlerDispatch(sources) }) {
  const mutations = new Map();
  for (const [actionId, request] of dispatch) {
    const body = methodBody(sources, request);
    if (body === null) continue;
    const bodies = [body];
    for (const name of new Set([...body.matchAll(/\b(Execute\w+)\s*\(/gu)].map((match) => match[1]))) {
      const inner = methodBody(sources, name);
      if (inner !== null) bodies.push(inner);
    }
    for (const text of bodies) {
      for (const match of text.matchAll(/([A-Za-z_][\w.[\]()?]*?)\s*\.\s*(\w+)\s*(?:\.Value)?\s*=(?!=)/gu)) {
        const receiver = match[1];
        const member = match[2];
        if (receiver === "this" || member === "Value") continue;
        const id = `${actionId}:${member}`;
        const entry = mutations.get(id) ?? { id, actionId, member, receivers: new Set(), count: 0 };
        entry.receivers.add(receiver);
        entry.count += 1;
        mutations.set(id, entry);
      }
    }
  }
  return [...mutations.values()]
    .map((entry) => ({
      id: entry.id,
      actionId: entry.actionId,
      member: entry.member,
      count: entry.count,
      receivers: [...entry.receivers].sort(),
      published: isPublishedMember(entry.member, vocabulary, fields),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// 观测缺口 E 段：publication gating
// ---------------------------------------------------------------------------

/**
 * A snapshot family published only while a set of actions is ADVERTISED.
 *
 * The defect class: `WorldObjectTargets` is published while `place_owned_object`,
 * `remove_placed_item` or ... is advertised. `move_placed_furniture` names a row from that same
 * array, but it was not in the enabling set, so a companion that could ONLY move furniture got a
 * snapshot with no world-object rows at all - the action is not advertised, so the family is not
 * published, so the model cannot see a target, so the action is never used. Each step is a
 * consequence of the previous one, and no existing section could see it: the family IS published
 * (`publishedSnapshotSurface` finds it in the record) and the action IS addressable (`TARGET_FIELD`
 * names it). Only the GATE made them incompatible.
 *
 * The gate is written one of three ways, and the family name is an authority in none of them:
 *
 *   positional   `new BridgeSnapshot(..., cond ? DiscoverFooTargets(player) : null, ...)` - the
 *                family is the record parameter at that INDEX (`record BridgeSnapshot(...)`)
 *   named        `Field: cond ? DiscoverFooTargets(player) : null`
 *   via a local  `<type> foo = cond ? DiscoverFooTargets(player) : null;` referenced by name
 *
 * so every name is resolved from `record BridgeSnapshot(...)` - the same declaration
 * `publishedSnapshotSurface` reads for the population - and then CROSS-CHECKED against the row type
 * the `Discover*` method declares. A mis-counted argument list would bind a gate to the wrong
 * family, and the two authorities disagreeing is the only way to see that from text. When they
 * disagree, or the condition is not an advertisement chain, the gate is reported as unreadable
 * instead of being dropped: a silently skipped gate is the defect, not the parse failure.
 */

/** One `<receiver>.Contains("<action id>", StringComparer.X)` term of an advertisement chain. */
const ADVERTISEMENT = /^[A-Za-z_][\w.]*\s*\.\s*Contains\s*\(\s*"([a-z0-9_]+)"\s*,\s*StringComparer\.\w+\s*\)$/u;

/** A `bool` local an advertisement chain can be lifted into, so a named gate stays readable. */
const BOOLEAN_LOCAL = /\bbool\s+(\w+)\s*=\s*([^;]+);/gu;

/**
 * The ordered parameter list of `record BridgeSnapshot(...)`.
 *
 * `row` is the `Bridge*` row type when the parameter is a published family and null otherwise, so a
 * caller can tell a family parameter from a scalar one without a second name list.
 */
export function snapshotParameterOrder(models) {
  const code = withoutComments(models);
  const declaration = /\brecord\s+BridgeSnapshot\s*\(/u.exec(code);
  if (declaration === null) return [];
  const open = declaration.index + declaration[0].length - 1;
  const close = matchingBracket(code, open);
  if (close < 0) return [];
  return splitTopLevel(code.slice(open + 1, close)).map((parameter) => {
    const declared = parameter.replace(/=[\s\S]*$/u, "").trim();
    return {
      name: /([A-Za-z_]\w*)\s*$/u.exec(declared)?.[1] ?? null,
      row: /IReadOnlyList<(Bridge\w+)>\??/u.exec(declared)?.[1] ?? null,
    };
  });
}

/**
 * A C# parameter or argument list split on its top-level commas.
 *
 * Generics are counted as nesting (`<`/`>`), because `NetLongDictionary<FarmAnimal,
 * NetRef<FarmAnimal>>` is one argument and a naive split would silently shift every later index -
 * and every later index here IS a family name.
 */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let angle = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "(" || character === "[" || character === "{") depth++;
    else if (character === ")" || character === "]" || character === "}") depth--;
    else if (character === "<" && /[\w>?\]]/u.test(text[index - 1] ?? "")) angle++;
    else if (character === ">" && angle > 0) angle--;
    else if (character === "," && depth === 0 && angle === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Where the expression ending at `question` starts, never before `floor`. */
function conditionStart(code, question, floor) {
  let depth = 0;
  for (let index = question - 1; index >= floor; index--) {
    const character = code[index];
    if (character === ")") depth++;
    else if (character === "(") {
      if (depth === 0) return -1;
      depth--;
    } else if (
      depth === 0 &&
      (character === "," || character === ";" || character === "{" || character === "}" || character === ":" || character === "=")
    )
      return index + 1;
  }
  return floor;
}

/** The actions one gate admits, expanding a `bool` local the chain was lifted into. */
function gatedActions(condition, booleanLocals, depth = 0) {
  const operands = condition.trim().split("||");
  // A chain can be parenthesised as a whole (`(A || B || C) ? ... : null`), which leaves the ternary's own
  // grouping brackets on the first and last operand of the split. Exactly that many are removed - one more would
  // eat the `)` that closes the last Contains call and no term would parse.
  const wrapped = /^\s*(\(+)/u.exec(condition)?.[1].length ?? 0;
  if (wrapped > 0 && operands.length > 0) {
    let first = operands[0];
    for (let count = 0; count < wrapped; count++) first = first.replace(/^\s*\(/u, "");
    operands[0] = first;
    const last = operands.length - 1;
    const tail = operands[last].trimEnd();
    operands[last] = tail.slice(0, Math.max(0, tail.length - wrapped));
  }
  const actions = new Set();
  for (const operand of operands) {
    const advertisement = ADVERTISEMENT.exec(operand.trim());
    if (advertisement !== null) {
      actions.add(advertisement[1]);
      continue;
    }
    const lifted = booleanLocals.get(operand.trim());
    if (lifted === undefined || depth >= 4) return null;
    const nested = gatedActions(lifted, booleanLocals, depth + 1);
    if (nested === null) return null;
    for (const action of nested) actions.add(action);
  }
  return actions;
}

/**
 * Every `<family> is published while <action set> is advertised` gate in the Mod sources.
 *
 * `findings` here are STRUCTURAL (a gate this reader could not resolve) and carry no baseline id:
 * an unreadable gate would make its family look ungated, which is the same silence the section
 * exists to remove, so it must stay red rather than be excused.
 */
export function publicationGates({ sources, parameters = [], discoveryRows = new Map() }) {
  const findings = [];
  const gates = [];
  for (const source of sources) {
    const code = withoutComments(source.source);
    const booleanLocals = new Map([...code.matchAll(BOOLEAN_LOCAL)].map((match) => [match[1], match[2]]));
    // A gated value held in a local, keyed by the local's name: the call site then just names it.
    const locals = new Map();
    for (const match of code.matchAll(/\?\s*(?:this\s*\.\s*)?(Discover\w+)\s*\(/gu)) {
      const start = conditionStart(code, match.index, 0);
      if (start < 0) continue;
      const assignment = /([A-Za-z_]\w*)\s*=\s*$/u.exec(code.slice(0, start));
      if (assignment === null) continue;
      locals.set(assignment[1], { discovery: match[1], condition: code.slice(start, match.index) });
    }
    for (const call of code.matchAll(/new\s+BridgeSnapshot\s*\(/gu)) {
      const open = call.index + call[0].length - 1;
      const close = matchingBracket(code, open);
      if (close < 0) continue;
      let offset = open + 1;
      for (const [index, argument] of splitTopLevel(code.slice(open + 1, close)).entries()) {
        const argumentStart = offset;
        offset = argumentStart + argument.length + 1;
        const named = /^\s*([A-Za-z_]\w*)\s*:/u.exec(argument);
        const inline = /\?\s*(?:this\s*\.\s*)?(Discover\w+)\s*\(/u.exec(argument);
        let family = null;
        let discovery = null;
        let condition = null;
        if (inline !== null) {
          const question = argumentStart + inline.index;
          const start = Math.max(conditionStart(code, question, argumentStart), argumentStart);
          discovery = inline[1];
          condition = code.slice(start, question);
          family = named !== null ? named[1] : (parameters[index]?.name ?? null);
        } else {
          const bare = /^\s*([A-Za-z_]\w*)\s*$/u.exec(argument);
          const local = bare === null ? undefined : locals.get(bare[1]);
          if (local === undefined) continue;
          family = parameters[index]?.name ?? null;
          discovery = local.discovery;
          condition = local.condition;
        }
        const declared = parameters.find((parameter) => parameter.name === family);
        if (declared === undefined) {
          findings.push({
            code: `publication_gate_unparsed:${family ?? `argument_${index}`}`,
            kind: "gating",
            id: null,
            detail: `${source.path} publishes ${discovery} behind an advertisement chain, and argument ${index + 1} of new BridgeSnapshot(...) is not a parameter of record BridgeSnapshot`,
          });
          continue;
        }
        const actions = gatedActions(condition, booleanLocals);
        if (actions === null) {
          findings.push({
            code: `publication_gate_unparsed:${family}`,
            kind: "gating",
            id: null,
            detail: `${source.path} publishes ${family} behind \`${condition.trim().replace(/\s+/gu, " ")}\`, which is not a chain of advertisedCapabilities.Contains("<action id>", ...) terms`,
          });
          continue;
        }
        const row = discoveryRows.get(discovery) ?? null;
        if (row !== null && declared.row !== null && row !== declared.row) {
          findings.push({
            code: `publication_gate_unparsed:${family}`,
            kind: "gating",
            id: null,
            detail: `${source.path} publishes ${discovery} (a ${row} list) at the position of BridgeSnapshot.${family} (a ${declared.row} list); the argument list and the record disagree, so no gate is claimed here`,
          });
          continue;
        }
        if (declared.row === null) continue;
        gates.push({ path: source.path, family, discovery, gatedBy: [...actions].sort() });
      }
    }
  }
  return { gates, findings };
}

/**
 * Which gated families a targeting action needs and cannot reach.
 *
 * `needs` comes from the discovery audit's `TARGET_FIELD` (imported, never copied): it is the one
 * declaration of "this action's opaque target is published under this family", so an action that
 * needs a family IS an action whose `TARGET_FIELD` row names it. A family published
 * unconditionally has no gate and therefore no way to hide, so it is not measured here.
 */
export function publicationGateCoverage({ gates, targetField = TARGET_FIELD }) {
  const enabling = new Map();
  for (const gate of gates) {
    const key = gate.family.toLowerCase();
    const entry = enabling.get(key) ?? { family: gate.family, actions: new Set(), discoveries: new Set() };
    for (const action of gate.gatedBy) entry.actions.add(action);
    entry.discoveries.add(gate.discovery);
    enabling.set(key, entry);
  }
  const needed = new Map();
  for (const [action, family] of Object.entries(targetField)) {
    if (typeof family !== "string") continue;
    const key = family.toLowerCase();
    const list = needed.get(key) ?? [];
    list.push(action);
    needed.set(key, list);
  }
  const rows = [];
  const findings = [];
  for (const [key, entry] of [...enabling].sort(([left], [right]) => left.localeCompare(right))) {
    const actions = (needed.get(key) ?? []).sort();
    const missing = actions.filter((action) => !entry.actions.has(action));
    rows.push({
      family: entry.family,
      discoveries: [...entry.discoveries].sort(),
      gatedBy: [...entry.actions].sort(),
      needs: actions,
      missing,
    });
    for (const action of missing)
      findings.push({
        code: `family_gated_off:${entry.family}:${action}`,
        kind: "gating",
        id: `${entry.family}:${action}`,
        detail: `${entry.family} is published only while one of ${[...entry.actions].sort().join(", ")} is advertised, and ${action} names a ${entry.family} row as its target: an actor that cannot advertise ${action} never sees the target ${action} needs`,
      });
  }
  return { rows, findings };
}

// ---------------------------------------------------------------------------
// 观测缺口 F 段：consumption
// ---------------------------------------------------------------------------

/**
 * A published family nothing reads is bytes the model pays for and a fact it never sees.
 *
 * THREE STATEMENTS THIS SECTION MAKES, AND THREE IT DELIBERATELY DOES NOT
 *
 * 1. ON-DEMAND DELIVERY IS NOT A GAP. The Host attaches `snapshot-projection.ts` to every turn
 *    under a 4 KB cap, so a 64-row family cannot live there (measured 2026-11-02: `cropTargets`
 *    alone is ~5.7 KB, over the whole cap). Every family is delivered verbatim by a solicited
 *    `stardew_observe`, and `host/src/snapshot-projection-coverage.ts` is the authority for that
 *    delivery policy: a wire field must be read by one of its five projections or be recorded in
 *    `WITHHELD_SNAPSHOT_KEYS` with a reason. This report does not re-litigate that policy and a
 *    family delivered only on demand is CORRECT.
 *
 * 2. THE ADVISORY COUNT IS NOT A TO-DO LIST. `family_without_consumer` names families no HUD line,
 *    no projection reader and no tool description mentions. That is a description of where a fact
 *    reaches the model as raw observation JSON and nowhere else. It going up is not by itself a
 *    regression, and a reader who treats it as a backlog will re-derive the 64-family "red" this
 *    section was written to avoid.
 *
 * 3. TWO THINGS ARE RED, and they are different questions:
 *    - `family_without_consumer_and_targeted`: nobody consumes it AND an action targets a row from
 *      it. That is the case where the model must spend an observe to learn something a line could
 *      have said, about a family it also has to act through.
 *    - `family_unclassified_by_consumer_inventory`: the Host's own inventory does not classify the
 *      family at all - it is not read by a projection and not declared withheld. That is a DECISION
 *      gap rather than a delivery-policy judgment, so it fails closed: someone has to write the
 *      line. It is not baselinable, because excusing it would preserve the ambiguity.
 *
 * CONSUMER KINDS come from the Host, not from a taxonomy invented here. `PROJECTION_SOURCES`,
 * `UNPROJECTED_OBSERVED_FAMILIES`, `REQUIRED_PROJECTED_KEYS` and `WITHHELD_SCALAR_KEYS` are read out
 * of `host/src/snapshot-projection-coverage.ts` as text, because this tool is `.mjs` and cannot
 * import a `.ts` module; the projection files those tables name are then read directly. The HUD is
 * read through its own declaration (`SNAPSHOT_HUD_LINES[].fields`), and a tool-description mention
 * is read from `host/src/game-tools.ts`. Nothing here restates the inventory: a rename in that
 * module makes the tables unreadable, which is reported as `consumption_inventory_unreadable`
 * instead of silently classifying nothing.
 */

export const CONSUMPTION_INVENTORY_PATH = "host/src/snapshot-projection-coverage.ts";
export const GAME_TOOLS_PATH = "host/src/game-tools.ts";
export const SNAPSHOT_HUD_PATH = "host/src/snapshot-hud.ts";

/** The quoted strings of one `NAME = Object.freeze([...])` table, or null when the table is gone. */
function inventoryList(inventory, name) {
  const block = new RegExp(`${name}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`, "u").exec(inventory);
  return block === null ? null : [...block[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

/** The snapshot keys the per-turn state block declares, read from the block's own line table. */
export function hudFieldKeys(hud) {
  return new Set(
    [...withoutComments(hud).matchAll(/fields:\s*\[([^\]]*)\]/gu)].flatMap((match) =>
      [...match[1].matchAll(/"([^"]+)"/gu)].map((field) => field[1]),
    ),
  );
}

/** The keys of the `WITHHELD_SCALAR_KEYS` record, or null when the record is gone. */
function inventoryRecordKeys(inventory, name) {
  const block = new RegExp(`${name}[\\s\\S]*?Object\\.freeze\\(\\{([\\s\\S]*?)\\n\\}\\);`, "u").exec(inventory);
  return block === null ? null : [...block[1].matchAll(/^\s*([A-Za-z_][\w]*)\s*:\s*\n?\s*"/gmu)].map((match) => match[1]);
}

/**
 * Whether one projection source reads a snapshot key.
 *
 * This mirrors the Host's own `projectionReads` (`.key`, `"key"`, and a destructure binding), because a
 * `.mjs` tool cannot import it. The population it is applied to comes from the Host's tables, so the
 * two can only disagree about a spelling - which `snapshot-projection-coverage.private.test.ts` already gates
 * on its own side.
 */
function projectionReads(source, key) {
  const code = withoutComments(source);
  return [
    new RegExp(`\\.${key}\\b`, "u"),
    new RegExp(`["']${key}["']`, "u"),
    new RegExp(`\\{[^}]*\\b${key}\\b[^}]*\\}\\s*=`, "u"),
  ].some((pattern) => pattern.test(code));
}

/**
 * Where each published family is consumed, and which of those questions are red.
 *
 * `families` are the snapshot's own family parameters (from `record BridgeSnapshot(...)`), the HUD
 * fields are its declared ones, and `targetField` is the discovery audit's table - so "an action
 * targets a row from this family" has one authority, the same one sections C and E use.
 */
export function consumptionCoverage({
  families = [],
  inventory,
  tools,
  hud,
  projectionSources = new Map(),
  targetField = TARGET_FIELD,
}) {
  const findings = [];
  const listed = {
    PROJECTION_SOURCES: inventoryList(inventory, "PROJECTION_SOURCES"),
    UNPROJECTED_OBSERVED_FAMILIES: inventoryList(inventory, "UNPROJECTED_OBSERVED_FAMILIES"),
    REQUIRED_PROJECTED_KEYS: inventoryList(inventory, "REQUIRED_PROJECTED_KEYS"),
    WITHHELD_SCALAR_KEYS: inventoryRecordKeys(inventory, "WITHHELD_SCALAR_KEYS"),
  };
  for (const [table, value] of Object.entries(listed))
    if (value === null || value.length === 0)
      findings.push({
        code: `consumption_inventory_unreadable:${table}`,
        kind: "consumption",
        id: null,
        detail: `${CONSUMPTION_INVENTORY_PATH} no longer declares ${table} in a form this reader can follow; the consumer classification would silently empty, so it is reported instead`,
      });
  const unclassified = [];
  for (const path of projectionSources.keys())
    if (listed.PROJECTION_SOURCES !== null && !listed.PROJECTION_SOURCES.includes(path))
      findings.push({
        code: `consumption_projection_not_in_inventory:${path}`,
        kind: "consumption",
        id: null,
        detail: `${path} is read as a projection and ${CONSUMPTION_INVENTORY_PATH} does not name it in PROJECTION_SOURCES`,
      });

  const declaredWithheld = new Set([
    ...(listed.UNPROJECTED_OBSERVED_FAMILIES ?? []),
    ...(listed.WITHHELD_SCALAR_KEYS ?? []),
  ]);
  const requiredProjected = new Set(listed.REQUIRED_PROJECTED_KEYS ?? []);
  const hudFields = hudFieldKeys(hud);
  const toolText = withoutComments(tools);
  const sources = [...projectionSources]
    .filter(([path]) => path !== SNAPSHOT_HUD_PATH)
    .map(([path, text]) => ({ path, text }));
  const targeted = new Set(Object.values(targetField).filter((family) => typeof family === "string"));

  const rows = families.map((family) => {
    const key = family[0].toLowerCase() + family.slice(1);
    const reads = sources.filter((source) => projectionReads(source.text, key)).map((source) => source.path);
    const row = {
      family,
      targeted: targeted.has(family),
      hud: hudFields.has(key),
      projections: reads,
      toolDescription: new RegExp(`\\b${key}\\b`, "u").test(toolText),
      declared: (listed.UNPROJECTED_OBSERVED_FAMILIES ?? []).includes(key)
        ? "UNPROJECTED_OBSERVED_FAMILIES"
        : (listed.WITHHELD_SCALAR_KEYS ?? []).includes(key)
          ? "WITHHELD_SCALAR_KEYS"
          : requiredProjected.has(key)
            ? "REQUIRED_PROJECTED_KEYS"
            : null,
    };
    row.consumed = row.hud || reads.length > 0 || row.toolDescription;
    // The Host's own rule, in its own terms: read by one of its projections, or declared withheld.
    row.classified = row.declared !== null || [...projectionSources].some(([, text]) => projectionReads(text, key));
    if (!row.classified) unclassified.push(family);
    return row;
  });

  for (const row of rows) {
    if (!row.classified)
      findings.push({
        code: `family_unclassified_by_consumer_inventory:${row.family}`,
        kind: "consumption",
        id: null,
        detail: `${row.family} is published by the snapshot and ${CONSUMPTION_INVENTORY_PATH} neither projects it nor declares it withheld; nobody has decided whether the model should see it outside a solicited observation, so the report stops rather than baselining the ambiguity`,
      });
    else if (!row.consumed && row.targeted)
      findings.push({
        code: `family_without_consumer_and_targeted:${row.family}`,
        kind: "consumption",
        id: null,
        detail: `${row.family} is published, no HUD line, projection or tool description reads it, and an action targets a row from it: the model must spend an observe on a family it also acts through`,
      });
  }
  return { rows, findings, unclassified };
}

/** The Host sources the consumption section reads, resolved from the inventory's own path list. */
export function loadConsumptionSources({
  inventory = readFileSync(path.join(REPOSITORY_ROOT, CONSUMPTION_INVENTORY_PATH), "utf8"),
  tools = readFileSync(path.join(REPOSITORY_ROOT, GAME_TOOLS_PATH), "utf8"),
  hud = readFileSync(path.join(REPOSITORY_ROOT, SNAPSHOT_HUD_PATH), "utf8"),
  projectionSources = null,
} = {}) {
  const paths = inventoryList(inventory, "PROJECTION_SOURCES") ?? [];
  return {
    inventory,
    tools,
    hud,
    projectionSources:
      projectionSources ??
      new Map(paths.map((relative) => [relative, readFileSync(path.join(REPOSITORY_ROOT, relative), "utf8")])),
  };
}

// ---------------------------------------------------------------------------
// 观测缺口 G 段：quadrant（local / map_fixed / actor_owned）
// ---------------------------------------------------------------------------

/**
 * Which quadrant a published family lives in, derived from the Mod's own discovery code.
 *
 * THE DEFECT THIS SECTION EXISTS FOR, measured 2026-11-05: `mineEntranceTargets` is published whole-map (the
 * mine level's own Buildings layer is scanned for the exit ladder at tile 115 and the descent ladder at 173),
 * validated, in `SNAPSHOT_KEYS` - and no per-turn line read it. A companion standing in a mine shaft had to
 * spend a `stardew_observe` (~6.9k tokens, the largest tool result in a run) to learn where the way out was,
 * in exactly the place it gets lost. The same shape appeared earlier with the watering-can refill: the family
 * existed but was scoped to radius 6 while ponds are 10-20 tiles away.
 *
 * Both are QUADRANT ERRORS: a MAP-FIXED thing delivered as if it were a LOCAL one. The quadrant is a property
 * of the discovery, so it is read out of the discovery rather than remembered here:
 *
 *   local        every discovery bounds its rows around the actor's own tile - `IsTileWithinChebyshevRadius`,
 *                the engine's `Utility.tileWithinRadiusOfPlayer`, an adjacency helper, or a scan window whose
 *                lower bound is something minus a `*Radius*` symbol.
 *   map_fixed    some discovery publishes rows that do NOT depend on where the actor stands: a whole-layer
 *                scan (`for (x = 0; x < LayerWidth; ...)`, directly or through one of the Mod's own helpers)
 *                or a read of a location-wide collection. THIS WINS OVER `local`: a family with one
 *                actor-bounded branch and one whole-map branch publishes rows the actor cannot reach by
 *                walking, and calling that family local is exactly how the mine ladder stayed invisible.
 *   actor_owned  the discovery reads no location and no map content at all - the actor's pack, its body
 *                slots, the quest log, the content catalogs. There is no quadrant to get wrong, so the red
 *                rule does not touch it; naming it map_fixed would be a false claim about the world.
 *   undeclared   the family has neither a `Discover*` nor a declaration in `UNDISCOVERED_FAMILY_QUADRANTS`, so the
 *                derivation has no evidence and says so (by name, in the summary) instead of guessing. Three families
 *                had none when this section was written - `Warps`, `PendingLevelUpChoices` and `DiscoveryExclusions` -
 *                and each is now declared there; a fourth arriving without either is the case this class is for.
 *
 * THE RED RULE is the quadrant error itself: `map_fixed` AND an action targets a row from it AND no line of
 * the per-turn block reads it. That is a family the model must spend an observe on, about a fact that does not
 * move, to act on something it also has to act through. It is a ratchet like D, with the same two rules: a red
 * that is not in the baseline fails, and an entry whose family is now read by the HUD - or is no longer
 * map_fixed and targeted - fails as stale rather than excusing the next one.
 *
 * WHAT EACH ROW CARRIES, and why the evidence is printed: every classification names the discovery that
 * decided it and the branch the evidence was found in (or the helper it was found through), so a
 * misclassification is arguable from the report instead of mysterious.
 */

/** A distance check against the actor's own tile: the Mod's helper, the engine's, or adjacency. */
const QUADRANT_RADIUS = /\bIsTileWithinChebyshevRadius\s*\(|\btileWithinRadiusOfPlayer\s*\(|\b\w*Adjacent\w*\s*\(/u;
/** A scan window centred on the actor: `for (int x = player.TilePoint.X - TargetDiscoveryRadius; ...)`. */
const QUADRANT_WINDOW = /-\s*\w*[Rr]adius\b/u;
/** A whole-layer scan: a loop from zero bounded by the layer's own size. */
const QUADRANT_LAYER = /\bLayerWidth\b|\bLayerHeight\b/u;
const QUADRANT_ORIGIN_LOOP = /for\s*\(\s*(?:int\s+)?[A-Za-z_]\w*\s*=\s*0\s*;/u;
/** A read of the map the actor stands on. */
const QUADRANT_LOCATION =
  /\blocation\s*(?:\?|!)?\s*\.\s*[A-Za-z_]|\bdoesTileHaveProperty\s*\(|\bGame1\s*\.\s*locations\b/u;

/**
 * The published families no `Discover*` produces, and the quadrant the code that BUILDS them decides.
 *
 * `parseDiscoveries` only matches `IReadOnlyList<Bridge*>` methods named `Discover*`, so a family assembled at the
 * snapshot call site (or by a `Describe*` helper, or by a recorder) reaches this section with no body to read, and
 * saying `undeclared` about a family whose quadrant is plainly visible one call away is a report that knows less
 * than the tree does. Three families are in that position, and each one is declared with the site that decides it
 * rather than with a guess:
 *
 *   Warps                  `record BridgeSnapshot` reads `player.currentLocation?.warps` - the current location's
 *                          whole warp table. A location's exits are MAP topology: they sit at fixed tiles of the
 *                          map they belong to and do not move when the actor walks away. `map_fixed`.
 *   PendingLevelUpChoices  `DescribePendingLevelUpChoices` walks `player.newLevels` and reads `player.professions`:
 *                          the actor's own unspent milestones, no location and no map content. `actor_owned`.
 *   DiscoveryExclusions    `DiscoveryExclusionRecorder.Publish` emits `(family, reason, count)` rows about what the
 *                          LAST radar pass withheld. It reads no location and no map: the counts move with the
 *                          actor's radius, but they aggregate rows no caller can name (there is no tile and no
 *                          target id in a row), so there is no addressable row and no quadrant to get wrong.
 *                          `actor_owned`, and NOT `local`: `local` claims rows the actor can walk to.
 *
 * A declaration is used ONLY where the derivation found no `Discover*` evidence, so a family that gains one is
 * classified by its own body again and the declaration becomes dead text rather than a stale answer.
 */
export const UNDISCOVERED_FAMILY_QUADRANTS = Object.freeze({
  Warps: Object.freeze({
    quadrant: "map_fixed",
    evidence:
      "built at integrations/stardew/farmhandexecutioncontroller.cs:2366 from `player.currentLocation?.warps`, the current location's whole warp table, so its rows are where the MAP's exits are",
  }),
  PendingLevelUpChoices: Object.freeze({
    quadrant: "actor_owned",
    evidence:
      "built at integrations/stardew/farmhandexecutioncontroller.cs:2684 by `DescribePendingLevelUpChoices`, which walks `player.newLevels` and reads `player.professions`: the actor's own unspent milestones, no location and no map read",
  }),
  DiscoveryExclusions: Object.freeze({
    quadrant: "actor_owned",
    evidence:
      "built at integrations/stardew/src/Core/Policy/DiscoveryExclusionReasons.cs:159 by `DiscoveryExclusionRecorder.Publish`, which counts what the last radar pass withheld: (family, reason, count) rows with no tile and no target id, so no action can name one and no location or map content is read",
  }),
});

/** C# keywords followed by `(` that are not calls into the Mod's own methods. */
const CSHARP_KEYWORDS = new Set([
  "as",
  "await",
  "base",
  "case",
  "catch",
  "checked",
  "default",
  "do",
  "else",
  "finally",
  "fixed",
  "for",
  "foreach",
  "goto",
  "if",
  "in",
  "is",
  "lock",
  "nameof",
  "new",
  "out",
  "ref",
  "return",
  "sizeof",
  "stackalloc",
  "switch",
  "throw",
  "try",
  "typeof",
  "unchecked",
  "using",
  "when",
  "while",
  "yield",
]);

/**
 * The Mod's own method bodies by name, for the radius and layer-scan closure.
 *
 * A discovery is usually two calls away from the bound that decides its quadrant (`DiscoverChestStates` ->
 * `OrderedStorageContainers` -> `IsChestTargetInRange` -> `IsTileWithinChebyshevRadius`), so a reader that
 * only looked at the discovery's own text would classify half the tree by accident.
 */
export function modMethodBodies(sources) {
  const bodies = new Map();
  for (const { source } of sources) {
    const code = codeOnly(source);
    for (const match of code.matchAll(/\b([A-Za-z_]\w*)\s*(?:<[^<>()]{0,80}>)?\s*\(/gu)) {
      const name = match[1];
      if (CSHARP_KEYWORDS.has(name) || bodies.has(name)) continue;
      const open = code.indexOf("(", match.index + match[0].length - 1);
      const close = matchingBracket(code, open);
      if (close < 0) continue;
      const body = bodyAfterParameters(code, close);
      if (body !== null) bodies.set(name, body);
    }
  }
  return bodies;
}

/** The Mod methods a body calls that satisfy `predicate`, three calls deep, by name. */
function callsReaching(body, bodies, predicate, depth = 3, seen = new Set()) {
  if (depth === 0) return [];
  const reached = [];
  for (const match of body.matchAll(/\b([A-Za-z_]\w*)\s*(?:<[^<>()]{0,60}>)?\s*\(/gu)) {
    const name = match[1];
    if (CSHARP_KEYWORDS.has(name) || seen.has(name)) continue;
    seen.add(name);
    const nested = bodies.get(name);
    if (nested === undefined) continue;
    if (predicate(nested)) reached.push(name);
    else reached.push(...callsReaching(nested, bodies, predicate, depth - 1, seen));
  }
  return reached;
}

const isWholeLayerScan = (body) => QUADRANT_LAYER.test(body) && QUADRANT_ORIGIN_LOOP.test(body);
const isActorBounded = (body) => QUADRANT_RADIUS.test(body) || QUADRANT_WINDOW.test(body);

/** What one discovery's own text - and the Mod helpers it calls - says about its quadrant. */
function discoveryQuadrantEvidence(body, bodies) {
  const radius = [];
  if (QUADRANT_RADIUS.test(body)) radius.push("an actor-radius helper");
  if (QUADRANT_WINDOW.test(body)) radius.push("a scan window around the actor");
  radius.push(...callsReaching(body, bodies, isActorBounded).map((name) => `an actor bound inside ${name}`));
  const mapFixed = [];
  if (isWholeLayerScan(body)) mapFixed.push("a whole-layer scan");
  mapFixed.push(...callsReaching(body, bodies, isWholeLayerScan).map((name) => `a whole-layer scan inside ${name}`));
  const location = [];
  if (QUADRANT_LOCATION.test(body)) location.push("the location's own contents");
  location.push(
    ...callsReaching(body, bodies, (nested) => QUADRANT_LOCATION.test(nested)).map(
      (name) => `the location's contents inside ${name}`,
    ),
  );
  return { radius, mapFixed, location };
}

/** One published family's quadrant, its evidence, and whether the per-turn block and an action reach it. */
export function quadrantRow({ family, row, discoveries, bodies, hudFields, targetField = TARGET_FIELD }) {
  const owned = discoveries.filter((discovery) => discovery.row === row);
  const evidence = owned.map((discovery) => ({
    discovery: discovery.name,
    ...discoveryQuadrantEvidence(discovery.body, bodies),
  }));
  const key = family[0].toLowerCase() + family.slice(1);
  const declared = evidence.length === 0 ? UNDISCOVERED_FAMILY_QUADRANTS[family] : undefined;
  const quadrant =
    declared !== undefined
      ? declared.quadrant
      : evidence.length === 0
        ? "undeclared"
        : evidence.some((entry) => entry.mapFixed.length > 0)
          ? "map_fixed"
          : evidence.some((entry) => entry.radius.length > 0)
            ? "local"
            : evidence.some((entry) => entry.location.length > 0)
              ? "map_fixed"
              : "actor_owned";
  const evidenceLines =
    declared !== undefined
      ? [declared.evidence]
      : evidence.map((entry) => {
          const found = [
            ...entry.mapFixed.map((part) => `map-fixed: ${part}`),
            ...entry.radius.map((part) => `actor-bounded: ${part}`),
            ...entry.location.map((part) => `location-wide: ${part}`),
          ];
          return `${entry.discovery}: ${
            found.length > 0 ? found.join("; ") : "no location and no map read (the actor's own state)"
          }`;
        });
  return {
    family,
    key,
    quadrant,
    declared: declared !== undefined,
    targeted: Object.values(targetField).includes(family),
    hud: hudFields.has(key),
    discoveries: owned.map((discovery) => discovery.name),
    evidence: evidenceLines,
  };
}

/**
 * Every published family's quadrant, plus the one red this section can raise.
 *
 * `families` are the snapshot's own parameters (name and row type), `discoveries` the parsed `Discover*`
 * bodies, `bodies` the Mod's method table for the call closure, and the HUD keys come from the block's own
 * declaration - so "is it read every turn" has one authority and a rename upstream empties nothing silently.
 */
export function observationQuadrants({
  families = [],
  discoveries = [],
  bodies = new Map(),
  hudFields = new Set(),
  targetField = TARGET_FIELD,
}) {
  const rows = families.map((family) =>
    quadrantRow({ family: family.name, row: family.row, discoveries, bodies, hudFields, targetField }),
  );
  const findings = [];
  for (const row of rows) {
    if (row.quadrant !== "map_fixed" || !row.targeted || row.hud) continue;
    findings.push({
      code: `map_fixed_family_not_in_hud:${row.family}`,
      kind: "quadrant",
      id: row.family,
      detail: `${row.family} is map-fixed (${row.evidence.join(" | ")}), an action targets a row from it, and no line of ${SNAPSHOT_HUD_PATH} reads it: the model must spend an observe on a fact that does not move, about a family it also acts through`,
    });
  }
  const counts = {
    local: rows.filter((row) => row.quadrant === "local").length,
    mapFixed: rows.filter((row) => row.quadrant === "map_fixed").length,
    actorOwned: rows.filter((row) => row.quadrant === "actor_owned").length,
    undeclared: rows.filter((row) => row.quadrant === "undeclared").length,
    mapFixedUntargeted: rows.filter((row) => row.quadrant === "map_fixed" && !row.targeted).length,
    red: findings.length,
  };
  return { rows, findings, counts };
}

// ---------------------------------------------------------------------------
// 观测缺口 H 段：field-level coverage
// ---------------------------------------------------------------------------

/**
 * THE DEFECT THIS SECTION EXISTS FOR, measured 2026-11-05: section D asks only whether the member an action
 * handler MUTATES is carried by SOME family, so it is green while the actual row is too thin to act on.
 * `water_crop` decides from `HoeDirt.needsWatering()` / `isWatered()`, and the row it is handed
 * (`BridgeCropTarget`) carries target id, tile, crop id and display name - so the companion learns "there is a
 * crop at 12,7" and not "it needs water", the single fact the action exists for. Same shape for the tillable
 * tile that is only published as `{ x, y }`.
 *
 * THE EXTRACTION RULE, deliberately narrow, and the reason its counts are printed separately from its verdicts:
 *
 *   1. BODIES. The body set is section D's: the request method the handler dispatch maps the action to, plus
 *      every `Execute*` method that body calls, one hop.
 *   2. ENGINE BINDINGS. A name a body binds to one of the engine's world-object types by pattern or declarator:
 *      `<expr> is [not] [ns.]HoeDirt dirt`, `HoeDirt? dirt = ...`, `<name> = <expr> as HoeDirt`,
 *      `out [ns.]Object? machine`. The binding counts ONLY when the statement that produced it reads the
 *      location: a value taken out of the actor's pack is not the row's subject, and counting it would report
 *      a target family for a decision about something else. The type names are one vocabulary below, not a
 *      per-action list; a target read through a type outside it is invisible here, which is what `unparsed`
 *      counts.
 *   3. DECISION READS. A member read through an engine binding that appears inside an `if`, `while` or `switch`
 *      selector, or in a `return` expression. `dirt.crop.netSeedIndex` reads `crop` then `netSeedIndex`; `.Value`
 *      is the net wrapper and `this.<field>` is controller bookkeeping, exactly as in section D. The arguments
 *      of the Mod's own `Build*TargetId(...)` are excluded: they NAME the row the caller must echo and decide
 *      nothing.
 *   4. PRESENCE READS. A call whose result is null-tested in a decision expression and whose NAME carries one of
 *      those engine type names (`location.GetHoeDirtAtTile(tile) is not null`) reads that type's presence in the
 *      target.
 *   5. CARRIED. A read is carried when its field spelling is a field of the row type the action's target family
 *      publishes. The spelling is camelCase, plus an accessor prefix stripped when a capital follows it
 *      (`isWatered` -> `watered`, `GetHarvestMethod` -> `harvestMethod`), which is the convention the engine's own
 *      predicates and accessors use. The row type is the schema `$defs` entry the family's `items.$ref` names - the wire
 *      authority - and its field list is CROSS-CHECKED against the Mod's `record Bridge<Row>` declaration, so a field
 *      added to one side and not the other is a finding rather than a silent half-fact.
 *   6. Everything else is `field_unobservable:<action>:<member>:<family>`, ratcheted like D: a red not in the
 *      baseline fails, and a baselined entry that is now carried - or no longer measured - fails as stale.
 *   7. A handler whose body cannot be located, or that yields no decision read at all, is counted `unparsed` and
 *      printed. An action that names no family, or a family the schema has no row for, is counted `noFamily` /
 *      `noRow` and printed. None of the three is ever treated as clean.
 */

export const OBSERVATION_SCHEMA_PATH = "protocol/bridge-v1.schema.json";

/** The engine's world-object types a handler casts its target to (a vocabulary, not a population). */
export const ENGINE_TARGET_TYPES = Object.freeze(["HoeDirt", "Crop", "Object", "TerrainFeature"]);

const ENGINE_TYPE_ALTERNATION = ENGINE_TARGET_TYPES.join("|");

/** Every shape that binds a name to one of the engine types, each capturing `type` then `name`. */
const ENGINE_BINDING_PATTERNS = Object.freeze([
  new RegExp(`\\bis\\s+(?:not\\s+)?(?:[\\w.]+\\.)?(${ENGINE_TYPE_ALTERNATION})\\s+([A-Za-z_]\\w*)`, "gu"),
  new RegExp(`(?:[\\w.]+\\.)?(${ENGINE_TYPE_ALTERNATION})\\??\\s+([A-Za-z_]\\w*)\\s*=`, "gu"),
  new RegExp(`\\bout\\s+(?:[\\w.]+\\.)?(${ENGINE_TYPE_ALTERNATION})\\??\\s+([A-Za-z_]\\w*)`, "gu"),
  new RegExp(`\\b([A-Za-z_]\\w*)\\s*=\\s*[^;=]*?\\bas\\s+(?:[\\w.]+\\.)?(${ENGINE_TYPE_ALTERNATION})\\b`, "gu"),
]);

/** The Mod's own identity builder: its arguments NAME the row, so reading them decides nothing. */
const TARGET_ID_CALL = /\bBuild\w*TargetId\s*\([^()]*\)/gu;

/** A call whose result is tested against null: the presence read of an engine type named by the call. */
const PRESENCE_NULL_TEST = /\b([A-Za-z_]\w*)\s*\([^()]*\)\s*(?:is\s+(?:not\s+)?null|[!=]=\s*null)/gu;

/** The deciding expressions of one body: what `if`, `while` and `switch` test, and what a `return` states. */
function decisionExpressions(body) {
  const expressions = [];
  for (const match of body.matchAll(/\b(?:if|while|switch)\s*\(/gu)) {
    const open = body.indexOf("(", match.index + match[0].length - 1);
    const close = matchingBracket(body, open);
    if (close > open) expressions.push(body.slice(open + 1, close));
  }
  for (const match of body.matchAll(/\breturn\b([^;]*);/gu)) expressions.push(match[1]);
  return expressions;
}

/** The members one selector reads through `name`, one member at a time along the chain. */
function membersReadThrough(selector, name) {
  const members = new Set();
  const chain = new RegExp(`\\b${name}((?:\\s*[!?]?\\s*\\.\\s*[A-Za-z_]\\w*)+)`, "gu");
  for (const match of selector.matchAll(chain))
    for (const segment of match[1].replace(/[!?]/gu, "").split(".")) {
      const member = segment.trim();
      if (member.length > 0 && member !== "Value") members.add(member);
    }
  return members;
}

/** A statement that reads the world: the receiver a target value has to come from. */
const LOCATION_RECEIVER =
  /\b(?:location|farm|currentLocation|terrainFeatures|largeTerrainFeatures|objects)\b/u;

/**
 * The engine members one handler reads to decide, or `parsed: false` when its request body is missing.
 *
 * Bindings are collected from the whole body (a cast can sit above the selector that uses it) and the reads only
 * from the selectors, so a member that merely appears in an evidence string is not a decision read. A binding
 * counts only when the statement that produced it reads the LOCATION: a value taken out of the actor's pack
 * (`out Object? carried` from a pack search) is not the row's subject, and counting it would report a family for
 * a decision about something else.
 */
export function handlerFieldReads(sources, request) {
  const body = methodBody(sources, request);
  if (body === null) return { parsed: false, bindings: new Map(), members: [] };
  const bodies = [body];
  for (const name of new Set([...body.matchAll(/\b(Execute\w+)\s*\(/gu)].map((match) => match[1]))) {
    const inner = methodBody(sources, name);
    if (inner !== null) bodies.push(inner);
  }
  const bindings = new Map();
  for (const text of bodies) {
    // A pattern cast of a location-bound name is location-bound too (`feature is not HoeDirt dirt`), so the
    // set is grown until it stops growing.
    let grown = true;
    while (grown) {
      grown = false;
      for (const pattern of ENGINE_BINDING_PATTERNS)
        for (const match of text.matchAll(pattern)) {
          const type = ENGINE_TARGET_TYPES.includes(match[1]) ? match[1] : match[2];
          const name = ENGINE_TARGET_TYPES.includes(match[1]) ? match[2] : match[1];
          if (bindings.has(name)) continue;
          const boundary = Math.max(text.lastIndexOf(";", match.index), text.lastIndexOf("{", match.index), text.lastIndexOf("}", match.index));
          const statement = text.slice(boundary + 1, match.index);
          const root = /([A-Za-z_]\w*)\s*[!?]?\s*\.?[^.;]*$/u.exec(statement)?.[1];
          if (!LOCATION_RECEIVER.test(statement) && !(root !== undefined && bindings.has(root))) continue;
          bindings.set(name, type);
          grown = true;
        }
    }
  }
  const members = new Set();
  for (const text of bodies)
    for (const raw of decisionExpressions(text)) {
      // Identity arguments name the row the caller must echo; they are not a decision about its state.
      const expression = raw.replace(TARGET_ID_CALL, "BuildTargetId");
      for (const name of bindings.keys()) for (const member of membersReadThrough(expression, name)) members.add(member);
      for (const call of expression.matchAll(PRESENCE_NULL_TEST)) {
        const type = ENGINE_TARGET_TYPES.find((candidate) => call[1].includes(candidate));
        if (type !== undefined) members.add(type);
      }
    }
  return { parsed: true, bindings, members: [...members].sort() };
}

/**
 * Every published family's row type and its wire fields, resolved through the schema's own `$ref`.
 *
 * The family name is the schema's own camelCase key, so nothing here singularises a name by hand: `cropTargets`
 * names `$defs/cropTarget`, and that definition's `properties` ARE the fields the wire publishes.
 */
export function publishedRowFields(schema) {
  const definitions = schema?.$defs;
  const properties = definitions?.snapshot?.properties;
  if (properties === undefined) return new Map();
  const rows = new Map();
  for (const [family, declaration] of Object.entries(properties)) {
    const reference = declaration?.items?.$ref;
    if (typeof reference !== "string") continue;
    const definition = reference.slice(reference.lastIndexOf("/") + 1);
    const declared = definitions[definition];
    if (declared?.properties === undefined) continue;
    rows.set(family, { definition, fields: Object.keys(declared.properties) });
  }
  return rows;
}

/** The parameter names of the Mod's `record Bridge<Row>(...)`, or null when it declares no such record. */
export function modRowFields(models, definition) {
  const record = `Bridge${definition[0].toUpperCase()}${definition.slice(1)}`;
  const code = withoutComments(models);
  const declaration = new RegExp(`\\brecord\\s+${record}\\s*\\(`, "u").exec(code);
  if (declaration === null) return null;
  const open = code.indexOf("(", declaration.index + declaration[0].length - 1);
  const close = matchingBracket(code, open);
  if (close < 0) return null;
  return splitTopLevel(code.slice(open + 1, close))
    .map((parameter) => parameter.replace(/\[[^\]]*\]/gu, "").replace(/=[\s\S]*$/u, "").trim())
    .map((parameter) => /([A-Za-z_]\w*)\s*$/u.exec(parameter)?.[1] ?? null)
    .filter((name) => name !== null);
}

const lowerFirst = (name) => name[0].toLowerCase() + name.slice(1);

/**
 * The spellings a read member and a row field may share.
 *
 * `lowerFirst` is the serializer's own crossing. An ACCESSOR prefix is stripped when a capital letter follows it, which
 * is the convention every boolean predicate and every derived accessor in the engine already follows: `isWatered` ->
 * `watered` (`HoeDirt.isWatered()`), `IsWeeds` -> `weeds`, `GetHarvestMethod` -> `harvestMethod` (the engine's method
 * returns the `HarvestMethod` fact the row publishes), `GetMachineData` -> `machineData`. A word that merely starts with
 * those letters (`island`, `getaway`) is untouched, because the prefix only counts when a capital follows it.
 *
 * Stripping an accessor is not a looser test: the row still has to publish the field, and the field still has to be the
 * fact the branch consumes. It only stops the gate from asking a row to name itself after a C# call (`getHarvestMethod`)
 * when the engine has a word for the value (`harvestMethod`).
 */
function memberSpellings(member) {
  const spellings = new Set([lowerFirst(member)]);
  if (/^[Ii]s[A-Z]/u.test(member)) spellings.add(lowerFirst(member.slice(2)));
  if (/^[Gg]et[A-Z]/u.test(member)) spellings.add(lowerFirst(member.slice(3)));
  return spellings;
}

/**
 * Every action handler's decision reads, checked against the row its target family publishes.
 *
 * Pure over `sources`, `surface`, `models` and `schema`, so the falsifier suite can inject a handler that reads a
 * member its row does not carry instead of editing the real Mod.
 */
export function fieldLevelCoverage({
  sources,
  surface,
  models,
  schema,
  targetField = TARGET_FIELD,
  dispatch = handlerDispatch(sources),
}) {
  const rows = publishedRowFields(schema);
  const actions = new Map((surface?.actions ?? []).map((action) => [action.actionId, action]));
  const findings = [];
  const readings = [];
  const unparsed = [];
  const noFamily = [];
  const noRow = [];
  const checkedRows = new Set();
  for (const [actionId, request] of [...dispatch].sort(([left], [right]) => left.localeCompare(right))) {
    const read = handlerFieldReads(sources, request);
    if (!read.parsed || read.members.length === 0) {
      unparsed.push({
        actionId,
        reason: read.parsed
          ? read.bindings.size === 0
            ? "no_location_bound_engine_value"
            : "no_decision_read_through_a_location_bound_value"
          : "request_method_body_not_found",
      });
      continue;
    }
    const family = targetField[actionId] ?? actions.get(actionId)?.targetFamily ?? null;
    if (family === null) {
      noFamily.push(actionId);
      continue;
    }
    const key = lowerFirst(family);
    const row = rows.get(key);
    if (row === undefined) {
      noRow.push({ actionId, family: key });
      continue;
    }
    if (!checkedRows.has(key)) {
      checkedRows.add(key);
      const declared = modRowFields(models, row.definition);
      if (declared === null)
        findings.push({
          code: `field_row_missing_record:${key}`,
          kind: "field",
          id: null,
          detail: `${OBSERVATION_SCHEMA_PATH} publishes ${key} rows as Bridge${row.definition[0].toUpperCase()}${row.definition.slice(1)}, and ${OBSERVATION_MODELS_PATH} declares no such record`,
        });
      else {
        const wired = new Set(row.fields);
        const modded = new Set(declared.map(lowerFirst));
        const onlyWire = [...wired].filter((field) => !modded.has(field)).sort();
        const onlyMod = [...modded].filter((field) => !wired.has(field)).sort();
        if (onlyWire.length > 0 || onlyMod.length > 0)
          findings.push({
            code: `field_row_disagrees:${key}`,
            kind: "field",
            id: null,
            detail: `${key} rows differ between the wire and the Mod's record: only in ${OBSERVATION_SCHEMA_PATH} [${onlyWire.join(", ")}], only in the record [${onlyMod.join(", ")}]`,
          });
      }
    }
    const members = read.members.map((member) => {
      const spellings = memberSpellings(member);
      const field = row.fields.find((candidate) => spellings.has(candidate)) ?? null;
      return { member, field, carried: field !== null, id: `${actionId}:${member}:${key}` };
    });
    readings.push({ actionId, family: key, row: row.definition, members });
  }
  const all = readings.flatMap((reading) => reading.members);
  return {
    handlers: dispatch.size,
    rows: readings,
    unparsed: unparsed.sort((left, right) => left.actionId.localeCompare(right.actionId)),
    noFamily: noFamily.sort(),
    noRow,
    findings,
    counts: {
      readMembers: all.length,
      carried: all.filter((member) => member.carried).length,
      absent: all.filter((member) => !member.carried).length,
      unparsed: unparsed.length,
      noFamily: noFamily.length,
      noRow: noRow.length,
      handlersWithReads: readings.length,
    },
  };
}

/** The baseline as six lookup tables, plus the findings that make it self-maintaining. */
export function readObservationBaseline(baseline) {
  const findings = [];
  const entries = new Map();
  const kinds = new Set(["collection", "channel", "addressability", "mutation", "gating", "quadrant", "field"]);
  for (const entry of baseline?.entries ?? []) {
    if (!kinds.has(entry?.kind) || typeof entry?.id !== "string" || entry.id.length === 0)
      findings.push({
        code: `baseline_entry_invalid:${entry?.kind ?? "unknown"}:${entry?.id ?? "unknown"}`,
        kind: entry?.kind ?? "unknown",
        id: entry?.id ?? "unknown",
        detail: "a baseline entry needs kind (collection|channel|addressability|mutation|gating|quadrant), id and reason",
      });
    else if (typeof entry.reason !== "string" || entry.reason.trim().length === 0)
      findings.push({
        code: `baseline_entry_unexplained:${entry.kind}:${entry.id}`,
        kind: entry.kind,
        id: entry.id,
        detail: `${entry.kind} ${entry.id} is baselined with no reason; a silent exception is not a ratchet`,
      });
    else entries.set(`${entry.kind}:${entry.id}`, entry.reason);
  }
  return { entries, findings };
}

function findDecompiledSource(root, name) {
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.name === name) return absolute;
    }
  }
  return null;
}

/** The decompiled sources the six sections read, resolved through the shared fail-closed guard. */
export function loadDecompiledSources({ sourceRoot } = {}) {
  const root = resolveStardewDecompileRoot({ repositoryRoot: REPOSITORY_ROOT, root: sourceRoot });
  const decompiled = {};
  for (const name of new Set(TILE_CHANNELS.map((channel) => channel.engine.file).concat(["GameLocation.cs", "Farmer.cs", "Game1.cs"]))) {
    const file = findDecompiledSource(root, name);
    if (file === null) throw new Error(`stardew_observation_decompiled_source_missing:${name}:${root}`);
    decompiled[name] = readFileSync(file, "utf8");
  }
  return decompiled;
}

/**
 * The whole observation-gap report: eight sections, one finding list, one ratchet.
 *
 * Pure over its inputs so the falsifier suite can inject a Mod that reads `location.objects` but not
 * `location.furniture` instead of editing the real tree.
 */
export function observeActionGaps({
  sources = readModSources(),
  decompiled = loadDecompiledSources(),
  collectionTypes = loadEngineCollectionTypeNames(),
  surface = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, OBSERVATION_SURFACE_PATH), "utf8")),
  models = readFileSync(path.join(REPOSITORY_ROOT, OBSERVATION_MODELS_PATH), "utf8"),
  schema = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, OBSERVATION_SCHEMA_PATH), "utf8")),
  baseline = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, OBSERVATION_BASELINE_PATH), "utf8")),
  targetField = TARGET_FIELD,
  channels = TILE_CHANNELS,
  consumption = loadConsumptionSources(),
} = {}) {
  const ratified = readObservationBaseline(baseline);
  const findings = [...ratified.findings];
  const excused = (kind, id) => ratified.entries.has(`${kind}:${id}`);

  // A - collections
  const population = locationCollectionPopulation({
    gameLocation: decompiled["GameLocation.cs"],
    farmer: decompiled["Farmer.cs"],
    game1: decompiled["Game1.cs"],
    collectionTypes,
  });
  const collectionRows = collectionCoverage({ discoveries: parseDiscoveries(sources), population });
  for (const row of collectionRows)
    if (row.readBy === 0 && !excused("collection", row.id))
      findings.push({
        code: `collection_never_read:${row.id}`,
        kind: "collection",
        id: row.id,
        detail: `\`${row.id}\` (${row.type} at ${row.evidence}) is a public engine collection and no Discover* reads it; either a family is invisible or the collection belongs in the baseline with its reason`,
      });
  for (const row of collectionRows)
    if (row.readBy > 0 && excused("collection", row.id))
      findings.push({
        code: `stale_baseline_entry:collection:${row.id}`,
        kind: "collection",
        id: row.id,
        detail: `${row.id} is now read by ${row.readers.slice(0, 3).join(", ")}; delete its baseline entry`,
      });

  // B - tile channels
  const channelCoverage = tileChannelCoverage({ sources, decompiled, channels });
  findings.push(...channelCoverage.findings);
  for (const row of channelCoverage.rows) {
    if (row.readBy === 0 && !excused("channel", row.id))
      findings.push({
        code: `tile_channel_never_read:${row.id}`,
        kind: "channel",
        id: row.id,
        detail: `no Mod source reads the ${row.id} tile channel (${row.engineSite}); whatever the engine dispatches there is invisible to the snapshot`,
      });
    if (row.readBy > 0 && excused("channel", row.id))
      findings.push({
        code: `stale_baseline_entry:channel:${row.id}`,
        kind: "channel",
        id: row.id,
        detail: `${row.id} is now read by ${row.readers.slice(0, 3).join(", ")}; delete its baseline entry`,
      });
  }

  // C - action addressability
  const published = publishedSnapshotSurface(models);
  const publishedFamilies = new Set(published.families.map((family) => family.field.toLowerCase()));
  const addressability = addressabilityCoverage({ surface, targetField, published: publishedFamilies });
  for (const finding of addressability.findings)
    if (!excused("addressability", finding.id)) findings.push(finding);
  for (const row of addressability.rows)
    if (row.family !== null && excused("addressability", row.actionId))
      findings.push({
        code: `stale_baseline_entry:addressability:${row.actionId}`,
        kind: "addressability",
        id: row.actionId,
        detail: `${row.actionId} now names ${row.family}; delete its baseline entry`,
      });

  // D - postcondition observability
  const dispatch = handlerDispatch(sources);
  const mutations = postconditionMutationCoverage({
    sources,
    vocabulary: published.vocabulary,
    fields: published.fields,
    dispatch,
  });
  for (const mutation of mutations)
    if (!mutation.published && !excused("mutation", mutation.id))
      findings.push({
        code: `mutation_not_observable:${mutation.id}`,
        kind: "mutation",
        id: mutation.id,
        detail: `${mutation.actionId} assigns \`${mutation.receivers[0]}.${mutation.member}\`, and no published snapshot field carries \`${mutation.member}\``,
      });
  for (const id of ratified.entries.keys()) {
    if (!id.startsWith("mutation:")) continue;
    const mutationId = id.slice("mutation:".length);
    const mutation = mutations.find((entry) => entry.id === mutationId);
    if (mutation === undefined)
      findings.push({
        code: `stale_baseline_entry:mutation:${mutationId}`,
        kind: "mutation",
        id: mutationId,
        detail: `no handler assigns \`${mutationId.split(":")[1]}\` for \`${mutationId.split(":")[0]}\` any more; delete its baseline entry`,
      });
    else if (mutation.published)
      findings.push({
        code: `stale_baseline_entry:mutation:${mutationId}`,
        kind: "mutation",
        id: mutationId,
        detail: `\`${mutation.member}\` is published now; delete its baseline entry`,
      });
  }
  // E - publication gating
  const parameters = snapshotParameterOrder(models);
  const gateScan = publicationGates({
    sources,
    parameters,
    discoveryRows: new Map(parseDiscoveries(sources).map((discovery) => [discovery.name, discovery.row])),
  });
  findings.push(...gateScan.findings);
  const gating = publicationGateCoverage({ gates: gateScan.gates, targetField });
  for (const finding of gating.findings) if (!excused("gating", finding.id)) findings.push(finding);
  const measuredGatingGaps = new Set(gating.rows.flatMap((row) => row.missing.map((action) => `${row.family}:${action}`)));
  for (const id of ratified.entries.keys()) {
    if (!id.startsWith("gating:")) continue;
    const gap = id.slice("gating:".length);
    if (measuredGatingGaps.has(gap)) continue;
    findings.push({
      code: `stale_baseline_entry:gating:${gap}`,
      kind: "gating",
      id: gap,
      detail: `${gap.split(":")[1]} is admitted by the gate that publishes ${gap.split(":")[0]} now, or that gate is gone; delete its baseline entry`,
    });
  }
  // F - consumption
  const publishedParameters = parameters.filter((parameter) => parameter.row !== null);
  const consumptionRows = consumptionCoverage({
    families: publishedParameters.map((parameter) => parameter.name),
    ...consumption,
    targetField,
  });
  findings.push(...consumptionRows.findings);

  // G - quadrants
  const quadrantScan = observationQuadrants({
    families: publishedParameters,
    discoveries: parseDiscoveries(sources),
    bodies: modMethodBodies(sources),
    hudFields: hudFieldKeys(consumption.hud),
    targetField,
  });
  for (const finding of quadrantScan.findings) if (!excused("quadrant", finding.id)) findings.push(finding);
  const quadrantRows = new Map(quadrantScan.rows.map((row) => [row.family, row]));
  let quadrantBaselined = 0;
  for (const id of ratified.entries.keys()) {
    if (!id.startsWith("quadrant:")) continue;
    const family = id.slice("quadrant:".length);
    const row = quadrantRows.get(family);
    if (row === undefined) continue;
    if (row.quadrant === "map_fixed" && row.targeted && !row.hud) {
      quadrantBaselined += 1;
      continue;
    }
    findings.push({
      code: `stale_baseline_entry:quadrant:${family}`,
      kind: "quadrant",
      id: family,
      detail: row.hud
        ? `${family} is read by a line in ${SNAPSHOT_HUD_PATH} now; delete its baseline entry`
        : `${family} is ${row.quadrant}${row.targeted ? "" : " and untargeted"} now, so it is not a quadrant error; delete its baseline entry`,
    });
  }
  // H - field-level coverage
  const fieldScan = fieldLevelCoverage({ sources, surface, models, schema, targetField, dispatch });
  findings.push(...fieldScan.findings);
  const fieldReadings = new Map(fieldScan.rows.flatMap((row) => row.members.map((member) => [member.id, member])));
  let fieldBaselined = 0;
  for (const member of fieldReadings.values()) {
    if (member.carried) continue;
    if (excused("field", member.id)) {
      fieldBaselined += 1;
      continue;
    }
    const [actionId, memberName, family] = member.id.split(":");
    findings.push({
      code: `field_unobservable:${member.id}`,
      kind: "field",
      id: member.id,
      detail: `${actionId} reads \`${memberName}\` to decide, and the ${family} row publishes no such field: the fact the action exists for is not on the row it is handed`,
    });
  }
  for (const id of ratified.entries.keys()) {
    if (!id.startsWith("field:")) continue;
    const gap = id.slice("field:".length);
    const member = fieldReadings.get(gap);
    if (member !== undefined && !member.carried) continue;
    findings.push({
      code: `stale_baseline_entry:field:${gap}`,
      kind: "field",
      id: gap,
      detail:
        member === undefined
          ? `${gap} is no longer a read no published row carries (the handler, the member or the family is gone); delete its baseline entry`
          : `the ${gap.split(":")[2]} row carries \`${gap.split(":")[1]}\` now; delete its baseline entry`,
    });
  }
  for (const id of ratified.entries.keys()) {
    const kind = id.slice(0, id.indexOf(":"));
    const subject = id.slice(id.indexOf(":") + 1);
    const known =
      (kind === "collection" && collectionRows.some((row) => row.id === subject)) ||
      (kind === "channel" && channelCoverage.rows.some((row) => row.id === subject)) ||
      (kind === "addressability" && addressability.rows.some((row) => row.actionId === subject)) ||
      (kind === "gating" && gating.rows.some((row) => subject.startsWith(`${row.family}:`))) ||
      (kind === "quadrant" && quadrantRows.has(subject)) ||
      (kind === "field" && fieldReadings.has(subject)) ||
      kind === "mutation";
    if (!known)
      findings.push({
        code: `baseline_entry_unknown_subject:${kind}:${subject}`,
        kind,
        id: subject,
        detail: `the baseline names ${subject} as a ${kind}, and this run measured no such ${kind}; a ratchet entry that names nothing excuses nothing`,
      });
  }

  const ungranted = findings;
  return {
    schema: "gamebuddy-stardew-observation-gap/v1",
    collections: {
      population: collectionRows.map((row) => row.id),
      read: collectionRows.filter((row) => row.readBy > 0).map((row) => row.id),
      neverRead: collectionRows.filter((row) => row.readBy === 0).map((row) => row.id),
      rows: collectionRows,
    },
    tileChannels: {
      channels: channelCoverage.rows,
      neverRead: channelCoverage.rows.filter((row) => row.readBy === 0).map((row) => row.id),
    },
    addressability: {
      targetBearingActions: addressability.rows.length,
      withoutFamily: addressability.rows.filter((row) => row.family === null).map((row) => row.actionId),
      rows: addressability.rows,
    },
    postconditionMutations: {
      handlers: dispatch.size,
      rowVocabulary: published.vocabulary.size,
      mutations,
      notObservable: mutations.filter((mutation) => !mutation.published).map((mutation) => mutation.id),
    },
    publicationGating: {
      gates: gateScan.gates,
      families: gating.rows,
      gatedOff: gating.findings.map((finding) => finding.id),
    },
    consumption: {
      population: consumptionRows.rows.length,
      rows: consumptionRows.rows,
      withoutConsumer: consumptionRows.rows.filter((row) => !row.consumed).map((row) => row.family),
      unclassified: consumptionRows.unclassified,
    },
    quadrant: {
      population: quadrantScan.rows.length,
      rows: quadrantScan.rows,
      mapFixed: quadrantScan.rows.filter((row) => row.quadrant === "map_fixed").map((row) => row.family),
      actorOwned: quadrantScan.rows.filter((row) => row.quadrant === "actor_owned").map((row) => row.family),
      undeclared: quadrantScan.rows.filter((row) => row.quadrant === "undeclared").map((row) => row.family),
      counts: {
        local: quadrantScan.counts.local,
        mapFixed: quadrantScan.counts.mapFixed,
        actorOwned: quadrantScan.counts.actorOwned,
        undeclared: quadrantScan.counts.undeclared,
        mapFixedUntargeted: quadrantScan.counts.mapFixedUntargeted,
        red: quadrantScan.counts.red,
        baselined: quadrantBaselined,
        ungranted: quadrantScan.findings.filter((finding) => !excused("quadrant", finding.id)).length,
      },
    },
    fieldLevel: {
      handlers: fieldScan.handlers,
      handlersWithReads: fieldScan.counts.handlersWithReads,
      rows: fieldScan.rows,
      unparsed: fieldScan.unparsed,
      noFamily: fieldScan.noFamily,
      noRow: fieldScan.noRow,
      counts: {
        readMembers: fieldScan.counts.readMembers,
        carried: fieldScan.counts.carried,
        absent: fieldScan.counts.absent,
        red: fieldScan.counts.absent - fieldBaselined,
        baselined: fieldBaselined,
      },
    },
    baseline: { entries: ratified.entries.size, path: OBSERVATION_BASELINE_PATH },
    findings,
    ungranted,
    ok: ungranted.length === 0,
  };
}

// ---------------------------------------------------------------------------
// 输入契约
// ---------------------------------------------------------------------------

/**
 * 方法层的分档只存在于 remaining report 产物里（`tiers` + `counts.unmatchedCandidateUnits`）。
 * 传 candidates artifact 会在 `Object.entries(undefined)` 处抛一个无信息的 TypeError，
 * 所以这里先做形状检查并给出具名错误码。
 */
export function assertRemainingReport(value, sourceLabel = "input") {
  if (value === null || typeof value !== "object")
    throw new Error(`remaining_report_invalid:${sourceLabel}:not_an_object`);
  if (value.artifactKind === "stardew_action_candidate_derivation")
    throw new Error(
      `input_is_candidates_artifact_not_remaining_report:${sourceLabel}:run stardew-remaining-actions-report.mjs on this file first`,
    );
  if (value.tiers === undefined || value.tiers === null)
    throw new Error(`input_is_candidates_artifact_not_remaining_report:${sourceLabel}:missing_tiers`);
  for (const tier of ["A_catalog_intent_exists", "B_no_catalog_intent", "C_non_gameplay_writes"])
    if (!Array.isArray(value.tiers[tier]))
      throw new Error(`remaining_report_invalid:${sourceLabel}:missing_tier_${tier}`);
  if (typeof value.counts?.unmatchedCandidateUnits !== "number")
    throw new Error(`remaining_report_invalid:${sourceLabel}:missing_unmatchedCandidateUnits`);
  return value;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fail(code, message) {
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
}

/**
 * CLI 参数。`--remaining` 是正确名字（输入是 remaining report）。`--candidates` 是本
 * 工具最初的名字，保留为接受别名，让已写下的复现命令继续可用；两个名字映射到同一
 * 槽位，真正把关的是 `assertRemainingReport`（无论从哪个名字进来都会查形状），
 * 因此别名不会让 candidates artifact 蒙混过关。
 */
function parseArgs(argv) {
  const out = { pretty: false, failOnUngranted: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--pretty") {
      out.pretty = true;
      continue;
    }
    if (a === "--fail-on-ungranted") {
      out.failOnUngranted = true;
      continue;
    }
    if (!["--source-root", "--action-register", "--remaining", "--candidates", "--catalog", "--method-resolution", "--out"].includes(a))
      fail("arguments_invalid", `Bad argument ${a}.`);
    const v = argv[++i];
    if (!v) fail("arguments_invalid", `Missing value for ${a}.`);
    if (a === "--candidates" || a === "--remaining") {
      if (out.remaining !== undefined && out.remaining !== v)
        fail("arguments_invalid", "--remaining and --candidates were both given with different values.");
      out.remaining = v;
      continue;
    }
    out[a.slice(2)] = v;
  }
  for (const r of ["source-root", "action-register", "remaining", "catalog"])
    if (!out[r])
      fail(
        "arguments_required",
        `--${r === "remaining" ? "remaining" : r} is required (--remaining takes the stardew-remaining-actions-report output, not the candidates artifact).`,
      );
  return out;
}

/**
 * The human-readable half of the one report: one line per section, and every ungranted gap by name.
 *
 * It goes to stderr so the JSON on stdout stays a single parseable document for existing consumers,
 * and it is printed from the SAME run that produced that JSON - never as a second opinion.
 */
export function writeObservationSummary(observation, write = (text) => process.stderr.write(text)) {
  write(`observation gaps: ${observation.collections.population.length} engine collections\n`);
  write(
    `  A collections       ${observation.collections.read.length} read, ${observation.collections.neverRead.length} never read${
      observation.collections.neverRead.length > 0 ? ` (${observation.collections.neverRead.join(", ")})` : ""
    }\n`,
  );
  write(
    `  B tile channels     ${observation.tileChannels.channels.filter((row) => row.readBy > 0).length} read, ${
      observation.tileChannels.neverRead.length
    } never read${observation.tileChannels.neverRead.length > 0 ? ` (${observation.tileChannels.neverRead.join(", ")})` : ""}\n`,
  );
  write(
    `  C addressability    ${observation.addressability.targetBearingActions} target-bearing actions, ${observation.addressability.withoutFamily.length} without a published family\n`,
  );
  write(
    `  D postconditions    ${observation.postconditionMutations.handlers} handlers, ${observation.postconditionMutations.mutations.length} mutation pairs, ${observation.postconditionMutations.notObservable.length} unexplained (${observation.baseline.entries} baselined)\n`,
  );
  write(
    `  E publication       ${observation.publicationGating.gates.length} advertisement gates over ${observation.publicationGating.families.length} families, ${observation.publicationGating.gatedOff.length} family/action pair(s) gated off\n`,
  );
  const consumption = observation.consumption;
  write(
    `  F consumption       ${consumption.population} published families: ${consumption.rows.filter((row) => row.projections.length > 0).length} read by a projection, ${consumption.rows.filter((row) => row.hud).length} by a HUD line, ${consumption.rows.filter((row) => row.toolDescription).length} named in a tool description; ${consumption.withoutConsumer.length} with no consumer${consumption.withoutConsumer.length > 0 ? ` (${consumption.withoutConsumer.join(", ")})` : ""}, ${consumption.unclassified.length} unclassified by ${CONSUMPTION_INVENTORY_PATH}\n`,
  );
  write(
    "    on-demand delivery is not a gap: the per-turn projection cap and the 'projected or explained' inventory are the delivery-policy authority, so the advisory count is not a to-do list and rising is not a regression by itself\n",
  );
  const quadrant = observation.quadrant.counts;
  // The names, not only the count: a summary that says "3 undeclared" sends the reader to the artifact to find out
  // WHICH three, and a family nobody classified is exactly the fact this line exists to surface.
  const undeclared = observation.quadrant.undeclared;
  write(
    `  G quadrants         ${quadrant.local} local, ${quadrant.mapFixed} map-fixed (${quadrant.mapFixedUntargeted} untargeted), ${quadrant.actorOwned} actor-owned, ${quadrant.undeclared} undeclared${
      undeclared.length > 0 ? ` (${undeclared.join(", ")})` : ""
    }: ${quadrant.red} map-fixed family/action pair(s) with no per-turn line, ${quadrant.baselined} baselined with a reason, ${quadrant.ungranted} ungranted\n`,
  );
  write(
    "    a map-fixed family an action targets and no HUD line reads is a quadrant error: the model spends an observe on a fact that does not move, in the one place a line could have said it\n",
  );
  const fields = observation.fieldLevel;
  write(
    `  H field coverage    read ${fields.counts.readMembers} members across ${fields.handlersWithReads} handlers; carried ${fields.counts.carried}; absent ${fields.counts.absent} (${fields.counts.red} red, ${fields.counts.baselined} baselined); unparsed ${fields.unparsed.length}, no family ${fields.noFamily.length}, no schema row ${fields.noRow.length}\n`,
  );
  write(
    "    a member a handler decides from must be a field of the row its target family publishes; member extraction is heuristic, which is why the unparsed count is printed beside the verdicts\n",
  );
  for (const finding of observation.findings) write(`  ${finding.code}: ${finding.detail}\n`);
  write(
    observation.ok
      ? "  green: every engine collection, tile channel, action target and handler mutation is published or recorded\n"
      : `  ${observation.ungranted.length} ungranted observation gap(s)\n`,
  );
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directRun) {
  const options = parseArgs(process.argv.slice(2));
  try {
    const [remainingReport, register, catalog] = await Promise.all(
      [options.remaining, options["action-register"], options.catalog].map(async (p) => JSON.parse(await readFile(p, "utf8"))),
    );
    assertRemainingReport(remainingReport, options.remaining);
    const methodResolution = options["method-resolution"]
      ? JSON.parse(await readFile(options["method-resolution"], "utf8"))
      : null;
    const parser = await createSelectorParser();
    const selectorArtifact = await analyzeTileActionSelectorTree({ sourceRoot: options["source-root"], parser });
    // Both inputs are resolved from the SAME `--source-root`: the type index that decides whether a member
    // is a collection and the sources the members are declared in must come from one tree.
    const observation = observeActionGaps({
      decompiled: loadDecompiledSources({ sourceRoot: options["source-root"] }),
      collectionTypes: loadEngineCollectionTypeNames({ sourceRoot: options["source-root"] }),
    });
    const artifact = reconcile({ selectorArtifact, remainingReport, register, catalog, methodResolution, observation });
    const serialized = `${JSON.stringify(artifact, null, options.pretty ? 2 : 0)}\n`;
    if (options.out) {
      await writeFile(options.out, serialized);
      process.stdout.write(`${JSON.stringify({ state: "written", out: options.out, ...artifact.counts })}\n`);
    } else process.stdout.write(serialized);
    writeObservationSummary(observation);
    if (options.failOnUngranted && !observation.ok) process.exitCode = 1;
  } catch (error) {
    fail(error.code ?? "action_inventory_reconciliation_failed", error.message);
  }
}
