#!/usr/bin/env node
/**
 * Promote one or more Stardew Farmhand actions up the lifecycle ladder
 * (`Experimental` -> `LiveVerified`) in a single refusal-first pass.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TOOL EXISTS (the two failures that motivated it)
 * ---------------------------------------------------------------------------
 *
 * 1. A hand-written promotion row is not a row. Promotion was done with a
 *    throwaway generator that emitted a bare `{ actionId, runner }` object where
 *    a published row is a `gate("<id>", <identityVersion>, "<runner>",
 *    "<terminal>", "<scenario>")` FACTORY CALL. The result parsed as JavaScript
 *    but carried no `identityVersion`, so `check-stardew-action-promotion.mjs`
 *    reported `gate_identity_drift` and the promotion had to be repaired by hand.
 *    This tool emits the factory call and re-parses its own output before writing.
 *
 * 2. The frozen lists are independent copies. `stardew-action-gate-descriptors.test.mjs`
 *    pins the published table THREE ways - the golden runner map, the
 *    fixture-backed list (scenario !== null) and its scenario-less complement -
 *    and `check-stardew-action-promotion.mjs` stays green while any of them is
 *    stale. A promotion that updates the gate list alone leaves that test red.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER (six responsibilities; the first four are this tool's edits)
 * ---------------------------------------------------------------------------
 *
 * 1. the Mod catalog lifecycle (`FarmhandActionDefinitions.cs`): `Experimental` -> `LiveVerified`;
 * 2. `STARDEW_PUBLISHED_ACTION_GATES` gains the `gate(...)` row;
 * 3. the SAME id leaves `STARDEW_EXPERIMENTAL_ACTION_RUNNERS` (a key in BOTH maps
 *    fails `resolve-stardew-action-gate-runner.test.mjs`);
 * 4. the descriptor test's frozen lists - the golden runner map AND the
 *    fixture-backed list, both in the published table's ORDER, plus the
 *    scenario-less complement in the same test;
 * 5. the discovery audit's `TARGET_FIELD` (the action -> published snapshot family
 *    map owned by `audit-stardew-discovery-channels.mjs`) and the sensitivity
 *    register seam (`derive-stardew-native-multiplayer-sensitivity-register.mjs`);
 *    a target-bearing action with no `TARGET_FIELD` entry fails the promotion
 *    gate with `published_target_action_missing_snapshot_field`;
 * 6. the derived artifacts, regenerated from their producers and never hand-edited
 *    (`action-surface.v1.json` and the sensitivity register are only as fresh as
 *    the DLL/source that emits them).
 *
 * Steps 1-4 are applied here. Steps 5-6 need a human judgement that no source
 * states as a value, so the tool does not guess them: it names them in its report
 * and the gates it runs fail loudly when one is missing.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE ROW'S FOUR VALUES COME FROM (the tool never asks the caller)
 * ---------------------------------------------------------------------------
 *
 *   runner      the CURRENT `STARDEW_EXPERIMENTAL_ACTION_RUNNERS` entry;
 *   identity    the Mod catalog registration (`E("id", family, 1, ...)`);
 *   scenario    `fixtureScenario(fixtureActions(id), id)` in the fixture library -
 *               the same call the fixture itself uses, so the row cannot disagree
 *               with the world the runner is handed (`""` means "no scenario", and
 *               the row then omits the fifth argument and the id does not enter
 *               the fixture-backed list);
 *   terminal    the action's EMITTED success receipt code, corroborated against
 *               the runner source that asserts it.
 *
 * The terminal is deliberately NOT the Mod descriptor's `postcondition.name`.
 * They usually agree, but they are different fields: `talk_to_npc`'s descriptor
 * postcondition is `npc_talked` (the Host's descriptor-completeness gate requires
 * exactly that string), while the Mod emits `talk_to_npc_talked` - and the gate
 * row is consumed as the emitted code by
 * `live-run/game/run-stardew-native-local-agent-ab-live.mjs`, which compares it
 * with a raw receipt `reasonCode`. Writing `npc_talked` there would produce a row
 * no static gate catches and the live A/B run would call the execution a failure.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *
 *   node tools/promote-stardew-action.mjs talk_to_npc
 *   node tools/promote-stardew-action.mjs --dry-run talk_to_npc
 *
 * Exit 0 = promoted (or already promoted), 1 = refused / a gate failed, 2 = usage.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Biome's `lineWidth` for this repository; a row longer than this wraps. */
