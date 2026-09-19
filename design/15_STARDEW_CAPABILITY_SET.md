# 15 Stardew 最小玩法 Capability Set

> **范围**：Stardew Valley `1.6.15` / build `24356`、受支持 hosted multiplayer、独立原生 AI Farmhand、vanilla 正常游戏规则。
> **状态**：已接受的能力集合设计；不是 runtime registry、实现清单、权限来源或全玩法已验证声明。
> **前置阅读**：[00_CORE_PRODUCT](00_CORE_PRODUCT.md)、[11 Gameplay Capability Coverage](11_GAMEPLAY_CAPABILITY_COVERAGE.md)、[12 Primitive Action Basis](12_STARDEW_PRIMITIVE_ACTION_BASIS.md)、[13 Native Provenance](13_STARDEW_NATIVE_PROVENANCE.md)、[14 Native Capability Audit](14_STARDEW_PLAYER_COMMAND_COVERAGE_AUDIT.md)。

## 1. 目标与 stop rule

目标是确定玩家可理解的、**最小、可复用、可组合**的能力集合：在声明 scope 内，每个玩家玩法 intent variant 都有诚实的 capability decision。

```text
player intent variant
  → reuse existing capability
  | minimal new primitive
  | receipt-linked composite
  | coordination
  | finite content-operation contract
  | blocked / explicit scope exclusion
```

这不是以下任一目标：

- 将每个 C# method、callback、tick、selector、Content key 或 UI control 暴露为能力；
- 完整重建 call graph 或要求所有 PRCP/internal edge 分类后才能决定集合；
- 用当前 registry、静态测试、source reading 或成功启动替代 live evidence；
- 通过 UI、视觉、窗口焦点、OS keyboard/mouse/XInput injection、raw coordinate、raw UI callback、任意 native method 或 `performAction(string)` 补足能力。

目标版本 source、程序集、内容和 player-control ingress 只用于**定向 native audit**与版本漂移诊断：核对某个候选能力的 human guard、有限 domain、native lifecycle、result boundary 和 bridge equivalence。发现 source branch 不会自动产生 capability/action/catalog coverage。

## 2. 粒度与复用规则

一个 primitive 必须同时具备：玩家可独立请求的结果、有限 live target/input domain、同一 target 的有界 native lifecycle、独立 terminal receipt 与诚实 postcondition。动画、计时、内部 callback、自动 tick、同一 lifecycle 的 phase 不成为 action。

跨独立 target 或无可验证因果关联的 lifecycle 必须显式 composite；其每一步有 execution receipt，跨 boundary 重新 observe，aggregate result 不得将 source mutation 推断为 item/reward delivery。

对任何 player intent variant，按以下顺序决策：

1. 已发布 capability 是否以相同 native rule/result boundary 覆盖；若是，复用并在需要时做 focused source-equivalence audit 与回归 live gate。
2. 现有 Basis 的 proposed/experimental capability 是否准确表达它；若是，复用该 ID，不新造同义项。
3. 是否是已有独立 capabilities 的有序组合；若是，定义 composite graph。
4. 是否是 native multiplayer/save/day/text barrier；若是，定义 coordination。
5. 是否是无限内容域中的有限、版本化 operation；若是，定义 content-operation contract。
6. 只有无任何诚实既有边界时，新增最小 primitive；无法安全/诚实实现时标 `blocked`。

## 3. Evidence 与 materialization

每一项 decision record 记录：`capabilityId`、玩家结果、decision、复用目标、closed live domain、human/native guard 与 lifecycle、terminal/partial/blocked result model、non-guarantees、formal fixture/runner 与 required fresh postcondition。

一个 new/changed capability 仅在下列闭环完成后可标 `covered` 或进入 published surface：

```text
contract gate
→ deterministic implementation tests
→ formal Host + native independent AI Farmhand attachment
→ actual typed request
→ matching terminal request/execution receipt
→ fresh action-specific authoritative postcondition
→ cancel/timeout/disconnect/stale-target recovery
→ publish gate
```

Composite 还必须有每步 receipt、fresh observation、aggregate predicate 与 aggregate formal live run。source audit、graph diagnostic 与 deterministic test 都不是 live closure。

