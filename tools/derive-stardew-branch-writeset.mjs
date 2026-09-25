#!/usr/bin/env node
/**
 * 从目标版本反编译源码提取「分支级写入集合」，用于审查 action 边界。
 *
 * 这不是 action 注册表，也不推断无法静态确定的效果。它的用途是回答：
 *   「某个原生方法里，哪些分支构成候选 action，哪些分支被 UI/输入/RNG/
 *     异质委托排除」——把 18_ ledger 那类人工裁定变成可复跑的事实。
 *
 * 用法：
 *   node tools/derive-stardew-branch-writeset.mjs \
 *     --source-root <decompiled-root> --rel-path <file.cs> --member <Name> [--pretty]
 *
 * `--source-root` 指向目标版本的反编译源码树（例如仓库内的
 * `ref/external/StardewValleyDecompiled/Stardew Valley`）。本工具只读源码，
 * 不启动游戏、不碰 UI、不执行 action。
 */

import { writeFile } from "node:fs/promises";
import { createParser, extractBranches } from "./lib/stardew-branch-writeset.mjs";

const OPTIONS = new Set(["--source-root", "--rel-path", "--member", "--out"]);

function fail(code, message) {
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = { pretty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pretty") {
      result.pretty = true;
      continue;
    }
    if (!OPTIONS.has(arg)) fail("arguments_invalid", `Unexpected argument ${arg}.`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) fail("arguments_invalid", `Missing value for ${arg}.`);
    result[arg.slice(2)] = value;
  }
  if (!(result["source-root"] && result["rel-path"] && result.member))
    fail(
      "arguments_required",
      "Usage: --source-root <decompiled-root> --rel-path <file.cs> --member <Name> [--out <file>] [--pretty]",
    );
  return result;
}

const options = parseArgs(process.argv.slice(2));
const parser = await createParser();

let methods;
try {
  methods = await extractBranches({
    sourceRoot: options["source-root"],
    relPath: options["rel-path"],
    memberName: options.member,
    parser,
  });
} catch (error) {
  fail(error.code ?? "branch_writeset_failed", error.message);
}

if (methods.length === 0) fail("member_not_found", `${options["rel-path"]} has no method named ${options.member}.`);

const artifact = {
  artifactKind: "stardew_branch_writeset",
  schemaVersion: 1,
  source: {
    relPath: options["rel-path"],
    member: options.member,
    parser: {
      runtime: "web-tree-sitter",
      grammar: "@vscode/tree-sitter-wasm/tree-sitter-c-sharp.wasm",
    },
  },
  methods: methods.map((m) => ({
    methodLine: m.methodLine,
    maximalRegions: m.maximalRegions,
    nestedRegions: m.nestedRegions,
    candidateBranchCount: m.branches.filter((b) => b.candidate).length,
    branches: m.branches,
  })),
  /** 明确声明本产物不做什么 */
  nonGuarantees: Object.freeze([
    "no_action_identity_inferred",
    "no_postcondition_inferred_across_delegation",
    "no_content_or_rng_effect_inferred",
    "not_a_publishable_action_catalog",
  ]),
};

const serialized = `${JSON.stringify(artifact, null, options.pretty ? 2 : 0)}\n`;
if (options.out) {
  await writeFile(options.out, serialized);
  process.stdout.write(
    `${JSON.stringify({
      state: "written",
      out: options.out,
      member: options.member,
      methods: methods.length,
      candidateBranches: artifact.methods.reduce((n, m) => n + m.candidateBranchCount, 0),
    })}\n`,
  );
} else {
  process.stdout.write(serialized);
}
