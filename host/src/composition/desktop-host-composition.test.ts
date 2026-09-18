import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDesktopPrivateHostComposition,
  createHostChildLifecycleAggregation,
  type DesktopPrivateHostComposition,
  type DesktopRootLayoutCapability,
  type HostChildLifecycle,
} from "./desktop-host-composition.js";

const rootLayoutCapability = Object.freeze({}) as DesktopRootLayoutCapability;

type Assert<T extends true> = T;
type HasExactKeys<T, TKeys extends PropertyKey> =
  Exclude<keyof T, TKeys> extends never
    ? Exclude<TKeys, keyof T> extends never
      ? true
      : false
    : false;
type DesktopPrivateHostCompositionHasOnlyLifecycle = Assert<
  HasExactKeys<DesktopPrivateHostComposition, "close">
>;
// The compile-time facade assertion above is only meaningful if it is
// evaluated; this binding keeps it in the emitted type check.
const facadeHasOnlyLifecycle: DesktopPrivateHostCompositionHasOnlyLifecycle = true;

test("desktop product composition builds the Stardew game owner only through the registered catalog provider", async () => {
  const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "composition", "desktop-host-composition.ts");
  const source = await readFile(sourcePath, "utf8");
  // Main assertion: the generic composition never directly constructs a game
  // assembly; the Stardew lifecycle owner is built exclusively through the
  // provider registered in PRODUCT_INTEGRATION_CATALOG.
  assert.match(source, /PRODUCT_INTEGRATION_CATALOG\.getProvider\("stardew"\)/);
  assert.match(source, /provider\.createLifecycleCoordinator\(\{\s*manifest: input\.manifest,\s*game: shared\.game,\s*session,\s*\}\)/s);
  assert.doesNotMatch(source, /createStardewProductionLifecycleCoordinator\(/);
  // Secondary regression guards: retired Guardian-era seams never reappear in
  // the generic composition closure.
  assert.doesNotMatch(source, /StardewBootstrapGuardianOwnerFactory|stardewBootstrapGuardianOwnerFactory/);
  assert.doesNotMatch(source, /createStardewBootstrapGuardianOwnerFromDesktopSession\(/);
  assert.doesNotMatch(source, /createDesktopGuardianGameRuntimePlatform\(/);
  assert.match(source, /return Object\.freeze\(\{\s*close:/s);

  let closeCalls = 0;
  const session = Object.freeze({
    arm: async () => { throw new Error("unused"); },
    launch: async () => { throw new Error("unused"); },
    contain: async () => { throw new Error("unused"); },
    close: async () => { closeCalls += 1; },
  });
  const composition = createDesktopPrivateHostComposition(rootLayoutCapability, session);

  assert.deepEqual(Object.keys(composition), ["close"]);
  assert.deepEqual(Reflect.ownKeys(composition), ["close"]);
  assert.equal("stardewBootstrapGuardianOwnerFactory" in composition, false);
  assert.equal(facadeHasOnlyLifecycle, true);
  const typedComposition: DesktopPrivateHostComposition = composition;
  assert.equal(typeof typedComposition.close, "function");
  await Promise.all([composition.close(), composition.close()]);
  assert.equal(closeCalls, 1);
});

test("host child lifecycle aggregation closes children in reverse order exactly once", async () => {
  const calls: string[] = [];
  const children: HostChildLifecycle[] = [
    { close: async () => { calls.push("first"); } },
    { close: async () => { calls.push("second"); } },
    { close: async () => { calls.push("third"); } },
  ];
  const aggregation = createHostChildLifecycleAggregation(children);
  const firstClose = aggregation.close();
  const secondClose = aggregation.close();

  assert.equal(firstClose, secondClose);
  await Promise.all([firstClose, secondClose, aggregation.close()]);
  assert.deepEqual(calls, ["third", "second", "first"]);
});

test("host child lifecycle aggregation deduplicates a child and propagates the first reverse-order failure after attempting every child", async () => {
  const calls: string[] = [];
  const firstFailure = new Error("third_close_failed");
  const secondFailure = new Error("second_close_failed");
  const repeatedChild: HostChildLifecycle = {
    close: async () => { calls.push("repeated"); },
  };
  const aggregation = createHostChildLifecycleAggregation([
    repeatedChild,
    { close: async () => { calls.push("second"); throw secondFailure; } },
    { close: async () => { calls.push("third"); throw firstFailure; } },
    repeatedChild,
  ]);

  const closePromise = aggregation.close();
  await assert.rejects(closePromise, (error: unknown) => error === firstFailure);
  assert.deepEqual(calls, ["third", "second", "repeated"]);
  assert.equal(aggregation.close(), closePromise);
});

test("desktop composition retains the typed root capability and closes the authenticated session once", async () => {
  let closeCalls = 0;
  const session = Object.freeze({
    arm: async () => { throw new Error("unused"); },
    launch: async () => { throw new Error("unused"); },
    contain: async () => { throw new Error("unused"); },
    close: async () => { closeCalls += 1; },
  });
  const composition = createDesktopPrivateHostComposition(rootLayoutCapability, session);

  assert.deepEqual(Object.keys(composition), ["close"]);
  assert.deepEqual(Reflect.ownKeys(composition), ["close"]);
  assert.equal("stardewBootstrapGuardianOwnerFactory" in composition, false);
  const typedComposition: DesktopPrivateHostComposition = composition;
  assert.equal(typeof typedComposition.close, "function");
  await Promise.all([composition.close(), composition.close()]);
  assert.equal(closeCalls, 1);
});
test("desktop product composition wires the semantic authority, Chat runtime, and Stardew lifecycle owner into reverse-order children", async () => {
  const source = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "composition", "desktop-host-composition.ts"), "utf8");
  assert.match(source, /createSharedSemanticProductionAuthorityFromDeploymentManifest\(input\.manifest, input\.gameSessionMode\)/);
  assert.match(source, /createChatSemanticFacadeFromSharedAuthority\(shared\.chat\)/);
  assert.match(source, /startMountedChatRuntime\(\)/);
  assert.match(source, /PRODUCT_INTEGRATION_CATALOG\.getProvider\("stardew"\)/);
  assert.match(source, /provider\.createLifecycleCoordinator\(\{\s*manifest: input\.manifest,\s*game: shared\.game,\s*session,\s*\}\)/s);
  // The mounted Chat runtime is constructed before the lifecycle coordinator, so
  // a coordinator construction failure still drains the started Chat runtime
  // (not just the unmounted facade) alongside the shared owner.
  assert.match(source, /await mountedFacade\.startMountedChatRuntime\(\);[\s\S]*?lifecycleCoordinator = await provider\.createLifecycleCoordinator/);
  // The presentation admission owner is built from the provider's presentation
  // projection after the lifecycle owner; a provider that exposes no projection
  // fails closed rather than inventing one, and the projection is consumed only
  // as the Host-owned assembly input of the presentation child.
  assert.match(source, /const presentation = lifecycleCoordinator\.presentation;\s*if \(presentation === undefined\) throw new Error\("game_integration_presentation_projection_unavailable"\);/);
  assert.match(source, /presentationAdmission = await startDesktopPresentationAdmission\(\{\s*manifest: input\.manifest,\s*hostArtifactRoot: resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\), "\.\."\),\s*bootstrapToken: randomBytes\(32\)\.toString\("base64url"\),\s*eventStream: createChatEventStream\(\),\s*lease: mountedLease,\s*presentation,\s*\}\)/s);
  // The presentation child is registered after the Game owner, the Chat runtime,
  // and the shared authority, so the reverse-order aggregation closes the one
  // listener before the Chat runtime, the Game owner, and the shared authority
  // it serves, mirroring the reference entry's server -> facade -> coordinator ->
  // shared close order.
  assert.match(source, /createDesktopPrivateHostComposition\(rootLayoutCapability, session, \[\s*shared,\s*lifecycleCoordinator,\s*chatRuntime,\s*presentationAdmission,\s*\]\)/);
  assert.match(source, /await presentationAdmission\?\.close\(\)/);
  assert.match(source, /await lifecycleCoordinator\?\.close\(\)/);
  assert.match(source, /await shared\?\.close\(\)/);
  // A construction failure drains the presentation child first, then the Chat
  // child (or its unmounted facade when the mount never completed), before the
  // lifecycle owner, the shared authority, and the authenticated session,
  // preserving the construction error.
  assert.match(source, /await presentationAdmission\?\.close\(\);\s*\}\s*catch \{\s*\/\/ Preserve the product construction failure\.\s*\}\s*try \{\s*if \(chatRuntime !== undefined\) await chatRuntime\.close\(\);\s*else await chatFacade\?\.close\(\);[\s\S]*?await lifecycleCoordinator\?\.close\(\);[\s\S]*?await shared\?\.close\(\);[\s\S]*?await session\.close\(\);/);
  // The generic composition never constructs the Stardew launch assemblies or
  // imports game modules directly; the provider owns them.
  assert.doesNotMatch(source, /createStardewProductionLifecycleCoordinator\(/);
  assert.doesNotMatch(source, /createStardewPlayerHostRuntimeLaunchCollaboratorFactory\(/);
  assert.doesNotMatch(source, /games\/stardew\//);
  // The bootstrap mode and principal come only from the Host-owned manifest
  // input; the composition never derives them from root layout/bootstrap facts.
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /dataRoot|bootstrapId|programRoot|principal\s*:/);
  assert.doesNotMatch(source, /export\s*\{/);
  assert.doesNotMatch(source, /export\s+(?:type|interface|function|const)\s+(?:createSharedSemanticProductionAuthorityFromDeploymentManifest|createStardewProductionLifecycleCoordinator|DesktopGuardianSession|DesktopGuardianSessionBinding)/);
});

test("composition facade close runs the presentation, Chat, Game, and shared children exactly once in reverse registration order", async () => {
  const calls: string[] = [];
  let chatCloseCalls = 0;
  let coordinatorCloseCalls = 0;
  let sharedCloseCalls = 0;
  let presentationCloseCalls = 0;
  let sessionCloseCalls = 0;
  const children: HostChildLifecycle[] = [
    { close: async () => { sharedCloseCalls += 1; calls.push("shared"); } },
    { close: async () => { coordinatorCloseCalls += 1; calls.push("coordinator"); } },
    { close: async () => { chatCloseCalls += 1; calls.push("chat"); } },
    { close: async () => { presentationCloseCalls += 1; calls.push("presentation"); } },
  ];
  const session = Object.freeze({
    arm: async () => { throw new Error("unused"); },
    launch: async () => { throw new Error("unused"); },
    contain: async () => { throw new Error("unused"); },
    close: async () => { sessionCloseCalls += 1; },
  });
  const composition = createDesktopPrivateHostComposition(rootLayoutCapability, session, children);
  assert.deepEqual(Object.keys(composition), ["close"]);
  assert.deepEqual(Reflect.ownKeys(composition), ["close"]);
  await Promise.all([composition.close(), composition.close()]);
  // Chat and Game stay independent surfaces: the single facade close entry
  // invokes each child's own close once and only once - the presentation
  // admission (its listener and admitted Chat work) before the Chat runtime,
  // then the Game lifecycle owner, and the shared authority last - so closing
  // one surface never touches the other's runtime.
  assert.deepEqual(calls, ["presentation", "chat", "coordinator", "shared"]);
  assert.equal(presentationCloseCalls, 1);
  assert.equal(chatCloseCalls, 1);
  assert.equal(coordinatorCloseCalls, 1);
  assert.equal(sharedCloseCalls, 1);
  assert.equal(sessionCloseCalls, 1);
});

type CompositionDrainFixtureResult = Readonly<{
  scenario: string;
  outcome: "unexpected_success" | "original_failure_propagated" | "different_failure";
  shared: number;
  lease: number;
  facade: number;
  session: number;
  coordinator: number;
  presentationStarts: number;
  presentationCloses: number;
  errorMessage?: string;
}>;

type CompositionDrainFixtureScenario =
  | "coordinator-failure"
  | "mount-failure"
  | "presentation-failure"
  | "presentation-missing";

function runCompositionDrainFixture(scenario: CompositionDrainFixtureScenario): Promise<CompositionDrainFixtureResult> {
  const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "desktop-host-composition-drain-fixture-worker.js");
  return new Promise<CompositionDrainFixtureResult>((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, ["--experimental-test-module-mocks", fixturePath, scenario], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectResult(new Error(`composition_drain_fixture_timeout:${scenario}`));
    }, 30_000);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => { clearTimeout(timeout); rejectResult(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectResult(new Error(`composition_drain_fixture_exit_${String(code)}:${stderr || "<no stderr>"}`));
        return;
      }
      try {
        resolveResult(JSON.parse(output) as CompositionDrainFixtureResult);
      } catch {
        rejectResult(new Error(`composition_drain_fixture_output_invalid:${output || "<no output>"}`));
      }
    });
  });
}