### 3.1 Shared native-local mechanics record

The target-version `native_local_player_fixture` lane is a bounded mechanics
check for an existing shared typed capability. It uses one isolated current
native local Player and cannot establish Farmhand publication, a Portfolio row,
or the formal closure required above. A result in this lane is recorded only
when it has the action's matching terminal request/execution receipt, fresh action-specific
postcondition, and verified fixture/profile/process teardown.

| Shared capability | Native-local mechanics state | Recorded target-version result |
|---|---|---|
| `move_to_tile` | passed | `succeeded/target_reached`; fresh native location/tile arrival |
| `equip_tool` | passed | `succeeded/tool_selected`; receipt `expected`/`after` and fresh `currentTool` agree |
| `till_soil` | passed | `succeeded/soil_tilled`; fresh target soil state changed from bare to `HoeDirt` |
| `travel` | passed | `succeeded/travel_completed` after native `Warped`; fresh location and exact warp target tile agree |
| `clear_debris` | passed | Fixed Farm `(62,17)` `2×2` `ResourceClump` (`parentSheetIndex=752`) received eight real Pickaxe hits `8→0`; each hit had its matching request/execution receipt, and the eighth returned `succeeded/debris_cleared`, followed by fresh exact-target absence and verified fixture teardown. Drops/pickup are excluded. |

These rows neither change the `reuse published` decisions below nor relax their
separate Farmhand contract, lifecycle, recovery, and publish requirements.

## 4. Minimal capability set

下表使用以下 decision：`reuse`、`new`、`composite`、`coordination`、`content-contract`、`blocked`。现有 published actions 仅表示可复用候选，不能将整行未验证 variant 标为 covered。

### 4.1 移动、地点、互动流程与日期

| Capability | 玩家结果 | Decision / reuse | Boundary / evidence |
|---|---|---|---|
| `move_to_tile` | 到达 live-discovered reachable tile 或合法邻位 | reuse published | `PathFindController`; exact position/adjacency, cancel/replacement/recovery |
| `enter_exit` | 经发现入口进入/离开地点 | reuse published | native warp → location/tile change |
| `travel` | 使用发现的 world transport/warp 到目的地 | reuse published | native transport/warp lifecycle → `Warped` |
| `mount_transport`, `dismount_transport` | 骑乘/下坐同一可用 transport | new | mounted state + position evidence |
| `dismiss_interaction` | 结束当前无世界变更 interaction | new | native interaction-state transition only |
| `advance_dialogue`, `select_dialogue_response` | 前进当前 dialogue / 选择当前 offered response | new / finite options | current opaque page/choice → event/dialogue state; no friendship claim |
| `select_level_or_mastery_reward` | 选择当前 offered reward | new | offered option → skill/mastery delta |
| `sleep_ready`, `advance_day_after_ready` | AI 自己 ready；在 all-ready/save barrier 后推进跨日 | coordination | own ready; native Saving/Saved/new-day barriers; never ready other players |

### 4.2 背包、装备、放置与容器

| Capability | 玩家结果 | Decision / reuse | Boundary / evidence |
|---|---|---|---|
| `equip_tool` | owned tool becomes active | reuse published | exact CurrentTool before/after |
| `select_active_item` | owned non-tool item becomes active without consumption | new | exact selected slot/item |
| `use_item` | ordinary edible item consumption | reuse published, **not generic** | native eating lifecycle; exact stack -1 |
| `equip_wearable`, `unequip_wearable` | equipment slot changes with inventory reconciliation | new | exact equipment + overflow/inventory |
| `inventory_move_or_split_stack` | own inventory stack/slot move or split | new | source/destination exact quantities |
| `drop_inventory_item`, `discard_inventory_item` | native Debris drop / declared discard | new | declared Debris, or exact removal; later pickup is independent |
| `pickup_item`, `pickup_forage` | collect same drop/forage | reuse published | native collection / `tryToCheckAt`; target disappearance + exact inventory delta |
| `transfer_to_container`, `transfer_from_container` | exact item quantity enters/leaves discovered container | new | same container, capacity/rollback, both quantity deltas |
| `place_decor_or_furniture`, `place_fence_or_gate`, `place_tapper` | limited class placement/attachment | new, separate | placement/connectivity/attachment evidence; output is separate |
| `remove_placed_item`, `move_or_rotate_furniture`, `apply_wallpaper_or_flooring` | exact placed/decor state change | new | same target state + item reconciliation |
| `claim_mail_attachment` | receive exact mail attachment | new | mail claim + inventory transition |
| `name_entity` | name-required transaction reaches explicit waiting barrier | coordination | no arbitrary text callback |
| `place_camp_kit` | camp-kit place/sleep/cleanup | blocked | lifecycle/evidence unresolved |
| `place_explosive` | limited explosive placement/effect | blocked | effect envelope, collateral and multiplayer safety contract required |

