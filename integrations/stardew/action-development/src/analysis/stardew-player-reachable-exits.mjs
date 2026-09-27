#!/usr/bin/env node
/**
 * 从玩家输入根做**有界可达性枚举**，得到玩家可达的原生动作出口。
 *
 * 为什么不能用方法名清单（两次实测失败）：
 *   ① 手写 10 个方法名 → 漏掉 12/36 已注册 seam（`receiveGift`/`addItem`/`createItem`/
 *      `GetItemsForPlayer` 等不在任何"交互入口"直觉清单里）
 *   ② 用 `HOST_MEMBER_NAMES`（deliberately-broad discovery family）→ 786 条目、
 *      310 个假候选（`SaveGame.getLoadEnumerator`、`NPC.update`、`Game1.updateTextEntry`）
 *
 * 正确来源是控制流根：`Game1.pressActionButton` / `Game1.pressUseToolButton`
 * （由 `stardew-native-transition-ledger.control-slice.fixture.json` 的 `rootBindings` 绑定）。
 * 出口按方法名在调用图上有界展开得到，深度可查。
 *
 * 本工具不推断 action identity；transition ledger 仍是 transition 的 authority
 * （其 `closureState` 目前为 `partial`）。
 *
 * 用法：
 *   node tools/derive-stardew-player-reachable-exits.mjs \
 *     --source-root <decompiled-root> [--action-register <json>] \
 *     [--max-depth 4] [--out <file>] [--pretty]
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  STARDEW_GAMEPLAY_SHAPES,
  STARDEW_INGRESS_ROOT_GROUPS,
  STARDEW_ROUTING_LAYER_DEPTH,
  STARDEW_ROUTING_LAYER_SHAPE,
} from "../stardew-source-analysis-vocabulary.mjs";

const require = createRequire(import.meta.url);
const { Language, Parser } = require("web-tree-sitter");
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm")));

/**
 * 玩家输入根。对应 `17_WHOLE_GAME_SOURCE_FIRST_SEMANTIC_KERNEL_ATLAS` 记录的 9 个
 * normal-player ingress roots（其 one-to-many 到原生方法）。
 *
 * 索引（解析全部 .cs）是唯一昂贵步骤，约 7.5s；每多一个根只增加毫秒级 BFS。
 * 所以覆盖全部 9 个根几乎没有额外成本，但能改变结论：只取前 2 个根时
 * `CraftingRecipe.createItem`（craft_item / cook_recipe）看起来不可达，
 * 加入 `menu_semantic_selection` 后它变成 d1 可达。
 */
const ROOT_GROUPS = STARDEW_INGRESS_ROOT_GROUPS;

/** Gameplay-shaped exits; the register's seam members are unioned in below. */
const GAMEPLAY_SHAPE = STARDEW_GAMEPLAY_SHAPES;

const ROUTING_LAYER_SHAPE = STARDEW_ROUTING_LAYER_SHAPE;
const ROUTING_LAYER_DEPTH = STARDEW_ROUTING_LAYER_DEPTH;

function fail(code, message) {
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { pretty: false, "max-depth": "4" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--pretty") {
      out.pretty = true;
      continue;
    }
    const v = argv[++i];
    if (!(["--source-root", "--out", "--action-register", "--max-depth"].includes(a) && v))
      fail("arguments_invalid", `Bad argument ${a}.`);
    out[a.slice(2)] = v;
  }
  if (!out["source-root"])
    fail(
      "arguments_required",
      "Usage: --source-root <decompiled-root> [--action-register <json>] [--max-depth N] [--out <file>] [--pretty]",
    );
  return out;
}

const options = parseArgs(process.argv.slice(2));
const maxDepth = Number.parseInt(options["max-depth"], 10);
if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 8) fail("arguments_invalid", "--max-depth must be 1..8");

const collect = (node, type, out = []) => {
  if (node.type === type) out.push(node);
  for (const c of node.children) collect(c, type, out);
  return out;
};

// ---- 索引：方法名 → 其调用到的裸方法名集合 ---------------------------------

const sourceRoot = path.resolve(options["source-root"]);
const files = [];
const walk = async (d) => {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) await walk(p);
    else if (e.name.endsWith(".cs")) files.push(p);
  }
};
await walk(sourceRoot);

