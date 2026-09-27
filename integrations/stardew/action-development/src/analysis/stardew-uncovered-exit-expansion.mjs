#!/usr/bin/env node
/**
 * 把「未覆盖的玩家可达出口」按**实现数**展开为候选 action 单元。
 *
 * 为什么需要这一步：一个未覆盖出口不等于一个 action。
 *   `checkForAction`  有 16 个 override —— 每个覆写可能是不同动作（Fence 开门 / Chest / CrabPot / …）
 *   `performAction`   基类有 127 个 case selector —— 它是地图 Action 字符串解释器，不是单一动作
 *   `rotate`          只有 1 个实现（Furniture）—— 才真是一个动作候选
 *
 * 本工具对每个实现跑一次分支级提取，输出：
 *   - 该实现的候选分支数与被拒谓词（复用 tools/lib/stardew-branch-writeset.mjs 的九谓词）
 *   - 该实现的 selector 数（识别解释器形态）
 *   - 归为 single_implementor / multi_implementor / interpreter 三态之一
 *
 * 仍然不推断 action identity；也不声称未覆盖出口必须新增 action。
 *
 * 用法：
 *   node tools/derive-stardew-uncovered-exit-expansion.mjs \
 *     --source-root <decompiled-root> --exits <reconcile.json> [--out <file>] [--pretty]
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createParser, extractBranches } from "./stardew-branch-writeset.mjs";

/** 解释器阈值：case selector 数超过此值即视为 selector 解释器而非单一动作 */
const INTERPRETER_SELECTOR_THRESHOLD = 8;

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
    if (!["--source-root", "--exits", "--out"].includes(a)) fail("arguments_invalid", `Bad argument ${a}.`);
    const v = argv[++i];
    if (!v) fail("arguments_invalid", `Missing value for ${a}.`);
    out[a.slice(2)] = v;
  }
  for (const required of ["source-root", "exits"])
    if (!out[required]) fail("arguments_required", `--${required} is required.`);
  return out;
}

const options = parseArgs(process.argv.slice(2));
const sourceRoot = path.resolve(options["source-root"]);
const reconciliation = JSON.parse(await readFile(options.exits, "utf8"));

const uncovered = reconciliation.rows.filter(
  (r) => r.domain === "gameplay_mutation" && r.coverage.kind === "uncovered",
);
if (uncovered.length === 0) fail("no_uncovered_exits", "reconciliation has no uncovered gameplay exits.");

const parser = await createParser();
const collect = (node, type, out = []) => {
  if (node.type === type) out.push(node);
  for (const c of node.children) collect(c, type, out);
  return out;
};

// ---- 枚举全部定义 ----------------------------------------------------------

const files = [];
const walk = async (d) => {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) await walk(p);
    else if (e.name.endsWith(".cs")) files.push(p);
  }
};
await walk(sourceRoot);

const wanted = new Set(uncovered.map((r) => r.nativeMember));
/** nativeMember → [{file, cls, line, isOverride, isVirtual}] */
const definitions = new Map([...wanted].map((m) => [m, []]));

for (const f of files) {
  const src = await readFile(f, "utf8");
  const tree = parser.parse(src);
  for (const cls of collect(tree.rootNode, "class_declaration")) {
    const clsName = cls.childForFieldName("name")?.text ?? "(unknown)";
    for (const m of collect(cls, "method_declaration")) {
      const name = m.childForFieldName("name")?.text;
      if (!(name && wanted.has(name))) continue;
      const head = src.slice(m.startIndex, Math.min(m.startIndex + 240, m.endIndex)).split("{")[0];
      definitions.get(name).push({
        file: path.relative(sourceRoot, f).replace(/\\/g, "/"),
        cls: clsName,
        line: m.startPosition.row + 1,
        isOverride: /\boverride\b/.test(head),
        isVirtual: /\bvirtual\b/.test(head),
      });
    }
  }
}

// ---- 对每个实现跑分支级提取 ------------------------------------------------