### 4.3 Farming、source transform 与 resource delivery

| Capability | 玩家结果 | Decision / reuse | Boundary / evidence |
|---|---|---|---|
| `till_soil`, `water_crop`, `fertilize_tile`, `plant_crop_seed`, `harvest_crop` | normal crop-cycle transitions | reuse published (`plant_seed` implements `plant_crop_seed`) | same tile/crop + inventory/state delta |
| `clear_hoedirt`, `remove_crop_source`, `clear_grass_or_weed_source` | remove same source only | new | source transform/removal; delivery separate |
| `plant_sapling` | valid tree/sapling placement | new | native placement + inventory proof |
| `refill_watering_can` | can capacity increases at valid water source | new | same can capacity delta |
| `harvest_fruit_tree`, `harvest_bush_source`, `shake_tree_source` | source availability/change plus identified delivery where applicable | new | source state; shake drops require fresh `pickup_item*` |
| `chop_tree_source`, `break_rock_source`, `clear_resource_clump`, `dig_artifact_spot`, `break_container_source` | tool transforms/removes same source | new (`clear_resource_clump` may replace experimental `clear_debris`) | source-only receipt; drops never imply delivery |
| `collect_resource`, `get_tree_resources`, `get_mined_drops` | obtain attributable resources from a source | composite | source transform → fresh discovery → named `pickup_item*` → aggregate exact delta |
| `grow_and_harvest_crop` | full crop lifecycle | composite | till → plant → water → day/observe → harvest; no time skipping |

### 4.4 Tools, fishing, combat and item warp

| Capability | 玩家结果 | Decision / reuse | Boundary / evidence |
|---|---|---|---|
| `tool_transform_object` | finite compatible tool/object class transforms target | new | closed tool/object domain; native transform; not generic `use_tool` |
| `fish` | one same-rod fishing lifecycle reaches an honest native terminal outcome | new, single primitive | cast → active lifecycle/minigame/settlement; `caught` exact delivery/overflow, `escaped`, `cancelled`, `capacity_blocked`, or another observed terminal |
| `configure_fishing_gear` | finite bait/tackle configuration of same rod | new | attachment slots + item reconciliation |
| `pan_ore` | same pan point clears and outputs/overflows reconcile | new | same target lifecycle + output |
| `use_warp_item` | use owned finite Totem/Return-Scepter-like item | new; not `travel` | item consumption/charge + native destination |
| `melee_attack`, `ranged_attack`, `weapon_special` | limited weapon effect | blocked | bounded effect/collateral, other-Farmer protection, exact receipt and live closure required |

`fish_cast`、`fish_control` 与 `claim_fishing_result` **不是默认独立 capabilities**。cast timing、release、BobberBar control、tick/animation 与 inventory/overflow settlement 属于同一 rod lifecycle；只有目标版本证明某阶段有独立 player-meaningful result、独立 target/result boundary、无 raw input/UI 的独立 receipt/postcondition，且不双重归属 settlement 时才可拆分。

### 4.5 Machines, crafting, services and advanced items

