#!/usr/bin/env node
/**
 * 玩家可达出口 × 已注册 action × catalog intent 的三方对账。
 *
 * 遵守 `12_STARDEW_PRIMITIVE_ACTION_BASIS.md` 的约束：catalog 不是发现输入。
 * 本工具以**源码可达出口**(registry 的 native seam 对账结果)为准，
 * catalog 只作为**参考列**出现，用于标出「该出口是否已有规划中的 intent」。
 *
 * 规则（全部机械）：
 *   R2  出口是否被某已注册 action 承载（直接命中 native seam）
 *   R3  未承载的出口 → catalog 是否有语义对应的 intent（按 basisPrimitiveIds 词形）
 *   R4  出口是否菜单绑定（固定信号清单，含无 `Menu` 后缀的开放器如 Utility.TryOpenShopMenu）
 *
 * 用法：
 *   node tools/reconcile-stardew-reachable-exits.mjs \
 *     --exits <exits.json> --action-register <register.json> --catalog <catalog.json> \
 *     [--out <file>] [--pretty]
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  STARDEW_EVENT_DIALOGUE_EXITS,
  STARDEW_GAMEPLAY_MUTATIONS,
  STARDEW_MENU_CONSTRUCTOR,
  STARDEW_MENU_FIELDS,
  STARDEW_MENU_OPENERS,
  STARDEW_MENU_UI_EXITS,
  STARDEW_QUERY_HELPER_FILES,
  STARDEW_SEMANTIC_EQUIVALENT_EXITS,
} from "../stardew-source-analysis-vocabulary.mjs";

/**
 * Menu signals (R4). The opener list must include `Utility.TryOpenShopMenu`: its name
 * has no `Menu` suffix, so a `new *Menu(` scan alone misses every shop.
 */
const MENU_FIELDS = STARDEW_MENU_FIELDS;
const MENU_CONSTRUCTOR = STARDEW_MENU_CONSTRUCTOR;
const MENU_OPENERS = STARDEW_MENU_OPENERS;

function fail(code, message) {
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { pretty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--pretty") {
      out.pretty = true;
      continue;
    }
    if (!["--exits", "--action-register", "--catalog", "--game-source-root", "--out"].includes(a))
      fail("arguments_invalid", `Bad argument ${a}.`);
    const v = argv[++i];
    if (!v) fail("arguments_invalid", `Missing value for ${a}.`);
    out[a.slice(2)] = v;
  }
  for (const required of ["exits", "action-register", "catalog"])
    if (!out[required]) fail("arguments_required", `--${required} is required.`);
  return out;
}

const options = parseArgs(process.argv.slice(2));

const exitsArtifact = JSON.parse(await readFile(options.exits, "utf8"));
const register = JSON.parse(await readFile(options["action-register"], "utf8"));
const catalog = JSON.parse(await readFile(options.catalog, "utf8"));

