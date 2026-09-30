#!/usr/bin/env node
/**
 * 地图瓦片 Action 选择器分析（tile-Action dispatcher 的 selector 层）。
 *
 * 单位是 **selector**（地图 Action 字符串里的动作词），不是方法也不是分支：
 * `GameLocation.performAction` 在 `if (who.IsLocalPlayer)` 内解释地图属性字符串
 * （`Action MinecartTransport`、`Action WishingWell` …）。per-method 的九谓词
 * （stardew-branch-writeset）对这一层失效——selector 的效果几乎总是路由进
 * 一个被调用的 helper 或菜单（`MinecartTransport` 只调 `ShowMineCartMenu(...)`，
 * 无字段写入、无 DELEGATE 匹配，P4 直接拒绝它）。
 *
 * **dispatcher 族是 `performAction`**，它有 18 个 override + 1 个 `string` 重载
 * （`DesertFestival`）；子类各自带自己的 selector，且多数用 `if` 而不是 `switch`
 * 分派。因此 selector 的枚举必须覆盖整棵树的全部实现，不能只看基类的一个方法。
 *
 * 本工具只做有界的、信号驱动的分类：
 *
 *   menu-bound            直接挂菜单（activeClickableMenu / new *Menu( / 菜单开放器）
 *   dialogue-or-event-bound  对话或事件（drawObjectDialogue / createQuestionDialogue /
 *                          PlayEvent / startEvent …）
 *   warp-transition       传送（Game1.warpFarmer / new Warp( …）
 *   plain-world-effect    以上都不是：调用 helper、写世界状态 —— 需要进一步机制分析
 *   unknown               空 body / 仅 return / 无法解析
 *
 * 对 plain 选择器会做**同文件、有界深度**的 helper 追踪（默认 2 跳），并把 helper
 * 内解析到的数据表访问（`DataLoader.X`）与菜单/对话/传送信号回填到该行。
 * 跨类委托（`buildingAt.ToggleAnimalDoor(who)`）只记录、不解析。
 *
 * 产物是**有界清单**：一行一个 selector + 计数 + 显式 non-guarantees。
 * 不产出 action identity；分类也不等于「可支持 action」。
 *
 * 用法：
 *   # 单实现
 *   node .../stardew-tile-action-selectors.mjs \
 *     --source-root <decompiled-root> --rel-path <rel> --member performAction [--class <C>]
 *   # 整树：机械枚举 performAction 的每个实现
 *   node .../stardew-tile-action-selectors.mjs --source-root <decompiled-root>
 *   [--helper-depth 2] [--out <file>] [--pretty]
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Dispatcher family member. It is the only tile-Action entry point in the target tree. */
export const TILE_ACTION_DISPATCHER_MEMBER = "performAction";

/** First-parameter types that carry the parsed `Action` map property. */
const TILE_ACTION_PARAMETER_TYPES = new Set(["string[]", "string"]);

let Parser = null;
let Language = null;
let GRAMMAR_WASM = null;

function loadTreeSitter() {
  if (Parser) return;
  const require = createRequire(import.meta.url);
  Parser = require("web-tree-sitter").Parser;
  Language = require("web-tree-sitter").Language;
  GRAMMAR_WASM = require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm");
}

export async function createSelectorParser() {
  loadTreeSitter();
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load(GRAMMAR_WASM));
  return parser;
}

const collect = (node, type, out = []) => {
  if (node.type === type) out.push(node);
  for (const c of node.children) collect(c, type, out);
  return out;
};

/** switch 的 section 挂在 `switch_body` 下（不是 switch 的直接子节点）。 */
const switchSections = (sw) =>
  sw.namedChildren.flatMap((c) =>
    c.type === "switch_body" ? c.namedChildren.filter((s) => s.type === "switch_section") : [],
  );

/**
 * 一个 section 的**直接** case 标签。不能对 section 体做 `case "..."` 正则扫描：
 * 外层 selector 的 section 体包含嵌套 switch，扫体会把嵌套词（`Action OpenShop` 内的
 * `down/up/left/right`、`Action NPCMessage` 内的 `AnimalShop.20`）当成顶层 selector。
 * 标签在 tree-sitter-c-sharp 里是 `switch_section` 的直接 `constant_pattern` 子节点。
 */
