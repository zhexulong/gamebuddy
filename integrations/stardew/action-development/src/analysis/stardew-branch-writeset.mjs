import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { Language, Parser } = require("web-tree-sitter");
const GRAMMAR_WASM = require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm");

/**
 * 分支级写入提取。
 *
 * 目的：从目标版本反编译源码机械地得出「一个原生方法体的哪些分支构成候选 action」，
 *       不依赖人工阅读，也不推断无法静态确定的效果。
 *
 * 为什么粒度是分支而不是方法：
 *   `WateringCan.cs::DoFunction` 一个方法同时实现「装满水壶」与「浇灌瓦片」——
 *   这是 18_ ledger 的两条独立 entry。方法级判定会把它们混成一个动作。
 *
 * 与 17_ 的 unknown-sink 纪律一致：委托、虚分派、内容驱动、RNG 一律不猜，
 * 只记录为需要人工/后续解析的事实。
 */

// ---- 分类器（规则的可审查部分）-------------------------------------------

/** 直接挂菜单 */
const MENU_TARGET = /activeClickableMenu|currentMinigame|^activeMenu$/;
/** 经由菜单构建器 */
const MENU_CALLEE = /TryOpenShopMenu|OpenDonationMenu|OpenRewardMenu|new \w*Menu\b/;
/** 依赖真实键鼠/手柄事件 */
const INPUT_CALLEE =
  /didPlayerJustRightClick|didPlayerJustClickAtAll|isAnyGamePadButtonBeingPressed|Game1\.(oldMouseState|mouseState|oldKBState|inputState)/;
/**
 * 输入派生状态字段。只查调用是不够的：FishingRod.DoFunction 不直接调输入 API，
 * 它写 `who.canReleaseTool` / 读 `Game1.lastCursorMotionWasMouse`。
 */
const INPUT_STATE_FIELD = /canReleaseTool|lastCursorMotionWasMouse|ToolHold|isMousePressed|mouseMotion|heldButton/;

/** 把效果交给目标对象的统一入口 */
const DELEGATE = /\.perform(ToolAction|UseAction|ObjectDropInAction)$/;

/**
 * 纯转发：`base.<同方法名>` 或 `base.<生命周期方法>`。
 * 它不产生自己的终态，只是转给父类实现 —— 不能算作 P4 的终态证据。
 *
 * 为什么必须排除：`Caldera.performToolAction` 的 body 分支只调
 * `base.performToolAction` + 几个纯视觉写入，却因委托被 P4 放行成了候选。
 */
const FORWARDING_CALL =
  /^(base|this)\.(performToolAction|performUseAction|performObjectDropInAction|checkAction|checkForAction|DoFunction|performAction|placementAction)$/;

/** 结果由随机数决定 */
const RNG_CALLEE = /Game1\.random|CreateRandom|NetRandom|\.Next(Double|Bool|Int)?$|\.Choose$/;

/**
 * 延迟完成：终态在后续 NetEvent 回调或内部 finish() 里，本次调用只登记。
 * `DelayedAction.*Sound*` 只是声音延迟，不推迟终态，故不匹配。
 */
const DEFERRED_CALLEE = /(^|\.)(finish|finishEvent|doFinish)$|NetEvent/;
/** 延迟完成标志字段（NetEvent 的载荷） */
const DEFERRED_FIELD = /^(finishEvent|lastUser|endFunction|_?finish)$/;

/** 手持物槽位（写它就是消耗或替换手持物，不是“同时持有多个”） */
const HELD_SLOT = /^(Game1\.player|who)\.(ActiveObject|CurrentTool)$/;

/**
 * 编译器临时量条件：仅由 `flagN` / `numN` / `IL_xxxx` 这类变量构成。
 * 出现在新版 ILSpy 对复杂方法（含 try/finally、大 switch）的降级输出里。
 */
