#!/usr/bin/env node
/**
 * One number, two parties: the deadline a runner writes onto `execution_request`, and the window this Mod admits.
 *
 * WHY. Measured 2026-11-10: `node tools/live-action.mjs --action fish_here` ended `blocked` with
 * `bridge_rejected:invalid_deadline` after 13.7 s. The runner had written 120 s; `fish_here` publishes a 60 s
 * watchdog. Every runner sized its own deadline and nothing compared them, so the disagreement cost a game launch
 * and could only ever be read as a refusal that named neither number.
 *
 * THE TWO SIDES, AND WHY NEITHER IS RESTATED HERE.
 *   receiver - `action-deadline-windows.v1.json`: the admitted window per action, printed by the Mod's own export
 *              (`FarmhandActionDeadlineWindowExport`, the declaration `BridgeSession` also bounds requests with) and
 *              kept equal to that producer by `action-surface-export-drift.test.mjs`. Reading the Mod's catalogue out
 *              of the C# source here would be a second spelling of the number under test.
 *   sender   - the `timeoutMs` each runner passes to `executeFresh`/`executeFreshAfterReobserve`, read from the
 *              runner file the gate registry names. A runner that passes none writes the published window, which is
 *              the harness's own rule (`executeFresh` derives it from `hello_ack`), so it is an agreement by
 *              construction rather than an omission.
 *
 * POPULATION (derived, never listed): every action of the generated surface
 * (`integrations/stardew/action-development/contracts/generated/action-surface.v1.json`), each resolved to the
 * runner `tools/stardew-action-gate-descriptors.mjs` registers for it. An action with no runner is a read-only or
 * ungated action: it has no wire dispatch to disagree about, is counted, and is named.
 *
 * VERDICT. `actions examined N · agree M · disagree D` on one line, then one line per disagreement:
 *   `action_deadline_disagreement:<actionId>:sender=<n>:receiver=<n>`
 * A runner's declaration wider than the window is red (exit 1). Zero population, an unreadable side, or a runner
 * whose dispatch windows cannot be read is BLOCKED (exit 2) - never green, because "0 disagreements" out of "0
 * examined" is a gate agreeing with itself.
 *
 * USAGE
 *   node tools/check-action-deadline-agreement.mjs
 *   node tools/check-action-deadline-agreement.mjs --json
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
  STARDEW_PUBLISHED_ACTION_GATES,
} from "./stardew-action-gate-descriptors.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(TOOLS, "..");
const SURFACE = "integrations/stardew/action-development/contracts/generated/action-surface.v1.json";
const WINDOWS = "integrations/stardew/action-development/contracts/generated/action-deadline-windows.v1.json";

export const EXIT = Object.freeze({ agreed: 0, disagreement: 1, blocked: 2 });

function blocked(code, detail) {
  const error = new Error(detail === undefined ? code : `${code}:${detail}`);
  error.code = code;
  return error;
}

function readJson(root, relativePath) {
  try {
    return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
  } catch (error) {
    throw blocked(
      `action_deadline_${relativePath.includes("windows") ? "windows" : "surface"}_unreadable`,
      String(error?.message ?? error).slice(0, 160),
    );
  }
}

/**
 * Every `timeoutMs` one runner passes to a dispatch, as `{ line, value }`.
 *
 * Only the dispatch calls are read, because `timeoutMs` elsewhere in a runner sizes a LOCAL wait (a terminal poll, an
 * actionability poll) and a local wait longer than the Mod's window is legitimate: the world may settle at any point,
 * the request is not held for that long. The call is found by its own parentheses so a nested object literal cannot
 * be mistaken for the argument list.
 */
