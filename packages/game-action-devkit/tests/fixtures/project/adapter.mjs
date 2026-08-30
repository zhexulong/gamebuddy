const STATUS_BY_COMMAND = Object.freeze({
  inventory: "inventory_ready",
  check: "check_passed",
  preflight: "preflight_ready",
  status: "status_ready",
});

export async function runActionProject({ manifest, invocation }) {
  if (invocation.command === "run-live") {
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

  return {
    schema: "gamebuddy-action-scenario-result/v1",
    gameId: manifest.gameId,
    status: STATUS_BY_COMMAND[invocation.command],
    claimScope: "fixture_only",
    actionId: invocation.actionId ?? null,
    briefFile: invocation.briefFile ?? null,
  };
}