const PRINT_WIDTH = 120;

export const PROMOTION_PATHS = Object.freeze({
  gateDescriptors: "tools/stardew-action-gate-descriptors.mjs",
  descriptorTest: "tools/stardew-action-gate-descriptors.test.mjs",
  modCatalog: "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs",
  receiptCorpus: "host/src/test-fixtures/stardew-live-receipts.json",
});

/** The six responsibilities, in order, for the operator-facing report. */
export const PROMOTION_RESPONSIBILITIES = Object.freeze([
  "mod_catalog_lifecycle_experimental_to_live_verified",
  "published_gate_table_gains_the_gate_row",
  "experimental_runner_map_drops_the_id",
  "descriptor_test_frozen_lists_and_fixture_backed_order",
  "discovery_audit_TARGET_FIELD_and_sensitivity_register_seam",
  "derived_artifacts_regenerated_from_producers",
]);

/**
 * The gates this tool runs after writing: the cheap, offline checks that cover
 * steps 1-4 and the observation contract. They never launch a game and never
 * need the decompiled source root.
 */
export const PROMOTION_GATES = Object.freeze([
  Object.freeze({ label: "check:stardew-action-promotion", args: ["tools/check-stardew-action-promotion.mjs"] }),
  Object.freeze({
    label: "test:stardew-action-gate-descriptors",
    args: ["--test", "tools/stardew-action-gate-descriptors.test.mjs"],
  }),
  Object.freeze({
    label: "test:stardew-action-gate-runner-resolver",
    args: ["--test", "tools/resolve-stardew-action-gate-runner.test.mjs"],
  }),
  Object.freeze({
    label: "test:stardew-native-local-runner-fixture-contract",
    args: ["--test", "tools/stardew-native-local-runner-fixture-contract.test.mjs"],
  }),
  Object.freeze({ label: "audit:stardew-discovery-channels", args: ["tools/audit-stardew-discovery-channels.mjs"] }),
]);

const ACTION_ID = /^[a-z][a-z0-9_]{1,127}$/;
const RUNNER_FILE = /^run-stardew-[a-z0-9-]+\.mjs$/;
const SCENARIO = /^native_[a-z0-9_]+_v\d+$/;

/** A published row is a `gate(...)` FACTORY CALL, never an object literal. */
export function parsePublishedGates(source) {
  const table = /STARDEW_PUBLISHED_ACTION_GATES\s*=\s*Object\.freeze\(\[([\s\S]*?)\n\]\);/u.exec(source);
  if (table === null) return null;
  const rows = [];
  const call =
    /gate\(\s*"([a-z0-9_]+)"\s*,\s*(\d+)\s*,\s*"([a-z0-9-]+\.mjs)"\s*,\s*"([a-z0-9_]+)"(?:\s*,\s*"([a-z0-9_]+)")?\s*,?\s*\)/gu;
  for (const match of table[1].matchAll(call)) {
    rows.push({
      actionId: match[1],
      identityVersion: Number(match[2]),
      runner: match[3],
      terminalReasonCode: match[4],
      fixtureScenario: match[5] ?? null,
    });
  }
  return { rows, tableEnd: table.index + table[0].length };
}

