import assert from "node:assert/strict";
import test from "node:test";
import { checkTavernReleasePrerequisites, REQUIRED_MUST_FLOWS } from "./check-tavern-release-prerequisites.mjs";

test("Tavern release prerequisite checker reports an unwired Magic Context source as blocked evidence", async () => {
  const report = await checkTavernReleasePrerequisites({
    read: async (path, encoding) => {
      const value = await import("node:fs/promises").then(({ readFile }) => readFile(path, encoding));
      return path.endsWith("gamebuddy-stable-context-source.ts")
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

test("Tavern release prerequisite checker fails closed when a selected flow lacks a Host route test marker", async () => {
  const report = await checkTavernReleasePrerequisites({
    read: async (path, encoding) => {
      const value = await import("node:fs/promises").then(({ readFile }) => readFile(path, encoding));
      return path.endsWith("dialogue-web.test.ts")
        ? `${value.replaceAll("${base}/interchange/worldbook/export", "${base}/removed-interchange-export")}\n\${base}/memories`
        : path.endsWith("dialogue-web.ts")
          ? `${value}\nrouteEnabled("memories-read") magicContextMemoryFacade`
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
    'routeEnabled("library") routeEnabled("manage-chats") routeEnabled("new-companion") routeEnabled("new-chat") routeEnabled("new-chat-selections") routeEnabled("retry-response") routeEnabled("worldbook") routeEnabled("interchange-import") routeEnabled("refresh") routeEnabled("memories-read") async listCompanions async listChats async createNewCompanion createThread openingSelection guardTavernCausalMutation worldBookBinding decodeSafeInterchange resumeThread magicContextMemoryFacade ${base}/library ${base}/manage-chats ${base}/new-companion ${base}/new-chat ${base}/new-chat/selections ${base}/retry-response ${base}/worldbook ${base}/interchange/worldbook/export ${base}/refresh ${base}/memories';
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