const sectionLabels = (section) =>
  section.namedChildren
    .filter((c) => c.type === "constant_pattern")
    .filter((p) => p.namedChildren[0]?.type === "string_literal")
    .map((p) => stringValue(p.namedChildren[0]));

/** 纯标签 section 只有 pattern 子节点；带语句的 section 才是某个 selector 的 body。 */
const hasSectionStatements = (section) =>
  section.namedChildren.some((c) => c.type !== "constant_pattern" && c.type !== "default_switch_label");

const hasAncestorOfType = (node, type, stop) => {
  let n = node.parent;
  while (n && n !== stop) {
    if (n.type === type) return true;
    n = n.parent;
  }
  return false;
};

// ---- 信号（可审查部分）----------------------------------------------------

/** 直接挂菜单：菜单字段写入 / 菜单构造 / 菜单开放器（含名字无 Menu 后缀的） */
const MENU_SIGNALS =
  /Game1\.(activeClickableMenu|currentMinigame)\s*=|new\s+[A-Z]\w*Menu\s*\(|TryOpenShopMenu|OpenShopMenu|OpenDonationMenu|OpenRewardMenu|ActivateKitchen|ShowMineCartMenu|ShowElevatorMenu|ShowPagedResponses|ShowQiCatMenu|ShowConstructOptions|openCraftingMenu|ShowMenu\(/;

/** 对话或事件：把终态交给对话/事件系统 */
const DIALOGUE_EVENT_SIGNALS =
  /drawObjectDialogue|drawDialogue|multipleDialogues|createQuestionDialogue|CreateQuestionDialogue|CreateYesNoResponses|PlayEvent|startEvent|Game1\.event\b|afterDialogues|beginEvent|Game1\.currentDialogueBox|loadedGameEvent|functionKicked/;

/** 传送：warp 到别的 location / tile */
const WARP_SIGNALS = /warpFarmer|new\s+(?:StardewValley\.)?Warp\s*\(|RequestWarp|doWarp|doLocalWarp/;

/** 数据表访问：效果由内容数据（Data/*）驱动 */
const DATA_TABLE_SIGNAL = /DataLoader\.\w+/;

/**
 * 信号按优先级归类：menu > dialogue/event > warp > plain。
 * plain = 三者都不是（可能有世界写入或本地 helper 调用）。
 * 分类是**证据**，不是裁定（见文件头与产物 nonGuarantees）。
 */
function classify(raw) {
  const signals = [];
  if (MENU_SIGNALS.test(raw)) signals.push("menu");
  if (DIALOGUE_EVENT_SIGNALS.test(raw)) signals.push("dialogue_or_event");
  if (WARP_SIGNALS.test(raw)) signals.push("warp");
  let category;
  if (signals.includes("menu")) category = "menu-bound";
  else if (signals.includes("dialogue_or_event")) category = "dialogue-or-event-bound";
  else if (signals.includes("warp")) category = "warp-transition";
  else category = "plain-world-effect";
  return { category, signals };
}

/** 不在同文件 helper 白名单内的点分调用 → 跨类/对象委托（只记录不解析） */
const HELPER_CALLEE_ROOT =
  /^(Game1|DataLoader|Utility|ArgUtility|TokenParser|GameStateQuery|this|base|string|int|float|List|Dictionary|NetRef|NetBool|NetInt|NetString|NetEvent|DelayedAction|Multiplayer)\b/;

function isDelegateCall(callee) {
  const c = callee.replace(/^\.+/, "");
  return c.includes(".") && !HELPER_CALLEE_ROOT.test(c) && !/^Game1\.player/.test(c);
}

// ---- selector 枚举 --------------------------------------------------------

const textOf = (src, node) => src.slice(node.startIndex, node.endIndex).replace(/\s+/g, " ");
const lineOf = (src, node) => src.slice(0, node.startIndex).split("\n").length;

/** `"Foo"` → `Foo`（含转义处理） */
const stringValue = (node) => {
  const raw = node.text;
  return raw.slice(1, -1).replace(/\\(.)/g, "$1");
};

/**
 * selector 键表达式：`ArgUtility.Get(action, 0)`、`action[0]`，以及**从二者初始化的本地变量**
 * （子类常用 `string text = ArgUtility.Get(action, 0);` 再比较 `text`）。
 * 不做数据流传播：只认同一方法体里直接初始化为 selector 表达式的局部变量。
 */
function selectorExpressionKeys(fn, src) {
  const keys = new Set(["ArgUtility.Get(action, 0)", "action[0]"]);
  const isSelectorExpr = (t) => {
    const c = t.replace(/\s+/g, " ");
    return c === "ArgUtility.Get(action, 0)" || c === "action[0]" || keys.has(c);
  };
  for (const d of collect(fn, "variable_declarator")) {
    const init = collect(d, "invocation_expression").find((i) => /ArgUtility\.Get$/.test(i.childForFieldName("function")?.text ?? ""));
    const elem = collect(d, "element_access_expression").find((e) => textOf(src, e) === "action[0]");
    if (!init && !elem) continue;
    const name = d.childForFieldName("name")?.text ?? collect(d, "identifier")[0]?.text;
    if (!name) continue;
    const initText = textOf(src, init ?? elem);
    if (isSelectorExpr(initText)) keys.add(name);
  }
  return { keys, isSelectorExpr };
}

/**
 * 连续 case 标签共享同一个 body。tree-sitter-c-sharp 的切分不稳定：
 * 有时多个标签在同一 section，有时每个标签各占一个 section（body 挂在最后一个）。
 * 规则：没有语句的 section 是纯标签 -> 其标签是下一个有语句 section 的别名。
 *
 * **只取直接子 section**：`collect(sw, "switch_section")` 会递归收进嵌套 switch 的
 * section，使 `Action OpenShop` 内的方向 switch（down/up/left/right）与
 * `Action NPCMessage` 内的对话键 switch（AnimalShop.20 …）被误记成顶层 selector。
 */
function selectorsInSwitch(sw, src) {
  const out = new Map();
  const attach = (map, label, section, groupLabels, site) => {
    if (!map.has(label)) map.set(label, { label, aliases: new Set(), sections: [], site, bodyCaptured: true });
    const row = map.get(label);
    row.sections.push(section);
    for (const g of groupLabels) if (g !== label) row.aliases.add(g);
  };
  const sections = switchSections(sw).sort((a, b) => a.startIndex - b.startIndex);
  let pending = [];
  for (const section of sections) {
    const labels = sectionLabels(section);
    const hasStatements = hasSectionStatements(section);
    const anchor = { line: lineOf(src, section), s: section.startIndex, e: section.endIndex, node: section };
    if (!labels.length && !pending.length) continue;
    if (!hasStatements) {
      pending.push(...labels);
      continue;
    }
    const group = [...pending, ...labels];
    for (const label of group) attach(out, label, anchor, group, "switch");
    pending = [];
  }
  for (const label of pending) attach(out, label, { line: 0, s: 0, e: 0 }, pending, "switch");
  return out;
}

/**
 * `if (ArgUtility.Get(action, 0) == "X")` 形态。子类大多用 if 而不是 switch 分派自己的
 * selector（Woods / IslandEast / FishShop / LibraryMuseum …），只认 switch 会漏掉整族。
 *
 * 负向写法 `if (!(text == "X")) { A } else { B }`——X 的 body 是 **else 分支** B，
 * 不是 A。无 else 时 X 无 body（落到 base.performAction）。
 */
function selectorsInIfs(fn, src, isSelectorExpr) {
  const out = new Map();
  const attach = (label, anchor, groupLabels) => {
    if (!out.has(label)) out.set(label, { label, aliases: new Set(), sections: [], site: "if", bodyCaptured: true });
    const row = out.get(label);
    row.sections.push(anchor);
    if (anchor.bodyCaptured === false) row.bodyCaptured = false;
    for (const g of groupLabels) if (g !== label) row.aliases.add(g);
  };
  for (const ifNode of collect(fn, "if_statement")) {
    const cond = ifNode.childForFieldName("condition");
    if (!cond) continue;
    const matches = [];
    for (const bin of collect(cond, "binary_expression")) {
      const op = bin.children.find((c) => c.type === "==" || c.type === "!=")?.type;
      if (!op) continue;
      const left = bin.childForFieldName("left");
      const right = bin.childForFieldName("right");
      let literal = null;
      if (right?.type === "string_literal" && left && isSelectorExpr(textOf(src, left))) literal = right;
      else if (left?.type === "string_literal" && right && isSelectorExpr(textOf(src, right))) literal = left;
      if (literal) matches.push({ label: stringValue(literal), negated: op === "!=", bin });
    }
    if (!matches.length) continue;
    // 整个条件被 `!` 包住（`!(X == "Y")`）时，命中分支是 else，而不是 consequence。
    // 必须以**确实存在前导 `!`** 为条件：否则 `(X == "Y")` 这种纯括号形式会被误判成否定。
    const condText = textOf(src, cond);
    const strip = (t) => {
      let s = t.trim();
      for (;;) {
        if (s.startsWith("!")) s = s.slice(1).trim();
        else if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1).trim();
        else return s;
      }
    };
    const wholeNegated =
      matches.length === 1 && /^\s*!/.test(condText) && strip(condText) === strip(textOf(src, matches[0].bin));
    let body = ifNode.childForFieldName("consequence");
    if (wholeNegated || (matches.length === 1 && matches[0].negated)) {
      body = ifNode.childForFieldName("alternative");
    }
    const anchor = {
      line: lineOf(src, ifNode),
      s: body ? body.startIndex : ifNode.endIndex,
      e: body ? body.endIndex : ifNode.endIndex,
      node: body ?? ifNode,
      bodyCaptured: Boolean(body),
      negative: Boolean(wholeNegated || (matches.length === 1 && matches[0].negated)),
    };
    const labels = matches.map((m) => m.label);
    for (const label of labels) attach(label, anchor, labels);
  }
  return out;
}

function selectorsInMethod(fn, src) {
  const merged = new Map();
  const { isSelectorExpr } = selectorExpressionKeys(fn, src);
  const sources = [...switchStatements(fn).map((sw) => selectorsInSwitch(sw, src)), selectorsInIfs(fn, src, isSelectorExpr)];
  for (const map of sources) {
    for (const [label, row] of map) {
      if (!merged.has(label)) merged.set(label, { label, aliases: new Set(), sections: [], site: row.site, bodyCaptured: true });
      else if (merged.get(label).site !== row.site) merged.get(label).site = "switch+if";
      const target = merged.get(label);
      for (const s of row.sections) {
        if (target.sections.some((t) => t.line === s.line && t.s === s.s)) continue;
        target.sections.push(s);
      }
      if (row.bodyCaptured === false) target.bodyCaptured = false;
      for (const a of row.aliases) target.aliases.add(a);
    }
  }
  for (const row of merged.values()) {
    row.body = row.sections
      .map((s) => (s.e > s.s ? src.slice(s.s, s.e).replace(/\s+/g, " ") : ""))
      .join(" ");
    row.aliases = [...row.aliases].sort();
  }
  return merged;
}

/**
 * 方法体内的**顶层** switch。递归收 switch 会把嵌套分派误当 selector 来源：
 * `Action OpenShop` 内的方向 switch（down/up/left/right）与 `Action NPCMessage` 内的
 * 对话键 switch（AnimalShop.20 …）都不是地图 Action 词。判据是「方法与该 switch 之间
 * 不再有另一个 switch」。
 */
function switchStatements(method) {
  return collect(method, "switch_statement").filter((sw) => !hasAncestorOfType(sw, "switch_statement", method));
}

/** 祖先 if 条件链（该 selector 自己所在位置之上的条件），到方法体为止。 */
function guardChain(anchor, src, method, limit = 4) {
  const chain = [];
  let n = anchor?.node ?? null;
  if (n && n.type !== "switch_statement" && n.type !== "if_statement") n = n.parent;
  while (n && n !== method && chain.length < limit) {
    if (n.type === "if_statement") {
      const cond = n.childForFieldName("condition");
      if (cond) chain.unshift(src.slice(cond.startIndex, cond.endIndex).replace(/\s+/g, " ").slice(0, 120));
    }
    n = n.parent;
  }
  return chain;
}

/**
 * 同文件 helper 索引：方法名 → 定义列表。BFS 追踪 selector 的调用，
 * 只回填：helper 名、dataTable 访问、菜单/对话/传送信号。
 */
function indexSameFileMethods(tree, src) {
  const index = new Map();
  for (const m of collect(tree.rootNode, "method_declaration")) {
    const name = m.childForFieldName("name")?.text;
    if (!name) continue;
    if (!index.has(name)) index.set(name, []);
    index.get(name).push({
      name,
      line: m.startPosition.row + 1,
      body: src.slice(m.startIndex, m.endIndex).replace(/\s+/g, " "),
    });
  }
  return index;
}

function invocationTexts(body) {
  return [...body.matchAll(/([\w.\[\]]+)\s*\(/g)].map((m) => m[1]).filter((c) => /[A-Za-z_]$/.test(c));
}

/**
 * **同文件**解析只对无接收者（或 `this.`/`base.` 接收者）的调用成立。
 * `character.checkAction(...)` 是跨对象委托，名字碰巧与同文件方法同名，
 * 按名字解析会把它错当成 `GameLocation.checkAction`（实测假阳性：`Crib`、`PlayEvent`）。
 */
const isSameFileCall = (callee) => !callee.includes(".") || /^(this|base)\./.test(callee);

/** 从已解析的 (src, tree) 分析指定类的 dispatcher 实现。 */
function analyzeParsed({ src, tree, className, member, helperDepth }) {
  const methods = collect(tree.rootNode, "method_declaration").filter((m) => {
    if (m.childForFieldName("name")?.text !== member) return false;
    const params = m.childForFieldName("parameters");
    if (!params || params.namedChildren.length === 0) return false;
    if (!TILE_ACTION_PARAMETER_TYPES.has(params.namedChildren[0].childForFieldName("type")?.text ?? "")) return false;
    if (!className) return true;
    let owner = m.parent;
    while (owner && owner.type !== "class_declaration") owner = owner.parent;
    return owner?.childForFieldName?.("name")?.text === className;
  });
  const helperIndex = indexSameFileMethods(tree, src);
  const boundedDepth = Math.max(1, Math.min(helperDepth, 4));

  const rows = [];
  const counts = { selectors: 0, menuBound: 0, dialogueOrEventBound: 0, warpTransition: 0, plainWorldEffect: 0, unknown: 0 };

  for (const m of methods) {
    const selectors = selectorsInMethod(m, src);
    for (const row of selectors.values()) {
      const anchor = { node: row.sections.length ? row.sections[0].node : null };
      const entry = {
        selector: row.label,
        aliases: row.aliases,
        site: row.site,
        bodyCaptured: row.bodyCaptured !== false,
        category: null,
        signals: [],
        sectionLines: row.sections.map((s) => s.line).filter((l) => l > 0),
        directCalls: [],
        helperEffects: [],
        delegatedCalls: [],
        dataTables: [],
        callSignals: [],
        resolveChain: [],
        helpers: [],
        guardChain: guardChain(anchor, src, m),
      };

      // 分类基于该 selector body 自身的信号
      const own = classify(row.body);
      entry.signals = own.signals;
      entry.category = own.category;
      const directCalls = invocationTexts(row.body);
      entry.directCalls = [...new Set(directCalls)].slice(0, 12);
      const ownHelpers = directCalls.filter((c) => isSameFileCall(c) && helperIndex.has(c.split(".").pop()));

      // 同文件 helper BFS（有界深度）：回填 helper 内的信号与数据表。
      // 对所有分类都做（菜单选择器也常把效果路由进 helper，例如
      // MinecartTransport → ShowMenu → DataLoader.Minecarts）。
      // `resolveChain` 是该 selector 的**同文件 helper 解析链**（含多态：同名多定义全列），
      // 是「与已注册 seam 对账」那条 join 的机械凭据。
      {
        const seen = new Set();
        const resolved = new Set();
        let frontier = ownHelpers.map((h) => helperIndex.get(h.split(".").pop()) ?? []);
        for (let depth = 0; depth < boundedDepth && frontier.length > 0; depth += 1) {
          const next = [];
          for (const defs of frontier) {
            for (const def of defs) {
              const key = `${def.line}`;
              if (seen.has(key)) continue;
              seen.add(key);
              resolved.add(`${def.name}@${def.line}`);
              const raw = def.body;
              const via = classify(raw);
              const tables = [...raw.matchAll(new RegExp(DATA_TABLE_SIGNAL.source, "g"))].map((x) => x[0]);
              const delegated = invocationTexts(raw).filter(isDelegateCall);
              if (depth === 0) {
                entry.helperEffects.push({
                  helper: def.name,
                  line: def.line,
                  signals: via.signals,
                  dataTables: [...new Set(tables)],
                  delegatedCalls: delegated.slice(0, 4),
                });
              }
              for (const t of tables) if (!entry.dataTables.includes(t)) entry.dataTables.push(t);
              for (const s of via.signals) if (!entry.callSignals.includes(s)) entry.callSignals.push(s);
              for (const d of delegated) if (!entry.delegatedCalls.includes(d)) entry.delegatedCalls.push(d);
              const nested = invocationTexts(raw)
                .filter(isSameFileCall)
                .map((c) => c.split(".").pop())
                .filter((c) => helperIndex.has(c));
              for (const n of nested) next.push(helperIndex.get(n) ?? []);
            }
          }
          frontier = next;
        }
        entry.resolveChain = [...resolved].sort();
        entry.helpers = [...new Set([...resolved].map((r) => r.split("@")[0]))].sort();
      }

      // 跨类委托：body 中带接收者的调用（不含 Game1/Utility/ArgUtility…）
      for (const c of directCalls) if (isDelegateCall(c) && !entry.delegatedCalls.includes(c)) entry.delegatedCalls.push(c);

      // unknown：body 无任何调用/赋值/控制流（如 `case "None": return true;`），
      // 或 selector 命中但**没有捕获到任何分支体**（子类只在 base 的否定条件里出现）。
      if (
        !entry.bodyCaptured ||
        (!/[\w\]]\s*\(/.test(row.body) && !/=\s*[^=]/.test(row.body.replace(/==|!=|<=|>=/g, "")))
      ) {
        entry.category = "unknown";
      }

      counts.selectors += 1;
      if (entry.category === "menu-bound") counts.menuBound += 1;
      else if (entry.category === "dialogue-or-event-bound") counts.dialogueOrEventBound += 1;
      else if (entry.category === "warp-transition") counts.warpTransition += 1;
      else if (entry.category === "plain-world-effect") counts.plainWorldEffect += 1;
      else counts.unknown += 1;

      rows.push(entry);
    }
  }
  rows.sort((a, b) => a.selector.localeCompare(b.selector));
  return { rows, counts, methodLines: methods.map((m) => m.startPosition.row + 1) };
}


// ---- 入口 -----------------------------------------------------------------
// ---- 入口 -----------------------------------------------------------------

/**
 * 分析单个实现。
 * @param {{sourceRoot:string, relPath:string, member:string, className?:string, parser?:object, helperDepth?:number}} opts
 */
export async function analyzeTileActionSelectors({ sourceRoot, relPath, member, className, parser, helperDepth = 2 }) {
  const p = parser ?? (await createSelectorParser());
  const filePath = path.join(sourceRoot, relPath);
  const src = await readFile(filePath, "utf8");
  const tree = p.parse(src);
  const { rows, counts, methodLines } = analyzeParsed({ src, tree, className, member, helperDepth });
  return artifactFor({ source: { relPath, member, className: className ?? null, methodLines }, helperDepth, counts, rows, implementations: 1 });
}

/**
 * 整树模式：机械枚举 `performAction` 的每个实现（第一参数为 `string[]`/`string`），
 * 不是手抄类名清单。返回按 (file, class) 分组的 selector 清单。
 */
export async function analyzeTileActionSelectorTree({ sourceRoot, parser, helperDepth = 2, member = TILE_ACTION_DISPATCHER_MEMBER }) {
  const p = parser ?? (await createSelectorParser());
  const files = [];
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = `${d}/${e.name}`;
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".cs")) files.push(full);
    }
  };
  await walk(sourceRoot);
  files.sort();

  const rows = [];
  const implementations = [];
  const counts = { selectors: 0, menuBound: 0, dialogueOrEventBound: 0, warpTransition: 0, plainWorldEffect: 0, unknown: 0 };
  for (const full of files) {
    const src = await readFile(full, "utf8");
    if (!src.includes(member)) continue;
    const tree = p.parse(src);
    const rel = path.relative(sourceRoot, full).replace(/\\/g, "/");
    for (const cls of collect(tree.rootNode, "class_declaration")) {
      const className = cls.childForFieldName("name")?.text;
      if (!className) continue;
      const { rows: fileRows, counts: fileCounts, methodLines } = analyzeParsed({
        src,
        tree,
        className,
        member,
        helperDepth,
      });
      if (!fileRows.length && !methodLines.length) continue;
      implementations.push({ file: rel, className, member, methodLines, selectors: fileCounts.selectors });
      for (const k of Object.keys(counts)) counts[k] += fileCounts[k];
      for (const r of fileRows) rows.push({ ...r, file: rel, className });
    }
  }
  rows.sort((a, b) => `${a.file}/${a.className}/${a.selector}`.localeCompare(`${b.file}/${b.className}/${b.selector}`));
  return artifactFor({
    source: { relPath: null, member, className: null, methodLines: [] },
    helperDepth: Math.max(1, Math.min(helperDepth, 4)),
    counts,
    rows,
    implementations: implementations.length,
    implementationRows: implementations,
  });
}