/** The experimental runner map's entries, each with the exact text to remove. */
export function parseExperimentalEntries(source) {
  const table = /STARDEW_EXPERIMENTAL_ACTION_RUNNERS\s*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\);/u.exec(source);
  if (table === null) return null;
  const bodyStart = table.index + table[0].indexOf(table[1]);
  const entries = [];
  const entry = /^([ \t]*)([a-z][a-z0-9_]*)[ \t]*:[ \t]*(?:\r?\n[ \t]*)?"([a-z0-9-]+\.mjs)",/gmu;
  for (const match of table[1].matchAll(entry)) {
    const start = bodyStart + match.index;
    // Remove the whole line the entry occupies, including its terminator.
    const lineEnd = source.indexOf("\n", start + match[0].length);
    entries.push({
      actionId: match[2],
      runner: match[3],
      start,
      end: lineEnd < 0 ? start + match[0].length : lineEnd + 1,
    });
  }
  return entries;
}

/** The Mod catalog registrations this tool may edit, with their lifecycle token. */
export function parseModRegistrations(source) {
  const registrations = [];
  const call =
    /\b(?:E|Registration)\(\s*"([a-z][a-z0-9_]{1,127})",\s*"([a-z][a-z0-9_]{1,127})",\s*(?:(\d+),\s*)?FarmhandActionHandlerGroup\./gu;
  for (const match of source.matchAll(call)) {
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    const lineEnd = source.indexOf("\n", match.index + match[0].length);
    const line = source.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
    const lifecycles = [
      ...new Set(
        [...line.matchAll(/FarmhandActionLifecycle\.(Published|LiveVerified|Experimental)\b/gu)].map((t) => t[1]),
      ),
    ];
    registrations.push({
      actionId: match[1],
      familyId: match[2],
      identityVersion: match[3] === undefined ? 1 : Number(match[3]),
      lifecycles,
      lifecycle:
        lifecycles.length === 1 ? lifecycles[0].toLowerCase().replace("liveverified", "live_verified") : undefined,
      lineStart,
      lineEnd: lineEnd < 0 ? source.length : lineEnd,
    });
  }
  return registrations;
}

/** The single terminal a runner returns as its verdict, or null when it is not unique. */
export function runnerVerdictTerminal(source) {
  const codes = [...new Set([...source.matchAll(/reasonCode:\s*"([a-z][a-z0-9_]*)"/gu)].map((match) => match[1]))];
  return codes.length === 1 ? codes[0] : null;
}

/** `gate("id", 1, "runner.mjs", "terminal", "scenario"),`, wrapped past `PRINT_WIDTH`. */
export function renderGateRow(row) {
  const scenario = row.fixtureScenario === null ? "" : `, "${row.fixtureScenario}"`;
  const single = `  gate("${row.actionId}", ${row.identityVersion}, "${row.runner}", "${row.terminalReasonCode}"${scenario}),`;
  if (single.length <= PRINT_WIDTH) return single;
  const args = [
    `    "${row.actionId}"`,
    `    ${row.identityVersion}`,
    `    "${row.runner}"`,
    `    "${row.terminalReasonCode}"`,
  ];
  if (row.fixtureScenario !== null) args.push(`    "${row.fixtureScenario}"`);
  return ["  gate(", ...args.map((argument) => `${argument},`), "  ),"].join("\n");
}

/**
 * Re-read the table this tool just rendered. A row that is not a `gate(...)`
 * call - the bare `{ actionId, runner }` object the scratch generator wrote -
 * parses to nothing here and is refused before any byte reaches disk.
 */
export function verifyPromotedGateRows({ source, promotions }) {
  const parsed = parsePublishedGates(source);
  if (parsed === null) return ["gate_table_unreadable_after_render"];
  const problems = [];
  for (const promotion of promotions) {
    const row = parsed.rows.find((candidate) => candidate.actionId === promotion.actionId);
    if (row === undefined) {
      problems.push(`rendered_row_is_not_a_gate_call:${promotion.actionId}`);
      continue;
    }
    if (row.identityVersion !== promotion.identityVersion)
      problems.push(`rendered_row_identity_mismatch:${promotion.actionId}`);
    if (row.runner !== promotion.runner) problems.push(`rendered_row_runner_mismatch:${promotion.actionId}`);
    if (row.terminalReasonCode !== promotion.terminalReasonCode)
      problems.push(`rendered_row_terminal_mismatch:${promotion.actionId}`);
    if (row.fixtureScenario !== promotion.fixtureScenario)
      problems.push(`rendered_row_scenario_mismatch:${promotion.actionId}`);
  }
  return problems;
}

/**
 * Resolve the action's EMITTED success receipt code, corroborated against the
 * runner that asserts it. The Mod descriptor's `postcondition.name` is a
 * different field and is deliberately not consulted (see the header).
 */
function resolveTerminal({ actionId, runner, runnerSource, receiptCorpus }) {
  const problems = [];
  const notes = [];
  const recorded = (receiptCorpus?.receipts ?? []).filter(
    (receipt) => receipt.actionId === actionId && receipt.state === "succeeded",
  );
  const recordedCodes = [...new Set(recorded.map((receipt) => receipt.reasonCode))];
  if (recordedCodes.length > 1) problems.push(`recorded_terminal_ambiguous:${actionId}:${recordedCodes.join(",")}`);
  const verdict = runnerVerdictTerminal(runnerSource);
  const terminalReasonCode = recordedCodes.length === 1 ? recordedCodes[0] : verdict;
  if (recordedCodes.length === 1 && verdict !== null && verdict !== terminalReasonCode)
    notes.push(`recorded_terminal_differs_from_runner_verdict:${actionId}:${terminalReasonCode}:${verdict}`);
  if (terminalReasonCode === undefined || terminalReasonCode === null)
    problems.push(`terminal_unresolved:${actionId}: no recorded live receipt and no single runner verdict`);
  else if (!runnerSource.includes(`"${terminalReasonCode}"`))
    problems.push(`terminal_not_asserted_by_runner:${actionId}:${terminalReasonCode}:${runner}`);
  return { terminalReasonCode, problems, notes };
}

/** The fixture's own scenario for this action; `""` means it has none. */
function resolveScenario({ actionId, fixtures }) {
  try {
    const scenario = fixtures.fixtureScenario(fixtures.fixtureActions(actionId), actionId);
    if (typeof scenario !== "string" || scenario.length === 0) return { fixtureScenario: null, problems: [] };
    if (!SCENARIO.test(scenario))
      return { fixtureScenario: null, problems: [`scenario_shape:${actionId}:${scenario}`] };
    return { fixtureScenario: scenario, problems: [] };
  } catch (error) {
    return { fixtureScenario: null, problems: [`scenario_unresolved:${actionId}:${error?.message ?? error}`] };
  }
}

/**
 * Resolve one action's promotion, or return the problems that make it unsafe.
 * Every anchor must be present exactly once; nothing is guessed.
 */
function resolveOne(actionId, { sources, fixtures, readRunner, receiptCorpus }) {
  const problems = [];
  const notes = [];
  const published = parsePublishedGates(sources.gateDescriptors);
  if (published === null) return { problems: ["gate_descriptor_table_not_found"], notes };
  const experimental = parseExperimentalEntries(sources.gateDescriptors);
  if (experimental === null) return { problems: ["experimental_runner_map_not_found"], notes };
  const registrations = parseModRegistrations(sources.modCatalog).filter((entry) => entry.actionId === actionId);

  const inTable = published.rows.find((row) => row.actionId === actionId);
  const inMap = experimental.filter((entry) => entry.actionId === actionId);
  const registration = registrations[0];

  if (inTable !== undefined && inMap.length === 0 && registration?.lifecycle === "live_verified")
    return { alreadyPromoted: true, problems, notes };
  if (inTable !== undefined) problems.push(`already_in_published_table:${actionId}`);
  if (inMap.length === 0) problems.push(`not_in_experimental_runner_map:${actionId}`);
  if (inMap.length > 1) problems.push(`duplicate_experimental_runner_entry:${actionId}`);
  if (registrations.length === 0) problems.push(`mod_catalog_registration_not_found:${actionId}`);
  if (registrations.length > 1) problems.push(`duplicate_mod_catalog_registration:${actionId}`);
  if (registration !== undefined && registration.lifecycle === undefined)
    problems.push(`mod_catalog_lifecycle_ambiguous:${actionId}`);
  if (registration?.lifecycle !== undefined && registration.lifecycle !== "experimental")
    problems.push(`mod_catalog_lifecycle_not_experimental:${actionId}:${registration.lifecycle}`);
  if (problems.length > 0) return { problems, notes };

  const runner = inMap[0].runner;
  if (!RUNNER_FILE.test(runner)) problems.push(`runner_name_shape:${actionId}:${runner}`);

  let runnerSource;
  try {
    runnerSource = readRunner(runner);
  } catch (error) {
    problems.push(`runner_source_unreadable:${actionId}:${runner}:${error?.message ?? error}`);
    return { problems, notes };
  }

  const terminal = resolveTerminal({ actionId, runner, runnerSource, receiptCorpus });
  problems.push(...terminal.problems);
  notes.push(...terminal.notes);

  const scenario = resolveScenario({ actionId, fixtures });
  problems.push(...scenario.problems);

  if (problems.length > 0) return { problems, notes };
  return {
    promotion: {
      actionId,
      identityVersion: registration.identityVersion,
      runner,
      terminalReasonCode: terminal.terminalReasonCode,
      fixtureScenario: scenario.fixtureScenario,
      experimentalEntry: inMap[0],
      modLine: registration,
    },
    problems,
    notes,
  };
}

/** The descriptor test's three anchors, or the problems that make it uneditable. */
export function descriptorTestAnchors(source) {
  const problems = [];
  const goldenOpen = source.indexOf("const expectedRunners = Object.freeze({");
  const goldenClose = goldenOpen < 0 ? -1 : source.indexOf("\n  });", goldenOpen);
  if (goldenClose < 0) problems.push("descriptor_test_golden_map_not_found");
  const fixtureAnchor = source.indexOf("fixtureBacked.map((gate) => gate.actionId),");
  const fixtureClose = fixtureAnchor < 0 ? -1 : source.indexOf("\n    ],", fixtureAnchor);
  if (fixtureClose < 0) problems.push("descriptor_test_fixture_backed_list_not_found");
  const scenarioLess = /fixtureScenario === null\)\.map\(\(gate\) => gate\.actionId\),\n\s*\[([^\]]*)\],/u.exec(source);
  if (scenarioLess === null) problems.push("descriptor_test_scenario_less_list_not_found");
  return problems.length > 0
    ? { problems }
    : {
        goldenClose,
        fixtureClose,
        scenarioLess: { index: scenarioLess.index, body: scenarioLess[1], match: scenarioLess[0] },
      };
}