export function declaredDispatchWindows(source) {
  const windows = [];
  const pattern = /executeFresh(?:AfterReobserve)?\(/gu;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    let depth = 0;
    let index = pattern.lastIndex - 1;
    for (; index < source.length; index += 1) {
      if (source[index] === "(") depth += 1;
      else if (source[index] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const call = source.slice(match.index, index + 1);
    const literal = /timeoutMs\s*:\s*(-?[0-9][0-9_]*)/u.exec(call);
    if (literal === null) continue;
    windows.push({
      line: source.slice(0, match.index).split("\n").length,
      value: Number(literal[1].replaceAll("_", "")),
    });
  }
  return windows;
}

/** The action id each runner file dispatches for, from the two registries the gate tables own. */
function runnersByFile() {
  const byFile = new Map();
  const add = (actionId, file) => {
    if (typeof file !== "string" || file.length === 0) return;
    const actions = byFile.get(file) ?? [];
    if (!actions.includes(actionId)) actions.push(actionId);
    byFile.set(file, actions);
  };
  for (const entry of STARDEW_PUBLISHED_ACTION_GATES) add(entry.actionId, entry.runner);
  for (const [actionId, file] of Object.entries(STARDEW_EXPERIMENTAL_ACTION_RUNNERS)) add(actionId, file);
  return byFile;
}

/**
 * The derivation, pure over its inputs so the gate's own reading can be falsified without a runner or an artifact.
 *
 * `readRunnerFile` returns the source of one runner relative to the repository root, or null when it cannot be read.
 */
export function deriveDeadlineAgreement({ surface, windows, readRunnerFile }) {
  const actions = Array.isArray(surface?.actions) ? surface.actions : [];
  if (actions.length === 0)
    throw blocked("action_deadline_population_empty", "the generated surface publishes no action");
  const admitted = new Map();
  for (const window of Array.isArray(windows?.windows) ? windows.windows : []) {
    if (typeof window?.actionId === "string" && Number.isSafeInteger(window?.admittedMs) && window.admittedMs > 0)
      admitted.set(window.actionId, window.admittedMs);
  }
  if (admitted.size === 0)
    throw blocked("action_deadline_windows_unreadable", "the producer's export carries no window");

  // Only the runners of the actions being examined are read: the population decides what is measured, so a gate run
  // over a smaller surface reads a smaller tree instead of demanding that every runner in the repository be readable.
  const runners = runnersByFile();
  const examinedIds = actions.map((action) => action?.actionId).filter((actionId) => typeof actionId === "string");
  const filesToRead = [...runners].filter(([, actionIds]) =>
    actionIds.some((actionId) => examinedIds.includes(actionId)),
  );
  const declared = new Map();
  const unreadable = [];
  for (const [file, actionIds] of filesToRead) {
    const source = readRunnerFile(file);
    if (source === null) {
      unreadable.push(`${file}(${actionIds.join("+")})`);
      continue;
    }
    declared.set(file, declaredDispatchWindows(source));
  }
  if (unreadable.length > 0) throw blocked("action_deadline_runner_unreadable", unreadable.slice(0, 5).join(","));

  const disagreements = [];
  const missing = [];
  let agree = 0;
  let dispatched = 0;
  let windowsRead = 0;
  for (const action of actions) {
    const actionId = action?.actionId;
    if (typeof actionId !== "string") continue;
    const receiverMs = admitted.get(actionId);
    if (receiverMs === undefined) {
      missing.push(actionId);
      continue;
    }
    const files = filesToRead.filter(([, actionIds]) => actionIds.includes(actionId)).map(([file]) => file);
    const values = files.flatMap((file) => declared.get(file) ?? []).map((entry) => entry.value);
    windowsRead += values.length;
    if (files.length > 0) dispatched += 1;
    const senderMs = values.length === 0 ? receiverMs : Math.max(...values);
    if (senderMs <= receiverMs) {
      agree += 1;
      continue;
    }
    disagreements.push({
      actionId,
      files,
      senderMs,
      receiverMs,
      wider: files
        .flatMap((file) => (declared.get(file) ?? []).map((entry) => ({ file, ...entry })))
        .filter((entry) => entry.value > receiverMs),
    });
  }
  if (missing.length > 0) throw blocked("action_deadline_window_missing", missing.slice(0, 5).join(","));

  return Object.freeze({
    examined: actions.length,
    agree,
    disagree: disagreements.length,
    disagreements,
    dispatchedByARunner: dispatched,
    declaredWindowsRead: windowsRead,
  });
}

/** The lines one run prints: the verdict first, then the members, so a failure names the drifting action. */
export function formatDeadlineAgreement(report) {
  const lines = [
    `actions examined ${report.examined} · agree ${report.agree} · disagree ${report.disagree}`,
    `actions dispatched by a gate runner ${report.dispatchedByARunner} of ${report.examined} · runner-declared windows read ${report.declaredWindowsRead}`,
  ];
  for (const disagreement of report.disagreements) {
    lines.push(
      `action_deadline_disagreement:${disagreement.actionId}:sender=${disagreement.senderMs}:receiver=${disagreement.receiverMs}`,
    );
    for (const entry of disagreement.wider) lines.push(`  ${entry.file}:${entry.line} writes ${entry.value} ms`);
  }
  return lines;
}

export function checkActionDeadlineAgreement({ root = REPO, readRunnerFile } = {}) {
  const report = deriveDeadlineAgreement({
    surface: readJson(root, SURFACE),
    windows: readJson(root, WINDOWS),
    readRunnerFile:
      readRunnerFile ??
      ((file) => {
        try {
          return readFileSync(join(root, "tools", file), "utf8");
        } catch {
          return null;
        }
      }),
  });
  return report;
}

if (import.meta.main) {
  const json = process.argv.includes("--json");
  try {
    const report = checkActionDeadlineAgreement();
    if (json)
      process.stdout.write(`${JSON.stringify({ status: report.disagree === 0 ? "agreed" : "disagree", ...report })}\n`);
    else process.stdout.write(`${formatDeadlineAgreement(report).join("\n")}\n`);
    process.exitCode = report.disagree === 0 ? EXIT.agreed : EXIT.disagreement;
  } catch (error) {
    process.stdout.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = EXIT.blocked;
  }
}