test("desktop product composition drains the Chat child, shared owner, and session when construction fails", async () => {
  // The real composition entry runs in a hermetic fixture worker with the
  // registered stardew provider (and the Chat/shared imports) mocked to fail;
  // a construction failure must drain every already-succeeded child and
  // propagate the original error unchanged.
  for (const scenario of ["coordinator-failure", "mount-failure"] as const) {
    const result = await runCompositionDrainFixture(scenario);
    assert.equal(result.outcome, "original_failure_propagated");
    assert.equal(result.shared, 1);
    assert.equal(result.session, 1);
    // Neither scenario reaches the presentation child, so no lifecycle owner
    // and no presentation admission was ever constructed.
    assert.equal(result.coordinator, 0);
    assert.equal(result.presentationStarts, 0);
    assert.equal(result.presentationCloses, 0);
    if (scenario === "coordinator-failure") {
      // The mounted Chat child is drained through its lease and facade close.
      assert.equal(result.lease, 1);
      assert.equal(result.facade, 1);
    } else {
      // The mount never completed; the facade alone drains the projection.
      assert.equal(result.lease, 0);
      assert.equal(result.facade, 1);
    }
  }
});

test("desktop product composition drains the presentation, Chat, Game, and shared children when presentation construction fails", async () => {
  // The lifecycle owner is live and the presentation admission owner is mocked
  // to fail; the composition must drain the Chat runtime, the lifecycle owner,
  // the shared authority, and the authenticated session in that order while
  // propagating the original presentation failure.
  const result = await runCompositionDrainFixture("presentation-failure");
  assert.equal(result.outcome, "original_failure_propagated");
  assert.equal(result.presentationStarts, 0);
  assert.equal(result.presentationCloses, 0);
  assert.equal(result.lease, 1);
  assert.equal(result.facade, 1);
  assert.equal(result.coordinator, 1);
  assert.equal(result.shared, 1);
  assert.equal(result.session, 1);
});

test("desktop product composition fails closed when the registered provider exposes no presentation projection", async () => {
  // A provider capability without a presentation projection is never replaced
  // by a composition-invented surface: construction fails with the fixed
  // category while every already-succeeded child still drains.
  const result = await runCompositionDrainFixture("presentation-missing");
  assert.equal(result.outcome, "different_failure");
  assert.equal(result.errorMessage, "game_integration_presentation_projection_unavailable");
  assert.equal(result.presentationStarts, 0);
  assert.equal(result.presentationCloses, 0);
  assert.equal(result.lease, 1);
  assert.equal(result.facade, 1);
  assert.equal(result.coordinator, 1);
  assert.equal(result.shared, 1);
  assert.equal(result.session, 1);
});