/** Plan the whole promotion: every action and anchor validated before anything renders. */
export function planPromotion({ actionIds, sources, fixtures, readRunner, receiptCorpus }) {
  const problems = [];
  const notes = [];
  const promotions = [];
  const alreadyPromoted = [];
  const seen = new Set();
  for (const actionId of actionIds) {
    if (!ACTION_ID.test(actionId)) {
      problems.push(`invalid_action_id:${actionId}`);
      continue;
    }
    if (seen.has(actionId)) {
      problems.push(`duplicate_action_id:${actionId}`);
      continue;
    }
    seen.add(actionId);
    const resolved = resolveOne(actionId, { sources, fixtures, readRunner, receiptCorpus });
    problems.push(...resolved.problems);
    notes.push(...resolved.notes);
    if (resolved.promotion !== undefined) promotions.push(resolved.promotion);
    if (resolved.alreadyPromoted === true) alreadyPromoted.push(actionId);
  }
  if (problems.length > 0) return { problems, notes, promotions: [], alreadyPromoted: [] };
  if (promotions.length > 0) problems.push(...(descriptorTestAnchors(sources.descriptorTest).problems ?? []));
  if (problems.length > 0) return { problems, notes, promotions: [], alreadyPromoted: [] };
  return { problems, notes, promotions, alreadyPromoted };
}

