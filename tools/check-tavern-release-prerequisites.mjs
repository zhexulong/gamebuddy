import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const REQUIRED_MUST_FLOWS = Object.freeze([
  "companion-library",
  "manage-chats",
  "new-companion",
  "new-chat",
  "persona-scenario-greeting-selection",
  "effect-aware-causal-guard",
  "worldbook-catalog-binding",
  "character-worldbook-chat-import-export",
  "authenticated-reconnect",
  "memory-management",
]);

// This is deliberately a bounded ordinary-containment check. It executes the
// actual Host security regressions rather than treating source tokens as
// evidence. Node pathname APIs cannot prove safety against a same-user hostile
// replacement between the final check and the filesystem operation; that P3
// residual risk must remain explicit rather than being promoted to a release
// claim.
const HOST_TAVERN_CONTAINMENT_TEST_FILES = Object.freeze([
  "dist-test/tavern/artifact-store.test.js",
  "dist-test/tavern/chat-thread-store.test.js",
  "dist-test/tavern/chat-draft/chat-draft-store.test.js",
  "dist-test/tavern/world-info-management/world-info-management.test.js",
  "dist-test/tavern/new-companion-service.test.js",
  "dist-test/path-lock.test.js",
]);

const WINDOWS_REPARSE_LIVE_GATE_PATH = Object.freeze(["host", "scripts", "run-windows-reparse-live-gate.mjs"]);
const WINDOWS_REPARSE_LIVE_GATE_TIMEOUT_MS = 120_000;
const WINDOWS_REPARSE_LIVE_GATE_MAX_BUFFER_BYTES = 16 * 1024;
const WINDOWS_ARBITRARY_REPARSE_ENFORCEMENT = Object.freeze({
  detail: "windows_reparse_live_gate_failed_or_could_not_run",
  passedDetail: "current_windows_reparse_live_gate_exact_success_verified",
});

function runWindowsReparseLiveGate(root) {
  const scriptPath = resolve(root, ...WINDOWS_REPARSE_LIVE_GATE_PATH);
  return spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    shell: false,
    timeout: WINDOWS_REPARSE_LIVE_GATE_TIMEOUT_MS,
    maxBuffer: WINDOWS_REPARSE_LIVE_GATE_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
}

function isExactWindowsReparseLiveGateSuccess(child) {
  if (
    !child ||
    child.error ||
    child.signal ||
    child.status !== 0 ||
    child.stderr !== "" ||
    typeof child.stdout !== "string" ||
    !child.stdout.endsWith("\n") ||
    child.stdout.includes("\r")
  ) {
    return false;
  }

  const line = child.stdout.slice(0, -1);
  let output;
  try {
    output = JSON.parse(line);
  } catch {
    return false;
  }

  return (
    JSON.stringify(output) === line &&
    JSON.stringify(Object.keys(output)) ===
      JSON.stringify(["schemaVersion", "gate", "status", "reason", "helperSha256", "probes", "consumers"]) &&
    output.schemaVersion === 1 &&
    output.gate === "windows_reparse_live_gate/v1" &&
    output.status === "passed" &&
    output.reason === "passed" &&
    typeof output.helperSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(output.helperSha256) &&
    JSON.stringify(output.probes) ===
      JSON.stringify({ regular: "passed", junction: "passed", directorySymlink: "passed", nonLinkReparse: "passed" }) &&
    JSON.stringify(output.consumers) === JSON.stringify({ browserGenerator: "passed", hostStaticVerifier: "passed" })
  );
}

function verifyWindowsReparseLiveGate(root, runner = runWindowsReparseLiveGate) {
  if (process.platform !== "win32") return false;
  try {
    return isExactWindowsReparseLiveGateSuccess(runner(root));
  } catch {
    return false;
  }
}

const TAVERN_FILESYSTEM_THREAT_MODEL = Object.freeze({
  schemaVersion: 1,
  descriptor: Object.freeze({ name: "gamebuddy-tavern-filesystem-threat-model", version: "1" }),
  ordinaryContainment: Object.freeze({
    status: "required",
    guarantees: Object.freeze(["reject_preexisting_link_or_reparse_escape", "fail_closed_outside_runtime_root"]),
    verification: "host_deterministic_containment_tests",
  }),
  sameUserHostilePathRace: Object.freeze({
    status: "P3_defense_in_depth_residual_risk",
    guarantee: "not_provided",
    escalation: "windows_handle_relative_no_follow_required_before_claiming_protection",
  }),
});

const here = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(here, "..");

function result(id, status, detail) {
  return { id, status, detail };
}

function validateTavernFilesystemThreatModel(model) {
  const ordinary = model?.ordinaryContainment;
  const hostile = model?.sameUserHostilePathRace;
  if (
    model?.schemaVersion !== 1 ||
    model?.descriptor?.name !== "gamebuddy-tavern-filesystem-threat-model" ||
    model?.descriptor?.version !== "1" ||
    ordinary?.status !== "required" ||
    ordinary?.verification !== "host_deterministic_containment_tests" ||
    !Array.isArray(ordinary?.guarantees) ||
    JSON.stringify([...ordinary.guarantees].sort()) !==
      JSON.stringify(["fail_closed_outside_runtime_root", "reject_preexisting_link_or_reparse_escape"]) ||
    hostile?.status !== "P3_defense_in_depth_residual_risk" ||
    hostile?.guarantee !== "not_provided" ||
    hostile?.escalation !== "windows_handle_relative_no_follow_required_before_claiming_protection"
  ) {
    return "tavern_filesystem_threat_model_drift";
  }
  return undefined;
}

