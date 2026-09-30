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
 *     --catalog <catalog.json> [--out <file>] [--pretty]
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

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTileActionSelectorTree, createSelectorParser } from "./stardew-tile-action-selectors.mjs";

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
    boundary: "B1_menu_owned_transaction",
    reason: "terminal is a game-owned menu; the transaction only exists inside the menu, so binding it would require menu-stack or input ingress",
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
 * B5 不是 UI 边界，而是「没有可绑定的世界效果」这个单独的排除理由（空壳 / 仅音效）。
 */
export const UI_INPUT_BOUNDARIES = Object.freeze({
  B1_menu_owned_transaction:
    "menu-owned transaction: the native settlement only exists inside a menu input handler (ShopMenu.tryToPurchaseItem, MuseumMenu, SpecialOrdersBoard/DropBox, MineElevatorMenu level pick, ActivateKitchen/CraftingPage, BobberBar reeling)",
  B2_input_edge_gated_branch:
    "input-edge gated branch: the native branch requires a real mouse/keyboard edge (Game1.didPlayerJustRightClick) that the companion cannot manufacture without input injection",
  B3_subjective_text_input: "subjective text input (NamingMenu naming, free dialogue text)",
  B4_realtime_minigame: "real-time minigame / reeling contest (MiniGames, festival minigames, fishing reel)",
  B5_no_effect: "no bound effect (empty selector shell, sound-only selector)",
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
  // ---- 新 primitive（方法层看不到的 selector 级发现）-----------------------
  Lamp: {
    at: "GameLocation",
    group: "new_primitive_needed",
    actionId: "toggle_mine_lamp",
    reason: "deterministic lightLevel.Value 0 <-> 0.6 toggle; no menu, no dialogue, no RNG; the nine predicates reject it because the branch has no write the predicate sees as a world terminal of the whole method",
    anchor: "GameLocation.cs:9776",
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
  BuildingSilo: {
    at: "GameLocation",
    group: "new_primitive_needed",
    actionId: "deposit_silo_hay",
    reason: "deterministic consume of held (O)178 + tryToAddHay into the building silo; carries a dialogue branch for the non-hay path, which is why the signal classifier reads it as dialogue-bound",
    anchor: "GameLocation.cs:10150",
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
  ObeliskWarp: {
    at: "GameLocation",
    group: "merge_into_existing",
    actionIds: ["travel", "enter_exit"],
    reason: "Building.PerformObeliskWarp is a public UI-free warp helper whose terminal is Game1.warpFarmer / obeliskWarpForReal",
    anchor: "GameLocation.cs:9036 -> Building.cs:1030",
  },
  FarmObelisk: {
    at: "IslandWest",
    group: "merge_into_existing",
    actionIds: ["travel", "enter_exit"],
    reason: "same farm-obelisk warp intent on IslandWest; terminal Game1.warpFarmer after a fade",
    anchor: "IslandWest.cs:186",
  },

  // ---- 待裁定（selector 层暴露的新问题，每项一个问题）-------------------
  BuildingChest: {
    at: "GameLocation",
    group: "needs_adjudication",
    question:
      "Building.PerformBuildingChestAction has a Chest branch that opens ItemGrabMenu and a Load branch that converts depot items with no menu; does the Load branch's transaction equal the ordinary chest store/retrieve transaction (target extension) or is it a separate primitive?",
    anchor: "GameLocation.cs:10128 -> Building.cs:746",
  },
  SpiritAltar: {
    at: "GameLocation",
    group: "needs_adjudication",
    question:
      "4.4 excluded the 14 predicate-passing buckets as mail/quest-gated content, but SpiritAltar's body gates only on sharedDailyLuck != +-0.12 and held-item price, then writes Game1.player.team.sharedDailyLuck.Value deterministically; is this a player operation (new primitive) or content?",
    anchor: "GameLocation.cs:9972",
  },
  MineElevator: {
    at: "GameLocation",
    group: "needs_adjudication",
    question:
      "MinecartTransport became a real action because its payload MinecartWarp is a public non-menu method; MineElevator's level pick only exists inside MineElevatorMenu.receiveLeftClick (a menu input handler), so the same precedent does not obviously apply. Does floor selection get a primitive (as archived M8 `select_mine_elevator_floor` implied) or is it B1?",
    anchor: "GameLocation.cs:9797 -> MineElevatorMenu.cs receiveLeftClick",
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
  Gunther: plainContent("OpenGuntherDialogueMenu + DataLoader.MuseumRewards", "LibraryMuseum.cs:240"),
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
  BuildingToggleAnimalDoor: {
    at: "GameLocation",
    group: "explicit_exclusion",
    boundary: "B2_input_edge_gated_branch",
    reason: "the branch only calls buildingAt.ToggleAnimalDoor when Game1.didPlayerJustRightClick(ignoreNonMouseHeldInput: true) is true",
    anchor: "GameLocation.cs:10137",
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
  "Game1.warpFarmer@9788": merge(["enter_exit"], "same Farmer.warpFarmer transition", "4.3"),
  "GameServer.warpFarmer@673": merge(["enter_exit"], "multiplayer-authoritative copy of the same warp transition", "4.3"),
  "NPC.checkAction@2464": merge(["interact_npc_with_item"], "gift branch routes into tryToReceiveActiveObject -> receiveGift", "4.3"),
  "ShippingBin.shipItem@158": merge(["ship_item"], "private shipItem is the shipping transaction; Farm.shipItem is registered", "4.3"),
  "ShippingBin.leftClicked@182": merge(["ship_item"], "menu-free shipping entry point", "4.3"),
  "FarmHouse.checkAction@696": implemented("chest_store/chest_retrieve fridge target extension (live 2026-09-28)", "4.3"),
  "IslandFarmHouse.checkAction@199": implemented("chest_store/chest_retrieve fridge target extension (live 2026-09-28)", "4.3"),
  "IslandWest.leftClick@235": implemented("ship_item island bin target extension (live 2026-09-28)", "4.3"),
  "PetBowl.performToolAction@81": implemented("water_pet_bowl (live 2026-09-28)", "4.3"),
  "SlimeHutch.performToolAction@154": implemented("water_slime_hutch_trough (live 2026-09-28)", "4.3"),
  "Horse.checkAction@599": newPrimitive("mount_transport", "mount/dismount/hat/carrot horse interaction", "Horse.cs:599", "4.3"),
  "Cask.performToolAction@41": newPrimitive("clear_cask", "heavy-hitter strike drops heldObject", "Cask.cs:41", "4.3"),
  "Mannequin.performToolAction@358": newPrimitive("dress_mannequin", "place/dress/undress are the same intent", "Mannequin.cs:358", "4.3"),
  "Mannequin.checkForAction@400": newPrimitive("dress_mannequin", "same intent (cursed <0.001 branch counted here)", "Mannequin.cs:400", "4.3"),
  "Mannequin.performObjectDropInAction@436": newPrimitive("dress_mannequin", "same intent", "Mannequin.cs:436", "4.3"),
  "Sign.checkForAction@49": newPrimitive("set_sign_display", "displayItem.Value = currentItem.getOne()", "Sign.cs:49", "4.3"),
  "Lantern.DoFunction@36": newPrimitive("toggle_tool_light", "on = !on; remove/AddLightSource", "Lantern.cs:36", "4.3"),
  "Raft.DoFunction@29": newPrimitive("use_raft", "who.isRafting = true; water-tile move", "Raft.cs:29", "4.3"),
  "Child.checkAction@737": pending(
    "hat swap + talkToFriend + doEmote mixed; whether it is an independent action depends on dress-up vs social product intent",
    "Child.cs:737",
  ),
  "JojaMart.checkAction@61": pending(
    "Morris dialogue answerQuestionBehavior; only becomes an action after the event trigger is verified",
    "JojaMart.cs:61",
  ),
  "IslandEast.performAction@290": contentFromSelector("selector `BananaShrine`: banana offering -> event", "4.4"),
  "IslandSecret.performAction@145": contentFromSelector("selector `BananaShrine`: shrine animation + reduceActiveItemByOne", "4.4"),
  "IslandSouthEastCave.performAction@124": contentFromSelector("selector `Bartender`/`DartsGame`: story dialogue", "4.4"),
  "IslandWestCave1.performAction@212": contentFromSelector("selector `Crystal`/`CrystalCaveActivate`: netPhase state machine", "4.4"),
  "IslandSecret.checkAction@112": contentFromSelector("birdieQuestBegun/Finished quest line + Event", "4.4"),
  "MineShaft.checkAction@3053": contentFromSelector(
    "calico statue: the real effect is in the fieldChangeEvent callback with Utility.CreateDaySaveRandom",
    "4.4",
  ),
  "Railroad.checkAction@130": contentFromSelector("witchStatueGone + xPeriodic animation", "4.4"),
  "GameLocation.performAction@8695": {
    group: "decomposed_by_selector_layer",
    reason: "the whole map Action interpreter; its 155 selectors carry the verdict for this unit (see selectorLayer groups)",
    anchor: "GameLocation.cs:8695",
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

const memberOf = (signature) => {
  const p = signature.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
  return p ? p[p.length - 1].replace(/\s*\($/, "") : signature.trim().split(/\s+/).pop();
};

function registeredSeamMembers(register) {
  const map = new Map();
  for (const action of register.actions)
    for (const seam of action.seams ?? []) {
      if (seam.kind !== "native") continue;
      const m = memberOf(seam.signature);
      if (!map.has(m)) map.set(m, new Set());
      map.get(m).add(action.actionId);
    }
  return map;
}

function seamJoin(selector, seamMembers) {
  const hits = [];
  const consider = (text) => {
    const m = memberOf(text);
    if (seamMembers.has(m)) hits.push({ via: text, actionIds: [...seamMembers.get(m)].sort() });
  };
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

export function reconcile({ selectorArtifact, remainingReport, register, catalog, rules }) {
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

  // 参照列：A / C 档不参与计数（A 有 catalog intent，C 只有视觉/计时器写入）
  const referenceTiers = remainingReport.tiers;

  // ---- 合并计数 -----------------------------------------------------------
  const selectorGroups = groupRows(selectorRows);
  const methodGroups = groupRows(methodRows);
  const intentIds = (groups, kind) =>
    [...new Set(groups[kind].flatMap((r) => r.actionIds.filter((id) => !registeredActionIds.has(id))))].sort();

  const newPrimitiveIntents = [...new Set([...intentIds(selectorGroups, "new_primitive_needed"), ...intentIds(methodGroups, "new_primitive_needed")])].sort();
  const pendingItems = [...selectorGroups.needs_adjudication, ...methodGroups.needs_adjudication];

  /** 归并行的门禁标注：`merge_into_existing` 只说意图相同，不说门禁等价。 */
  const gatingAnnotations = [...selectorGroups.merge_into_existing, ...methodGroups.merge_into_existing]
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
      newPrimitiveIntents: newPrimitiveIntents.length,
      pendingAdjudicationItems: pendingItems.length,
      upperBoundIfAllPendingBecomePrimitives: newPrimitiveIntents.length + pendingItems.length,
      newPrimitivesRequired: newPrimitiveIntents.length,
    },
    newPrimitiveIntents,
    gatingAnnotations,
    groups: { selectorLayer: selectorGroups, methodLayer: methodGroups },
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
  return result;
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
  const out = { pretty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--pretty") {
      out.pretty = true;
      continue;
    }
    if (!["--source-root", "--action-register", "--remaining", "--candidates", "--catalog", "--out"].includes(a))
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

const directRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directRun) {
  const options = parseArgs(process.argv.slice(2));
  try {
    const [remainingReport, register, catalog] = await Promise.all(
      [options.remaining, options["action-register"], options.catalog].map(async (p) => JSON.parse(await readFile(p, "utf8"))),
    );
    assertRemainingReport(remainingReport, options.remaining);
    const parser = await createSelectorParser();
    const selectorArtifact = await analyzeTileActionSelectorTree({ sourceRoot: options["source-root"], parser });
    const artifact = reconcile({ selectorArtifact, remainingReport, register, catalog });
    const serialized = `${JSON.stringify(artifact, null, options.pretty ? 2 : 0)}\n`;
    if (options.out) {
      await writeFile(options.out, serialized);
      process.stdout.write(`${JSON.stringify({ state: "written", out: options.out, ...artifact.counts })}\n`);
    } else process.stdout.write(serialized);
  } catch (error) {
    fail(error.code ?? "action_inventory_reconciliation_failed", error.message);
  }
}