/** Render the written files. Pure: no I/O, so a fixture tree can drive it. */
export function applyPromotionPlan({ sources, promotions }) {
  if (promotions.length === 0) return { files: {}, problems: [] };
  const published = parsePublishedGates(sources.gateDescriptors);
  if (published === null) return { files: {}, problems: ["gate_descriptor_table_not_found"] };
  const anchors = descriptorTestAnchors(sources.descriptorTest);
  if (anchors.problems !== undefined) return { files: {}, problems: anchors.problems };

  const rows = promotions.map(renderGateRow).join("\n");
  const removeEntry = [...promotions]
    .sort((a, b) => b.experimentalEntry.start - a.experimentalEntry.start)
    .map((promotion) => ({ start: promotion.experimentalEntry.start, end: promotion.experimentalEntry.end, text: "" }));
  const gateDescriptors = splice(sources.gateDescriptors, [
    ...removeEntry,
    { start: published.tableEnd - 4, end: published.tableEnd - 4, text: `\n${rows}` },
  ]);

  const modCatalog = splice(
    sources.modCatalog,
    [...promotions]
      .sort((a, b) => b.modLine.lineStart - a.modLine.lineStart)
      .map((promotion) => {
        const line = sources.modCatalog.slice(promotion.modLine.lineStart, promotion.modLine.lineEnd);
        const at = line.indexOf("FarmhandActionLifecycle.Experimental");
        return {
          start: promotion.modLine.lineStart + at,
          end: promotion.modLine.lineStart + at + "FarmhandActionLifecycle.Experimental".length,
          text: "FarmhandActionLifecycle.LiveVerified",
        };
      }),
  );

  const descriptorTest = splice(sources.descriptorTest, descriptorTestEdits(promotions, anchors));
  return { files: { descriptorTest, gateDescriptors, modCatalog }, problems: [] };
}

