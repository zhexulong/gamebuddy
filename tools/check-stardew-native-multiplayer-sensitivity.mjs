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
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { validateMultiplayerSensitivityRegister } from "./lib/stardew-native-multiplayer-sensitivity.mjs";

/** Admission tokens that constitute an outright multiplayer rejection. */
const MP_REJECT_PATTERN =
  /Context\.IsMultiplayer|!Game1\.IsMasterGame|getAllFarmers\(\)\.Count\(\)\s*!=\s*1|Game1\.server\s+is not null/;

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
    if (!value || value.startsWith("--"))
      fail("multiplayer_sensitivity_arguments_invalid", `Missing value for ${option}.`);
    result[option.slice(2)] = value;
  }
  if (!(result.register && result["source-root"]))
    fail(
      "multiplayer_sensitivity_arguments_required",
      "Usage: --register <register.json> --source-root <exact-decompile-root> [--report]",
    );
  return result;
}

/**
 * Derive, per action, the native game methods its Mod handler reaches.
 *
 * Why this axis exists: `Axis 1` only proves the recorded seam *exists* in the
 * decompiled source. It cannot prove the action reaches it. A seam that is never
 * invoked still validates — `machine_inspect` was registered against
 * `GameLocation.checkAction` while its handler performs no native call at all and
 * its descriptor declares it read-only.
 *
 * Two invocation shapes count, because both reach the seam:
 *   direct          `axe.DoFunction(...)`, `location.checkAction(...)`
 *   via body driver `controller.TryStart(approach, ...)` where magnetic pickup owns
 *                   the native call on later game updates (`pickup_item`)
 */