| Capability | 玩家结果 | Decision / reuse | Boundary / evidence |
|---|---|---|---|
| `machine_inspect` | read same live machine facts | reuse published | held input/output-ready snapshot agreement |
| `machine_load`, `machine_collect_output` | load / collect exact output | new | same machine and inventory reconciliation; `process_machine_item` remains an explicit composite across native time/day barrier |
| `machine_configure` | change a finite machine configuration | **not applicable / excluded from pinned-version release set** | Internal design rationale: the pinned `1.6.15.24356` `Machines.xnb` has 39 decoded `MachineData` entries and zero nonempty `InteractMethod` values; `Object.CheckForActionOnMachine` has no configuration-delegate ingress. This is not a missing save, fixture, or live gate. Do not invent generic configuration, raw delegate dispatch, or direct state mutation. Reassess only on a target content/version change. |
| `process_machine_item` | machine processing from input to output | composite | load → time/day observe → collect |
| `place_crab_pot`, `bait_crab_pot`, `collect_crab_pot_output` | same pot placement/bait/collection | reuse published for placement/bait; new for collection | `bait_crab_pot` is a finite `(O)685` → existing unbaited owned `(O)710` slice. Its bridge invokes normal `GameLocation.checkAction` exactly once (native probe+commit), with same opaque pot identity, owner, Bait `1→0`, revision and fresh actionability evidence. The fixture may only establish pre-attachment state; output/day/collection remain separate. Its shared native-local mechanics evidence is accepted by an action-specific product exception recorded in the closure board; this does not establish output/day collection, Farmhand, Portfolio, or release closure. |
| `craft_item`, `cook_recipe`, `tailor_item`, `dye_item`, `forge_item`, `enchant_item`, `process_geode` | finite transaction with costs/output | new | live unlocked recipe/station/service; all costs/output reconcile |
| `request_tool_upgrade`, `claim_tool_upgrade` | order then later receive exact upgraded tool | new, separate | pending order vs later delivery are independent boundaries |

### 4.6 Animals, NPCs, social and communication

| Capability | 玩家结果 | Decision / reuse | Boundary / evidence |
|---|---|---|---|
| `pet_animal` | same unpetted pet daily state transition | reuse experimental Basis; shared native-local mechanics passed | Target-version `Pet.checkAction`; production-only `friendship 0→12`, daily record/callback evidence, and fresh target absence. Farmhand record remains separate. |
| `feed_animal` | Hay enters same empty trough | reuse published | Hay -1 + trough state; never “animal ate” |
| `collect_animal_product` | same adult product delivered through native tool lifecycle | reuse published | produce cleared + expected inventory |
| `toggle_animal_door` | same house door state changes | new | exact AnimalHouse state |
| `purchase_animal`, `sell_or_relocate_animal` | management outcome requiring placement/name | coordination | native management + player/host naming/placement barriers |
| `talk_to_npc`, `give_npc_gift`, `offer_social_item` | conversation/gift/offer to same eligible NPC | new | live eligibility, item/result/event state; dialogue opening is not friendship |
| `npc_relationship` | read same NPC friendship facts | reuse experimental Basis; shared native-local mechanics passed | Read-only target-version facts; `Robin` `250`/`Friendly` receipt evidence followed by an identical fresh reread. Farmhand record remains separate. |
| `perform_emote` | finite native emote | new | finite enum → observed event/state |
| `send_multiplayer_chat` | native message delivery | coordination | text/delivery, never raw UI callback |
| `phone_contact_or_service` | finite phone service | content-contract | operation ID + discovery predicate + typed lifecycle/evidence |

### 4.7 Economy, buildings, quests, collections and rewards

| Capability | 玩家结果 | Decision / reuse | Boundary / evidence |
|---|---|---|---|
| `shop_inspect`, `shop_buy`, `shop_sell` | discover offers / buy / sell | new | live offer/price/stock; currency/inventory/stock reconciliation |
| `ship_item`, `collect_shipment_proceeds` | enter shipping ledger / obtain next-day proceeds | new + coordination | ledger then native new-day result; not one action |
| `trade_or_redeem` | finite exchange | new | exact source, cost and output |
| `construct_building`, `upgrade_building`, `move_building`, `demolish_building`, `renovate_or_paint_building` | building-management outcomes | coordination | materials/currency/map/construction/save/multiplayer barriers |
| `accept_quest_or_order`, `submit_quest`, `claim_quest_or_order_reward` | accept, submit, claim exact reward | new | quest state + transfers/reward; obtain graph remains composite |
| `donate_bundle_item`, `claim_bundle_reward`, `donate_museum_item`, `claim_museum_or_collection_reward` | collection progress / exact reward | new | exact slot/collection + inventory/reward state |
| `contribute_world_project`, `claim_world_reward` | finite project progress/reward | content-contract | versioned operation records only |

