#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  allowsTransitionImplementation,
  TARGET_BUILD,
  validateTransitionCharacterization,
} from "./stardew-navigation-transition-characterization-validator.mjs";
import {
  allowsMultiHopTopologyImplementation,
  validateMultiSourceTransitionCharacterization,
} from "./stardew-navigation-multisource-characterization-validator.mjs";
import { productionMultiSourceReceiptLedger } from "./stardew-navigation-multisource-receipt-ledger.mjs";

/**
 * Zero-dispatch static topology preflight for the Task 7 navigation gate.
 *
 * Validates the actual target-version install, the static Mod bundle, and the
 * caller-supplied transition-characterization artifact, plus a no-dispatch /
 * no-M8 static source closure of the Navigation sources. It never launches
 * Stardew, never connects a named pipe, never writes fixtures/profiles/config,
 * never calls execute(), and never creates a target artifact.
 */

export const ASSEMBLY_NAME = "Stardew Valley.dll";
export const BUNDLE_FILES = Object.freeze([
  "GameBuddy.Stardew.dll",
  "GameBuddy.Stardew.Core.dll",
  "manifest.json",
  "GameBuddy.Stardew.deps.json",
  "Raffinert.FuzzySharp.dll",
]);
export const BUNDLE_MANIFEST_UNIQUE_ID = "zhexulong.GameBuddy";
export const BUNDLE_MANIFEST_ENTRY_DLL = "GameBuddy.Stardew.dll";
export const M8_ANCHORS = Object.freeze([
  "enter_mine", "use_mine_ladder", "select_mine_elevator_floor", "reach_mine_floor",
]);
export const DISPATCH_ANCHORS = Object.freeze(["warpFarmer", ".Execute(", "EnterMineShaft"]);
export const ORDINARY_WARP_ANCHOR = "warps";
export const NAVIGATION_SOURCES = Object.freeze([
  "NavigationExecutionCoordinator.cs",
  "NavigationLifecycle.cs",
  "Game1NavigationWorldSource.cs",
  "ExecutionModels.cs",
]);
const execFileAsync = promisify(execFile);

function isRecord(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

export async function defaultReadVersion(filePath) {
  if (process.platform !== "win32") throw new Error("target_version_read_unavailable");
  const result = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Command", "$p=$env:GAMEBUDDY_INSPECT_FILE; (Get-Item -LiteralPath $p).VersionInfo.FileVersion"],
    { encoding: "utf8", env: { ...process.env, GAMEBUDDY_INSPECT_FILE: filePath } },
  );
  const version = result.stdout?.trim();
  return version || null;
}

function ready(checks) {
  return Object.freeze({
    state: "PREFLIGHT_READY",
    blockers: Object.freeze([]),
    checks,    mutationCount: 0,
    executionReceiptCount: 0,
    ready: true,
  });
}

function blocked(checks, blockers) {
  return Object.freeze({
    state: "BLOCKED",
    blockers: Object.freeze([...blockers]),
    checks,
    mutationCount: 0,
    executionReceiptCount: 0,
    ready: false,
  });
}

// Composition receives this only through the module-private WeakMap, so public
// reports never disclose registry, raw artifact, digest, or marker details.
const deferredMultiSourceClaims = new WeakMap();
export function consumeDeferredMultiSourceReceiptClaim(report) {
  const deferred = deferredMultiSourceClaims.get(report);
  return deferred ? deferred.ledger.consume(deferred.claim) : Promise.resolve(false);
}

