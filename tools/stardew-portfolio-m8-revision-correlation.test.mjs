import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const integrationPath = new URL("../integrations/stardew/PortfolioIntegration.cs", import.meta.url);
const adapterPath = new URL("../integrations/stardew/PortfolioMineElevatorSemanticAdapter.cs", import.meta.url);

async function source(path) {
  return readFile(path, "utf8");
}

function methodBody(text, methodName) {
  const start = text.indexOf(`private string? ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must exist`);
  const end = text.indexOf("\n    private ", start + 1);
  return text.slice(start, end === -1 ? text.length : end);
}

test("M8 elevator correlation is deterministic and bound to fresh semantic facts", async () => {
  const adapter = await source(adapterPath);
  assert.doesNotMatch(
    adapter,
    /Guid\.NewGuid|Random(?:NumberGenerator)?/,
    "M8 correlation must not use random generation",
  );
  assert.match(
    adapter,
    /SHA256\.HashData\(Encoding\.UTF8\.GetBytes\(canonicalFacts\)\)/,
    "M8 correlation must be a SHA-256 digest of canonical facts",
  );
  for (const fact of [
    "requestId=",
    "traceId=",
    "scope.integrationId=",
    "scope.topology=",
    "scope.saveId=",
    "scope.worldId=",
    "scope.localPlayerId=",
    "scope.companionId=",
    "scope.bindingGeneration=",
    "scope.bindingHash=",
    "revision=",
    "selectedCheckpoint=",
    "currentFloor=",
    "lowestMineLevel=",
  ])
    assert.ok(adapter.includes(fact), `M8 correlation must bind ${fact}`);
  assert.match(adapter, /Game1\.enterMine\(context\.SelectedCheckpoint\)/, "M8 must retain the native checkpoint edge");

  const integration = await source(integrationPath);
  const handler = methodBody(integration, "HandlePortfolioMineElevator");

  assert.match(
    handler,
    /TryMineElevator\([\s\S]*?this\.portfolioMineElevatorAdapter,\s*this\.portfolioLastObservedRevision,/,
    "M8 ingress must pass the current published revision",
  );
  assert.doesNotMatch(
    handler,
    /\+\+this\.portfolioLastObservedRevision/,
    "M8 ingress must not mint a revision before coordinator correlation",
  );
  assert.match(
    integration,
    /long revision = \+\+this\.portfolioLastObservedRevision;/,
    "observe snapshots remain revision producers",
  );
  assert.match(
    integration,
    /\(\) => \+\+this\.portfolioLastObservedRevision,/,
    "the transition/postcondition adapter remains the callback revision producer",
  );

  assert.match(
    adapter,
    /NativeRequestCompleted = true, TransitionRevision = this\.nextRevision\(\)/,
    "native transition observation must mint a newer revision",
  );
  assert.match(
    adapter,
    /PortfolioMineElevatorPostconditionObservation postcondition = new\([\s\S]*?this\.nextRevision\(\)/,
    "native postcondition observation must mint a newer revision",
  );
});
