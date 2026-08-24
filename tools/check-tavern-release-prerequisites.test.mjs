import assert from "node:assert/strict";
import test from "node:test";
import { checkTavernReleasePrerequisites, REQUIRED_MUST_FLOWS } from "./check-tavern-release-prerequisites.mjs";

const exactLiveGateSuccess = () => ({
  status: 0,
  signal: null,
  stderr: "",
  stdout:
    '{"schemaVersion":1,"gate":"windows_reparse_live_gate/v1","status":"passed","reason":"passed","helperSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","probes":{"regular":"passed","junction":"passed","directorySymlink":"passed","nonLinkReparse":"passed"},"consumers":{"browserGenerator":"passed","hostStaticVerifier":"passed"}}\n',
});

const blockedLiveGate = () => ({ status: 2, signal: null, stderr: "", stdout: "" });

test("Tavern prerequisite checker treats target must flows as external target-gate input only", async () => {
  const calls = [];
  const report = await checkTavernReleasePrerequisites({
    verifyReferences: false,
    verifyStableContextRuntime: false,
    exec(command, args) {
      calls.push([command, args]);
    },
    windowsReparseLiveGateRunner: blockedLiveGate,
  });

  assert.equal(report.verdict, "blocked");
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
  assert.equal(
    report.checks.some((check) => check.id.includes("selected_l3")),
    false,
  );
  assert.equal(
    report.checks.some((check) => check.id.includes("must_flow")),
    false,
  );
  assert.equal(
    calls.some(([, args]) => args.includes("build:test")),
    true,
  );
  assert.deepEqual(
    report.checks.find((check) => check.id === "magic_context_stable_source"),
    {
      id: "magic_context_stable_source",
      status: "blocked",
      detail: "magic_context_source_runtime_proof_missing: version-locked source/marker/render tests were not executed",
    },
  );
});

test("Tavern prerequisite checker remains blocked unless the current live gate has exact success output", async () => {
  const report = await checkTavernReleasePrerequisites({
    verifyReferences: false,
    read: async () => "runtime source is wired",
    exec() {},
    windowsReparseLiveGateRunner: blockedLiveGate,
  });

  assert.equal(report.verdict, "blocked");
  assert.deepEqual(
    report.checks.find((check) => check.id === "windows_arbitrary_reparse_enforcement"),
    {
      id: "windows_arbitrary_reparse_enforcement",
      status: "blocked",
      detail: "windows_reparse_live_gate_failed_or_could_not_run",
    },
  );
  assert.equal(
    report.checks.every((check) => check.id !== "selected_l3_v1_manifest" && !check.id.includes("must_flow")),
    true,
  );
});

test("Tavern prerequisite checker accepts only the fixed current live-gate success contract", async () => {
  const report = await checkTavernReleasePrerequisites({
    verifyReferences: false,
    read: async () => "runtime source is wired",
    exec() {},
    windowsReparseLiveGateRunner: exactLiveGateSuccess,
  });
  assert.deepEqual(
    report.checks.find((check) => check.id === "windows_arbitrary_reparse_enforcement"),
    {
      id: "windows_arbitrary_reparse_enforcement",
      status: "passed",
      detail: "current_windows_reparse_live_gate_exact_success_verified",
    },
  );
});

test("Tavern prerequisite checker fails closed for malformed, timed-out, stderr, and nonzero live-gate results", async () => {
  const invalidResults = [
    { status: 0, signal: null, stderr: "", stdout: "not-json\n" },
    { ...exactLiveGateSuccess(), error: new Error("ETIMEDOUT"), signal: "SIGTERM" },
    { ...exactLiveGateSuccess(), stderr: "unexpected diagnostic" },
    { ...exactLiveGateSuccess(), status: 1 },
    {
      ...exactLiveGateSuccess(),
      stdout:
        '{"schemaVersion":1,"gate":"windows_reparse_live_gate/v1","status":"blocked","reason":"non_link_reparse_fixture_unavailable","helperSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","probes":{"regular":"passed","junction":"passed","directorySymlink":"passed","nonLinkReparse":"blocked"},"consumers":{"browserGenerator":"passed","hostStaticVerifier":"passed"}}\n',
    },
    {
      ...exactLiveGateSuccess(),
      stdout:
        '{"schemaVersion":1,"gate":"windows_reparse_live_gate/v1","status":"passed","reason":"passed","helperSha256":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","probes":{"regular":"passed","junction":"passed","directorySymlink":"passed","nonLinkReparse":"passed"},"consumers":{"browserGenerator":"passed","hostStaticVerifier":"passed"}}\n',
    },
  ];

  for (const child of invalidResults) {
    const report = await checkTavernReleasePrerequisites({
      verifyReferences: false,
      read: async () => "runtime source is wired",
      exec() {},
      windowsReparseLiveGateRunner: () => child,
    });
    assert.deepEqual(
      report.checks.find((check) => check.id === "windows_arbitrary_reparse_enforcement"),
      {
        id: "windows_arbitrary_reparse_enforcement",
        status: "blocked",
        detail: "windows_reparse_live_gate_failed_or_could_not_run",
      },
    );
  }
});

test("Tavern prerequisite checker reports an unwired Magic Context source as blocked evidence", async () => {
  const report = await checkTavernReleasePrerequisites({
    read: async (path, encoding) => {
      const value = await import("node:fs/promises").then(({ readFile }) => readFile(path, encoding));
      return path.replaceAll("\\", "/").endsWith("gamebuddy-stable-context-source.ts")
        ? `${value}\n// runtime publication is intentionally unwired`
        : value;
    },
    windowsReparseLiveGateRunner: blockedLiveGate,
  });
  assert.equal(report.verdict, "blocked");
  assert.deepEqual(
    report.checks.find((check) => check.id === "magic_context_stable_source"),
    {
      id: "magic_context_stable_source",
      status: "blocked",
      detail:
        "magic_context_source_contract_only: source rendering is not runtime-wired through the required marker/render lifecycle; Tavern live run must not begin",
    },
  );
});

test("Tavern prerequisite checker blocks when ordinary containment tests fail", async () => {
  const report = await checkTavernReleasePrerequisites({
    verifyReferences: false,
    exec(_command, args) {
      if (args.some((arg) => arg.replaceAll("\\", "/").endsWith("dist-test/tavern/artifact-store.test.js"))) {
        throw new Error("containment regression");
      }
    },
    windowsReparseLiveGateRunner: blockedLiveGate,
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

test("Tavern prerequisite checker blocks filesystem threat-model drift", async () => {
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
    windowsReparseLiveGateRunner: blockedLiveGate,
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
