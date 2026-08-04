#!/usr/bin/env node
/**
 * Real provider gate for the embedded Historian authoring pipeline.
 * Runs only in a fresh GameBuddy-owned Node process with an in-memory test DB.
 * It never reads system Pi state or creates a browser surface. It verifies the
 * same embedded-SDK, no-tool pipeline selected for product authoring, without
 * forcing the normal production context-pressure scheduler.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const timeoutMs = 45_000;
let exitCode = 0;
const root = await mkdtemp(join(tmpdir(), "gamebuddy-ongoing-historian-authoring-"));
const priorNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "test";
try {
  const [{ createCompanionRuntime, DEFAULT_COMPANION_MODEL_CONFIG, MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED }, { runEmbeddedHistorianAuthoringGateInMemoryForTest }] = await Promise.all([
    import("../host/dist/runtime.js"),
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
    const runScenario = (scenario) => Promise.race([
      runEmbeddedHistorianAuthoringGateInMemoryForTest({
        registry,
        directory: runtime.paths.runtimeCwd,
        model: `${DEFAULT_COMPANION_MODEL_CONFIG.provider}/${DEFAULT_COMPANION_MODEL_CONFIG.modelId}`,
        thinkingLevel: DEFAULT_COMPANION_MODEL_CONFIG.thinkingLevel,
        timeoutMs,
        scenario,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`historian_gate_timeout:${scenario}`)), timeoutMs + 5_000)),
    ]);
    if (MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED !== true) {
      throw new Error("product_auto_promote_not_enabled");
    }
    const episodic = await runScenario("episodic");
    const semanticPromotion = await runScenario("semantic-promotion");
    if (episodic.compartmentCount < 1 || episodic.semanticMemoryCount !== 0 || episodic.autoPromote !== false) {
      throw new Error(`unexpected_episodic_result:${JSON.stringify(episodic)}`);
    }
    if (semanticPromotion.compartmentCount < 1 || semanticPromotion.semanticMemoryCount !== 1 || semanticPromotion.autoPromote !== true) {
      throw new Error(`unexpected_semantic_promotion_result:${JSON.stringify(semanticPromotion)}`);
    }
    console.log(JSON.stringify({
      state: "passed",
      authoring: "embedded-sdk-only",
      episodic,
      semanticPromotion,
      productAutoPromote: MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED,
    }));
  } finally {
    runtime.session.dispose();
  }
} catch (error) {
  console.error(JSON.stringify({
    state: "failed",
    reasonCode: error instanceof Error ? error.message : String(error),
    autoPromote: true,
  }));
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
