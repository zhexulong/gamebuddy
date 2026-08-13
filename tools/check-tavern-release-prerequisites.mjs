import { execFileSync } from "node:child_process";
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

const REQUIRED_CHARTER_COVERAGE = Object.freeze([
  { flow: "companion-library", step: "TVL-00" },
  { flow: "manage-chats", step: "TVL-00" },
  { flow: "new-companion", step: "TVL-02" },
  { flow: "new-chat", step: "TVL-03" },
  { flow: "persona-scenario-greeting-selection", step: "TVL-03" },
  { flow: "effect-aware-causal-guard", step: "TVL-06" },
  { flow: "worldbook-catalog-binding", step: "TVL-03" },
  { flow: "character-worldbook-chat-import-export", step: "TVL-01" },
  { flow: "authenticated-reconnect", step: "TVL-05" },
  { flow: "memory-management", step: "TVL-09" },
]);

// A selected flow is not release-ready merely because it appears in the profile.
// Each entry ties it to a Host route or durable-artifact implementation and an
// executable Host contract test that exercises that implementation.
const HOST_MUST_FLOW_EVIDENCE = Object.freeze([
  {
    flow: "companion-library",
    route: 'routeEnabled("library")',
    artifact: "async listCompanions",
    test: "${base}/library",
  },
  {
    flow: "manage-chats",
    route: 'routeEnabled("manage-chats")',
    artifact: "async listChats",
    test: "${base}/manage-chats",
  },
  {
    flow: "new-companion",
    route: 'routeEnabled("new-companion")',
    artifact: "async createNewCompanion",
    test: "${base}/new-companion",
  },
  { flow: "new-chat", route: 'routeEnabled("new-chat")', artifact: "createThread", test: "${base}/new-chat" },
  {
    flow: "persona-scenario-greeting-selection",
    route: 'routeEnabled("new-chat-selections")',
    artifact: "openingSelection",
    test: "${base}/new-chat/selections",
  },
  {
    flow: "effect-aware-causal-guard",
    route: 'routeEnabled("retry-response")',
    artifact: "guardTavernCausalMutation",
    test: "${base}/retry-response",
  },
  {
    flow: "worldbook-catalog-binding",
    route: 'routeEnabled("worldbook-bind")',
    artifact: "worldBookBinding",
    test: "${base}/worldbook",
  },
  {
    flow: "character-worldbook-chat-import-export",
    route: 'routeEnabled("interchange-import")',
    artifact: "decodeSafeInterchange",
    test: "${base}/interchange/worldbook/export",
  },
  {
    flow: "authenticated-reconnect",
    route: 'routeEnabled("refresh")',
    artifact: "resumeThread",
    test: "${base}/refresh",
  },
  {
    flow: "memory-management",
    route: 'routeEnabled("memories-read")',
    artifact: "magicContextMemoryFacade",
    artifactScope: "host",
    test: "${base}/memories",
  },
]);

const HOST_CONTRACT_TEST_FILES = Object.freeze([
  "dist-test/dialogue-web.test.js",
  "dist-test/tavern/chat-thread-store.test.js",
  "dist-test/tavern/catalog-service.test.js",
  "dist-test/tavern/st-card-import-service.test.js",
  "dist-test/tavern/effect-aware-causal-guard.test.js",
  "dist-test/tavern/conversation.test.js",
]);

const here = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(here, "..");

function result(id, status, detail) {
  return { id, status, detail };
}

