#!/usr/bin/env node
/**
 * Real provider gate for the embedded Historian authoring pipeline.
 * Runs only in a fresh GameBuddy-owned Node process with an in-memory test DB.
 * It never reads system Pi state or creates a browser surface. It verifies the
 * same embedded-SDK, no-tool pipeline selected for product Historian execution,
 * without forcing the normal production context-pressure scheduler. Product
 * auto-promotion stays disabled. The gate uses its test-only in-memory admission
 * invocation to prove the shared lifecycle can author each durable category,
 * while reporting the product flag separately.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const timeoutMs = 45_000;
let exitCode = 0;
const root = await mkdtemp(join(tmpdir(), "gamebuddy-ongoing-historian-authoring-"));
const priorNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "test";
try {
  const [
    { createCompanionRuntime, DEFAULT_COMPANION_MODEL_CONFIG, MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED },
    { runEmbeddedHistorianAuthoringGateInMemoryForTest },
  ] = await Promise.all([
    loadHostProductionModule("runtime.js"),
    import("../vendor/magic-context/packages/pi-plugin/dist/embedded-historian-gate.js"),
  ]);
  const runtime = await Promise.race([
    createCompanionRuntime(
      {
        playerId: "historian_gate_player",
        companionId: "historian_gate_companion",
        continuityId: "historian_gate_continuity",
      },
      root,
      undefined,
      DEFAULT_COMPANION_MODEL_CONFIG,
      undefined,
      undefined,
      false,
      undefined,
      "historian_gate_surface",
      undefined,
      "chat",
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error("runtime_boot_timeout")), 20_000)),
  ]);
  try {
    const registry = runtime.session.extensionRunner.getModelRegistry();
    const runScenario = (scenario) =>
      Promise.race([
        runEmbeddedHistorianAuthoringGateInMemoryForTest({
          registry,
          directory: runtime.paths.runtimeCwd,
          model: `${DEFAULT_COMPANION_MODEL_CONFIG.provider}/${DEFAULT_COMPANION_MODEL_CONFIG.modelId}`,
          thinkingLevel: DEFAULT_COMPANION_MODEL_CONFIG.thinkingLevel,
          timeoutMs,
          scenario,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`historian_gate_timeout:${scenario}`)), timeoutMs + 5_000),
        ),
      ]);
    if (MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED !== false) {
      throw new Error("product_auto_promote_must_remain_disabled");
    }
    const [semantic, interaction, ordinaryProcess] = await Promise.all([
      runScenario("semantic"),
      runScenario("interaction"),
      runScenario("ordinary-process"),
    ]);
    for (const [name, result] of Object.entries({ semantic, interaction, ordinaryProcess })) {
      if (result.compartmentCount < 1 || result.testAutoPromote !== false) {
        throw new Error(`unexpected_${name}_result`);
      }
    }
    // The real provider probe proves that the embedded no-tool Historian
    // successfully parses and publishes each synthetic interaction through
    // its real model path. Production auto-promotion intentionally stays
    // disabled; category admission/promotion proof is covered separately by
    // the test-only shared-lifecycle suite (which cannot toggle product config).
    assertScenarioFacts("semantic", semantic, "semantic");
    assertScenarioFacts("interaction", interaction, "interaction");
    assertScenarioFacts("ordinaryProcess", ordinaryProcess, "ordinary");
    console.log(
      JSON.stringify({
        state: "passed",
        authoring: "embedded-sdk-only",
        scenarios: {
          semantic: redactScenarioResult(semantic),
          interaction: redactScenarioResult(interaction),
          ordinaryProcess: redactScenarioResult(ordinaryProcess),
        },
        productAutoPromote: MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED,
      }),
    );
  } finally {
    runtime.session.dispose();
  }
} catch (error) {
  // Never serialize an error message: provider and SDK errors can carry raw
  // request/response text. Keep the public report to an allowlisted outcome.
  const reasonCode = historianGateReasonCode(error);
  const observedCategoryCounts = historianGateObservedCategoryCounts(error);
  console.error(
    JSON.stringify({
      state: "failed",
      reasonCode,
      ...(observedCategoryCounts === undefined ? {} : { observedCategoryCounts }),
      autoPromote: false,
    }),
  );
  exitCode = 2;
} finally {
  if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = priorNodeEnv;
  await Promise.race([
    rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  // Extension/database handles are intentionally retained by the embedded SDK;
  // this one-shot verifier must never wait for their process-global teardown.
  process.exit(exitCode);
}

function historianGateReasonCode(error) {
  const message = error instanceof Error ? error.message : "";
  if (message === "product_auto_promote_must_remain_disabled") return message;
  if (message === "runtime_boot_timeout") return message;
  if (message === "embedded_historian_gate_publication_missing") return "historian_gate_publication_missing";
  if (/^historian_gate_timeout:(semantic|interaction|ordinary-process)$/.test(message)) return "historian_gate_timeout";
  if (/^unexpected_(semantic|interaction|ordinaryProcess)_result$/.test(message))
    return "historian_gate_unexpected_aggregate";
  if (/^historian_gate_scenario_counts:(semantic|interaction|ordinary):semantic=\d+:interaction=\d+$/.test(message))
    return "historian_gate_unexpected_aggregate";
  if (
    /^embedded_historian_gate_category_mismatch:(semantic|interaction|ordinary-process):semantic=\d+:interaction=\d+$/.test(
      message,
    )
  )
    return "historian_gate_category_mismatch";
  return "historian_gate_execution_failed";
}

function historianGateObservedCategoryCounts(error) {
  const message = error instanceof Error ? error.message : "";
  const match =
    /^(?:embedded_historian_gate_category_mismatch:(semantic|interaction|ordinary-process)|historian_gate_scenario_counts:(semantic|interaction|ordinary)):semantic=(\d+):interaction=(\d+)$/.exec(
      message,
    );
  if (match === null) return undefined;
  return Object.freeze({
    scenario: match[1] ?? match[2],
    semanticMemoryCount: Number(match[3]),
    interactionEpisodeCount: Number(match[4]),
  });
}

function assertScenarioFacts(name, result, expected) {
  const semantic = result.semanticFactsEmitted;
  const interaction = result.interactionEpisodeFactsEmitted;
  const valid =
    (expected === "semantic" && semantic >= 1) ||
    (expected === "interaction" && interaction >= 1) ||
    (expected === "ordinary" && semantic === 0 && interaction === 0);
  if (!valid)
    throw new Error(`historian_gate_scenario_counts:${expected}:semantic=${semantic}:interaction=${interaction}`);
}

function redactScenarioResult(result) {
  return Object.freeze({
    compartmentCount: result.compartmentCount,
    factsEmitted: result.factsEmitted,
    semanticFactsEmitted: result.semanticFactsEmitted,
    interactionEpisodeFactsEmitted: result.interactionEpisodeFactsEmitted,
  });
}
