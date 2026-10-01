#!/usr/bin/env node
/**
 * 方法层委托解析：回答「这个方法的调用链最终到达什么」。
 *
 * 为什么需要这一层：九谓词的 P4 问的是「**这个方法体自己有终态写入吗**」，这是
 * 正确的粒度判据。但玩家入口常常是**纯委托**形态 —— 方法体只调 helper，终态在
 * helper 里。`Grass.performToolAction` 就是实例（目标版本 1.6.15）：
 *
 *     public override bool performToolAction(Tool t, int explosion, Vector2 tileLocation)
 *     {
 *         ...                                  // 只有视觉（sound / shake）
 *         numberOfWeeds.Value -= num;          // `-=` → 被判为 DIMINISHING「代价」
 *         createDestroySprites(gameLocation, tileLocation);
 *         return TryDropItemsOnCut(t);         // 终态在这里（Hay 进筒仓）
 *     }
 *
 * 提取结果：`writes=[]`、`delegates=[]`、`calls=[createDestroySprites, TryDropItemsOnCut]`，
 * 于是 P4/P7 拒绝它，它**从后续所有分析里消失** —— 不是因为它是错的，而是因为没有
 * 一层在问「它调用的那些东西最终做了什么」。
 *
 * 本工具补的就是这一层，且**不修改九谓词**：P4 的语义保持原样，这里只增加一个
 * 「委托链到达什么」的下游视角。selector 层早已有同形机制（`resolveChain`），
 * 这里为方法层建同样的东西。
 *
 * 输出是**有界**的：每个方法一条记录，含解析链、链上每个 helper 的效果信号、
 * 以及一个 `reachedEffects` 汇总。不产出 action identity，也不声称链上的效果
 * 就是该方法的终态 —— 那仍是人工裁定（见产物 nonGuarantees）。
 *
 * 效果信号词表复用 `star Dew-source-analysis-vocabulary` 的既有常量，本工具不新增
 * 平行词表；`isGameplayWrite` 复用 branch-writeset 的字段分类（它已处理
 * cosmetic/cost/accessor 后缀）。
 *
 * 用法：
 *   node stardew-method-resolution.mjs \
 *     --source-root <decompiled-root> --rel-path <file.cs> --member <Name> \
 *     [--class <C>] [--depth 3] [--out <file>] [--pretty]
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createParser } from "./stardew-branch-writeset.mjs";
import { STARDEW_MENU_CONSTRUCTOR, STARDEW_MENU_FIELDS, STARDEW_MENU_OPENERS } from "../stardew-source-analysis-vocabulary.mjs";

// ---------------------------------------------------------------------------
// 效果信号：从既有词汇表派生，不新增平行词表
// ---------------------------------------------------------------------------

/** 菜单：字段写入 / 构造 `*Menu` / 名字无 Menu 后缀的开放器 */
function menuSignals(raw) {
  const found = [];
  if (STARDEW_MENU_FIELDS.test(raw)) found.push("menu");
  if (new RegExp(STARDEW_MENU_CONSTRUCTOR.source).test(raw)) found.push("menu");
  for (const opener of STARDEW_MENU_OPENERS) if (raw.includes(opener)) found.push("menu");
  return found;
}

/** 对话/事件：终态交给对话系统 */
const DIALOGUE = /drawObjectDialogue|drawDialogue|multipleDialogues|createQuestionDialogue|CreateQuestionDialogue|createYesNoResponses|CreateYesNoResponses/;

