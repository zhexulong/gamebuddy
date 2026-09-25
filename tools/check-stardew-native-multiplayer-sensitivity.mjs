#!/usr/bin/env node
/**
 * Gate: every registered Stardew action's multiplayer scope is derived from
 * exact source, not asserted from memory.
 *
 * Axis 1 — native seam sensitivity, derived from the exact decompiled game source.
 * Axis 2 — Mod admission, derived from the Mod's own `RequestLocal*` entry points.
 *
 * The two axes are cross-checked to find actions whose declared scope does not
 * match what the code actually does, and to force every mp-semantic action to be
 * validated on a real shared-world multiplayer live run.
 *
 * Usage:
 *   node tools/check-stardew-native-multiplayer-sensitivity.mjs \
 *     --register <register.json> --source-root <exact-decompile-root> [--report]
 *
 * Without --report mismatches fail (exit 1). With --report they are listed and
 * the command still fails, so the gate cannot be used to silently pass.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { validateMultiplayerSensitivityRegister } from "./lib/stardew-native-multiplayer-sensitivity.mjs";

/** Admission tokens that constitute an outright multiplayer rejection. */
const MP_REJECT_PATTERN = /Context\.IsMultiplayer|!Game1\.IsMasterGame|getAllFarmers\(\)\.Count\(\)\s*!=\s*1|Game1\.server\s+is not null/;

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function parseArgs(argv) {
  const result = { report: false };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--report") {
      result.report = true;
      continue;
    }
    if (!option.startsWith("--")) fail("multiplayer_sensitivity_arguments_invalid", `Unexpected argument ${option}.`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail("multiplayer_sensitivity_arguments_invalid", `Missing value for ${option}.`);
    result[option.slice(2)] = value;
  }
  if (!result.register || !result["source-root"])
    fail(
      "multiplayer_sensitivity_arguments_required",
      "Usage: --register <register.json> --source-root <exact-decompile-root> [--report]",
    );
  return result;
}

async function collectSources(root) {
  const sources = {};
  const pending = [path.resolve(root)];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name.endsWith(".cs"))
        sources[path.relative(root, absolute).split(path.sep).join("/")] = { text: await readFile(absolute, "utf8") };
    }
  }
  return sources;
}

/** Derive, from the Mod source, whether each action's admission rejects multiplayer. */
async function deriveModAdmission(repoRoot) {
  const handlerDir = path.join(repoRoot, "integrations/stardew/Handlers");
  const controllerDir = path.join(repoRoot, "integrations/stardew");

  const actionToMethod = new Map();
  for (const file of await readdir(handlerDir)) {
    if (!file.endsWith(".cs")) continue;
    const text = await readFile(path.join(handlerDir, file), "utf8");
    for (const match of text.matchAll(/"([a-z_]+)"\s*=>\s*this\.executions\.(RequestLocal\w+)\(/g))
      actionToMethod.set(match[1], match[2]);
  }

  const methodBody = new Map();
  for (const file of await readdir(controllerDir)) {
    if (!/^farmhandexecutioncontroller\..*\.cs$/.test(file)) continue;
    const text = await readFile(path.join(controllerDir, file), "utf8");
    const starts = [...text.matchAll(/public LocalExecutionReceipt (RequestLocal\w+)\(/g)];
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index].index;
      const end = index + 1 < starts.length ? starts[index + 1].index : text.length;
      methodBody.set(starts[index][1], text.slice(start, end));
    }
  }

  const derived = new Map();
  for (const [actionId, method] of actionToMethod) {
    const body = methodBody.get(method);
    if (!body) continue;
    // The admission block is the guard sequence before the first mutation.
    const admission = body.split("\n").slice(0, 45).join("\n");
    const rejects = MP_REJECT_PATTERN.test(admission);
    const reasonCode = (admission.match(/"(native_local_player_required|master_player_required|world_not_ready)"/) ?? [])[1];
    derived.set(actionId, {
      method,
      verdict: rejects ? "rejects_multiplayer" : "admits_multiplayer",
      ...(rejects ? { observedReasonCode: reasonCode ?? null } : {}),
    });
  }
  return derived;
}

/**
 * Actions served by the read pipelines (navigation read / scene observation) and
 * by the navigation coordinator never pass through a `RequestLocal*` admission,
 * so there is no guard whose scope could be overstated or restrictive.
 */