function descriptorTestEdits(promotions, anchors) {
  const withScenario = promotions.filter((promotion) => promotion.fixtureScenario !== null);
  const withoutScenario = promotions.filter((promotion) => promotion.fixtureScenario === null);
  const goldenLines = promotions.map((promotion) => `    ${promotion.actionId}: "${promotion.runner}",`).join("\n");
  const edits = [{ start: anchors.goldenClose + 1, end: anchors.goldenClose + 1, text: `${goldenLines}\n` }];

  if (withScenario.length > 0) {
    const lines = withScenario.map((promotion) => `      "${promotion.actionId}",`).join("\n");
    edits.push({ start: anchors.fixtureClose + 1, end: anchors.fixtureClose + 1, text: `${lines}\n` });
  }
  if (withoutScenario.length > 0) {
    const { index, body, match } = anchors.scenarioLess;
    const items = [...body.matchAll(/"([a-z0-9_]+)"/gu)].map((entry) => entry[1]);
    const rendered = [...items, ...withoutScenario.map((promotion) => promotion.actionId)]
      .map((item) => `"${item}"`)
      .join(", ");
    const bodyStart = index + match.indexOf("[") + 1;
    edits.push({ start: bodyStart, end: bodyStart + body.length, text: rendered });
  }
  return edits;
}

/** Apply `{start, end, text}` edits right-to-left so earlier offsets stay valid. */
function splice(source, edits) {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of ordered) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

/**
 * Run the promotion gates. Each entry reports its own exit code; the caller may
 * not treat the promotion as done while any is non-zero.
 */
export function runPromotionGates({ root, gates = PROMOTION_GATES, spawn = spawnSync }) {
  return gates.map((gate) => {
    const result = spawn(process.execPath, gate.args, { cwd: root, encoding: "utf8", windowsHide: true });
    return Object.freeze({
      label: gate.label,
      command: `node ${gate.args.join(" ")}`,
      exitCode: result.status,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/u).slice(-40),
    });
  });
}

