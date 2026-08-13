import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const managerPath = new URL("../integrations/stardew/ExecutionManager.cs", import.meta.url);
const controllerPath = new URL("../integrations/stardew/StardewBodyController.cs", import.meta.url);
const protocolPath = new URL("../integrations/stardew/BridgeProtocol.cs", import.meta.url);
const sessionPath = new URL("../integrations/stardew/BridgeSession.cs", import.meta.url);

async function sources() {
  const [manager, controller, protocol, session] = await Promise.all([
    readFile(managerPath, "utf8"),
    readFile(controllerPath, "utf8"),
    readFile(protocolPath, "utf8"),
    readFile(sessionPath, "utf8"),
  ]);
  return { manager, controller, protocol, session };
}

test("P5 publishes only the bounded body categories through the existing semantic publication path", async () => {
  const { manager, protocol, session } = await sources();
  const categories = [
    "execution_started",
    "route_progress",
    "execution_settled_succeeded",
    "execution_settled_cancelled",
    "execution_settled_failed",
    "execution_invalidated",
    "body_idle",
  ];
  for (const category of categories) assert.match(manager, new RegExp(`"${category}"`));
  assert.match(manager, /ExecutionState\.MeaningfulProgress\s*=>\s*"route_progress"/);
  assert.match(manager, /ExecutionState\.Cancelled\s*=>\s*"execution_settled_cancelled"/);
  assert.match(manager, /ExecutionState\.Invalidated\s*=>\s*"execution_invalidated"/);
  assert.match(manager, /ExecutionState\.Failed or ExecutionState\.Expired or ExecutionState\.Uncertain\s*=>\s*"execution_settled_failed"/);
  assert.match(manager, /new\(category, executionId, requestId, this\.tick, this\.revision,/);
  assert.match(manager, /private void PublishIdleAfterRelease\(string executionId, string requestId\)/);
  assert.match(manager, /private void DrainPendingIdleAfterRelease\(\)/);
  assert.match(manager, /this\.pendingIdleByExecutionId\[executionId\] = requestId/);
  assert.doesNotMatch(manager, /if \(category is "execution_settled_succeeded" or "execution_settled_cancelled" or "execution_settled_failed" or "execution_invalidated"\)\s*this\.AddPublicTrace\("body_idle", executionId, requestId\)/s);
  assert.match(manager, /this\.active = null;\s*LocalExecutionReceipt receipt = new\(specification\.ExecutionId,[\s\S]*?this\.AddTrace\(receipt\);\s*if \(terminal\)\s*this\.PublishIdleAfterRelease\(specification\.ExecutionId, specification\.RequestId\);/);
  assert.match(manager, /if \(animationComplete\)\s*\{\s*this\.activeItemUse = null;\s*this\.PublishIdleAfterRelease\(specification\.ExecutionId, specification\.RequestId\);/s);
  assert.match(manager, /if \(animationComplete\)\s*\{\s*Game1\.player\.CurrentToolIndex = specification\.PreviousSlot;\s*this\.activeAnimalProduct = null;\s*this\.PublishIdleAfterRelease\(specification\.ExecutionId, specification\.RequestId\);/s);
  assert.match(protocol, /internal sealed record BridgeBodyTrace\(/);
  assert.match(session, /TryCreateBodyTraceEvent\(/);
  assert.match(session, /if \(!IsBodyTraceCategory\(trace\.Category\)\)/);
  assert.match(session, /private static bool IsBodyTraceCategory\(string category\) => category is/);
  assert.match(session, /Reply\("semantic_event", correlationId,/);
});

test("P5 release-settlement matrix traces every released manager owner before one idle", async () => {
  const { manager } = await sources();

  // Travel terminal paths release their spec, record the terminal receipt/trace,
  // and then delegate exactly once to the central idempotent settlement helper.
  assert.match(manager, /activeTravel\.DeadlineMs[\s\S]*?this\.activeTravel = null;[\s\S]*?this\.Remember\(receipt\);\s*this\.AddTrace\(receipt\);\s*this\.PublishIdleAfterRelease\(specification\.ExecutionId, specification\.RequestId\);/);
  assert.match(manager, /CompleteTravelAfterWarp\(\)[\s\S]*?this\.activeTravel = null;\s*this\.Remember\(receipt\);\s*this\.AddTrace\(receipt\);\s*this\.PublishIdleAfterRelease\(specification\.ExecutionId, specification\.RequestId\);/);

  // A pickup has controller and pickup ownership. A non-success controller
  // terminal must clear both before the terminal trace is followed by idle.
  assert.match(manager, /if \(this\.activeItemPickup is \{ \} pickup[\s\S]*?this\.active = null;[\s\S]*?this\.activeItemPickup = null;[\s\S]*?this\.Remember\(pickupReceipt\);\s*this\.AddTrace\(pickupReceipt\);\s*this\.PublishIdleAfterRelease\(pickup\.ExecutionId, pickup\.RequestId\);/);
  assert.match(manager, /else if \(\(!sameLocation \|\| nowMs > specification\.DeadlineMs\) && approachSettled\)[\s\S]*?this\.activeItemPickup = null;[\s\S]*?this\.AddTrace\(receipt\);\s*this\.PublishIdleAfterRelease\(specification\.ExecutionId, specification\.RequestId\);/);

  // Immediate success/cancel/invalidate and delayed animation ownership all
  // use the same gate. The gate sees every manager-owned slot and de-duplicates
  // body_idle per execution before publishing through the nullable-safe trace.
  for (const owner of ["active", "activeTravel", "activePet", "activeAnimalProduct", "activeItemUse", "activeItemPickup"]) {
    assert.match(manager, new RegExp(`this\\.${owner}\\?\\.ExecutionId == executionId`));
  }
  assert.match(manager, /this\.controller\.ActiveExecutionId == executionId;/);
  assert.match(manager, /if \(this\.idlePublishedExecutionIds\.Contains\(executionId\)\)\s*return;[\s\S]*?this\.pendingIdleByExecutionId\[executionId\] = requestId;/);
  assert.match(manager, /!this\.idlePublishedExecutionIds\.Add\(executionId\)[\s\S]*?this\.pendingIdleByExecutionId\.Remove\(executionId\);\s*this\.AddPublicTrace\("body_idle", executionId, requestId\);/);
  assert.match(manager, /Farmer\? player = Game1\.player;\s*ExecutionTrace entry = new\(category, executionId, requestId, this\.tick, this\.revision,\s*player\?\.currentLocation\?\.NameOrUniqueName, player\?\.Tile\);/);
});

test("P5 native tick and terminal paths settle controller ownership without an ambient pilot", async () => {
  const { manager, controller } = await sources();
  assert.match(manager, /public void Update\(\)\s*\{\s*this\.tick\+\+;\s*this\.controller\.Update\(this\.tick\);/s);
  assert.match(controller, /public void Cancel\(string reasonCode\) => this\.Stop\(ExecutionState\.Cancelled,/);
  assert.match(controller, /public void Invalidate\(string reasonCode\) => this\.Stop\(ExecutionState\.Invalidated,/);
  assert.match(controller, /Game1\.activeClickableMenu is not null[\s\S]*?this\.Invalidate\("menu_opened"\)/);
  assert.match(controller, /Game1\.eventUp[\s\S]*?this\.Invalidate\("event_started"\)/);
  assert.match(controller, /if \(ReferenceEquals\(Game1\.player\.controller, this\.pathController\)\)\s*Game1\.player\.controller = null;[\s\S]*?Game1\.player\.Halt\(\);[\s\S]*?this\.active = null;/);
  assert.match(controller, /if \(specification is null\)\s*return;/);
  assert.doesNotMatch(manager, /(?:faceDirection|movePosition|setMoving)\s*\(/);
  assert.match(manager, /Farmer\? player = Game1\.player;[\s\S]*?if \(player is null\)\s*return CreateWorldNotReadyBridgeSnapshot\(advertisedCapabilities\);/);
  assert.match(manager, /private BridgeSnapshot CreateWorldNotReadyBridgeSnapshot\(IReadOnlyList<string> advertisedCapabilities\)/);
});