const NATIVE_CALL_PATTERN =
  /\b(?:[A-Za-z_]\w*\.)*(DoFunction|performToolAction|performUseAction|performObjectDropInAction|checkAction|checkForAction|placementAction|receiveGift|createItem|addItem|shipItem|warpFarmer|tryToCheckAt|collect|eatObject|getShippingBin|GetItemsForPlayer|closeDialogue)\s*\(/g;

/**
 * One-hop delegations observed in the Mod or in the game itself: the handler calls
 * the left method, which reaches the right one. Recorded explicitly so the detector
 * cannot silently accept an unreachable seam.
 */
const SEAM_DELEGATION_TARGETS = Object.freeze([
  // `Farmer.eatHeldObject()` calls `eatObject(ActiveObject)`; the register cites eatObject.
  ["eatHeldObject", "eatObject"],
]);

/**
 * `NATIVE_CALL_PATTERN` also treats `eatHeldObject` as a native call for the same
 * reason — the detector must see it before the delegation hop can fire.
 */
const NATIVE_DELEGATING_CALL = /\b(?:[A-Za-z_]\w*\.)*eatHeldObject\s*\(/;

/**
 * Approach-and-let-the-world-own-it: the handler starts a body approach and the
 * native mutation happens on later game updates.
 *
 * `pickup_item` is the reference case: `RequestLocalPickupItem` records
 * `native_auto_collect=true` and hands the approach to the body controller;
 * `Debris.updateChunks` owns magnetic delivery and calls `Debris.collect` on a
 * following update. The handler never calls `collect` itself — that is the design,
 * not a missing invocation.
 */
const NATIVE_AUTO_COLLECT_MARKER = /native_auto_collect=true/;

/**
 * Private Mod wrappers that reach a native seam on the handler's behalf.
 *
 * `RequestLocalPlaceWoodFence` calls `PlaceQualifiedWoodFenceNative(...)`, and that
 * helper is the one that invokes `Object.placementAction`. The wrapper exists so the
 * handler can re-check the finite `(O)322` source before the closed `IsFenceItem`
 * branch runs — the seam is still reached, just through a named helper.
 */
const MOD_WRAPPER_TO_SEAM = Object.freeze([
  ["PlaceQualifiedWoodFenceNative", "placementAction"],
  // `RequestLocalMinecartRide` delegates the native ride to `RideMinecart`, whose
  // only native call is `GameLocation.MinecartWarp`. The wrapper exists because it
  // also applies the ticket price transaction the native menu path documents, so
  // the handler body alone never names the seam.
  ["RideMinecart", "MinecartWarp"],
  // `RequestLocalAdvanceDay` hands the night to `SleepAndAdvanceDayLifecycle`,
  // which answers the game-owned Sleep question (`GameLocation.answerDialogue`)
  // exactly as the native input paths do. `answerDialogue` itself reads no
  // multiplayer token; the outcome fork is one step further in `startSleep`, so
  // that is the seam the register cites and the wrapper reaches it on the
  // handler's behalf.
  ["SleepAndAdvanceDayLifecycle.TryStart", "startSleep"],
  // Every direct tool swing funnels into the shared `UseNativeToolOnTile` seam
  // (`d8a422a`), which reproduces the native swing in its canonical order:
  // `tool.DoFunction(...)`, `who.lastClick = Vector2.Zero`, then the native
  // `checkForExhaustion(staminaBefore)` check. The register cites the tool's
  // `DoFunction` as the native seam (gameplay-capability-expansion §6.3), so the
  // wrapper reaches it on every tool-family handler's behalf.
  ["UseNativeToolOnTile", "DoFunction"],
]);

/**
 * Lifecycle entry points that reach a tool's native seam on a later frame.
 *
 * FarmAnimal produce collection is owned by the tool animation: the handler calls
 * `Game1.player.BeginUsingTool()` and the apex frame invokes `Tool.DoFunction`
 * (MilkPail / Shears). This is the documented seam from
 * `gameplay-capability-expansion` §6.3 — the Mod does not call `DoFunction` itself.
 */
const TOOL_LIFECYCLE_TO_DOFUNCTION = /\bGame1\.player\.(?:BeginUsingTool|FireTool)\s*\(/;

/**
 * Resolve the actions whose descriptor declares them **read-only**.
 *
 * `FarmhandActionDefinitions` maps `actionId` → descriptor factory via
 * `E("id", …, Descriptor())`, and only the factory body knows the mode. Scanning the
 * factory bodies separately keeps the argument names (`"x"`, `"y"`) from being
 * mistaken for an action id.
 */
function deriveReadOnlyActions(definitionsText) {
  const factories = new Map();
  for (const match of definitionsText.matchAll(
    /private static FarmhandActionDescriptor (\w+)\(\)\s*=>\s*([\s\S]*?);\s*\n/g,
  ))
    factories.set(match[1], match[2]);
  const readOnly = new Set();
  for (const match of definitionsText.matchAll(/E\("([a-z_]+)"[^)]*?,\s*(\w+)\(\)\)/g)) {
    const [, actionId, factory] = match;
    if (/EmbodiedActorResource,\s*"read"/.test(factories.get(factory) ?? "")) readOnly.add(actionId);
  }
  return readOnly;
}

async function deriveNativeSeamCalls(repoRoot) {
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

  // Read-only descriptors: the action has no mutation, so no seam invocation is expected.
  const definitions = await readFile(
    path.join(repoRoot, "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs"),
    "utf8",
  );
  const readOnlyActions = deriveReadOnlyActions(definitions);

  const derived = new Map();
  for (const [actionId, method] of actionToMethod) {
    const body = methodBody.get(method);
    if (!body) continue;
    const called = [...new Set([...body.matchAll(NATIVE_CALL_PATTERN)].map((match) => match[1]))].sort();
    /** Follow one recorded delegation hop: `eatHeldObject()` → `eatObject(..)` */
    const reached = new Set(called);
    if (NATIVE_DELEGATING_CALL.test(body)) reached.add("eatHeldObject");
    for (const [from, to] of SEAM_DELEGATION_TARGETS) if (reached.has(from)) reached.add(to);
    /**
     * The tool animation owns the native seam on a later frame. When the handler
     * starts the animation, the apex frame reaches `Tool.DoFunction` — the
     * documented seam (gameplay-capability-expansion §6.3), not an absent call.
     */
    if (TOOL_LIFECYCLE_TO_DOFUNCTION.test(body)) reached.add("DoFunction");
    /** Magnetic pickup owns `Debris.collect`; the handler only records the approach. */
    if (NATIVE_AUTO_COLLECT_MARKER.test(body)) reached.add("collect");
    /** Private Mod wrappers that call the native seam on the handler's behalf. */
    for (const [wrapper, seam] of MOD_WRAPPER_TO_SEAM) if (body.includes(`${wrapper}(`)) reached.add(seam);
    derived.set(actionId, {
      method,
      calledNativeMethods: [...reached].sort(),
      readOnly: readOnlyActions.has(actionId),
    });
  }
  return derived;
}

/**
 * Extract the method name from a register signature.
 *
 * Register signatures are written in two forms and both must parse:
 *   `public virtual bool checkAction`
 *   `public void shipItem(Item i, Farmer who)`
 * Taking the last parenthesised token only works for the second form, so the bare
 * form falls back to the final identifier.
 */
function nativeMemberOf(signature) {
  const withParens = signature.match(/([A-Za-z_]\w*)\s*\(/g);
  if (withParens) return withParens[withParens.length - 1].replace(/\s*\($/, "");
  const tokens = signature.trim().split(/\s+/);
  return tokens[tokens.length - 1].replace(/\(.*$/, "");
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
    const reasonCode = (admission.match(/"(native_local_player_required|master_player_required|world_not_ready)"/) ??
      [])[1];
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
  const [registerText, sources, modAdmission, pipelines, nativeSeamCalls] = await Promise.all([
    readFile(args.register, "utf8"),
    collectSources(args["source-root"]),
    deriveModAdmission(repoRoot),
    derivePipelineRoutedActions(repoRoot),
    deriveNativeSeamCalls(repoRoot),
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

  // Axis 3 must match the register: the action must actually reach its recorded
  // native seam. A seam that validates but is never called lets a read-only action
  // masquerade as a native mutation (machine_inspect did exactly that).
  // The validated report omits `seams`, so read them from the register itself.
  const registerActionsById = new Map(register.actions.map((action) => [action.actionId, action]));
  const seamCallMismatches = [];
  for (const action of report.actions) {
    const observed = nativeSeamCalls.get(action.actionId);
    if (!observed) continue;
    const declared = registerActionsById.get(action.actionId)?.seams ?? [];
    for (const seam of declared) {
      if ((seam.kind ?? "native") !== "native") continue;
      const memberName = nativeMemberOf(seam.signature);
      if (!memberName) continue;
      if (observed.calledNativeMethods.includes(memberName)) continue;
      seamCallMismatches.push({
        actionId: action.actionId,
        detail:
          `register cites ${seam.file}::${memberName} but ${observed.method} never calls it ` +
          `(called: ${observed.calledNativeMethods.join(", ") || "none"})` +
          (observed.readOnly ? "; the descriptor declares this action read-only" : ""),
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
  const _acknowledgedMechanisms = mechanisms.filter((id) => mechanismAcks.has(id));

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
  for (const defect of report.overRestricted) lines.push(`  [over-restriction] ${defect.actionId}: ${defect.detail}`);
  for (const entry of report.acknowledged)
    lines.push(`  [acknowledged:${entry.defect}] ${entry.actionId} — ${entry.reason} (owner: ${entry.owner})`);
  for (const defect of report.unverifiedScope) lines.push(`  [unverified-scope] ${defect.actionId}: ${defect.detail}`);
  for (const mismatch of admissionMismatches)
    lines.push(`  [admission-mismatch] ${mismatch.actionId}: ${mismatch.detail}`);
  for (const mismatch of seamCallMismatches)
    lines.push(`  [seam-call-mismatch] ${mismatch.actionId}: ${mismatch.detail}`);
  for (const entry of mpSemanticWithoutTopology)
    lines.push(`  [topology-understated] ${entry.actionId}: requires ${entry.requiredLiveTopology}`);

  const blocking =
    report.defects.length +
    admissionMismatches.length +
    seamCallMismatches.length +
    mpSemanticWithoutTopology.length +
    blockingMechanisms.length;

  if (args.report || blocking > 0) console.log(lines.join("\n"));

  if (blocking > 0) {
    console.error(
      `native multiplayer sensitivity: ${blocking} blocking finding(s) ` +
        `(${report.defects.length} unpinned defect, ${admissionMismatches.length} admission mismatch, ` +
        `${seamCallMismatches.length} seam-call mismatch, ` +
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
