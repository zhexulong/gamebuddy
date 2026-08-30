import { createGameRuntimePlugin } from "@gamebuddy/game-action-devkit";

const STATUS_BY_COMMAND = Object.freeze({
  inventory: "inventory_ready",
  check: "check_passed",
  preflight: "preflight_ready",
  status: "status_ready",
});

const FIXTURE_RUNTIME = createGameRuntimePlugin({
  gameId: "clockwork_fixture",
  targets: [{
    targetId: "clockwork_target",
    targetVersion: "v1",
    actions: [{
      actionId: "toggle_lamp",
      verifier: { admit: () => true, verify: () => true },
    }],
  }],
});

export async function runActionProject({ manifest, invocation }) {
  if (invocation.command === "run-live") {
    const admission = FIXTURE_RUNTIME.inspectTarget({
      targetId: "clockwork_target",
      targetVersion: "v1",
      actionId: invocation.actionId,
      runId: invocation.runId,
    });
    if (admission.blocked) {
      return {
        schema: "gamebuddy-action-scenario-result/v1",
        gameId: manifest.gameId,
        status: "blocked",
        reasonCode: "non_production_fixture",
        claimScope: "fixture_only",
        actionId: invocation.actionId ?? null,
        runId: invocation.runId,
      };
    }
    const outcome = FIXTURE_RUNTIME.run({
      admission: admission.admission,
      actionRunner: {
        actionId: invocation.actionId,
        runId: invocation.runId,
        execute: () => ({
          receipt: { state: "blocked", code: "non_production_fixture", evidence: null },
          postcondition: { state: "not_applicable", code: null, evidence: null },
          cleanup: { state: "complete", code: "complete" },
        }),
      },
    });
    return {
      schema: "gamebuddy-action-scenario-result/v1",
      gameId: manifest.gameId,
      status: "blocked",
      reasonCode: outcome.receipt?.code ?? "non_production_fixture",
      claimScope: "fixture_only",
      actionId: invocation.actionId ?? null,
      runId: invocation.runId,
    };
  }

  return {
    schema: "gamebuddy-action-scenario-result/v1",
    gameId: manifest.gameId,
    status: STATUS_BY_COMMAND[invocation.command],
    claimScope: "fixture_only",
    actionId: invocation.actionId ?? null,
    briefFile: invocation.briefFile ?? null,
  };
}