function runTavernContainmentTests(exec, root) {
  exec(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--filter", "@gamebuddy/companion-host", "build:test"], {
    cwd: root,
    stdio: "pipe",
    ...(process.platform === "win32" ? { shell: true } : {}),
  });
  exec(process.execPath, ["--test", ...HOST_TAVERN_CONTAINMENT_TEST_FILES.map((path) => resolve(root, "host", path))], {
    cwd: root,
    stdio: "pipe",
  });
}

/**
 * Checks only release-profile prerequisites that can be established locally.
 * It intentionally does not turn a contract-only Magic Context source into a
 * runtime proof and does not read target taxonomy as mounted or released authority.
 */
export async function checkTavernReleasePrerequisites({
  root = repositoryRoot,
  verifyReferences = true,
  read = readFile,
  verifyStableContextRuntime = true,
  tavernFilesystemThreatModel = TAVERN_FILESYSTEM_THREAT_MODEL,
  exec = execFileSync,
  windowsReparseLiveGateRunner = runWindowsReparseLiveGate,
} = {}) {
  const sourcePath = resolve(root, "vendor/magic-context/packages/pi-plugin/src/gamebuddy-stable-context-source.ts");
  const source = await read(sourcePath, "utf8");
  const checks = [];
  if (verifyWindowsReparseLiveGate(root, windowsReparseLiveGateRunner)) {
    checks.push(
      result("windows_arbitrary_reparse_enforcement", "passed", WINDOWS_ARBITRARY_REPARSE_ENFORCEMENT.passedDetail),
    );
  } else {
    checks.push(
      result("windows_arbitrary_reparse_enforcement", "blocked", WINDOWS_ARBITRARY_REPARSE_ENFORCEMENT.detail),
    );
  }
  const threatModelIssue = validateTavernFilesystemThreatModel(tavernFilesystemThreatModel);
  if (threatModelIssue) {
    checks.push(result("tavern_filesystem_threat_model", "blocked", threatModelIssue));
  } else {
    try {
      runTavernContainmentTests(exec, root);
      checks.push(
        result(
          "tavern_ordinary_link_reparse_containment",
          "passed",
          "ordinary symlink/junction/reparse containment tests passed; same-user hostile TOCTOU is an explicit P3 residual risk, not a hostile-race safety claim",
        ),
      );
    } catch {
      checks.push(
        result(
          "tavern_ordinary_link_reparse_containment",
          "blocked",
          "tavern_ordinary_link_reparse_containment_tests_failed_or_could_not_run",
        ),
      );
    }
  }
  const runtimeUnwired =
    /runtime publication is intentionally unwired|later runtime-wiring slice|materializationStatus\s*=\s*"contract-only"/.test(
      source,
    );
  if (runtimeUnwired) {
    checks.push(
      result(
        "magic_context_stable_source",
        "blocked",
        "magic_context_source_contract_only: source rendering is not runtime-wired through the required marker/render lifecycle; Tavern live run must not begin",
      ),
    );
  } else if (!verifyStableContextRuntime) {
    checks.push(
      result(
        "magic_context_stable_source",
        "blocked",
        "magic_context_source_runtime_proof_missing: version-locked source/marker/render tests were not executed",
      ),
    );
  } else {
    try {
      exec(
        process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        [
          "--dir",
          resolve(root, "vendor/magic-context/packages/pi-plugin"),
          "exec",
          "bun",
          "test",
          "src/gamebuddy-stable-context-source.test.ts",
          "src/inject-compartments-pi.test.ts",
          "src/context-handler.test.ts",
        ],
        {
          cwd: root,
          stdio: "pipe",
          ...(process.platform === "win32" ? { shell: true } : {}),
        },
      );
      checks.push(
        result("magic_context_stable_source", "passed", "version-locked source/marker/render lifecycle tests passed"),
      );
    } catch {
      checks.push(
        result(
          "magic_context_stable_source",
          "blocked",
          "magic_context_source_runtime_proof_failed: version-locked source/marker/render tests failed or could not run",
        ),
      );
    }
  }

  if (verifyReferences) {
    try {
      exec(process.execPath, [resolve(root, "tools/verify-tavern-semantic-references.mjs")], {
        cwd: root,
        stdio: "pipe",
      });
      checks.push(
        result("semantic_reference_attestation", "passed", "locked SillyTavern source anchors and fixtures verified"),
      );
    } catch {
      checks.push(
        result("semantic_reference_attestation", "blocked", "semantic-reference attestation failed or could not run"),
      );
    }
  }

  const blocked = checks.filter((check) => check.status !== "passed");
  return {
    gate: "tavern_release_prerequisites/v1",
    verdict: blocked.length === 0 ? "passed" : "blocked",
    checks,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const report = await checkTavernReleasePrerequisites();
    console.log(JSON.stringify(report, null, 2));
    if (report.verdict !== "passed") process.exitCode = 2;
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          gate: "tavern_release_prerequisites/v1",
          verdict: "blocked",
          checks: [result("checker_execution", "blocked", error instanceof Error ? error.message : String(error))],
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
  }
}