function artifactFor({ source, helperDepth, counts, rows, implementations, implementationRows }) {
  return {
    artifactKind: "stardew_tile_action_selector_analysis",
    schemaVersion: 2,
    source,
    helperDepth,
    implementations,
    implementationRows: implementationRows ?? null,
    counts,
    selectors: rows,
    nonGuarantees: Object.freeze([
      "classification_is_signal_based_not_a_semantic_proof",
      "helper_following_is_same_file_and_bounded_depth",
      "cross_class_delegation_is_recorded_but_not_resolved",
      "content_driven_effects_resolve_through_data_tables_or_runtime_state_and_are_not_enumerated",
      "virtual_dispatch_targets_are_not_resolved",
      "no_action_identity_inferred",
      "plain_world_effect_is_a_review_class_not_an_action_authorization",
      "selector_equality_is_matched_syntactically_against_the_action_argument_so_indirect_or_computed_selectors_are_missed",
      "the_TouchAction_family_is_a_separate_dispatcher_and_is_not_enumerated_here",
    ]),
  };
}

// ---- CLI ------------------------------------------------------------------

function fail(code, message) {
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { pretty: false, "helper-depth": "2" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--pretty") {
      out.pretty = true;
      continue;
    }
    if (!["--source-root", "--rel-path", "--member", "--class", "--helper-depth", "--out"].includes(a)) {
      fail("arguments_invalid", `Bad argument ${a}.`);
    }
    const v = argv[++i];
    if (!v) fail("arguments_invalid", `Missing value for ${a}.`);
    out[a.slice(2)] = v;
  }
  if (!out["source-root"]) fail("arguments_required", "--source-root is required.");
  const single = Boolean(out["rel-path"] || out.member);
  if (single && !(out["rel-path"] && out.member))
    fail("arguments_required", "single-implementation mode needs both --rel-path and --member.");
  return { ...out, mode: single ? "single" : "tree" };
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directRun) {
  const options = parseArgs(process.argv.slice(2));
  try {
    const parser = await createSelectorParser();
    const artifact =
      options.mode === "tree"
        ? await analyzeTileActionSelectorTree({
            sourceRoot: options["source-root"],
            parser,
            helperDepth: Number.parseInt(options["helper-depth"], 10),
            member: options.member ?? TILE_ACTION_DISPATCHER_MEMBER,
          })
        : await analyzeTileActionSelectors({
            sourceRoot: options["source-root"],
            relPath: options["rel-path"],
            member: options.member,
            className: options["class"] ?? undefined,
            parser,
            helperDepth: Number.parseInt(options["helper-depth"], 10),
          });
    const serialized = `${JSON.stringify(artifact, null, options.pretty ? 2 : 0)}\n`;
    if (options.out) {
      await writeFile(options.out, serialized);
      process.stdout.write(
        `${JSON.stringify({
          state: "written",
          out: options.out,
          mode: options.mode,
          member: options.member ?? TILE_ACTION_DISPATCHER_MEMBER,
          implementations: artifact.implementations,
          ...artifact.counts,
        })}\n`,
      );
    } else {
      process.stdout.write(serialized);
    }
  } catch (error) {
    fail(error.code ?? "tile_action_selector_analysis_failed", error.message);
  }
}
