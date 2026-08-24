#!/usr/bin/env node
/**
 * Content-free, bounded orchestrator for the Game Operational Gate.
 *
 * It deliberately has no fallback Game result: a real Game launch must publish
 * its Pi-session identity and an authoritative bridge receipt/snapshot through
 * a source-owned IPC contract before this runner may execute a live gate.
 */
import { randomBytes } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyGameOperationalGateMarkerReport } from "./lib/game-operational-gate-marker.mjs";
import { validateGameOperationalGatePreflight } from "./lib/game-operational-gate-preflight.mjs";

const HOST_ROOT = resolve(fileURLToPath(new URL("../host/", import.meta.url)));
// The planned live launch is pinned through this immutable-artifact launcher;
// admission is currently blocked before spawn because its Game child has no
// source-owned runtime/receipt IPC contract.
const PRODUCTION_LAUNCHER = join(HOST_ROOT, "scripts", "start-production-artifact.mjs");
const RUNNER_SCHEMA = "gamebuddy-game-operational-gate/v1";
const RUNNER_ID = "game-operational-gate";
const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,256}$/;

export function parseArguments(argv) {
  if (argv.length !== 2 && argv.length !== 4)
    throw new Error("usage: node tools/run-game-operational-gate.mjs --config <path> [--report <path>]");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (
      (flag !== "--config" && flag !== "--report") ||
      typeof value !== "string" ||
      value.length === 0 ||
      values.has(flag)
    )
      throw new Error("usage: node tools/run-game-operational-gate.mjs --config <path> [--report <path>]");
    values.set(flag, resolve(value));
  }
  if (!values.has("--config"))
    throw new Error("usage: node tools/run-game-operational-gate.mjs --config <path> [--report <path>]");
  return Object.freeze({ configPath: values.get("--config"), reportPath: values.get("--report") });
}

export function createOperationalDeploymentManifest(runtimeRoot, principal, bootstrapOperationId) {
  return Object.freeze({
    schemaVersion: 2,
    topology: "independent_chat_and_game_surfaces",
    runtimeRoot,
    principal: Object.freeze({ ...principal }),
    bootstrapOperationId,
    authorityGeneration: 1,
  });
}

function blocked(reasonCode) {
  return Object.freeze({ state: "BLOCKED", reasonCode });
}

/** Validates the runner-owned, payload-free binding of three one-shot markers. */
export function verifyOperationalMarkers(reports, sessions, nonceSha256) {
  if (!SHA256.test(nonceSha256)) return blocked("marker_nonce_invalid");
  if (
    !reports ||
    !sessions ||
    !OPAQUE_ID.test(sessions.chat) ||
    !OPAQUE_ID.test(sessions.game) ||
    !OPAQUE_ID.test(sessions.foreign)
  )
    return blocked("launcher_session_identity_unavailable");
  const consumed = new Set();
  const checked = {};
  for (const surface of ["chat", "game", "foreign"]) {
    const expectedSurface = surface === "foreign" ? "chat" : surface;
    const result = verifyGameOperationalGateMarkerReport(
      reports[surface],
      { sessionId: sessions[surface], nonceSha256, surface: expectedSurface },
      consumed,
    );
    if (!result.observed) return blocked(`${surface}_${result.reasonCode}`);
    checked[surface] = result;
  }
  const sharedMaterialized = ["chat", "game"].every(
    (surface) =>
      checked[surface].materializedCategoryCounts.SEMANTIC_MEMORY >= 1 &&
      checked[surface].materializedCategoryCounts.INTERACTION_EPISODE >= 1,
  );
  const foreignZeroSharedDelta =
    checked.foreign.materializedCategoryCounts.SEMANTIC_MEMORY === 0 &&
    checked.foreign.materializedCategoryCounts.INTERACTION_EPISODE === 0;
  return Object.freeze({
    state: sharedMaterialized && foreignZeroSharedDelta ? "READY" : "BLOCKED",
    ...(sharedMaterialized && foreignZeroSharedDelta
      ? { assertions: Object.freeze({ sharedMaterialized, foreignZeroSharedDelta }) }
      : {
          reasonCode: sharedMaterialized
            ? "foreign_marker_shared_delta_observed"
            : "shared_marker_materialization_unobserved",
        }),
  });
}

