#!/usr/bin/env node
/**
 * 派生「候选 action 单元」全集，并与已注册 action 对账。
 *
 * 单位是 **(原生出口, 实现类)**，不是「原生方法」也不是「玩家意图」：
 *   - 一个原生方法对不同目标类型就是不同操作（`Object.placementAction` 承载
 *     plant_seed / fertilize_tile / place_crab_pot / plant_sapling 四个 action）
 *   - 玩家意图只存在于 catalog/人脑，不能作为机械推导单位
 *
 * 流程：
 *   1. 枚举全部 (出口, 实现类) —— 出口集合 = 已注册 seam 方法名 ∪ 交互形状名
 *   2. 对每个单元跑分支级九谓词（tools/lib/stardew-branch-writeset.mjs）
 *   3. 与已注册 action 的 native seam 对账，输出三类：
 *        matched                  已被 action 承载
 *        unmatched_candidate      有候选分支但无 action —— 候选池
 *        registered_without_candidate  已注册但九谓词全拒 —— 需解释
 *
 * 明确不产出 action identity。候选 ≠ 要做；`registered_without_candidate` ≠ 缺陷
 * （它通常表示 Mod 直接调内部方法，而不是走玩家路径）。
 *
 * 用法：
 *   node tools/derive-stardew-action-candidates.mjs \
 *     --source-root <decompiled-root> --action-register <register.json> [--out <file>] [--pretty]
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { STARDEW_INTERACTION_SHAPES } from "../stardew-source-analysis-vocabulary.mjs";
import { createParser, extractBranches } from "./stardew-branch-writeset.mjs";

/**
 * Interaction shapes come from the game-owned vocabulary module so a registered seam
 * can never be missed and the list has one home.
 */
const INTERACTION_SHAPES = STARDEW_INTERACTION_SHAPES;

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
    if (!["--source-root", "--action-register", "--out"].includes(a)) fail("arguments_invalid", `Bad argument ${a}.`);
    const v = argv[++i];
    if (!v) fail("arguments_invalid", `Missing value for ${a}.`);
    out[a.slice(2)] = v;
  }
  for (const r of ["source-root", "action-register"]) if (!out[r]) fail("arguments_required", `--${r} is required.`);
  return out;
}

const options = parseArgs(process.argv.slice(2));
const sourceRoot = path.resolve(options["source-root"]);

const memberOf = (signature) => {
  const p = signature.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
  return p ? p[p.length - 1].replace(/\s*\($/, "") : signature.trim().split(/\s+/).pop();
};
const baseName = (p) => path.basename(p).replace(/\.cs$/, "");

// ---- 已注册 seam -----------------------------------------------------------

const register = JSON.parse(await readFile(options["action-register"], "utf8"));
const registered = [];
for (const action of register.actions)
  for (const seam of action.seams ?? []) {
    if (seam.kind !== "native") continue;
    registered.push({ actionId: action.actionId, member: memberOf(seam.signature), file: seam.file });
  }
const registeredMembers = new Set(registered.map((r) => r.member));
const registeredKeys = new Set(registered.map((r) => `${r.member}::${baseName(r.file)}`));

const wanted = new Set([...INTERACTION_SHAPES, ...registeredMembers]);

// ---- 枚举 (出口, 实现类) ---------------------------------------------------

const parser = await createParser();
const collect = (node, type, out = []) => {
  if (node.type === type) out.push(node);
  for (const c of node.children) collect(c, type, out);
  return out;
};

const files = [];
const walk = async (d) => {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) await walk(p);
    else if (e.name.endsWith(".cs")) files.push(p);
  }
};
await walk(sourceRoot);

const units = [];
for (const f of files) {
  const src = await readFile(f, "utf8");
  const tree = parser.parse(src);
  const rel = path.relative(sourceRoot, f).replace(/\\/g, "/");
  for (const cls of collect(tree.rootNode, "class_declaration")) {
    const clsName = cls.childForFieldName("name")?.text;
    if (!clsName) continue;
    for (const m of collect(cls, "method_declaration")) {
      const name = m.childForFieldName("name")?.text;
      if (!(name && wanted.has(name))) continue;
      units.push({ member: name, class: clsName, file: rel, line: m.startPosition.row + 1 });
    }
  }
}