/** 传送 */
const WARP = /warpFarmer|new\s+(?:StardewValley\.)?Warp\s*\(|RequestWarp|doWarp|doLocalWarp/;

/** 世界状态写入：VA 上**没有** `-=`/`--` 的那些（`-=` 是代价，见 branch-writeset） */
const WORLD_WRITE =
  /\.Value\s*=[^=]|\bValue\s*=[^=]|heldObject\s*=|\bTileLocation\s*=|\.Add\(|removeItemFromInventory|addItemToInventory|Items\.Add|debris\.Add|createObjectDebris|createDebris|createRadialDebris/;

/** 筒仓/库存：Hay 入仓这类"存量转移" */
const INVENTORY = /StoreHayInAnySilo|tryToAddHay|addItemToInventory|removeItemFromInventory|AddItem|TryAdd/;

/** 世界实体销毁/变更 */
const DESTRUCTION = /destroyCrop|cutWeed|reduceBy|releaseContents|TryDropItemsOnCut|removeObject|RemoveObject|destroyObject/;

/** 纯表现：单独标记，不构成 gameplay 效果 */
const PRESENTATION = /playSound|localSound|delayedSound|playSoundAfterDelay|flashAlpha|screenGlow|doEmote|shake\(|TemporaryAnimatedSprite|createDestroySprites/;

/**
 * 把方法体按语句切开，并标出哪些语句只是「调用同文件 helper」。
 *
 * 为什么必需：按子串分类会把 `return TryDropItemsOnCut(t);` 当成入口自身的
 * `destruction` 效果，而它其实是一次委托 —— 效果属于链上。这正是让
 * `Grass.performToolAction` 看起来「自己有终态」的同一个混淆。
 * 因此：自己分类时跳过「整条语句就是同文件 helper 调用」的那些语句。
 */
function ownStatements(body, isHelperCall) {
  return body
    .split(/[;{}]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !isHelperCall(s));
}

/** 该语句是否是一条（或一条 return/await 包裹的）同文件 helper 调用。 */
function makeHelperCallTest(index) {
  return (statement) => {
    const m = statement.match(/^(?:return\s+|await\s+|yield\s+return\s+)*([A-Za-z_]\w*)\s*\(/);
    return Boolean(m && index.has(m[1]));
  };
}

/**
 * 信号里哪些不算 gameplay。
 *
 * 单一权威：分类与判定都从这里取，避免同一个规则被写成多份
 * （多份的结果是「把纯表现当成 gameplay」的变异不会被任何测试抓到）。
 */
const PRESENTATION_ONLY = new Set(["presentation"]);

function classifyRaw(raw) {
  const effects = new Set();
  if (menuSignals(raw).length) effects.add("menu");
  if (DIALOGUE.test(raw)) effects.add("dialogue");
  if (WARP.test(raw)) effects.add("warp");
  if (INVENTORY.test(raw)) effects.add("inventory");
  if (DESTRUCTION.test(raw)) effects.add("destruction");
  if (WORLD_WRITE.test(raw)) effects.add("world-write");
  if (PRESENTATION.test(raw)) effects.add("presentation");
  return [...effects];
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

const text = (src, node) => src.slice(node.startIndex, node.endIndex).replace(/\s+/g, " ");
const lineOf = (src, node) => src.slice(0, node.startIndex).split("\n").length;

function collect(node, type, out = []) {
  if (node.type === type) out.push(node);
  for (const child of node.namedChildren) collect(child, type, out);
  return out;
}

/** 同一文件里的方法索引：name -> [{name, line, body, params}]（多态 ⇒ 同名多条） */
function indexMethods(tree, src) {
  const index = new Map();
  for (const m of collect(tree.rootNode, "method_declaration")) {
    const name = m.childForFieldName("name")?.text;
    if (!name) continue;
    if (!index.has(name)) index.set(name, []);
    index.get(name).push({
      name,
      line: lineOf(src, m),
      node: m,
      body: text(src, m),
      params: m.childForFieldName("parameters")?.text ?? "",
    });
  }
  return index;
}

/**
 * 方法体里的调用表达式文本（含接收者）。
 *
 * 必须用 AST：正则会连**方法声明自己**一起匹配（`void entry() { ... }` 里的 `entry(`），
 * 于是 `entry` 被当成自己的 depth-0 helper，链上凭空多出一条自环。
 */
function invocationTexts(src, node) {
  const out = new Set();
  for (const call of collect(node, "invocation_expression")) {
    const fn = call.childForFieldName("function");
    if (fn) out.add(src.slice(fn.startIndex, fn.endIndex).replace(/\s+/g, " "));
  }
  return [...out];
}

/** 本文件内可解析的 helper 名：无接收者，或 `this.X` */
function sameFileCallee(callee) {
  if (callee.includes(".")) return callee.startsWith("this.") ? callee.split(".").pop() : null;
  return callee;
}

/**
 * 有界 BFS：从入口方法出发，沿**同文件 helper** 展开，收集链上每个 helper 的效果。
 *
 * 跨类委托只记录不解析（与 selector 层同一纪律）：无类型信息时无法可靠定位目标文件。
 */
export function resolveMethodChain({ src, tree, className, member, depth = 3 }) {
  const methods = collect(tree.rootNode, "method_declaration").filter((m) => {
    if (m.childForFieldName("name")?.text !== member) return false;
    if (!className) return true;
    let owner = m.parent;
    while (owner && owner.type !== "class_declaration") owner = owner.parent;
    return owner?.childForFieldName?.("name")?.text === className;
  });

  const index = indexMethods(tree, src);
  const bounded = Math.max(1, Math.min(depth, 5));
  const isHelperCall = makeHelperCallTest(index);

  return methods.map((entry) => {
    const ownBody = text(src, entry);
    // 自身效果只看「不是同文件 helper 调用」的语句：委托的效果归链上。
    const ownEffects = classifyRaw(ownStatements(ownBody, isHelperCall).join("; "));
    const rootCalls = invocationTexts(src, entry)
      .map(sameFileCallee)
      .filter((n) => n && index.has(n));

    const seen = new Set();
    const chain = [];
    const helperEffects = [];
    let frontier = [...new Set(rootCalls)];

    for (let d = 0; d < bounded && frontier.length; d += 1) {
      const next = [];
      for (const name of frontier) {
        for (const def of index.get(name) ?? []) {
          const key = `${def.name}@${def.line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          chain.push(key);
          const effects = classifyRaw(def.body);
          helperEffects.push({ helper: def.name, line: def.line, depth: d, effects });
          for (const callee of invocationTexts(src, def.node)) {
            const n = sameFileCallee(callee);
            if (n && index.has(n)) next.push(n);
          }
        }
      }
      frontier = [...new Set(next)];
    }

    // 汇总：入口自身 + 链上所有 helper 的效果并集
    const reached = new Set(ownEffects);
    const chainReached = new Set();
    for (const h of helperEffects)
      for (const e of h.effects) {
        reached.add(e);
        chainReached.add(e);
      }

    // 单一谓词：gameplay = 排除纯表现。三个判定与三个展示字段全部从它派生，
    // 不再各自重复过滤（重复过的结果：把 presentation 当成 gameplay 的变异
    // 打不中任何一个测试，因为每个判定用的都是自己的副本）。
    const isGameplay = (e) => !PRESENTATION_ONLY.has(e);
    const gameplay = [...reached].filter(isGameplay);
    const ownGameplay = ownEffects.filter(isGameplay);
    const chainGameplay = [...chainReached].filter(isGameplay);

    return {
      member,
      methodLine: lineOf(src, entry),
      className,
      ownEffects,
      helperEffects,
      resolveChain: chain.sort(),
      reachedEffects: [...reached].sort(),
      gameplayEffects: gameplay.sort(),
      /**
       * 入口**自身**有无 gameplay 效果 —— 这正是九谓词 P4 的判据。
       *
       * 注意：P4 用的是 branch-writeset 的 writes/delegates 桶，而 `-=` 被归入
       * 「代价」、普通 helper 调用被归入 `calls`，所以一个在本工具里
       * `ownTerminalWrite: true` 的入口（`Grass.performToolAction` 有
       * `numberOfWeeds.Value -= num`）在 P4 眼里仍是 false。两个判据**不相等**，
       * 这是刻意的：本工具不去改 P4，只把「链上还有什么」补上。
       */
      ownTerminalWrite: ownGameplay.length > 0,
      /**
       * 委托链（不含入口自身）到达 gameplay 效果，而入口自身没有。
       *
       * 这是 P4 看不到的那一类：入口是纯转发。
       *   `Grass.performToolAction` 自身只有 destruction+presentation，但链上的
       *   `TryDropItemsOnCut` 到达 inventory（`StoreHayInAnySilo`）。
       */
      chainReachesGameplay: chainGameplay.length > 0 && ownGameplay.length === 0,
      /** 链上（不含入口自身）的 gameplay 效果，供审查直接对照。 */
      chainGameplayEffects: chainGameplay.sort(),
    };
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fail(code, message) {
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { pretty: false, depth: 3 };
  const takes = new Set(["--source-root", "--rel-path", "--member", "--class", "--depth", "--out", "--rejected"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--pretty") {
      out.pretty = true;
      continue;
    }
    if (!takes.has(a)) fail("arguments_invalid", `Unexpected argument ${a}.`);
    const v = argv[++i];
    if (!v || v.startsWith("--")) fail("arguments_invalid", `Missing value for ${a}.`);
    out[a.slice(2)] = v;
  }
  // Batch mode (`--rejected`) resolves every unit a candidates artifact rejected,
  // which is the population the nine predicates removed before any later analysis
  // could see it. Single-unit mode (`--rel-path`+`--member`) is unchanged.
  const batch = Boolean(out.rejected);
  if (!batch && !(out["source-root"] && out["rel-path"] && out.member))
    fail("arguments_required", "Usage: --source-root <root> (--rejected <candidates.json> | --rel-path <file.cs> --member <Name>) [--class <C>] [--depth 3]");
  if (batch && !out["source-root"]) fail("arguments_required", "--source-root is required with --rejected.");
  return out;
}

/** 目标版本源码树里按 basename 定位文件（类的命名空间目录不固定）。 */
export async function findSourceFile(sourceRoot, relPath) {
  const direct = path.join(sourceRoot, relPath);
  try {
    return await readFile(direct, "utf8");
  } catch {
    // fall through to a basename walk
  }
  const want = path.basename(relPath);
  const stack = [sourceRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === want) return readFile(full, "utf8");
    }
  }
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const parser = await createParser();
  const depth = Number(options.depth);

  if (options.rejected) {
    await runBatch({ options, parser, depth });
    return;
  }

  const src = await findSourceFile(options["source-root"], options["rel-path"]);
  if (src === null) fail("source_not_found", options["rel-path"]);

  const tree = parser.parse(src);
  const results = resolveMethodChain({
    src,
    tree,
    className: options.class ?? null,
    member: options.member,
    depth,
  });

  const artifact = {
    artifactKind: "stardew_method_resolution",
    schemaVersion: 1,
    source: {
      relPath: options["rel-path"],
      member: options.member,
      className: options.class ?? null,
      depth,
      parser: {
        runtime: "web-tree-sitter",
        grammar: "@vscode/tree-sitter-wasm/tree-sitter-c-sharp.wasm",
      },
    },
    counts: {
      methods: results.length,
      chainReachesGameplay: results.filter((r) => r.chainReachesGameplay).length,
      ownTerminalWrite: results.filter((r) => r.ownTerminalWrite).length,
    },
    methods: results,
    nonGuarantees: NON_GUARANTEES,
  };

  const json = JSON.stringify(artifact, null, options.pretty ? 2 : 0);
  if (options.out) {
    await writeFile(options.out, json);
    process.stdout.write(`${JSON.stringify({ state: "written", out: options.out, ...artifact.counts })}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

const NON_GUARANTEES = [
  "no_action_identity_inferred",
  "cross_class_delegation_not_resolved",
  "chain_effect_is_not_claimed_as_the_entry_terminal",
  "cost_assignments_are_not_counted_as_world_writes",
];

/**
 * Batch mode: resolve every unit a candidates artifact rejected.
 *
 * This is the population that matters most, because nothing downstream ever sees it:
 * the nine predicates remove a unit, `candidates.unmatchedCandidates` never contains
 * it, and the remaining-actions report therefore has no row for it. `Grass`
 * (`performToolAction`, rejected by P4+P7) is the case that exposed this.
 *
 * Each source file is parsed once and reused for every unit in it.
 */
async function runBatch({ options, parser, depth }) {
  const raw = await readFile(options.rejected, "utf8");
  const candidates = JSON.parse(raw);
  const rejected = candidates.rejectedUnits ?? [];
  const sourceRoot = options["source-root"];

  const byFile = new Map();
  for (const unit of rejected) {
    if (!byFile.has(unit.file)) byFile.set(unit.file, []);
    byFile.get(unit.file).push(unit);
  }

  const units = [];
  const missingFiles = [];
  for (const [file, list] of [...byFile.entries()].sort()) {
    const src = await findSourceFile(sourceRoot, file);
    if (src === null) {
      for (const unit of list) missingFiles.push(`${unit.class}.${unit.member}`);
      continue;
    }
    const tree = parser.parse(src);
    for (const unit of list) {
      const results = resolveMethodChain({ src, tree, className: unit.class, member: unit.member, depth });
      // A member can have several declarations in one file; keep the one on the
      // rejected line when the artifact named it, otherwise every declaration.
      const picked = unit.line ? results.filter((r) => r.methodLine === unit.line) : results;
      for (const r of picked.length ? picked : results) {
        units.push({
          unit: `${unit.class}.${unit.member}`,
          className: unit.class,
          member: unit.member,
          file,
          line: r.methodLine,
          rejectedBy: unit.rejectedBy ?? [],
          ownEffects: r.ownEffects,
          gameplayEffects: r.gameplayEffects,
          chainGameplayEffects: r.chainGameplayEffects ?? [],
          resolveChain: r.resolveChain,
          helperEffects: r.helperEffects,
          ownTerminalWrite: r.ownTerminalWrite,
          chainReachesGameplay: r.chainReachesGameplay,
        });
      }
    }
  }

  const byReach = {
    chain_reaches_gameplay: units.filter((u) => u.chainReachesGameplay).length,
    own_terminal_write: units.filter((u) => u.ownTerminalWrite && !u.chainReachesGameplay).length,
    no_gameplay_effect: units.filter((u) => !u.ownTerminalWrite && !u.chainReachesGameplay).length,
  };

  const artifact = {
    artifactKind: "stardew_method_resolution",
    schemaVersion: 1,
    mode: "batch",
    source: {
      rejectedFrom: options.rejected,
      depth,
      parser: {
        runtime: "web-tree-sitter",
        grammar: "@vscode/tree-sitter-wasm/tree-sitter-c-sharp.wasm",
      },
    },
    counts: { rejectedUnits: rejected.length, resolvedUnits: units.length, filesParsed: byFile.size, ...byReach },
    units,
    nonGuarantees: [...NON_GUARANTEES, "batch_mode_covers_only_units_the_candidates_artifact_rejected"],
  };

  if (missingFiles.length) artifact.unresolvedSourceFiles = missingFiles.sort();

  const json = JSON.stringify(artifact, null, options.pretty ? 2 : 0);
  if (options.out) {
    await writeFile(options.out, json);
    process.stdout.write(`${JSON.stringify({ state: "written", out: options.out, ...artifact.counts })}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

// Same direct-run convention as the other analysis tools: comparing URL strings
// fails on Windows because import.meta.url is file:///E:/... (three slashes).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