export async function prepareReportTarget(path) {
  if (path === undefined) return undefined;
  if (!isAbsolute(path) || relative(path, dirname(path)) === "") throw new Error("invalid_report_path");
  try {
    await lstat(path);
    throw new Error("report_target_already_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let parent;
  try {
    parent = await realpath(dirname(path));
  } catch {
    throw new Error("report_parent_missing_or_unresolvable");
  }
  const state = await lstat(parent);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("report_parent_not_real_directory");
  return join(parent, basename(path));
}

export async function writeReport(path, report) {
  if (path === undefined) return;
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (/(?:content|prompt|provider|cookie|csrf|token|jsonl|sqlite)/i.test(serialized))
    throw new Error("evidence_report_content_guard_rejected");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
  } finally {
    await handle.close();
  }
}

async function productionArtifactIdentity() {
  try {
    const pointer = JSON.parse(await readFile(join(HOST_ROOT, "dist", "current.json"), "utf8"));
    if (!OPAQUE_ID.test(pointer.generation) || !SHA256.test(pointer.inventoryDigest)) throw new Error("invalid");
    return Object.freeze({ generation: pointer.generation, inventoryDigest: pointer.inventoryDigest });
  } catch {
    throw new Error("production_artifact_identity_unavailable");
  }
}

async function loadConfig(path) {
  if (!isAbsolute(path)) throw new Error("config_path_invalid");
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 7 ||
    ![
      "runtimeRoot",
      "sharedIdentity",
      "foreignIdentity",
      "surfaceSessions",
      "markerNonceSha256",
      "gameOperatorConfigPath",
      "gameBridgeReceiptDeclaration",
    ].every((key) => Object.hasOwn(parsed, key))
  )
    throw new Error("operational_gate_config_shape_invalid");
  const preflight = validateGameOperationalGatePreflight(parsed);
  if (preflight.state !== "READY") throw new Error(preflight.reasonCode);
  if (
    typeof parsed.gameOperatorConfigPath !== "string" ||
    !isAbsolute(parsed.gameOperatorConfigPath) ||
    typeof parsed.gameBridgeReceiptDeclaration !== "string" ||
    parsed.gameBridgeReceiptDeclaration.length === 0
  )
    throw new Error("game_operator_config_or_receipt_declaration_invalid");
  return Object.freeze({
    ...preflight,
    gameOperatorConfigPath: parsed.gameOperatorConfigPath,
    gameBridgeReceiptDeclaration: parsed.gameBridgeReceiptDeclaration,
  });
}

function safeReasonCode(error) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:.-]{1,160}$/i.test(value) ? value : "live_runner_internal_error";
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const reportPath = await prepareReportTarget(args.reportPath);
  const runId = randomBytes(12).toString("hex");
  let report;
  try {
    const config = await loadConfig(args.configPath);
    const artifact = await productionArtifactIdentity();
    // Current immutable entries accept the nonce but expose neither an
    // operational runtime Pi-session IPC message nor a bridge receipt IPC
    // message. Do not start a process we cannot authenticate and observe.
    report = {
      schema: RUNNER_SCHEMA,
      runner: { id: RUNNER_ID, version: 1 },
      runId,
      artifact,
      state: "BLOCKED",
      reasonCode: "game_operational_runtime_or_bridge_receipt_ipc_unavailable",
      scope: "no_game_result_fabricated",
    };
    void config;
    void PRODUCTION_LAUNCHER;
  } catch (error) {
    report = {
      schema: RUNNER_SCHEMA,
      runner: { id: RUNNER_ID, version: 1 },
      runId,
      artifact: null,
      state: "BLOCKED",
      reasonCode: safeReasonCode(error),
      scope: "no_game_result_fabricated",
    };
  }
  await writeReport(reportPath, report);
  console.log(JSON.stringify(report));
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(JSON.stringify({ schema: RUNNER_SCHEMA, state: "BLOCKED", reasonCode: safeReasonCode(error) }));
      process.exitCode = 2;
    });