function extractStringArray(source, property) {
  const match = source.match(new RegExp(`${property}:\\s*Object\\.freeze\\(\\[([^\\]]*)\\]\\)`));
  if (!match) return undefined;
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function charterCoverage(charter) {
  const match = charter.match(/<!-- tavern-release-must-flow-coverage\n([\s\S]*?)-->/);
  if (!match) return undefined;
  return [...match[1].matchAll(/^([a-z0-9-]+)=(TVL-\d\d)$/gm)].map((entry) => ({ flow: entry[1], step: entry[2] }));
}

function hasMarker(source, marker) {
  return source.includes(marker);
}

function hostEvidenceFailures(hostRouteSource, hostTestSource, tavernSource) {
  return HOST_MUST_FLOW_EVIDENCE.filter(
    ({ route, artifact, artifactScope, test }) =>
      !hasMarker(hostRouteSource, route) ||
      !hasMarker(hostTestSource, test) ||
      !hasMarker(artifactScope === "host" ? hostRouteSource : tavernSource, artifact),
  ).map(({ flow }) => flow);
}

/**
 * Checks only release-profile prerequisites that can be established locally.
 * It intentionally does not turn a contract-only Magic Context source into a
 * runtime proof and it never asks for selected_l3_v1's `later` flows.
 */
export async function checkTavernReleasePrerequisites({
  root = repositoryRoot,
  verifyReferences = true,
  read = readFile,
  verifyStableContextRuntime = true,
  exec = execFileSync,
} = {}) {
  const selectedPath = resolve(root, "host/src/tavern/selected-l3.v1.ts");
  const charterPath = resolve(root, "tools/tavern-live-run-charter.md");
  const sourcePath = resolve(root, "vendor/magic-context/packages/pi-plugin/src/gamebuddy-stable-context-source.ts");
  const hostRoutePath = resolve(root, "host/src/dialogue-web.ts");
  const hostTestPath = resolve(root, "host/src/dialogue-web.test.ts");
  const tavernSourcePaths = [
    "host/src/tavern/library-service.ts",
    "host/src/tavern/chat-thread-store.ts",
    "host/src/tavern/effect-aware-causal-guard.ts",
    "host/src/tavern/catalog-service.ts",
    "host/src/tavern/st-card-import-service.ts",
    "host/src/tavern/interchange.ts",
    "host/src/tavern/conversation.ts",
  ].map((path) => resolve(root, path));
  const [selected, charter, source, hostRouteSource, hostTestSource, ...tavernSources] = await Promise.all([
    read(selectedPath, "utf8"),
    read(charterPath, "utf8"),
    read(sourcePath, "utf8"),
    read(hostRoutePath, "utf8"),
    read(hostTestPath, "utf8"),
    ...tavernSourcePaths.map((path) => read(path, "utf8")),
  ]);
  const tavernSource = tavernSources.join("\n");
  const checks = [];
  const must = extractStringArray(selected, "must");
  const later = extractStringArray(selected, "later");
  const unsupported = extractStringArray(selected, "unsupported");
  if (JSON.stringify(must) === JSON.stringify(REQUIRED_MUST_FLOWS) && later && unsupported) {
    checks.push(result("selected_l3_v1_manifest", "passed", "versioned must/later/unsupported flow sets are readable"));
  } else {
    checks.push(result("selected_l3_v1_manifest", "blocked", "selected_l3_v1 must-flow set is missing or drifted"));
  }

  const coverage = charterCoverage(charter);
  if (JSON.stringify(coverage) === JSON.stringify(REQUIRED_CHARTER_COVERAGE)) {
    checks.push(
      result(
        "live_charter_must_flow_coverage",
        "passed",
        "each selected_l3_v1 must flow maps to one required live-run step",
      ),
    );
  } else {
    checks.push(
      result(
        "live_charter_must_flow_coverage",
        "blocked",
        "live charter must-flow coverage is absent, incomplete, or drifted",
      ),
    );
  }

  const missingHostEvidence = hostEvidenceFailures(hostRouteSource, hostTestSource, tavernSource);
  if (missingHostEvidence.length > 0) {
    checks.push(
      result(
        "must_flow_host_contract_evidence",
        "blocked",
        `must_flow_host_contract_evidence_missing:${missingHostEvidence.join(",")}`,
      ),
    );
  } else {
    checks.push(
      result(
        "must_flow_host_contract_evidence",
        "passed",
        "every selected must flow has a Host route, durable-artifact marker, and Host contract-test marker",
      ),
    );
    try {
      exec(
        process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        ["--filter", "@gamebuddy/companion-host", "build:test"],
        { cwd: root, stdio: "pipe", ...(process.platform === "win32" ? { shell: true } : {}) },
      );
      exec(process.execPath, ["--test", ...HOST_CONTRACT_TEST_FILES.map((path) => resolve(root, "host", path))], {
        cwd: root,
        stdio: "pipe",
      });
      checks.push(
        result("must_flow_host_contract_execution", "passed", "dist-test Host must-flow contract tests passed"),
      );
    } catch {
      checks.push(
        result("must_flow_host_contract_execution", "blocked", "must_flow_host_contract_tests_failed_or_could_not_run"),
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
    excludedLaterFlows: later ?? [],
    excludedUnsupportedFlows: unsupported ?? [],
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