async function derivePipelineRoutedActions(repoRoot) {
  const readPipelines = new Set(["inspect_world_map", "find_destination", "observe_scene"]);
  const bridgeSession = await readFile(path.join(repoRoot, "integrations/stardew/BridgeSession.cs"), "utf8");
  for (const match of bridgeSession.matchAll(/operation is not \("([a-z_]+)" or "([a-z_]+)"\)/g)) {
    readPipelines.add(match[1]);
    readPipelines.add(match[2]);
  }
  // navigate_to_destination is admitted by TryAdmitNavigation, not by a
  // RequestLocal* handler.
  const controller = await readFile(path.join(repoRoot, "integrations/stardew/farmhandexecutioncontroller.cs"), "utf8");
  const admissionScopes = new Map();
  const navigationAdmission = controller.indexOf("internal bool TryAdmitNavigation(");
  if (navigationAdmission >= 0) admissionScopes.set("navigate_to_destination", "TryAdmitNavigation");
  // Read-only navigation/scene requests have no execution admission at all.
  return { readPipelines, admissionScopes };
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = process.cwd();

try {
  const [registerText, sources, modAdmission, pipelines] = await Promise.all([
    readFile(args.register, "utf8"),
    collectSources(args["source-root"]),
    deriveModAdmission(repoRoot),
    derivePipelineRoutedActions(repoRoot),
  ]);
  const register = JSON.parse(registerText);
  const report = validateMultiplayerSensitivityRegister(register, sources);

  // Read-pipeline actions have no execution admission; the navigation action has
  // its own dedicated admission.
  for (const actionId of pipelines.readPipelines)
    modAdmission.set(actionId, { method: "read_pipeline", verdict: "read_only" });
  for (const [actionId, method] of pipelines.admissionScopes)
    if (!modAdmission.has(actionId)) modAdmission.set(actionId, { method, verdict: "admits_multiplayer" });

  // Axis 2 must match the register: the register may not claim a scope the Mod
  // does not actually implement.
  const admissionMismatches = [];
  for (const action of report.actions) {
    const observed = modAdmission.get(action.actionId);
    if (!observed) {
      admissionMismatches.push({ actionId: action.actionId, detail: "no Mod admission entry point found." });
      continue;
    }
    if (observed.verdict !== action.admission) {
      admissionMismatches.push({
        actionId: action.actionId,
        detail: `register declares ${action.admission} but the Mod implements ${observed.verdict} (${observed.method}).`,
      });
    }
  }

  const mpSemanticWithoutTopology = report.actions
    .filter((action) => action.derivedSensitivity === "mp-semantic")
    .map((action) => ({ actionId: action.actionId, requiredLiveTopology: action.requiredLiveTopology }))
    .filter((entry) => entry.requiredLiveTopology !== "shared_world_multiplayer");

  const mechanisms = report.requiredSharedWorldMechanisms ?? [];
  const mechanismAcks = new Map(
    (report.scopeAcknowledgements ?? [])
      .filter((scope) => scope.defect === "unverified_mechanism_scope")
      .flatMap((scope) => scope.mechanisms.map((id) => [id, scope])),
  );
  const blockingMechanisms = mechanisms.filter((id) => !mechanismAcks.has(id));
  const acknowledgedMechanisms = mechanisms.filter((id) => mechanismAcks.has(id));

  const lines = [];
  lines.push(
    `native multiplayer sensitivity: ${report.actionCount} actions, ` +
      `${report.actions.filter((action) => action.derivedSensitivity === "mp-semantic").length} mp-semantic, ` +
      `${report.actions.filter((action) => action.derivedSensitivity === "mp-observational").length} mp-observational, ` +
      `${report.actions.filter((action) => action.derivedSensitivity === "mp-insensitive").length} mp-insensitive; ` +
      `${report.mechanisms.length} mechanisms (` +
      `${mechanisms.length} requiring shared-world evidence)`,
  );
  for (const id of mechanisms)
    lines.push(`  [mechanism-shared-world] ${id}: single-player evidence cannot stand in for a shared world`);
  for (const [id, scope] of mechanismAcks)
    lines.push(`  [acknowledged:unverified_mechanism_scope] ${id} — ${scope.reason} (owner: ${scope.owner})`);
  for (const defect of report.overRestricted)
    lines.push(`  [over-restriction] ${defect.actionId}: ${defect.detail}`);
  for (const entry of report.acknowledged)
    lines.push(`  [acknowledged:${entry.defect}] ${entry.actionId} — ${entry.reason} (owner: ${entry.owner})`);
  for (const defect of report.unverifiedScope)
    lines.push(`  [unverified-scope] ${defect.actionId}: ${defect.detail}`);
  for (const mismatch of admissionMismatches)
    lines.push(`  [admission-mismatch] ${mismatch.actionId}: ${mismatch.detail}`);
  for (const entry of mpSemanticWithoutTopology)
    lines.push(`  [topology-understated] ${entry.actionId}: requires ${entry.requiredLiveTopology}`);

  const blocking =
    report.defects.length +
    admissionMismatches.length +
    mpSemanticWithoutTopology.length +
    blockingMechanisms.length;

  if (args.report || blocking > 0) console.log(lines.join("\n"));

  if (blocking > 0) {
    console.error(
      `native multiplayer sensitivity: ${blocking} blocking finding(s) ` +
        `(${report.defects.length} unpinned defect, ${admissionMismatches.length} admission mismatch, ` +
        `${mpSemanticWithoutTopology.length} topology understated, ` +
        `${blockingMechanisms.length} unacknowledged shared-world mechanism).`,
    );
    process.exitCode = 1;
  } else if (!args.report) {
    console.log(lines.join("\n"));
  }
} catch (error) {
  console.error(`${error.code ?? "multiplayer_sensitivity_failed"}: ${error.message}`);
  if (error.details && Object.keys(error.details).length) console.error(JSON.stringify(error.details));
  process.exitCode = 2;
}