const COMPILER_TEMPORARY_CONDITION =
  /^(?:\(?\s*(?:!|\|\||&&|\()*\s*(?:flag|num|text|array|list|bool)\d*\s*\)?\s*(?:\|\||&&)?\s*)+$/;

/**
 * 阶段标记字段：写它表示**开始一个跨 tick 的生命周期**，终态由游戏循环后续驱动，
 * 不在本次调用内完成。
 *
 * 为什么需要它：`P8_completesInCall` 原本只认显式的 `NetEvent`/`finish()` 延迟，
 * 漏了这种“设个标志，游戏循环接着跑”的形态 —— `FishingRod` 的 `isFishing = true`
 * （抛竿）就是这样：本分支不调 finish，但抛竿明显不是一次调用内完成的。
 */
const PHASE_FLAG_FIELD =
  /^(isFishing|isNibbling|showingTreasure|castedButBobberStillInAir|pullingOutOfWater|UsingTool|isEmoting|isEating|isAnimating|isCharging)$/;

/** 视觉/动画/面板索引：计入但标记，避免被当成 gameplay effect */
const COSMETIC =
  /^(jitterStrength|shakeTimer|shakeRotation|maxShake|flipped|alpha|alphaFade|currentParentTileIndex|IndexOfMenuItemView|delayBeforeAnimationStart|motion|acceleration|scale|rotation)$/i;

/**
 * 赋值运算符区分终态与代价：
 *   `field = value` → 终态（水壶装满、锄点清空、土壤浇水）
 *   `field -= x`    → **看字段**，不能一律当代价
 * 同一字段在不同分支角色可相反：`waterLeft.Value = waterCanMax`（refill）vs
 * `waterLeft.Value -= power + 1`（apply）。
 */
const DIMINISHING = /-=$|--$/;

/**
 * 复合赋值里「消耗的是**执行者自己的资源**」的字段 —— 这些才是代价。
 *
 * 为什么必须区分：把 `-=` 一律当代价会把**世界实体的终态削减**一起排掉。
 * `Grass.performToolAction` 的 `numberOfWeeds.Value -= num` 与 `Bush` /
 * `GiantCrop` / `ResourceClump` 的 `health -= ...` 都是实体自身的状态：减到 0
 * 就是销毁，是动作的**终态**，不是动作的代价。旧规则把它们从 `writes` 排进
 * `cost`（而 `cost` 桶无任何消费者），于是 P4 判它们「无终态写入」，
 * `Grass` 被九谓词拒掉、`Bush` 掉进「只写视觉/计时器」的 C 档，
 * 两处遗漏同一个根因。
 *
 * 名单刻意**不含 `health`**：`health` 既是 actor 资源（`Farmer.health`）又是
 * 世界实体生命（`Bush.health` / `GiantCrop.health` / `ResourceClump.health`），
 * 无法单靠字段名区分；而这里列出的字段（水量/弹药/耐久/燃料）在任何世界实体
 * 类里都不存在，所以 `-=` 只可能含义一种 —— 消耗。
 */
const ACTOR_RESOURCE_FIELD =
  /^(stamina|waterLeft|waterCanMax|money|durability|ammo|magazine|usesLeft|fuel)$/i;

/**
 * 委托接收者静态类型 → 该类型是否有多个子类实现。
 * 子类数 > 1 时，委托会把效果分散到多个实现，不构成「单一原生生命周期」。
 * 数值由 derive-stardew-branch-writeset 的 type index 从源码实测。
 */
const HETEROGENEOUS_TYPES = new Set([
  "Object",
  "TerrainFeature",
  "LargeTerrainFeature",
  "GameLocation",
  "NPC",
  "Item",
  "Tool",
]);

/**
 * 容器成员 → 元素类型。用于解析 `location.terrainFeatures` 这类委托接收者，
 * 以及 `TryGetValue(..., out var x)` 的 x 类型。
 */
const FIELD_ELEMENT_TYPE = new Map([
  ["location.terrainFeatures", "TerrainFeature"],
  ["location.objects", "Object"],
  ["location.largeTerrainFeatures", "LargeTerrainFeature"],
  ["location.resourceClumps", "ResourceClump"],
  ["Game1.currentLocation.terrainFeatures", "TerrainFeature"],
  ["Game1.currentLocation.objects", "Object"],
  ["Game1.currentLocation.largeTerrainFeatures", "LargeTerrainFeature"],
]);

/** 包装类型 → 元素类型（二级解析） */
const WRAPPER_ELEMENT_TYPE = new Map([["OverlaidDictionary", "Object"]]);

// ---- 语法工具 -------------------------------------------------------------

const collect = (node, type, out = []) => {
  if (node.type === type) out.push(node);
  for (const c of node.children) collect(c, type, out);
  return out;
};

/** 声明节点的类型名。字段声明的类型在 `variable_declaration` 子节点里，property 才有 `type`。 */

/**
 * 分支区域：if 的 consequence / alternative + switch_section。
 *
 * 注意：不能只用 if_statement 的整体区间做最内层归属——那样 `else` 体内的写入会被
 * 误判给外层 if。tree-sitter 提供 `alternative` 字段，必须用它切分。
 */
function branchRegions(fn, src) {
  const out = [];
  const walk = (n) => {
    if (n.type === "if_statement") {
      const cond = n.childForFieldName("condition");
      const cons = n.childForFieldName("consequence");
      const alt = n.childForFieldName("alternative");
      const label = cond ? src.slice(cond.startIndex, cond.endIndex).replace(/\s+/g, " ").slice(0, 96) : "";
      const line = n.startPosition.row + 1;
      if (cons) out.push({ line, kind: "then", label, s: cons.startIndex, e: cons.endIndex });
      if (alt) out.push({ line, kind: "else", label, s: alt.startIndex, e: alt.endIndex });
    } else if (n.type === "switch_section") {
      out.push({
        line: n.startPosition.row + 1,
        kind: "case",
        label: src.slice(n.startIndex, Math.min(n.startIndex + 48, n.endIndex)).replace(/\s+/g, " "),
        s: n.startIndex,
        e: n.endIndex,
      });
    }
    for (const c of n.children) walk(c);
  };
  walk(fn);
  return out;
}

/**
 * 极大区域：被其它区域真包含的区域属于更外层 action 的内部实现。
 * 这是「不可分割」在语法上的直接表达。
 *
 * **例外：case 自成一个作用域。** 真包含规则对 if/then/else 嵌套成立，对 switch
 * 不成立 —— 一个 `case` 是**兄弟作用域**，不是外层 `if` 的实现细节：
 *
 *     if (who.IsLocalPlayer)          // 外层 if
 *     {
 *         switch (action) {
 *             case "MinecartTransport": ...   // 与其它 case 互斥的独立动作
 *         }
 *     }
 *
 * 旧实现按「任意真包含即丢弃」处理，于是外层 if 吞掉了整段 switch。实测后果：
 * `GameLocation.performAction`（127 个 selector）保留 0 个 case，
 * `Object.placementAction` 34→0、`Object.performToolAction` 29→0、
 * `Event.checkAction` 33→0、`Town.checkAction` 14→0。
 *
 * 正确的吞并关系：
 *   case ⊂ if/else      → **不吞**（case 自己划作用域）
 *   case ⊂ case         → 吞（case 内部的嵌套 switch 是该 case 的实现细节）
 *   then/else ⊂ 任意     → 吞（原有行为不变）
 */
const maximalRegions = (regions) => {
  const uniq = regions.filter((r, i) => !regions.some((o, j) => j < i && o.s === r.s && o.e === r.e));
  return uniq.filter(
    (r) => !uniq.some((o) => o !== r && o.s <= r.s && r.e <= o.e && (o.kind === "case" || r.kind !== "case")),
  );
};

const innermost = (regions, item) => {
  let best = null;
  for (const r of regions) {
    if (r.s <= item.s && item.e <= r.e) if (!best || r.e - r.s < best.e - best.s) best = r;
  }
  return best;
};

/** 参数名 + 局部变量名 + 静态类型 */
function scopeNames(fn, src) {
  const locals = new Set();
  const params = new Set();
  const types = new Map();

  const p = fn.childForFieldName("parameters");
  if (p) {
    for (const x of collect(p, "parameter")) {
      const n = x.childForFieldName("name")?.text;
      const t = x.childForFieldName("type");
      if (!n) continue;
      params.add(n);
      if (t) types.set(n, src.slice(t.startIndex, t.endIndex).trim().split(/\s+/)[0]);
    }
  }

  for (const d of collect(fn, "local_declaration_statement")) {
    const vd = d.namedChildren.find((c) => c.type === "variable_declaration");
    const tn = vd
      ? src
          .slice(vd.startIndex, vd.endIndex)
          .replace(/^var\s+/, "")
          .trim()
          .split(/\s+/)[0]
      : null;
    for (const v of collect(d, "variable_declarator")) {
      const n = v.childForFieldName("name")?.text;
      if (!n) continue;
      locals.add(n);
      if (tn && tn !== "var") types.set(n, tn);
    }
  }

  for (const f of collect(fn, "foreach_statement")) {
    const l = f.childForFieldName("left");
    if (l) locals.add(src.slice(l.startIndex, l.endIndex).trim());
  }

  locals.delete(undefined);
  params.delete(undefined);
  return { locals, params, types };
}

/**
 * 从 `X.<member>.TryGetValue(..., out var Y)` 补出 Y 的静态类型。
 * out var 本身不带类型标记，唯一来源是容器的元素类型。
 */
function resolveOutVarTypes(fn, src, types) {
  for (const call of collect(fn, "invocation_expression")) {
    const f = call.childForFieldName("function");
    if (!f) continue;
    const callee = src.slice(f.startIndex, f.endIndex).replace(/\s+/g, " ");
    if (!/TryGetValue$/.test(callee)) continue;
    const args = call.childForFieldName("arguments");
    if (!args) continue;
    const name = collect(args, "declaration_expression")[0]?.childForFieldName("name")?.text;
    if (!name) continue;
    const container = callee.replace(/\.TryGetValue$/, "");
    const type = FIELD_ELEMENT_TYPE.get(container) ?? FIELD_ELEMENT_TYPE.get(container.replace(/^Game1\./, ""));
    if (type) types.set(name, type);
  }
  return types;
}

/** 局部变量写入属动作内部中间状态；裸参数赋值同理；`param.Member` 是对象图写入。 */
const isInternalWrite = (target, locals, params) => {
  const root = target.split(/[.[]/)[0];
  if (locals.has(root)) return true;
  if (params.has(root) && root === target) return true;
  return false;
};

const stripValue = (t) => t.replace(/\.Value$/, "");

// ---- 提取 -----------------------------------------------------------------

/**
 * @returns {Promise<Array<{file,member,methodLine,maximalRegions,nestedRegions,branches}>>}
 */
export async function extractBranches({ sourceRoot, relPath, memberName, parser }) {
  const src = await readFile(path.join(sourceRoot, relPath), "utf8");
  const tree = parser.parse(src);
  const methods = collect(tree.rootNode, "method_declaration").filter(
    (m) => m.childForFieldName("name")?.text === memberName,
  );

  return methods.map((m) => {
    const all = branchRegions(m, src).sort((a, b) => a.s - b.s);
    const regions = maximalRegions(all);
    const { locals, params, types } = scopeNames(m, src);
    resolveOutVarTypes(m, src, types);
    const text = (l) => src.slice(l.startIndex, l.endIndex).replace(/\s+/g, " ");

    /**
     * 集合变更调用（`X.Add/Y.Remove/Z.Clear`）。
     *
     * **刻意不归入 `writes`**：mutator 接收者的类型在无完整类型信息时不可靠——
     * `Chest.addItem` 的 `itemsForPlayer.Add(item)` 写的是世界容器，而
     * `WateringCan` 的 `List<Vector2> list = tilesAffected(...)` 后 `list.Add`
     * 只是局部缓冲。语法层无法区分，属“unknown sink”情形。
     *
     * 因此单独暴露供审查，不参与九谓词（猜它会破坏已校准的裁定）。
     */
    const MUTATOR = /^(Add|Remove|Clear|Push|Enqueue|Dequeue|Insert|RemoveAt|AddRange)$/;
    const _mutatorWrites = collect(m, "invocation_expression")
      .map((i) => {
        const f = i.childForFieldName("function");
        if (!f) return null;
        const parts = text(f).split(".");
        if (parts.length < 2) return null;
        const member = parts[parts.length - 1];
        if (!MUTATOR.test(member)) return null;
        return {
          line: i.startPosition.row + 1,
          target: parts.slice(0, -1).join("."),
          operation: member,
          /** 接收者是方法调用结果还是已知字段前缀 —— 前者不可判定 */
          receiverIsCallResult: /\w+\(/.test(parts.slice(0, -1).join(".")),
          receiverIsKnownRoot: /^(location|Game1|farm|who|this)\b/.test(parts[0]),
        };
      })
      .filter(Boolean);

    const writes = collect(m, "assignment_expression").map((a) => {
      const left = a.childForFieldName("left");
      const target = left ? text(left) : "?";
      const op = a.children.find((c) => /^[-+]?=$/.test(c.type))?.type ?? "=";
      const tail = stripValue(target).split(".").pop();
      // `-=` 只有作用在**执行者资源**上才是代价；作用在世界实体上是终态削减。
      const diminishing = DIMINISHING.test(op);
      return {
        s: a.startIndex,
        e: a.endIndex,
        line: a.startPosition.row + 1,
        target,
        op,
        internal: isInternalWrite(target, locals, params),
        cosmetic: COSMETIC.test(tail),
        cost: diminishing && ACTOR_RESOURCE_FIELD.test(tail),
        diminishing,
        deferred: DEFERRED_FIELD.test(tail),
        phaseFlag: PHASE_FLAG_FIELD.test(tail),
        menu: MENU_TARGET.test(target),
        inputState: INPUT_STATE_FIELD.test(target),
      };
    });

    const calls = collect(m, "invocation_expression").map((i) => {
      const f = i.childForFieldName("function");
      const callee = f ? text(f) : "?";
      const [recvRoot, recvMember] = callee.split(".");
      let recvType = types.get(recvRoot) ?? null;
      if (!recvType && recvMember)
        recvType =
          FIELD_ELEMENT_TYPE.get(`${recvRoot}.${recvMember}`) ??
          FIELD_ELEMENT_TYPE.get(`Game1.${recvRoot}.${recvMember}`) ??
          null;
      if (recvType && WRAPPER_ELEMENT_TYPE.has(recvType)) recvType = WRAPPER_ELEMENT_TYPE.get(recvType);
      return {
        s: i.startIndex,
        e: i.endIndex,
        line: i.startPosition.row + 1,
        callee,
        delegate: DELEGATE.test(callee) && !FORWARDING_CALL.test(callee),
        forwarding: FORWARDING_CALL.test(callee),
        delegateTargetType: recvType,
        delegateHeterogeneous: DELEGATE.test(callee) && recvType !== null && HETEROGENEOUS_TYPES.has(recvType),
        rng: RNG_CALLEE.test(callee),
        deferred: DEFERRED_CALLEE.test(callee),
        menu: MENU_TARGET.test(callee) || MENU_CALLEE.test(callee),
        input: INPUT_CALLEE.test(callee),
      };
    });

    const buckets = new Map();
    const touch = (item) => {
      const b = innermost(regions, item);
      const key = b ? `L${b.line}/${b.kind}` : "body";
      if (!buckets.has(key))
        buckets.set(key, {
          key,
          line: b?.line ?? m.startPosition.row + 1,
          kind: b?.kind ?? "body",
          condition: b?.label ?? "(方法体直写)",
          writes: [],
          cosmetic: [],
          cost: [],
          internal: [],
          delegates: [],
          heterogeneousDelegates: [],
          forwarding: [],
          calls: [],
          menu: false,
          input: false,
          rng: false,
          deferred: false,
        });
      return buckets.get(key);
    };

    for (const w of writes) {
      const b = touch(w);
      if (w.internal) b.internal.push(w.target);
      else if (w.cosmetic) b.cosmetic.push(w.target);
      else if (w.cost) b.cost.push(w.target);
      else if (!b.writes.includes(w.target)) b.writes.push(w.target);
      if (w.menu) b.menu = true;
      if (w.inputState) b.input = true;
      if (w.deferred || w.phaseFlag) b.deferred = true;
    }
    for (const c of calls) {
      const b = touch(c);
      if (c.forwarding) b.forwarding.push(c.callee);
      if (c.delegate) {
        b.delegates.push(c.callee);
        if (c.delegateHeterogeneous) b.heterogeneousDelegates.push(c.callee);
      } else if (!c.forwarding) {
        b.calls.push(c.callee);
      }
      if (c.rng) b.rng = true;
      if (c.deferred) b.deferred = true;
      if (c.menu) b.menu = true;
      if (c.input) b.input = true;
    }

    for (const b of buckets.values()) {
      /**
       * 接收者集合。区分三种写入形态，P2 只对「世界实体」计数：
       *   implicit_this  裸标识符（`heldObject.Value`）—— 写的是 this 自身的字段，
       *                  多个这样的写入仍是一个实体（Cask 写 heldObject/readyForHarvest/
       *                  minutesUntilReady 被旧实现误判为 3 个目标）
       *   actor          以 who/Game1.player 开头 —— 写玩家状态，不是动作目标
       *   world          其它（`location.objects[x]` / `obj.X`）—— 真正的目标实体
       */
      const classify = (t) => {
        const root = stripValue(t).split(/[.[]/)[0];
        if (/^(who|player|Game1)$/.test(root)) return "actor";
        if (!t.includes(".") || /^[a-z]/.test(root)) return "implicit_this";
        return "world";
      };
      const worldReceivers = new Set(
        b.writes.filter((t) => classify(t) === "world").map((t) => stripValue(t).split(/[.[]/)[0]),
      );
      const actorReceivers = new Set(
        b.writes.filter((t) => classify(t) === "actor").map((t) => stripValue(t).split(/[.[]/)[0]),
      );
      const implicitThisFields = new Set(
        b.writes.filter((t) => classify(t) === "implicit_this").map((t) => stripValue(t)),
      );
      b.receiverCount = worldReceivers.size;
      b.receivers = [...worldReceivers];
      b.receiverClassification = {
        world: [...worldReceivers],
        actor: [...actorReceivers],
        implicitThis: [...implicitThisFields],
      };
      /**
       * 手持物消耗：`Game1.player.ActiveObject = null` 等。
       *
       * 这是动作的**结果/代价**（物品被用掉），不是“同时持有多个”。
       * 旧实现把 `ShippingBin.leftClicked` 写 `farm.lastItemShipped` +
       * `ActiveObject = null` 误判为 P1 违例，从而错过无需菜单的出货入口。
       */
      b.heldConsumed = b.writes.filter((t) => HELD_SLOT.test(t));
      b.verdict = {
        /**
         * 只在「引用多个手持物槽」时才是多持有。
         * 写一个槽（含置 null 消耗） + 其它世界字段 = 单一持有。
         */
        P1_singleHeld: b.writes.filter((t) => HELD_SLOT.test(t)).length <= 1,
        /** 只在写入多个**世界实体**时才是多目标；写自己多个字段不算 */
        P2_singleTarget: worldReceivers.size <= 1,
        P3_singleSeam: new Set(b.delegates).size <= 1,
        P4_terminalWrite: b.writes.length > 0 || b.delegates.length > 0,
        P5_noInputEvent: !b.input,
        P6_noMenu: !b.menu,
        P7_deterministic: !b.rng,
        P8_completesInCall: !b.deferred,
        P9_homogeneousDelegate: b.heterogeneousDelegates.length === 0,
        /**
         * 条件由编译器临时量构成（`flag5 || flag2 || flag4`）说明该方法的控制流
         * 已不是源码形式——新版 ILSpy 会把复杂方法降为 `IL_xxxx:` + `flagN` 形态
         * （实测 14 个文件如此，含 FishingRod）。这种分支的“条件”无源码语义，
         * **不可判定**，必须拒绝而不是猜。
         */
        P10_sourceShapedCondition: !COMPILER_TEMPORARY_CONDITION.test(b.condition),
      };
      b.candidate = Object.values(b.verdict).every(Boolean);
      b.rejectedBy = Object.entries(b.verdict)
        .filter(([, v]) => !v)
        .map(([k]) => k.replace(/_.*$/, ""));
    }

    return {
      file: relPath,
      member: memberName,
      methodLine: m.startPosition.row + 1,
      maximalRegions: regions.length,
      nestedRegions: all.length - regions.length,
      branches: [...buckets.values()],
    };
  });
}

/** 创建已加载 C# 语法的 parser（同一进程内复用） */
export async function createParser() {
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load(GRAMMAR_WASM));
  return parser;
}