// ---- 九谓词 ----------------------------------------------------------------

const candidates = [];
const rejected = [];
for (const u of units) {
  let branches = [];
  try {
    const methods = await extractBranches({
      sourceRoot,
      relPath: u.file,
      memberName: u.member,
      parser,
    });
    const hit = methods.find((m) => m.methodLine === u.line) ?? methods[0];
    branches = hit?.branches ?? [];
  } catch (error) {
    rejected.push({ ...u, rejectedBy: [], extractionError: error.message });
    continue;
  }
  const cands = branches.filter((b) => b.candidate);
  if (cands.length > 0)
    candidates.push({
      ...u,
      candidateBranchCount: cands.length,
      writes: [...new Set(cands.flatMap((b) => b.writes))].sort(),
      delegates: [...new Set(cands.flatMap((b) => b.delegates))].sort(),
    });
  else
    rejected.push({
      ...u,
      rejectedBy: [...new Set(branches.flatMap((b) => b.rejectedBy))].sort(),
      /** 单表达式方法没有分支可判 —— 既非候选也无可拒谓词 */
      rejectedByFallback: branches.length === 0 ? "no_branch" : null,
      extractionError: null,
    });
}

// ---- 对账 ------------------------------------------------------------------

const matched = candidates.filter((c) => registeredKeys.has(`${c.member}::${baseName(c.file)}`));
const unmatched = candidates.filter((c) => !registeredKeys.has(`${c.member}::${baseName(c.file)}`));
const candidateKeys = new Set(candidates.map((c) => `${c.member}::${baseName(c.file)}`));
const registeredWithoutCandidate = registered.filter((r) => !candidateKeys.has(`${r.member}::${baseName(r.file)}`));

const artifact = {
  artifactKind: "stardew_action_candidate_derivation",
  schemaVersion: 1,
  unit: "(native_exit, implementing_class)",
  inputs: { sourceRoot: options["source-root"], actionRegister: options["action-register"] },
  counts: {
    implementationsConsidered: units.length,
    candidatesAfterNinePredicates: candidates.length,
    rejectedByPredicates: rejected.length,
    registeredNativeSeams: registered.length,
    matchedWithRegistered: matched.length,
    unmatchedCandidateUnits: unmatched.length,
    registeredWithoutCandidateSeam: registeredWithoutCandidate.length,
  },
  matched: matched.map((c) => ({ member: c.member, class: c.class, file: c.file, line: c.line })),
  unmatchedCandidates: unmatched.map((c) => ({
    member: c.member,
    class: c.class,
    file: c.file,
    line: c.line,
    candidateBranchCount: c.candidateBranchCount,
    writes: c.writes.slice(0, 8),
    delegates: c.delegates.slice(0, 4),
  })),
  registeredWithoutCandidateSeam: registeredWithoutCandidate.map((r) => ({
    actionId: r.actionId,
    member: r.member,
    file: r.file,
  })),
  rejectedUnits: rejected.map((r) => ({
    member: r.member,
    class: r.class,
    file: r.file,
    line: r.line,
    rejectedBy: r.rejectedBy,
    rejectedByFallback: r.rejectedByFallback ?? null,
    extractionError: r.extractionError,
  })),
  nonGuarantees: Object.freeze([
    "no_action_identity_inferred",
    "unit_is_exit_x_class_not_player_intent",
    "nine_predicates_reject_but_do_not_authorize",
    "unmatched_candidate_is_a_review_input_not_a_required_action",
    "registered_without_candidate_usually_means_mod_calls_the_internal_method_directly",
  ]),
};

const serialized = `${JSON.stringify(artifact, null, options.pretty ? 2 : 0)}\n`;
if (options.out) {
  await writeFile(options.out, serialized);
  process.stdout.write(`${JSON.stringify({ state: "written", out: options.out, ...artifact.counts })}\n`);
} else {
  process.stdout.write(serialized);
}