### 4.8 Events, festivals, world operations and minigames

| Capability | 玩家结果 | Decision / reuse | Boundary / evidence |
|---|---|---|---|
| `execute_world_operation` | one registered world operation | content-contract | content provenance, live discovery, typed params and evidence |
| `select_event_choice` | select currently offered event choice | content-contract | current opaque choice → event state |
| `festival_enter_or_leave` | native festival transition | coordination | participation barrier |
| `submit_festival_entry`, `start_minigame_phase`, `control_minigame_phase`, `claim_minigame_or_festival_reward` | finite operation-specific phase/reward result | content-contract | per-operation phase/reward evidence; no generic festival/minigame action |

## 5. Required legacy cleanup

The following planned roadmap labels are intentionally not materialization targets: `use_tool`, `combat_attack`, `place_item`, `transfer_item`, `manage_animal`, `world_interact`, `special_interact`, `festival_interact`, `minigame_play`, and `end_day`. They must be removed or replaced by the finite capabilities above before any implementation work; planned registry labels do not grant capability.

Likewise, resource collection remains an intent/composite, never a successful one-step primitive or a live `collect_resource` wire action. `milk_animal` and `shear_animal` reuse `collect_animal_product`, while `request_tool_upgrade` and `claim_tool_upgrade` must remain separate.

## 5.1 M1–M10 current action-selection and implementation set

§4.1–§4.8 remain a broad player-intent map: they do not authorize runtime
capabilities, and a `new`/`proposed` row does not automatically become a work
item. But `core_valley_milestone_portfolio_v1` M1–M10 is a **current required
gate**, not a future optional backlog. This section is its action-selection
record. It determines the required shared action work before milestone
composition; it does not turn shared-native-local evidence into a Portfolio
`pass`, publication, Farmhand, release, or save/reopen claim.

Every new row must follow the applicable action SOP:

```text
reuse → bounded parameter extension → receipt-linked composition
→ minimal new typed primitive/content operation/coordination
→ one thin typed bridge slice → static review → serial target-version live gate
```

A fixture may establish only an intact player-achievable start state before
bridge attachment. It cannot perform the claimed result, advance time, mutate a
save result, call an equivalent native ingress, consume an input, add output,
or emit a receipt. `Game1.NewDay`, raw UI/menu callbacks, visual/input
injection, generic dispatcher strings, and arbitrary native calls remain
prohibited substitutes.

### Current M1–M10 action map