export async function runTopologyPreflight(options = {}) {
  const gamePath = options.gamePath ?? process.env.GAMEBUDDY_STARDEW_GAME_PATH;
  const releaseDir = options.releaseDir ?? "integrations/stardew/bin/Release/net6.0";
  const artifactPath = options.transitionArtifact;
  const multiSourceArtifactPath = options.multiSourceTransitionArtifact;
  const readVersion = options.readVersion ?? defaultReadVersion;
  const navSrcDir = options.navigationSrcDir ?? "integrations/stardew/Navigation";
  const requestedNavigationScope = options.requestedNavigationScope;
  // Multi-hop authority is fixed in reviewed source; callers cannot select a
  // registry, marker root, or ledger implementation through this preflight.
  const receiptLedger = productionMultiSourceReceiptLedger;
  const deferMultiSourceReceiptConsume = options.deferMultiSourceReceiptConsume === true;
  let multiSourceReceiptClaim = null;
  const blockers = [];
  const checks = {};

  if (!gamePath) {
    blockers.push({ check: "target_version", reason: "game_path_required" });
    checks.version = { status: "blocked", reason: "game_path_required" };
  } else {
    const dllPath = join(gamePath, ASSEMBLY_NAME);
    let version = null;
    try { version = await readVersion(dllPath); } catch { version = null; }
    if (version !== TARGET_BUILD) {
      blockers.push({ check: "target_version", reason: "version_mismatch", expected: TARGET_BUILD, actual: version });
      checks.version = { status: "blocked", reason: "version_mismatch" };
    } else {
      checks.version = { status: "ready", version };
    }
  }
  const bundle = {};
  if (!releaseDir) {
    blockers.push({ check: "bundle", reason: "release_dir_required" });
    checks.bundle = { status: "blocked", reason: "release_dir_required" };
  } else {
    for (const name of BUNDLE_FILES) {
      let present = true;
      try { createHash("sha256").update(await readFile(join(releaseDir, name))).digest("hex"); } catch { present = false; }
      bundle[name] = { present };
      if (!present) blockers.push({ check: "bundle", reason: "bundle_missing", file: name });
    }
    let uniqueId = null;
    let entryDll = null;
    try { const m = JSON.parse(await readFile(join(releaseDir, "manifest.json"), "utf8")); uniqueId = m.UniqueID; entryDll = m.EntryDll; } catch { blockers.push({ check: "bundle_manifest", reason: "manifest_unreadable" }); }
    if (uniqueId !== BUNDLE_MANIFEST_UNIQUE_ID) blockers.push({ check: "bundle_manifest", reason: "unique_id_mismatch", actual: uniqueId });
    if (entryDll !== BUNDLE_MANIFEST_ENTRY_DLL) blockers.push({ check: "bundle_manifest", reason: "entry_dll_mismatch", actual: entryDll });
    checks.bundle = { status: blockers.some((b) => b.check === "bundle" || b.check === "bundle_manifest") ? "blocked" : "ready", manifest: { uniqueId, entryDll }, files: bundle };
  }
  // --- Caller-supplied transition artifact (direct source-only authority) ---
  // When multi_hop_ordinary_warp is requested, the old transition artifact is
  // optional; only the multi-source artifact is required. If a source-only
  // artifact is supplied, it is still validated and the existing scope blocker
  // is emitted for current_source_only scope.
  let parsed = null;
  let passed = false;
  const needOldArtifact = requestedNavigationScope !== "multi_hop_ordinary_warp";
  if (!artifactPath) {
    if (needOldArtifact) {
      blockers.push({ check: "transition_artifact", reason: "artifact_required" });
      checks.artifact = { status: "blocked", reason: "artifact_required" };
    } else {
      checks.artifact = { status: "skipped", reason: "not_required_for_multi_hop" };
    }
  } else {
    try { parsed = JSON.parse(await readFile(artifactPath, "utf8")); } catch { blockers.push({ check: "transition_artifact", reason: "artifact_unreadable" }); }
    const validation = parsed ? validateTransitionCharacterization(parsed) : { valid: false, errors: ["unreadable"] };
    const allowed = !!(parsed && allowsTransitionImplementation(parsed));
    passed = allowed && validation.valid;
    const familyOk = passed &&
      parsed.observationScope === "current_source_only" &&
      Number.isSafeInteger(parsed.permittedFamilyCounts?.ordinaryWarp) &&
      parsed.permittedFamilyCounts.ordinaryWarp > 0 &&
      parsed.permittedFamilyCounts.ordinaryDoor === 0;
    const zeroExcluded = passed && parsed.excludedFamilyCounts &&
      Object.values(parsed.excludedFamilyCounts).every((n) => n === 0);
    const nonMutating = passed && parsed.mutationCount === 0 && parsed.executionReceiptCount === 0;
    const cleaned = passed && parsed.fixtureCleanup?.restored === true && parsed.fixtureCleanup?.noStardewProcess === true;
    if (!validation.valid) blockers.push({ check: "transition", reason: "artifact_invalid", errors: validation.errors });
    if (passed && !familyOk) blockers.push({ check: "transition_family", reason: "ordinary_warp_only_violated" });
    if (passed && !zeroExcluded) blockers.push({ check: "transition_family", reason: "excluded_family_count_present" });
    if (passed && !nonMutating) blockers.push({ check: "transition", reason: "invariant_violated" });
    if (passed && !cleaned) blockers.push({ check: "transition", reason: "fixture_cleanup_incomplete" });
    if (!passed) blockers.push({ check: "transition", reason: "blocked_artifact" });
    checks.artifact = { status: blockers.some((b) => b.check === "transition" || b.check === "transition_family") ? "blocked" : "ready", terminalStatus: parsed?.terminalStatus, predicateCode: parsed?.predicateCode, allowed, observationScope: parsed?.observationScope };
  }

  // --- Multi-source transition artifact (audit projection; never sole authority) ---
  if (requestedNavigationScope === "multi_hop_ordinary_warp") {
    if (!multiSourceArtifactPath) {
      blockers.push({ check: "multi_source_artifact", reason: "multi_source_artifact_required_or_invalid", detail: "multi_hop_ordinary_warp requires a multi-source transition artifact" });
      checks.multiSourceArtifact = { status: "blocked", reason: "multi_source_artifact_required_or_invalid" };
    } else {
      let multiParsed = null;
      let multiRaw = null;
      try {
        multiRaw = await readFile(multiSourceArtifactPath);
        multiParsed = JSON.parse(multiRaw.toString("utf8"));
      } catch {
        blockers.push({ check: "multi_source_artifact", reason: "multi_source_artifact_required_or_invalid", detail: "multi-source artifact unreadable" });
        checks.multiSourceArtifact = { status: "blocked", reason: "multi_source_artifact_required_or_invalid" };
      }
      if (multiParsed) {
        const multiValidation = validateMultiSourceTransitionCharacterization(multiParsed);
        const multiAllowed = allowsMultiHopTopologyImplementation(multiParsed);
        if (!multiValidation.valid) {
          blockers.push({ check: "multi_source_artifact", reason: "multi_source_artifact_required_or_invalid", detail: "multi-source artifact invalid", errors: multiValidation.errors });
          checks.multiSourceArtifact = { status: "blocked", reason: "multi_source_artifact_required_or_invalid", valid: false };
        } else if (!multiAllowed) {
          blockers.push({ check: "multi_source_artifact", reason: "multi_source_artifact_required_or_invalid", detail: `multi-source artifact blocked: ${multiParsed.predicateCode}` });
          checks.multiSourceArtifact = { status: "blocked", reason: "multi_source_artifact_required_or_invalid", terminalStatus: multiParsed.terminalStatus, predicateCode: multiParsed.predicateCode };
        } else {
          const prepared = receiptLedger.preparePassedClaim({ rawArtifact: multiRaw });
          if (!prepared.ok) {
            blockers.push({ check: "multi_source_receipt", reason: "multi_source_receipt_required_or_invalid" });
            checks.multiSourceArtifact = { status: "blocked", reason: "multi_source_receipt_required_or_invalid" };
          } else {
            multiSourceReceiptClaim = prepared.claim;
            checks.multiSourceArtifact = { status: "ready", terminalStatus: "passed", predicateCode: "successful_multisource_characterization" };
          }
        }
      }
    }
    // If a source-only artifact was also supplied, keep its existing direct
    // behavior: emit the existing scope blocker if it's current_source_only.
    if (parsed && passed && parsed.observationScope === "current_source_only") {
      blockers.push({ check: "transition_scope", reason: "current_source_only_cannot_authorize_multi_hop", detail: "artifact observationScope is current_source_only; multi_hop_ordinary_warp requires a validated multi-source artifact" });
      checks.transition_scope = { status: "blocked", reason: "current_source_only_cannot_authorize_multi_hop" };
    }
  } else if (requestedNavigationScope !== undefined && requestedNavigationScope !== "current_source_only") {
    // Unknown future scope: fail closed.
    blockers.push({ check: "transition_scope", reason: "unknown_requested_scope", detail: `requestedNavigationScope=${requestedNavigationScope}` });
    checks.transition_scope = { status: "blocked", reason: "unknown_requested_scope" };
  }
  // --- Source-only, no-dispatch, no-M8 static closure ---
  const sources = {};
  for (const name of NAVIGATION_SOURCES) {
    let text = null;
    try { text = await readFile(join(navSrcDir, name), "utf8"); } catch { text = null; }
    sources[name] = { present: text !== null, anchors: {} };
    if (text === null) { blockers.push({ check: "navigation_source", reason: "source_missing", file: name }); continue; }
    for (const anchor of DISPATCH_ANCHORS)
      if (text.includes(anchor)) { sources[name].anchors[anchor] = true; blockers.push({ check: "navigation_source", reason: "dispatch_anchor", file: name }); }
    for (const anchor of M8_ANCHORS)
      if (text.includes(anchor)) { sources[name].anchors[anchor] = true; blockers.push({ check: "navigation_source", reason: "m8_anchor", file: name }); }
    if (name === "Game1NavigationWorldSource.cs" && !text.includes(ORDINARY_WARP_ANCHOR))
      blockers.push({ check: "navigation_source", reason: "ordinary_warp_contract_missing", file: name });
  }
  checks.source = { status: blockers.some((b) => b.check === "navigation_source") ? "blocked" : "ready", files: sources };

  if (blockers.length > 0) return blocked(checks, blockers);
  if (requestedNavigationScope === "multi_hop_ordinary_warp") {
    if (!multiSourceReceiptClaim) return blocked(checks, [{ check: "multi_source_receipt", reason: "multi_source_receipt_required_or_invalid" }]);
    if (deferMultiSourceReceiptConsume) {
      const report = ready(checks);
      deferredMultiSourceClaims.set(report, { ledger: receiptLedger, claim: multiSourceReceiptClaim });
      return report;
    }
    // This controlled local receipt-consumption marker is the final readiness
    // linearization point; it has no game, process, fixture, or action effect.
    if (!(await receiptLedger.consume(multiSourceReceiptClaim)))
      return blocked(checks, [{ check: "multi_source_receipt", reason: "multi_source_receipt_consumption_failed" }]);
  }
  return ready(checks);
}
function bindFlag(args, name) {
  for (let i = 0; i < args.length; i += 1) if (args[i] === name) return args[i + 1];
  return undefined;
}

async function cliMain(args) {
  const options = {
    gamePath: bindFlag(args, "--game-path"),
    releaseDir: bindFlag(args, "--release-dir"),
    transitionArtifact: bindFlag(args, "--transition-artifact"),
    multiSourceTransitionArtifact: bindFlag(args, "--multi-source-artifact"),
    navigationSrcDir: bindFlag(args, "--navigation-src-dir"),
    requestedNavigationScope: bindFlag(args, "--requested-navigation-scope"),
  };
  const report = await runTopologyPreflight(options);
  console.log(JSON.stringify({ state: report.state, ready: report.ready, checks: report.checks, blockers: report.blockers, mutationCount: report.mutationCount, executionReceiptCount: report.executionReceiptCount }));
  process.exitCode = report.ready ? 0 : 1;
}

if (process.argv[1] && new URL("file:" + process.argv[1]).href === import.meta.url) {
  cliMain(process.argv.slice(2)).catch((error) => { console.error(String(error?.message || error)); process.exitCode = 1; });
}
