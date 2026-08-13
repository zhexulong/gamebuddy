import assert from "node:assert/strict";
import test from "node:test";
import { checkTavernReleasePrerequisites, REQUIRED_MUST_FLOWS } from "./check-tavern-release-prerequisites.mjs";

test("Tavern release prerequisite checker reports an unwired Magic Context source as blocked evidence", async () => {
  const report = await checkTavernReleasePrerequisites({
    read: async (path, encoding) => {
      const value = await import("node:fs/promises").then(({ readFile }) => readFile(path, encoding));
      return path.replaceAll("\\", "/").endsWith("gamebuddy-stable-context-source.ts")
        ? `${value}\n// runtime publication is intentionally unwired`
        : value;
    },
  });
  assert.equal(report.verdict, "blocked");
  assert.deepEqual(report.excludedLaterFlows, [
    "response-regenerate-swipe-edit",
    "branch-checkpoint",
    "worldbook-full-editor",
    "background-sprite",
    "visual-novel-layout",
  ]);
  assert.deepEqual(report.excludedUnsupportedFlows, [
    "group-chat",
    "multi-buddy-runtime",
    "talkativeness",
    "prompt-manager",
    "preset-workbench",
    "extensions",
    "scripts",
    "macros",
    "regex",
    "html-runtime",
  ]);
  assert.deepEqual(REQUIRED_MUST_FLOWS, [
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
  assert.deepEqual(
    report.checks.find((check) => check.id === "live_charter_must_flow_coverage"),
    {
      id: "live_charter_must_flow_coverage",
      status: "passed",
      detail: "each selected_l3_v1 must flow maps to one required live-run step",
    },
  );
  const source = report.checks.find((check) => check.id === "magic_context_stable_source");
  assert.deepEqual(source, {
    id: "magic_context_stable_source",
    status: "blocked",
    detail:
      "magic_context_source_contract_only: source rendering is not runtime-wired through the required marker/render lifecycle; Tavern live run must not begin",
  });
});

test("Tavern release prerequisite checker executes ordinary containment tests rather than trusting source markers", async () => {
  const calls = [];
  const report = await checkTavernReleasePrerequisites({
    verifyReferences: false,
    exec(command, args) {
      calls.push([command, args]);
    },
  });
  assert.deepEqual(
    report.checks.find((check) => check.id === "tavern_ordinary_link_reparse_containment"),
    {
      id: "tavern_ordinary_link_reparse_containment",
      status: "passed",
      detail:
        "ordinary symlink/junction/reparse containment tests passed; same-user hostile TOCTOU is an explicit P3 residual risk, not a hostile-race safety claim",
    },
  );
  assert.equal(
    calls.some(([, args]) =>
      args.some((arg) => arg.replaceAll("\\", "/").endsWith("dist-test/tavern/artifact-store.test.js")),
    ),
    true,
  );
  assert.equal(
    calls.some(([, args]) => args.some((arg) => arg.replaceAll("\\", "/").endsWith("dist-test/path-lock.test.js"))),
    true,
  );
});

test("Tavern release prerequisite checker blocks when ordinary containment tests fail", async () => {
  const report = await checkTavernReleasePrerequisites({
    verifyReferences: false,
    exec(_command, args) {
      if (args.some((arg) => arg.replaceAll("\\", "/").endsWith("dist-test/tavern/artifact-store.test.js"))) {
        throw new Error("containment regression");
      }
    },
  });
  assert.equal(report.verdict, "blocked");
  assert.deepEqual(
    report.checks.find((check) => check.id === "tavern_ordinary_link_reparse_containment"),
    {
      id: "tavern_ordinary_link_reparse_containment",
      status: "blocked",
      detail: "tavern_ordinary_link_reparse_containment_tests_failed_or_could_not_run",
    },
  );
});

test("Tavern release prerequisite checker blocks filesystem threat-model drift rather than accepting a hostile-race claim", async () => {
  const report = await checkTavernReleasePrerequisites({
    verifyReferences: false,
    tavernFilesystemThreatModel: {
      schemaVersion: 1,
      descriptor: { name: "gamebuddy-tavern-filesystem-threat-model", version: "1" },
      ordinaryContainment: {
        status: "required",
        guarantees: ["reject_preexisting_link_or_reparse_escape", "fail_closed_outside_runtime_root"],
        verification: "host_deterministic_containment_tests",
      },
      sameUserHostilePathRace: {
        status: "P3_defense_in_depth_residual_risk",
        guarantee: "hostile-race-safe",
        escalation: "windows_handle_relative_no_follow_required_before_claiming_protection",
      },
    },
    exec() {},
  });
  assert.equal(report.verdict, "blocked");
  assert.deepEqual(
    report.checks.find((check) => check.id === "tavern_filesystem_threat_model"),
    {
      id: "tavern_filesystem_threat_model",
      status: "blocked",
      detail: "tavern_filesystem_threat_model_drift",
    },
  );
});

test("Tavern release prerequisite checker fails closed when a selected flow lacks a Host route test marker", async () => {
  const markers =
    'routeEnabled("library") routeEnabled("manage-chats") routeEnabled("new-companion") routeEnabled("new-chat") routeEnabled("new-chat-selections") routeEnabled("retry-response") routeEnabled("worldbook-bind") routeEnabled("interchange-import") routeEnabled("refresh") routeEnabled("memories-read") async listCompanions async listChats async createNewCompanion createThread openingSelection guardTavernCausalMutation worldBookBinding decodeSafeInterchange resumeThread magicContextMemoryFacade ${base}/library ${base}/manage-chats ${base}/new-companion ${base}/new-chat ${base}/new-chat/selections ${base}/retry-response ${base}/worldbook ${base}/removed-interchange-export ${base}/refresh ${base}/memories';
  const report = await checkTavernReleasePrerequisites({
    read: async (path, encoding) => {
      const value = await import("node:fs/promises").then(({ readFile }) => readFile(path, encoding));
      return path.replaceAll("\\", "/").endsWith("dialogue-web.test.ts")
        ? `${value.replaceAll("${base}/interchange/worldbook/export", "${base}/removed-interchange-export")}\n${markers}`
        : path.replaceAll("\\", "/").endsWith("dialogue-web.ts")
          ? `${value}\n${markers}`
          : value;
    },
    exec() {},
  });
  assert.equal(report.verdict, "blocked");
  assert.deepEqual(
    report.checks.find((check) => check.id === "must_flow_host_contract_evidence"),
    {
      id: "must_flow_host_contract_evidence",
      status: "blocked",
      detail: "must_flow_host_contract_evidence_missing:character-worldbook-chat-import-export",
    },
  );
  assert.equal(
    report.checks.some((check) => check.id === "must_flow_host_contract_execution"),
    false,
  );
});

test("Tavern release prerequisite checker fails closed when compiled Host must-flow contract execution fails", async () => {
  let hostBuildSeen = false;
  const markers =
    'routeEnabled("library") routeEnabled("manage-chats") routeEnabled("new-companion") routeEnabled("new-chat") routeEnabled("new-chat-selections") routeEnabled("retry-response") routeEnabled("worldbook-bind") routeEnabled("interchange-import") routeEnabled("refresh") routeEnabled("memories-read") async listCompanions async listChats async createNewCompanion createThread openingSelection guardTavernCausalMutation worldBookBinding decodeSafeInterchange resumeThread magicContextMemoryFacade ${base}/library ${base}/manage-chats ${base}/new-companion ${base}/new-chat ${base}/new-chat/selections ${base}/retry-response ${base}/worldbook ${base}/interchange/worldbook/export ${base}/refresh ${base}/memories';
  const report = await checkTavernReleasePrerequisites({
    verifyReferences: false,
    read: async (path, encoding) =>
      `${await import("node:fs/promises").then(({ readFile }) => readFile(path, encoding))}\n${markers}`,
    exec(_command, args) {
      if (args.includes("build:test")) hostBuildSeen = true;
      else if (hostBuildSeen && args.some((arg) => arg.includes("dialogue-web.test.js")))
        throw new Error("compiled Host contract failure");
    },
  });
  assert.equal(report.verdict, "blocked");
  assert.deepEqual(
    report.checks.find((check) => check.id === "must_flow_host_contract_execution"),
    {
      id: "must_flow_host_contract_execution",
      status: "blocked",
      detail: "must_flow_host_contract_tests_failed_or_could_not_run",
    },
  );
});

test("Tavern release prerequisite checker fails closed when its Magic Context runtime proof command fails", async () => {
  const report = await checkTavernReleasePrerequisites({
    verifyReferences: false,
    exec() {
      throw new Error("runtime proof failure");
    },
  });
  assert.equal(report.verdict, "blocked");
  assert.match(
    report.checks.find((check) => check.id === "magic_context_stable_source")?.detail ?? "",
    /runtime_proof_failed/,
  );
});