/** Read the real repository's promotion sources. */
export async function readPromotionSources({ root = ROOT } = {}) {
  const [gateDescriptors, descriptorTest, modCatalog] = await Promise.all([
    readFile(resolve(root, PROMOTION_PATHS.gateDescriptors), "utf8"),
    readFile(resolve(root, PROMOTION_PATHS.descriptorTest), "utf8"),
    readFile(resolve(root, PROMOTION_PATHS.modCatalog), "utf8"),
  ]);
  let receiptCorpus = { receipts: [] };
  try {
    receiptCorpus = JSON.parse(await readFile(resolve(root, PROMOTION_PATHS.receiptCorpus), "utf8"));
  } catch {
    receiptCorpus = { receipts: [] };
  }
  return {
    sources: { gateDescriptors, descriptorTest, modCatalog },
    readRunner: (fileName) => readFileSync(resolve(root, "tools", fileName), "utf8"),
    receiptCorpus,
  };
}

/** Plan, render, self-verify, write, then run the gates. */
export async function promoteStardewActions({
  actionIds,
  root = ROOT,
  dryRun = false,
  fixtures,
  runGates = runPromotionGates,
} = {}) {
  const context = await readPromotionSources({ root });
  const resolvedFixtures = fixtures ?? (await import("./lib/stardew-native-local-player-fixture.mjs"));
  const plan = planPromotion({ actionIds, ...context, fixtures: resolvedFixtures });
  if (plan.problems.length > 0) return { state: "refused", notes: plan.notes, problems: plan.problems, promotions: [] };
  if (plan.promotions.length === 0)
    return { state: "noop", alreadyPromoted: plan.alreadyPromoted, notes: plan.notes, problems: [], promotions: [] };

  const rendered = applyPromotionPlan({ sources: context.sources, promotions: plan.promotions });
  const renderProblems = [
    ...rendered.problems,
    ...verifyPromotedGateRows({ source: rendered.files.gateDescriptors, promotions: plan.promotions }),
  ];
  const editSummary = {
    gateRows: plan.promotions.map((promotion) => renderGateRow(promotion).trim()),
    experimentalEntriesRemoved: plan.promotions.map((promotion) => promotion.actionId),
    modCatalogEdits: plan.promotions.map((promotion) =>
      context.sources.modCatalog
        .slice(promotion.modLine.lineStart, promotion.modLine.lineEnd)
        .replace("FarmhandActionLifecycle.Experimental", "FarmhandActionLifecycle.LiveVerified")
        .trim(),
    ),
  };
  if (renderProblems.length > 0)
    return {
      state: "refused",
      notes: plan.notes,
      problems: renderProblems,
      promotions: plan.promotions,
      edits: editSummary,
    };
  if (dryRun)
    return { state: "dry_run", notes: plan.notes, problems: [], promotions: plan.promotions, edits: editSummary };

  for (const [key, content] of Object.entries(rendered.files))
    await writeFile(resolve(root, PROMOTION_PATHS[key]), content);
  const gates = await runGates({ root, gates: PROMOTION_GATES });
  const failed = gates.filter((gate) => gate.exitCode !== 0);
  return {
    state: failed.length === 0 ? "promoted" : "gate_failed",
    notes: plan.notes,
    problems: [],
    promotions: plan.promotions,
    edits: editSummary,
    gates,
    remainingResponsibilities: PROMOTION_RESPONSIBILITIES.slice(4),
  };
}

async function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const actionIds = argv.filter((argument) => !argument.startsWith("--"));
  if (actionIds.length === 0) {
    process.stderr.write("usage: node tools/promote-stardew-action.mjs [--dry-run] <action-id> [<action-id> ...]\n");
    return 2;
  }
  const result = await promoteStardewActions({ actionIds, dryRun });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.state === "refused" || result.state === "gate_failed" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2));
