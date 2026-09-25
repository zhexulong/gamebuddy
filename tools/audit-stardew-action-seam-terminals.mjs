#!/usr/bin/env node
/**
 * 审计「已注册 action 的 native seam 是否指向终态位置」。
 *
 * 为什么需要它：`native-multiplayer-sensitivity.v1.json` 的 seam 记录由人工编写
 * （见 generator 里的硬编码表），实测至少 3 处指向的不是终态位置：
 *   `ship_item`     → `Farm.getShippingBin`    取 IInventory 句柄，真入口是 `Farm.shipItem`
 *   `harvest_crop`  → `HoeDirt.performUseAction` 路由，真终态在 `HoeDirt.destroyCrop` 的 `crop = null`
 *   `place_wood_fence` → `Object.canBePlacedHere` 纯判断（**已修复**，现引用 `Object.placementAction`）
 *
 * 判据（全机械）：
 *   seam_ok                    方法内有候选分支 —— 终态在此，引用正确
 *   terminal_in_delegate       自身无候选但有委托 —— 终态在委托目标，seam 仍是入口
 *   seam_writes_but_no_terminal 有写入但被判为非终态 —— 需查它调用的哪个方法才是终态
 *   seam_not_terminal          无写入也无委托 —— 只判断/取引用，引用错误
 *
 * 用法：
 *   node tools/audit-stardew-action-seam-terminals.mjs \
 *     --candidates <candidates.json> --source-root <decompiled-root> [--out <file>] [--pretty]
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createParser, extractBranches } from "./lib/stardew-branch-writeset.mjs";

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
    if (!["--candidates", "--source-root", "--out"].includes(a)) fail("arguments_invalid", `Bad argument ${a}.`);
    const v = argv[++i];
    if (!v) fail("arguments_invalid", `Missing value for ${a}.`);
    out[a.slice(2)] = v;
  }
  for (const r of ["candidates", "source-root"]) if (!out[r]) fail("arguments_required", `--${r} is required.`);
  return out;
}

const options = parseArgs(process.argv.slice(2));
const sourceRoot = path.resolve(options["source-root"]);
const candidates = JSON.parse(await readFile(options.candidates, "utf8"));
const parser = await createParser();

/** 在给定文件里找出候选集里所有该文件的方法单元（用于定位真实入口） */
const unitsInFile = (file) =>
  [...candidates.matched, ...candidates.unmatchedCandidates]
    .filter((c) => c.file === file)
    .map((c) => ({ member: c.member, class: c.class, line: c.line }));

const audit = [];
for (const r of candidates.registeredWithoutCandidateSeam) {
  const methods = await extractBranches({
    sourceRoot,
    relPath: r.file,
    memberName: r.member,
    parser,
  });
  const m = methods[0];
  if (!m) {
    audit.push({ ...r, kind: "method_not_found", evidence: {} });
    continue;
  }

  const cands = m.branches.filter((b) => b.candidate);
  const writes = [...new Set(m.branches.flatMap((b) => b.writes))];
  const delegates = [...new Set(m.branches.flatMap((b) => b.delegates))];
  const callees = [...new Set(m.branches.flatMap((b) => b.calls))];
  const rejectedBy = [...new Set(m.branches.flatMap((b) => b.rejectedBy))].sort();

  let kind;
  if (cands.length > 0) kind = "seam_ok";
  else if (writes.length === 0 && delegates.length === 0) kind = "seam_not_terminal";
  else if (delegates.length > 0) kind = "terminal_in_delegate";
  else kind = "seam_writes_but_no_terminal";

  /**
   * 对疑似引用错误的两类，查它调用的方法里哪个在候选集内 —— 那个才是真实终态位置。
   * 只查同文件，因为 seam 记录本来就在同一类层级。
   */
  const sameFileUnits = unitsInFile(r.file);
  const terminalCandidates = callees.map((c) => sameFileUnits.find((u) => u.member === c)).filter(Boolean);

  audit.push({
    ...r,
    kind,
    evidence: {
      branchCount: m.branches.length,
      writes: writes.slice(0, 6),
      delegates: delegates.slice(0, 4),
      callees: callees.slice(0, 8),
      rejectedBy,
      /** 同文件内、被本方法调用、且在候选集里的方法 = 真实终态位置候选 */
      terminalCandidateInSameFile: terminalCandidates,
    },
  });
}

const byKind = {};
for (const a of audit) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;

const suspicious = audit.filter((a) => a.kind === "seam_not_terminal" || a.kind === "seam_writes_but_no_terminal");

const artifact = {
  artifactKind: "stardew_action_seam_terminal_audit",
  schemaVersion: 1,
  inputs: { candidates: options.candidates, sourceRoot: options["source-root"] },
  counts: {
    audited: audit.length,
    byKind,
    suspectSeamReferences: suspicious.length,
    suspectWithTerminalCandidateFound: suspicious.filter((a) => a.evidence.terminalCandidateInSameFile?.length > 0)
      .length,
  },
  audit,
  suspectSeamReferences: suspicious.map((a) => ({
    actionId: a.actionId,
    recordedSeam: { member: a.member, file: a.file },
    kind: a.kind,
    writes: a.evidence.writes,
    callees: a.evidence.callees,
    terminalCandidateInSameFile: a.evidence.terminalCandidateInSameFile,
  })),
  nonGuarantees: Object.freeze([
    "seam_not_terminal_means_the_recorded_method_does_not_write_terminal_state_it_does_not_prove_the_action_is_broken",
    "terminalCandidateInSameFile_is_a_candidate_not_a_confirmed_replacement_seam",
    "no_action_identity_inferred",
    "audit_covers_only_seams_present_in_the_supplied_candidates_artifact",
  ]),
};

const serialized = `${JSON.stringify(artifact, null, options.pretty ? 2 : 0)}\n`;
if (options.out) {
  await writeFile(options.out, serialized);
  process.stdout.write(`${JSON.stringify({ state: "written", out: options.out, ...artifact.counts })}\n`);
} else {
  process.stdout.write(serialized);
}