| Gate | Reuse — do not reimplement | Required composite / coordination | Required new typed work | Current disposition |
|---|---|---|---|---|
| M1 external task and return | `move_to_tile`, `travel`, `enter_exit` | frozen outbound/return route receipts plus reload checkpoints | no new primitive | monitor/route contract required |
| M2 first crop | `till_soil`, `plant_seed`, `water_crop`, `harvest_crop` | same-tile receipts across native day/save/reopen | one bounded `single_player_sleep_and_advance_day` coordination lifecycle | **implementation_needed**: build the bounded typed lifecycle; it is not `sleep_ready` + `advance_day_after_ready` wire actions |
| M3 forage delivery | `pickup_forage`; `pickup_item` only for actual Debris | exact target disappearance plus inventory receipt | no new primitive | DSM forage-domain/monitor required |
| M4 source-to-resource delivery | `break_rock_source` or `chop_tree_source`, then `pickup_item*` | source receipt → fresh drop discovery → each pickup receipt → aggregate delta | no `collect_resource` action | composite contract required |
| M5 animal product | `feed_animal`, `collect_animal_product` | same trough → native day → same animal/product evidence | reuses M2 day coordination | implementation depends on M2's bounded day lifecycle |
| M6 machine output | `machine_load`, `machine_collect_output`, `machine_inspect` | same-machine load → native time/day observation → collection | reuses M2 day coordination; no `process_machine_item` action | implementation depends on M2's bounded day lifecycle |
| M7 one Community Center contribution | none | contribute → fresh bundle progress → fresh reward-available observation → separately claim eligible reward | `contribute_bundle_slot` (preferred narrow replacement for `donate_bundle_item`); `claim_bundle_reward` only if the selected DSM contribution produces a native reward | **implementation_needed**: freeze finite DSM slot/alternative/reward then implement the Mod-owned typed transaction; a UI-owned source ingress is not an exemption from implementation |
| M8 locked mine depth | movement actions are steps only | `enter_mine` where required → one selected route-variant receipt | select `use_mine_ladder` **or** `select_mine_elevator_floor` only for the DSM route variant | **complete:** the three M8 primitives have independent target-version closure; ladder and elevator are distinct native transitions, never generic `mine`/`travel`. A future end-to-end Goal may separately define a read-only `reach_mine_floor` evaluator, but it is not an M8 action/capability or completion gate. |
| M9 one Special Order | existing actions only where the frozen objective has the same lifecycle | accept → objective-specific receipts/progress observation → completion → reward claim | `accept_special_order_offer` (preferred narrow replacement for `accept_special_order`); one or more objective-specific actions only where reuse fails; `claim_special_order_reward` | **implementation_needed**: freeze finite DSM order/objective/reward then implement typed acceptance/claim transactions; no generic progress action |
| M10 locked Museum subset | `pickup_item` only for ordinary acquisition where applicable | acquire/verify piece → donate → fresh collection → repeat finite set → reward eligibility → claim | `donate_museum_item`; `claim_museum_reward` | **implementation_needed**: freeze finite DSM piece-set/placement/reward then implement Mod-owned typed donation and claim transactions |

`collect_crab_pot_output` remains a separate shared capability candidate with a
ready-pot fixture-provenance requirement. It is not on the M1–M10 critical
path and must not displace the rows above.

### Explicitly rejected broad labels

The M1–M10 action set must not create `collect_resource`, `grow_crop`,
`process_machine_item`, `manage_animal`, generic `mine`, generic
`interact`/`world_interact`, generic quest/Museum/Bundle dispatch, generic
`special_order_progress`, or `end_day` wire actions. They combine independent
native targets/lifecycles and instead remain receipt-linked composites or
coordination.

### Required implementation batches

1. **Batch A — day coordination implementation:** build the single bounded
   `single_player_sleep_and_advance_day` typed sleep/save/new-day/reopen
   lifecycle required by M2/M5/M6. It must not split into
   `sleep_ready` / `advance_day_after_ready` wire actions or expose raw
   `NewDay`; its Mod-owned execution owns the complete finite lifecycle,
   revalidation, cancellation boundary, receipt, fresh reread, and reopen.
2. **Batch B — finite collection-operation implementations:** in independent
   Bundle and Museum lanes, freeze M7/M10 domains then implement the Mod-owned
   typed `contribute_bundle_slot`/`claim_bundle_reward` and
   `donate_museum_item`/`claim_museum_reward` transactions. UI-owned source
   ingress is evidence of the normal semantic rules to preserve, not a reason
   to defer implementation. Donation and reward claim remain separate.
3. **Batch C — mine route implementation:** implement the independent M8 primitives required by the selected DSM route: `enter_mine` where required and only the finite `use_mine_ladder` **or** `select_mine_elevator_floor` transition. The M8 action set is complete once its selected primitives independently close. A future product Goal may separately introduce a read-only `reach_mine_floor` evaluator; it is not a wire action, capability, or M8 completion gate.
4. **Batch D — Special Order implementation:** choose one DSM order whose
   objective either reuses the action set above or has one separately scoped
   missing primitive; then implement `accept_special_order_offer`, any true
   gap, and reward claim as separate lifecycles. Current M7–M10 source-audit artifacts are `projection
   blocked` / `live not performed`: they identify the semantics the typed
   implementation must preserve, not an implementation prohibition.
5. **Batch E — milestone composition:** after every needed primitive/
   coordination has its own closure, implement receipt-linked M1–M10 monitors
   and perform their isolated single-player save/reopen gates.

No batch is complete because a proposal, static test, fixture, or source audit
exists. Every materialized capability still requires its action-specific
contract, static checks, independent review, and serial target-version live
evidence before it is published or treated as closed.
