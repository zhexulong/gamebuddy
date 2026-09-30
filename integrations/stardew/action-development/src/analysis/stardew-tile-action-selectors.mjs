#!/usr/bin/env node
/**
 * 地图瓦片 Action 选择器分析（tile-Action dispatcher 的 selector 层）。
 *
 * 单位是 **selector**（switch 里 `case "Name":` 的动作词），不是方法也不是分支：
 * `GameLocation.performAction` 在 `if (who.IsLocalPlayer)` 内用 switch 解释地图
 * 属性字符串（`Action MinecartTransport`、`Action WishingWell` …）。per-method 的
 * 九谓词（stardew-branch-writeset）对这一层失效——selector 的效果几乎总是路由进
 * 一个被调用的 helper 或菜单（`MinecartTransport` 只调 `ShowMineCartMenu(...)`，
 * 无字段写入、无 DELEGATE 匹配，P4 直接拒绝它）。
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
 * 不产出 action identity；plain 分类也不等于「可支持 action」。
 *
 * 用法：
 *   node integrations/stardew/action-development/src/analysis/stardew-tile-action-selectors.mjs \
 *     --source-root <decompiled-root> --rel-path StardewValley/GameLocation.cs --member performAction \
 *     [--class GameLocation] [--helper-depth 2] [--out <file>] [--pretty]
 */

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/** 无效果 / 纯控制：body 里没有调用也没有赋值 */
const BODY_HAS_STATEMENT = /[.;]\s*$|return|if\s*\(|switch\s*\(/;

/**
 * 信号按优先级归类：menu > dialogue/event > warp > plain。
 * plain = 三者都不是（可能有世界写入或本地 helper 调用）。
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

// ---- 分析 ---------------------------------------------------------------

function switchStatements(method) {
  return collect(method, "switch_statement");
}

/** selector → {label, aliases, sections:[{s,e,line}], body 合并文本} */
function selectorsInMethod(fn, src) {
  const out = new Map();
  const attach = (map, label, section, groupLabels) => {
    if (!map.has(label)) map.set(label, { label, aliases: new Set(), sections: [] });
    const row = map.get(label);
    row.sections.push(section);
    for (const g of groupLabels) if (g !== label) row.aliases.add(g);
  };
  for (const sw of switchStatements(fn)) {
    const sections = collect(sw, "switch_section").sort((a, b) => a.startIndex - b.startIndex);
    // 连续 case 标签共享同一个 body。tree-sitter-c-sharp 的切分不稳定：
    // 有时多个标签在同一 section，有时每个标签各占一个 section（body 挂在最后一个）。
    // 规则：没有语句的 section 是纯标签 -> 其标签是下一个有语句 section 的别名。
    let pending = [];
    for (const section of sections) {
      const body = src.slice(section.startIndex, section.endIndex);
      const labels = [...body.matchAll(/case\s+"((?:[^"\\]|\\.)*)"\s*:/g)].map((m) => m[1]);
      const hasStatements = section.namedChildren.some(
        (c) =>
          !["constant_pattern", "case_switch_label", "default_switch_label"].includes(c.type),
      );
      const rowObj = { line: src.slice(0, section.startIndex).split("\n").length, s: section.startIndex, e: section.endIndex };
      if (!labels.length && !pending.length) continue;
      if (!hasStatements) {
        pending.push(...labels);
        continue;
      }
      const group = [...pending, ...labels];
      for (const label of group) attach(out, label, rowObj, group);
      pending = [];
    }
    // 悬空别名（末尾没有 body —— 原始代码里不应出现）
    for (const label of pending) attach(out, label, { line: 0, s: 0, e: 0 }, pending);
  }
  for (const row of out.values()) {
    row.body = row.sections.map((s) => (s.e > s.s ? src.slice(s.s, s.e).replace(/\s+/g, " ") : "")).join(" ");
    row.aliases = [...row.aliases].sort();
  }
  return out;
}

/** 祖先 if 条件链（switch 被包在哪些条件里）—— 记录但不参与分类 */
function guardChain(sw, src, limit = 4) {
  const chain = [];
  let n = sw.parent;
  while (n && chain.length < limit) {
    if (n.type === "if_statement") {
      const cond = n.childForFieldName("condition");
      if (cond) chain.unshift(src.slice(cond.startIndex, cond.endIndex).replace(/\s+/g, " ").slice(0, 120));
    }
    n = n.parent;
  }
  return chain;
}

/**
 * 同文件 helper 索引：方法名 → 定义列表。BFS 追踪 plain 选择器的调用，
 * 只回填：helper 名、dataTable 访问、菜单/对话/传送信号。
 */
function indexSameFileMethods(tree, src) {
  const index = new Map();
  for (const m of collect(tree.rootNode, "method_declaration")) {
    const name = m.childForFieldName("name")?.text;
    if (!name) continue;
    if (!index.has(name)) index.set(name, []);
    index.get(name).push({
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
 * 主入口。
 * @param {{sourceRoot:string, relPath:string, member:string, className?:string, parser?:object, helperDepth?:number}} opts
 */
export async function analyzeTileActionSelectors({ sourceRoot, relPath, member, className, parser, helperDepth = 2 }) {
  const p = parser ?? (await createSelectorParser());
  const filePath = path.join(sourceRoot, relPath);
  const src = await readFile(filePath, "utf8");
  const tree = p.parse(src);

  const methods = collect(tree.rootNode, "method_declaration").filter((m) => {
    if (m.childForFieldName("name")?.text !== member) return false;
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
    const switchNodes = switchStatements(m);
    for (const row of selectors.values()) {
      const entry = {
        selector: row.label,
        aliases: row.aliases,
        category: null,
        signals: [],
        sectionLines: row.sections.map((s) => s.line),
        directCalls: [],
        helperEffects: [],
        delegatedCalls: [],
        dataTables: [],
        callSignals: [],
        guardChain: guardChain(switchNodes[0], src),
      };

      // 分类基于 selector body 自身的信号
      const own = classify(row.body);
      entry.signals = own.signals;
      entry.category = own.category;
      const directCalls = invocationTexts(row.body);
      entry.directCalls = [...new Set(directCalls)].slice(0, 12);
      const ownHelpers = directCalls.filter((c) => helperIndex.has(c.split(".").pop()));

      // 同文件 helper BFS（有界深度）：回填 helper 内的信号与数据表。
      // 对所有分类都做（菜单选择器也常把效果路由进 helper，例如
      // MinecartTransport → ShowMineCartMenu → DataLoader.Minecarts）。
      {
        const seen = new Set();
        let frontier = ownHelpers.map((h) => helperIndex.get(h.split(".").pop()) ?? []);
        for (let depth = 0; depth < boundedDepth && frontier.length > 0; depth += 1) {
          const next = [];
          for (const defs of frontier) {
            for (const def of defs) {
              const key = `${def.line}`;
              if (seen.has(key)) continue;
              seen.add(key);
              const raw = def.body;
              const via = classify(raw);
              const tables = [...raw.matchAll(new RegExp(DATA_TABLE_SIGNAL.source, "g"))].map((x) => x[0]);
              const delegated = invocationTexts(raw).filter(isDelegateCall);
              if (depth === 0) {
                entry.helperEffects.push({
                  helper: raw.match(/(\w+)\s*\(/)?.[1] ?? "?",
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
                .map((c) => c.split(".").pop())
                .filter((c) => helperIndex.has(c));
              for (const n of nested) next.push(helperIndex.get(n) ?? []);
            }
          }
          frontier = next;
        }
      }

      // 跨类委托：body 中带接收者的调用（不含 Game1/Utility/ArgUtility…）
      for (const c of directCalls) if (isDelegateCall(c) && !entry.delegatedCalls.includes(c)) entry.delegatedCalls.push(c);

      // unknown：body 无任何调用/赋值/控制流（如 `case "None": return true;`）
      if (!/[\w\]]\s*\(/.test(row.body) && !/=\s*[^=]/.test(row.body.replace(/==|!=|<=|>=/g, ""))) {
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
  return {
    artifactKind: "stardew_tile_action_selector_analysis",
    schemaVersion: 1,
    source: { relPath, member, className: className ?? null, methodLines: methods.map((m) => m.startPosition.row + 1) },
    helperDepth: boundedDepth,
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
  for (const r of ["source-root", "rel-path", "member"])
    if (!out[r]) fail("arguments_required", "--source-root --rel-path --member are required.");
  return out;
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directRun) {
  const options = parseArgs(process.argv.slice(2));
  try {
    const parser = await createSelectorParser();
    const artifact = await analyzeTileActionSelectors({
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
        `${JSON.stringify({ state: "written", out: options.out, member: options.member, ...artifact.counts })}\n`,
      );
    } else {
      process.stdout.write(serialized);
    }
  } catch (error) {
    fail(error.code ?? "tile_action_selector_analysis_failed", error.message);
  }
}