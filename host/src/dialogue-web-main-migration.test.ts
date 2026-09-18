import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lane E1 migration guard for the temporary dialogue-web entry: the reference
 * (Chat-only) and management profiles must dispatch entirely through the
 * composition-owned presentation admission variants instead of assembling
 * their own listeners/services, so the entry keeps only the dispatch around
 * the mounted Chat lane until Lane E3 deletes it.
 */
test("dialogue-web entry dispatches the reference and management profiles through the composition-owned presentation admission variants", async () => {
  const source = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "dialogue-web-main.ts"), "utf8");

  // Both Chat-only profiles consume the matching owner variant; the composed
  // reference-game profile keeps consuming the composed variant.
  assert.match(source, /startChatOnlyPresentationAdmission\(\{/);
  assert.match(source, /startTavernManagementPresentationAdmission\(\{/);
  assert.match(source, /startDesktopPresentationAdmission\(\{/);
  // The entry no longer assembles any Chat-lane service, state facade, or
  // static shell composition itself; those assemblies live only in the owner.
  assert.doesNotMatch(source, /startReferencePipelineStaticShellComposition\(/);
  assert.doesNotMatch(source, /startTavernManagementStaticShellComposition\(/);
  assert.doesNotMatch(source, /createReferencePipelineStateFacade\(/);
  assert.doesNotMatch(source, /createChatPipelineService\(\{/);
  assert.doesNotMatch(source, /createChatManagementService\(\{/);
  assert.doesNotMatch(source, /createMemoryManagementService\(\{/);
  assert.doesNotMatch(source, /createWorldInfoBindingManagementService\(\{/);
  assert.doesNotMatch(source, /createWorldInfoManagementRepository\(/);
  assert.doesNotMatch(source, /composeTavernProfile\(\{/);
  // The close order for both migrated profiles still releases the admission
  // (its listener and delegated services) before the mounted lease/facade.
  assert.match(source, /await admission\?\.close\(\);/);
  assert.match(source, /closeReferencePipelineRuntime\(\{/);
  // The MIGRATION-ERA markers now say only the dispatch remains until E3.
  assert.match(source, /pure dispatch into the composition-owned chat-only presentation admission/);
  assert.match(source, /pure dispatch into the composition-owned management presentation/);
  assert.match(source, /goes away with Lane E3\./);
  assert.match(source, /nothing but the dispatch remains here/);
});

test("dialogue-web entry keeps the Chat-lane mount and the game-profile assembler out of the migrated profiles", async () => {
  const source = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "dialogue-web-main.ts"), "utf8");

  // Both migrated profiles still mount the exact Chat runtime themselves and
  // hand the mounted lease plus the one event stream to the owner variant.
  assert.match(source, /lease = await facade\.startMountedChatRuntime\(\);/);
  assert.match(source, /eventStream,\n\s*lease,/);
  // The Stardew lifecycle assembler stays only in the composed reference-game
  // profile; the Chat-only/management profiles never import it.
  assert.match(source, /createStardewProductionLifecycleCoordinator\(/);
  assert.match(source, /createStardewGamePresentationProjection\(lifecycleCoordinator\)/);
  assert.doesNotMatch(source, /runReferenceProfile\([\\s\\S]*?createStardewProductionLifecycleCoordinator/);
  assert.doesNotMatch(source, /runManagementProfile\([\\s\\S]*?createStardewProductionLifecycleCoordinator/);
});