const expansions = [];
for (const exit of uncovered) {
  const defs = definitions.get(exit.nativeMember) ?? [];
  const units = [];
  for (const def of defs) {
    const src = await readFile(path.join(sourceRoot, def.file), "utf8");
    const tree = parser.parse(src);
    const cls = collect(tree.rootNode, "class_declaration").find((c) => c.childForFieldName("name")?.text === def.cls);
    const method = cls
      ? collect(cls, "method_declaration").find(
          (m) => m.childForFieldName("name")?.text === exit.nativeMember && m.startPosition.row + 1 === def.line,
        )
      : null;
    const selectorCount = method
      ? (src.slice(method.startIndex, method.endIndex).match(/case\s+"[^"]*"\s*:/g) ?? []).length
      : 0;

    let branches = [];
    let extractionError = null;
    try {
      const methods = await extractBranches({
        sourceRoot,
        relPath: def.file,
        memberName: exit.nativeMember,
        parser,
      });
      const hit = methods.find((m) => m.methodLine === def.line) ?? methods[0];
      branches = hit?.branches ?? [];
    } catch (error) {
      extractionError = error.message;
    }

    const candidates = branches.filter((b) => b.candidate);
    const rejectedBy = [...new Set(branches.flatMap((b) => b.rejectedBy))].sort();
    units.push({
      class: def.cls,
      file: def.file,
      methodLine: def.line,
      isOverride: def.isOverride,
      isVirtual: def.isVirtual,
      selectorCount,
      branchCount: branches.length,
      candidateCount: candidates.length,
      rejectedBy,
      candidateBranches: candidates.slice(0, 4).map((b) => ({
        key: b.key,
        condition: b.condition.slice(0, 120),
        writes: b.writes.slice(0, 6),
        delegates: b.delegates.slice(0, 4),
      })),
      extractionError,
    });
  }

  const implementorCount = defs.length;
  const isInterpreter = units.some((u) => u.selectorCount >= INTERPRETER_SELECTOR_THRESHOLD);
  const shape = implementorCount <= 1 ? "single_implementor" : isInterpreter ? "interpreter" : "multi_implementor";

  expansions.push({
    nativeMember: exit.nativeMember,
    depth: exit.depth,
    definedIn: exit.definedIn,
    menuBinding: exit.menuBinding,
    referenceIntents: exit.referenceIntents,
    shape,
    implementorCount,
    candidateUnitCount: units.filter((u) => u.candidateCount > 0).length,
    units,
  });
}

const artifact = {
  artifactKind: "stardew_uncovered_exit_expansion",
  schemaVersion: 1,
  interpreterSelectorThreshold: INTERPRETER_SELECTOR_THRESHOLD,
  inputs: { sourceRoot: options["source-root"], reconciliation: options.exits },
  counts: {
    uncoveredExits: expansions.length,
    singleImplementor: expansions.filter((e) => e.shape === "single_implementor").length,
    multiImplementor: expansions.filter((e) => e.shape === "multi_implementor").length,
    interpreter: expansions.filter((e) => e.shape === "interpreter").length,
    totalImplementors: expansions.reduce((n, e) => n + e.implementorCount, 0),
    totalCandidateUnits: expansions.reduce((n, e) => n + e.candidateUnitCount, 0),
  },
  expansions,
  nonGuarantees: Object.freeze([
    "no_action_identity_inferred",
    "one_implementor_does_not_imply_one_action",
    "selector_count_is_a_heuristic_for_interpreter_shape_not_a_proof",
    "candidate_branch_is_a_derivation_input_not_a_publishable_action",
  ]),
};

const serialized = `${JSON.stringify(artifact, null, options.pretty ? 2 : 0)}\n`;
if (options.out) {
  await writeFile(options.out, serialized);
  process.stdout.write(`${JSON.stringify({ state: "written", out: options.out, ...artifact.counts })}\n`);
} else {
  process.stdout.write(serialized);
}