const methods = new Map(); // name -> [{file, member, line, calls:[name]}]
for (const f of files) {
  const src = await readFile(f, "utf8");
  const tree = parser.parse(src);
  const rel = path.relative(sourceRoot, f).replace(/\\/g, "/");
  for (const fn of collect(tree.rootNode, "method_declaration")) {
    const name = fn.childForFieldName("name")?.text;
    if (!name) continue;
    const calls = new Set();
    for (const i of collect(fn, "invocation_expression")) {
      const callee = i.childForFieldName("function");
      if (!callee) continue;
      const tail = src.slice(callee.startIndex, callee.endIndex).split(".").pop();
      calls.add(tail.replace(/^\(+/, "").replace(/\s+/g, ""));
    }
    if (!methods.has(name)) methods.set(name, []);
    methods.get(name).push({ file: rel, line: fn.startPosition.row + 1, calls: [...calls] });
  }
}

// ---- 有界 BFS（同时记录每个出口的最短根与路径）-----------------------------

const ALL_ROOT_METHODS = Object.values(ROOT_GROUPS).flat();
const ROOT_METHOD_SET = new Set(ALL_ROOT_METHODS);
/** @type {Map<string, {depth:number, root:string, path:string[]}>} */
const depthOfMember = new Map();
let frontier = ALL_ROOT_METHODS.map((name) => ({ name, depth: 0, root: name, path: [name] }));
while (frontier.length > 0) {
  const next = [];
  for (const node of frontier) {
    const previous = depthOfMember.get(node.name);
    if (previous !== undefined && previous.depth <= node.depth) continue;
    depthOfMember.set(node.name, { depth: node.depth, root: node.root, path: node.path });
    const defs = methods.get(node.name) ?? [];
    if (defs.length === 0) continue;
    if (node.depth >= maxDepth) continue;
    for (const def of defs) {
      for (const callee of def.calls) {
        next.push({ name: callee, depth: node.depth + 1, root: node.root, path: [...node.path, callee] });
      }
    }
  }
  frontier = next;
}

// 只保留 gameplay 形状的出口，并记录其最短深度
const reached = new Map();
for (const [name, info] of depthOfMember) {
  const shaped = GAMEPLAY_SHAPE.test(name);
  const routingLayer = info.depth === ROUTING_LAYER_DEPTH && ROUTING_LAYER_SHAPE.test(name);
  if (!(shaped || routingLayer)) continue;
  // 根自身也算入口（如 tryToCheckAt 既是根又直接是 pickup_forage 的 seam）
  if (info.depth === 0 && !ROOT_METHOD_SET.has(name) && !GAMEPLAY_SHAPE.test(name)) continue;
  const defs = methods.get(name) ?? [];
  reached.set(name, {
    depth: info.depth,
    root: info.root,
    layer: shaped ? "gameplay_seam" : "routing_layer_check",
    definedIn: defs.map((d) => `${d.file}:${d.line}`).slice(0, 4),
  });
}

// ---- 已注册 seam 对账 ------------------------------------------------------

let registerReport = null;
if (options["action-register"]) {
  const register = JSON.parse(await readFile(options["action-register"], "utf8"));
  const memberOf = (sig) => {
    const p = sig.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
    return p ? p[p.length - 1].replace(/\s*\($/, "") : sig.trim().split(/\s+/).pop();
  };
  const bySeam = new Map();
  for (const a of register.actions) {
    for (const s of a.seams ?? []) {
      if (s.kind !== "native") continue;
      const m = memberOf(s.signature);
      if (!bySeam.has(m)) bySeam.set(m, []);
      bySeam.get(m).push(a.actionId);
    }
  }
  const reachable = [];
  const unreachable = [];
  for (const [m, actionIds] of [...bySeam].sort()) {
    const hit = depthOfMember.get(m);
    const entry = {
      nativeMember: m,
      actionIds: [...new Set(actionIds)].sort(),
      depth: hit?.depth ?? null,
      root: hit?.root ?? null,
    };
    if (hit === undefined) unreachable.push(entry);
    else reachable.push(entry);
  }
  registerReport = {
    seamCount: bySeam.size,
    reachableCount: reachable.length,
    unreachableCount: unreachable.length,
    reachable,
    unreachable,
  };
}

// ---- 产物 ------------------------------------------------------------------

const artifact = {
  artifactKind: "stardew_player_reachable_exits",
  schemaVersion: 1,
  maxDepth,
  rootGroups: Object.fromEntries(
    Object.entries(ROOT_GROUPS).map(([id, members]) => [
      id,
      {
        members,
        resolved: members.map((m) => ({ member: m, methodLine: methods.get(m)?.[0]?.line ?? null })),
      },
    ]),
  ),
  indexedMethodCount: methods.size,
  reachableExits: [...reached]
    .map(([nativeMember, v]) => ({
      nativeMember,
      depth: v.depth,
      root: v.root,
      layer: v.layer,
      definedIn: v.definedIn,
    }))
    .sort((a, b) => a.depth - b.depth || a.nativeMember.localeCompare(b.nativeMember)),
  registerReconciliation: registerReport,
  nonGuarantees: Object.freeze([
    "no_action_identity_inferred",
    "no_dynamic_dispatch_resolution_virtual_calls_are_followed_by_name_only",
    "reachability_is_bounded_by_max_depth_and_is_not_a_proof_of_exhaustive_closure",
    "transition_ledger_closure_state_is_partial_and_remains_the_authority_for_transitions",
  ]),
};

const serialized = `${JSON.stringify(artifact, null, options.pretty ? 2 : 0)}\n`;
if (options.out) {
  await writeFile(options.out, serialized);
  process.stdout.write(
    `${JSON.stringify({
      state: "written",
      out: options.out,
      reachableExits: artifact.reachableExits.length,
      seamReachable: registerReport?.reachableCount ?? null,
      seamUnreachable: registerReport?.unreachableCount ?? null,
    })}\n`,
  );
} else {
  process.stdout.write(serialized);
}