const memberOf = (signature) => {
  const p = signature.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
  return p ? p[p.length - 1].replace(/\s*\($/, "") : signature.trim().split(/\s+/).pop();
};

// ---- 索引 -----------------------------------------------------------------

/** nativeMember → 已注册 actionIds */
const seamToActions = new Map();
for (const action of register.actions)
  for (const seam of action.seams ?? []) {
    if (seam.kind !== "native") continue;
    const m = memberOf(seam.signature);
    if (!seamToActions.has(m)) seamToActions.set(m, new Set());
    seamToActions.get(m).add(action.actionId);
  }

/** 已注册 action 的实现来源（mod_owned 也算"已实现"） */
const implementedActionIds = new Set(register.actions.map((a) => a.actionId));

/**
 * 出口的语义域分类。
 *
 * `17_` 说明 9 个 root 是 source evidence 扩展，“不代表都会暴露给 AI Farmhand；
 * UI/window injection remains forbidden”——所以把菜单/事件出口单独归类，
 * 供 scope/exclusion 决策使用，而不是当作 gameplay action。
 */
const GAMEPLAY_MUTATION = new Set(STARDEW_GAMEPLAY_MUTATIONS);
const MENU_UI_EXIT = new Set(STARDEW_MENU_UI_EXITS);
const EVENT_DIALOGUE_EXIT = new Set(STARDEW_EVENT_DIALOGUE_EXITS);
const QUERY_HELPER_FILES = STARDEW_QUERY_HELPER_FILES;

function domainOf(nativeMember, definedIn) {
  if (definedIn?.some((d) => QUERY_HELPER_FILES.test(d))) return "query_helper";
  if (GAMEPLAY_MUTATION.has(nativeMember)) return "gameplay_mutation";
  if (MENU_UI_EXIT.has(nativeMember)) return "menu_and_ui";
  if (EVENT_DIALOGUE_EXIT.has(nativeMember)) return "event_and_dialogue";
  return "unclassified";
}

// ---- R2：出口的承载判定 ----------------------------------------------------

/** Semantic-equivalence table; each entry carries its own self-contained reason. */
const SEMANTIC_EQUIVALENT = new Map(
  Object.entries(STARDEW_SEMANTIC_EQUIVALENT_EXITS).map(([exit, entry]) => [
    exit,
    { actions: entry.actions, why: entry.why },
  ]),
);

function coverageOf(nativeMember) {
  const direct = seamToActions.get(nativeMember);
  if (direct) return { kind: "direct", actions: [...direct].sort(), why: null };
  const equiv = SEMANTIC_EQUIVALENT.get(nativeMember);
  if (equiv) return { kind: "semantic_equivalent", actions: equiv.actions, why: equiv.why };
  return { kind: "uncovered", actions: [], why: null };
}

// ---- R3：catalog intent 参考 -----------------------------------------------

/** 每个 intent 的可匹配词：intentVariantId + basisPrimitiveIds */
const intentIndex = catalog.records.map((r) => ({
  intentVariantId: r.intentVariantId,
  coverageState: r.coverageState,
  coverageKind: r.coverageKind,
  implementationActionIds: r.implementationActionIds ?? [],
  words: [
    ...new Set(
      [r.intentVariantId.replace(/_variant$|_lifecycle$/, ""), ...(r.basisPrimitiveIds ?? [])]
        .flatMap((s) => String(s).split(/[_\s]+/))
        .filter((w) => w.length >= 4),
    ),
  ],
}));

/** 出口的候选词（下划线切分 + 去常见前缀） */
const wordsOf = (nativeMember) =>
  nativeMember
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .split(/[_\s]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 4);

/**
 * 参考匹配（非权威）：出口词与 intent 词有交集即记为候选。
 * 明确声明这是**参考**——`12_` 禁止把 catalog 当发现输入。
 */
function referenceIntents(nativeMember) {
  const words = new Set(wordsOf(nativeMember));
  if (words.size === 0) return [];
  return intentIndex
    .filter((i) => i.words.some((w) => words.has(w.toLowerCase())))
    .map((i) => ({
      intentVariantId: i.intentVariantId,
      coverageState: i.coverageState,
      coveredByRegisteredAction: i.implementationActionIds.some((a) => implementedActionIds.has(a)),
    }))
    .sort((a, b) => {
      if (a.coveredByRegisteredAction !== b.coveredByRegisteredAction) return a.coveredByRegisteredAction ? 1 : -1;
      return a.coverageState.localeCompare(b.coverageState);
    })
    .slice(0, 6);
}

// ---- R4：菜单绑定 ----------------------------------------------------------

let sharedParser = null;
let parserInit = null;
let parseLibs = null;

async function ensureParser() {
  if (sharedParser) return sharedParser;
  if (!parseLibs) {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    parseLibs = {
      Parser: require("web-tree-sitter").Parser,
      Language: require("web-tree-sitter").Language,
      wasm: require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm"),
    };
    parserInit = parseLibs.Parser.init();
  }
  await parserInit;
  sharedParser = new parseLibs.Parser();
  sharedParser.setLanguage(await parseLibs.Language.load(parseLibs.wasm));
  return sharedParser;
}

async function menuBindingFor(nativeMember, definedIn) {
  if (!definedIn?.length) return { bound: false, signals: [], reason: "no_source_location" };
  if (!options["game-source-root"]) return { bound: null, signals: [], reason: "game_source_root_not_provided" };

  const file = definedIn[0].split(":")[0];
  const parser = await ensureParser();
  const src = await readFile(path.join(options["game-source-root"], file), "utf8");
  const tree = parser.parse(src);
  const collect = (n, t, o = []) => {
    if (n.type === t) o.push(n);
    for (const c of n.children) collect(c, t, o);
    return o;
  };
  const defs = collect(tree.rootNode, "method_declaration").filter(
    (m) => m.childForFieldName("name")?.text === nativeMember,
  );
  const signals = new Set();
  for (const def of defs) {
    const body = src.slice(def.startIndex, def.endIndex);
    if (MENU_FIELDS.test(body)) signals.add("Game1.activeClickableMenu");
    for (const m of body.matchAll(MENU_CONSTRUCTOR)) signals.add(`new ${m[1]}`);
    for (const opener of MENU_OPENERS) if (body.includes(opener)) signals.add(opener);
  }
  return {
    bound: signals.size > 0,
    signals: [...signals].sort(),
    reason: defs.length === 0 ? "member_not_found_in_file" : null,
    methodLine: defs[0]?.startPosition.row + 1 ?? null,
    definedAtLine: Number.parseInt(definedIn[0].split(":")[1], 10),
  };
}

// ---- 对账 ------------------------------------------------------------------

const rows = [];
for (const exit of exitsArtifact.reachableExits) {
  const coverage = coverageOf(exit.nativeMember);
  const menu = await menuBindingFor(exit.nativeMember, exit.definedIn);
  const domain = domainOf(exit.nativeMember, exit.definedIn);
  rows.push({
    nativeMember: exit.nativeMember,
    domain,
    depth: exit.depth,
    root: exit.root,
    definedIn: exit.definedIn,
    coverage,
    menuBinding: menu,
    referenceIntents:
      coverage.kind === "uncovered" && domain === "gameplay_mutation" ? referenceIntents(exit.nativeMember) : [],
  });
}

/** 只有 gameplay_mutation 域的出口参与「还缺哪些 action」的计数 */
const gameplayRows = rows.filter((r) => r.domain === "gameplay_mutation");
const uncovered = gameplayRows.filter((r) => r.coverage.kind === "uncovered");
const direct = gameplayRows.filter((r) => r.coverage.kind === "direct");
const equivalent = gameplayRows.filter((r) => r.coverage.kind === "semantic_equivalent");
const byDomain = {};
for (const r of rows) byDomain[r.domain] = (byDomain[r.domain] ?? 0) + 1;

const artifact = {
  artifactKind: "stardew_reachable_exit_reconciliation",
  schemaVersion: 1,
  /** 输入来源；catalog 仅作参考列（12_ 禁止作为发现输入） */
  inputs: {
    exits: options.exits,
    actionRegister: options["action-register"],
    catalogReference: options.catalog,
    gameSourceRoot: options["game-source-root"] ?? null,
  },
  counts: {
    exits: rows.length,
    byDomain,
    gameplayMutationExits: gameplayRows.length,
    coveredDirect: direct.length,
    coveredSemanticEquivalent: equivalent.length,
    uncovered: uncovered.length,
    uncoveredAndMenuBound: uncovered.filter((r) => r.menuBinding.bound === true).length,
    uncoveredAndNotMenuBound: uncovered.filter((r) => r.menuBinding.bound === false).length,
  },
  rows,
  nonGuarantees: Object.freeze([
    "catalog_is_a_reference_column_not_a_discovery_input",
    "semantic_equivalence_entries_are_curated_and_must_cite_a_reason",
    "menu_signal_detection_is_a_bounded_pattern_match_not_a_proof_of_ui_exclusivity",
    "domain_classification_is_a_named_deny_list_not_a_semantic_proof",
    "reachability_is_bounded_by_max_depth",
    "no_action_identity_inferred",
  ]),
};

const serialized = `${JSON.stringify(artifact, null, options.pretty ? 2 : 0)}\n`;
if (options.out) {
  await writeFile(options.out, serialized);
  process.stdout.write(`${JSON.stringify({ state: "written", out: options.out, ...artifact.counts })}\n`);
} else {
  process.stdout.write(serialized);
}
