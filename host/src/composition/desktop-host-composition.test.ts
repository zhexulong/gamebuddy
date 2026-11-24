import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test, { before } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import { readSourceShape } from "../test-support/source-shape.test-support.js";
import { bindVerifiedWindowsLockReclaimerForTest } from "../test-support/windows-lock-reclaimer.test-support.js";

import {
  createDesktopPrivateHostComposition,
  type DesktopHostCompositionChild,
  type DesktopPrivateHostComposition,
  type DesktopRootLayoutCapability,
} from "./desktop-host-composition.js";

const rootLayoutCapability = Object.freeze({}) as DesktopRootLayoutCapability;

// The one reading in this file that mounts a real durable authority releases locks through the Windows
// reclaimer, and binds that reclaimer itself rather than leaning on the suite's `--import` preload.
before(async () => {
  await bindVerifiedWindowsLockReclaimerForTest("desktop-host-composition.test");
});

type Assert<T extends true> = T;
type HasExactKeys<T, TKeys extends PropertyKey> = Exclude<keyof T, TKeys> extends never
  ? Exclude<TKeys, keyof T> extends never
    ? true
    : false
  : false;
type DesktopPrivateHostCompositionHasOnlyLifecycle = Assert<HasExactKeys<DesktopPrivateHostComposition, "close">>;
// The compile-time facade assertion above is only meaningful if it is
// evaluated; this binding keeps it in the emitted type check.
const facadeHasOnlyLifecycle: DesktopPrivateHostCompositionHasOnlyLifecycle = true;

test("desktop product composition builds the Stardew game owner only through the registered catalog provider", async () => {
  const sourcePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "src",
    "composition",
    "desktop-host-composition.ts",
  );
  const { shape: source } = readSourceShape(sourcePath);
  // Main assertion: the generic composition never directly constructs a game
  // assembly; the Stardew lifecycle owner is built exclusively through the
  // provider registered in PRODUCT_INTEGRATION_CATALOG.
  //
  // SCOPE, so nobody reads this as "one coordinator in the product": the guard
  // covers the INTERACTIVE path. `host/src/main.ts` is the authorized headless
  // runner and does construct the coordinator itself; its authority is the same
  // Authority Root Identity, and the exclusion between the two entries is the
  // Windows named mutex plus the durable Game lease - not this assertion. The
  // product therefore has two legitimate entries (desktop shell, headless gate)
  // and one authority, which is why a second entry is not a second owner.
  assert.match(source, /PRODUCT_INTEGRATION_CATALOG\.getProvider\("stardew"\)/);
  assert.match(
    source,
    /provider\.createLifecycleCoordinator\(\{\s*manifest: input\.manifest,\s*game: shared\.game,\s*folderPicker,\s*runtimeCollaborator,?\s*\}\)/s,
  );
  assert.doesNotMatch(source, /createStardewProductionLifecycleCoordinator\(/);
  // Secondary regression guards: retired Guardian-era seams never reappear in
  // the generic composition closure.
  assert.doesNotMatch(source, /StardewBootstrapGuardianOwnerFactory|stardewBootstrapGuardianOwnerFactory/);
  assert.doesNotMatch(source, /createStardewBootstrapGuardianOwnerFromDesktopSession\(/);
  assert.match(source, /return Object\.freeze\(\{\s*close:/s);

  let closeCalls = 0;
  const session = Object.freeze({
    arm: async () => {
      throw new Error("unused");
    },
    launch: async () => {
      throw new Error("unused");
    },
    contain: async () => {
      throw new Error("unused");
    },
    recover: async () => {
      throw new Error("unused");
    },
    close: async () => {
      closeCalls += 1;
    },
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

test("desktop composition retains the typed root capability and closes the authenticated session once", async () => {
  let closeCalls = 0;
  const session = Object.freeze({
    arm: async () => {
      throw new Error("unused");
    },
    launch: async () => {
      throw new Error("unused");
    },
    contain: async () => {
      throw new Error("unused");
    },
    recover: async () => {
      throw new Error("unused");
    },
    close: async () => {
      closeCalls += 1;
    },
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
  const { shape: source } = readSourceShape(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "composition", "desktop-host-composition.ts"),
  );
  assert.match(
    source,
    /createSharedSemanticProductionAuthorityFromDeploymentManifest\(\s*input\.manifest,\s*\.\.\.\(mountOptions === undefined \? \[\] : \[mountOptions\]\),?\s*\)/,
  );
  // The mount this composition performs is the Host's own answer from the durable records in
  // the runtime root; nothing in the assembly input may name it.
  assert.doesNotMatch(source, /gameSessionMode|GAME_SESSION_MODE/);
  assert.match(source, /input\.publishLaunchUrl\?\.\(presentationAdmission\.launchUrl\)/);
  assert.match(source, /createChatSemanticFacadeFromSharedAuthority\(shared\.chat\)/);
  assert.match(source, /startMountedChatRuntime\(\)/);
  assert.match(source, /PRODUCT_INTEGRATION_CATALOG\.getProvider\("stardew"\)/);
  assert.match(
    source,
    /provider\.createLifecycleCoordinator\(\{\s*manifest: input\.manifest,\s*game: shared\.game,\s*folderPicker,\s*runtimeCollaborator,?\s*\}\)/s,
  );
  // The mounted Chat runtime is constructed before the lifecycle coordinator, so
  // a coordinator construction failure still drains the started Chat runtime
  // (not just the unmounted facade) alongside the shared owner.
  assert.match(
    source,
    /await mountedFacade\.startMountedChatRuntime\(\);[\s\S]*?lifecycleCoordinator = await provider\.createLifecycleCoordinator/,
  );
  // The presentation admission owner is built from the provider's presentation
  // projection after the lifecycle owner; a provider that exposes no projection
  // fails closed rather than inventing one, and the projection is consumed only
  // as the Host-owned assembly input of the presentation child.
  assert.match(
    source,
    /const presentation = lifecycleCoordinator\.presentation;\s*if \(presentation === undefined\) throw new Error\("game_integration_presentation_projection_unavailable"\);/,
  );
  // The composed reference-game admission still derives the artifact root in place
  // (5086882f fixed the same two-levels-up derivation for the hoisted local the
  // chat-only/management variant shares), and 46160994 added `chatSelection` as its
  // last argument so the composed surface mounts `chat.select` over the same shared
  // authority the mounted Chat lane owns.
  assert.match(
    source,
    /presentationAdmission = await startDesktopPresentationAdmission\(\{\s*\.\.\.\(input\.voiceSurface === undefined \? \{\} : \{ voiceSurface: input\.voiceSurface \}\),\s*\.\.\.\(input\.speechSink === undefined \? \{\} : \{ speechSink: input\.speechSink \}\),\s*\.\.\.\(input\.listVoiceOutputDevices === undefined\s*\? \{\}\s*: \{ listVoiceOutputDevices: input\.listVoiceOutputDevices \}\),\s*manifest: input\.manifest,\s*hostArtifactRoot: resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\), "\.\."\),\s*bootstrapToken: randomBytes\(32\)\.toString\("base64url"\),\s*eventStream: createChatEventStream\(\),\s*lease: mountedLease,\s*presentation,\s*chatSelection: shared\.chat,?\s*\}\)/s,
  );
  // The presentation child is registered after the Game owner, the Chat runtime,
  // and the shared authority, so the reverse-order aggregation closes the one
  // listener before the Chat runtime, the Game owner, and the shared authority
  // it serves, mirroring the reference entry's server -> facade -> coordinator ->
  // shared close order.
  assert.match(
    source,
    /createDesktopPrivateHostComposition\(rootLayoutCapability, session, \[\s*\{ step: "release_shared_authority"[\s\S]*?\{ step: "stop_admission"[\s\S]*?\]\)/,
  );
  assert.match(source, /await presentationAdmission\?\.close\(\)/);
  assert.match(source, /await lifecycleCoordinator\?\.close\(\)/);
  assert.match(source, /await shared\?\.close\(\)/);
  // A construction failure drains the presentation child first, then the Chat
  // child (or its unmounted facade when the mount never completed), before the
  // lifecycle owner, the shared authority, and the authenticated session,
  // preserving the construction error.
  assert.match(
    source,
    /await presentationAdmission\?\.close\(\);\s*\}\s*catch \{\s*\/\/ Preserve the product construction failure\.\s*\}\s*try \{\s*if \(chatRuntime !== undefined\) await chatRuntime\.close\(\);\s*else await chatFacade\?\.close\(\);[\s\S]*?await lifecycleCoordinator\?\.close\(\);[\s\S]*?await shared\?\.close\(\);[\s\S]*?await session\.close\(\);/,
  );
  // The generic composition never constructs the Stardew launch assemblies or
  // imports game modules directly; the provider owns them.
  assert.doesNotMatch(source, /createStardewProductionLifecycleCoordinator\(/);
  assert.match(source, /createDesktopGuardianGameRuntimePlatform\(session\)/);
  assert.doesNotMatch(source, /games\/stardew\//);
  // The bootstrap mode and principal come only from the Host-owned manifest
  // input; the composition never derives them from root layout/bootstrap facts.
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /dataRoot|bootstrapId|programRoot|principal\s*:/);
  assert.doesNotMatch(source, /export\s*\{/);
  assert.doesNotMatch(
    source,
    /export\s+(?:type|interface|function|const)\s+(?:createSharedSemanticProductionAuthorityFromDeploymentManifest|createStardewProductionLifecycleCoordinator|DesktopGuardianSession|DesktopGuardianSessionBinding)/,
  );
});

test("composition facade close runs the presentation, Chat, Game, and shared children exactly once in reverse registration order", async () => {
  const calls: string[] = [];
  let chatCloseCalls = 0;
  let coordinatorCloseCalls = 0;
  let sharedCloseCalls = 0;
  let presentationCloseCalls = 0;
  let sessionCloseCalls = 0;
  const children: DesktopHostCompositionChild[] = [
    {
      step: "release_shared_authority",
      close: async () => {
        sharedCloseCalls += 1;
        calls.push("shared");
      },
    },
    {
      step: "drain_game_lifecycle",
      close: async () => {
        coordinatorCloseCalls += 1;
        calls.push("coordinator");
      },
    },
    {
      step: "drain_chat_runtime",
      close: async () => {
        chatCloseCalls += 1;
        calls.push("chat");
      },
    },
    {
      step: "stop_admission",
      close: async () => {
        presentationCloseCalls += 1;
        calls.push("presentation");
      },
    },
  ];
  const session = Object.freeze({
    arm: async () => {
      throw new Error("unused");
    },
    launch: async () => {
      throw new Error("unused");
    },
    contain: async () => {
      throw new Error("unused");
    },
    recover: async () => {
      throw new Error("unused");
    },
    close: async () => {
      sessionCloseCalls += 1;
    },
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
  outcome: "unexpected_success" | "original_failure_propagated" | "different_failure" | "constructed";
  shared: number;
  lease: number;
  facade: number;
  session: number;
  coordinator: number;
  presentationStarts: number;
  presentationCloses: number;
  providerLookups: number;
  mountOptionsNonce: string | null;
  readyPublished: number;
  readyUrl: string | null;
  errorMessage?: string;
}>;

type CompositionDrainFixtureScenario =
  | "coordinator-failure"
  | "mount-failure"
  | "presentation-failure"
  | "presentation-missing"
  | "chat-only-surface"
  | "management-surface"
  | "gate-chat-only-surface";

function runCompositionDrainFixture(scenario: CompositionDrainFixtureScenario): Promise<CompositionDrainFixtureResult> {
  const fixturePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "desktop-host-composition-drain-fixture-worker.js",
  );
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
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectResult(error);
    });
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

test("desktop product composition forwards the gate marker nonce and publishes the launch URL once through the Host seam", async () => {
  // The gate-selected chat-only variant receives the Host-owned marker nonce
  // and publishes the composed launch URL exactly once through the assembly
  // input seam; the URL is never projected through the facade.
  const result = await runCompositionDrainFixture("gate-chat-only-surface");
  assert.equal(result.outcome, "constructed");
  assert.equal(result.coordinator, 0);
  assert.equal(result.providerLookups, 0);
  assert.equal(result.presentationStarts, 1);
  assert.equal(result.presentationCloses, 1);
  assert.equal(result.lease, 1);
  assert.equal(result.mountOptionsNonce, "a".repeat(64));
  assert.equal(result.readyPublished, 1);
  assert.equal(result.readyUrl, "http://127.0.0.1:1/#profile=reference&boot=fixture");
});

test("desktop product composition builds the chat-only surface with the mounted Chat lane and no Stardew coordinator", async () => {
  // The surface-selected chat-only variant of the composition assembles the
  // Chat runtime and the chat-only presentation admission as siblings; the
  // Stardew provider is never looked up and no coordinator is constructed.
  const result = await runCompositionDrainFixture("chat-only-surface");
  assert.equal(result.outcome, "constructed");
  assert.equal(result.coordinator, 0);
  assert.equal(result.providerLookups, 0);
  assert.equal(result.presentationStarts, 1);
  assert.equal(result.presentationCloses, 1);
  assert.equal(result.lease, 1);
  assert.equal(result.facade, 1);
  assert.equal(result.shared, 1);
  assert.equal(result.session, 1);
});

test("desktop product composition builds the management surface with the mounted Chat lane and no Stardew coordinator", async () => {
  // The surface-selected management variant assembles the Chat runtime and the
  // management presentation admission as siblings; the Stardew provider is
  // never looked up and no coordinator is constructed.
  const result = await runCompositionDrainFixture("management-surface");
  assert.equal(result.outcome, "constructed");
  assert.equal(result.coordinator, 0);
  assert.equal(result.providerLookups, 0);
  assert.equal(result.presentationStarts, 1);
  assert.equal(result.presentationCloses, 1);
  assert.equal(result.lease, 1);
  assert.equal(result.facade, 1);
  assert.equal(result.shared, 1);
  assert.equal(result.session, 1);
});

test("desktop product composition source selects the Chat-only/management variants without any Stardew coordinator assembly", async () => {
  const { shape: source } = readSourceShape(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "composition", "desktop-host-composition.ts"),
  );
  // The assembly input carries the surface selection; chat-only and management
  // never reach PRODUCT_INTEGRATION_CATALOG, and the composed-reference-game
  // surface keeps the single Stardew coordinator assembly.
  assert.match(source, /surface\?: DesktopHostSurface/);
  assert.match(source, /const surface = input\.surface \?\? "composed-reference-game";/);
  assert.match(source, /if \(surface === "chat-only" \|\| surface === "management"\) \{/);
  assert.match(
    source,
    /surface === "chat-only"\s*\? await startChatOnlyPresentationAdmission\(\{\s*\.\.\.variantInput,\s*\.\.\.\(input\.voiceSurface === undefined \? \{\} : \{ voiceSurface: input\.voiceSurface \}\),\s*\.\.\.\(input\.speechSink === undefined \? \{\} : \{ speechSink: input\.speechSink \}\),\s*\.\.\.\(input\.listVoiceOutputDevices === undefined\s*\? \{\}\s*: \{ listVoiceOutputDevices: input\.listVoiceOutputDevices \}\),?\s*\}\)\s*: await startTavernManagementPresentationAdmission\(\{\s*\.\.\.variantInput,\s*\.\.\.\(input\.listVoiceOutputDevices === undefined\s*\? \{\}\s*: \{ listVoiceOutputDevices: input\.listVoiceOutputDevices \}\),?\s*\}\)/,
  );
  assert.match(source, /startChatOnlyPresentationAdmission|startTavernManagementPresentationAdmission/);
  // The Chat-only variants register only the shared authority, Chat runtime,
  // and presentation admission as children; no game child participates.
  assert.match(
    source,
    /createDesktopPrivateHostComposition\(rootLayoutCapability, session, \[\s*\{ step: "release_shared_authority"[\s\S]*?\{ step: "stop_admission"[\s\S]*?\]\)/,
  );
  assert.doesNotMatch(source, /PRODUCT_INTEGRATION_CATALOG\.getProvider\("stardew"\)[\s\S]*?surface === "chat-only"/);
  assert.doesNotMatch(
    source,
    /createLifecycleCoordinator\(\{\s*manifest: input\.manifest,\s*game: shared\.game,\s*folderPicker,\s*runtimeCollaborator,?\s*\}\)[\s\S]*?surface === "chat-only"/,
  );
});
test("the Chat runtime's close ends the turn it is generating before it releases the mounted lane", async () => {
  const { shape: source } = readSourceShape(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "composition", "desktop-host-composition.ts"),
  );
  // The presentation port closed before this step, so an in-flight turn's stream has no reader:
  // the exit ends that turn through the same cancel seam a browser Stop uses, and only then
  // releases the lane whose close would otherwise wait for the model to stop generating.
  const abortAt = source.indexOf('abortMountedTurnThroughCancelSeam(input.manifest, mountedLease, "host_exit")');
  const leaseCloseAt = source.indexOf("await mountedLease.close();");
  assert.ok(abortAt >= 0, "the Chat runtime's close never ends the turn it is generating");
  assert.ok(leaseCloseAt >= 0, "the Chat runtime's close no longer releases the mounted lane");
  assert.ok(
    abortAt < leaseCloseAt,
    "the Chat runtime's close releases the mounted lane before ending the turn: the lane's close waits for that turn",
  );
  // The lane is released whatever the abort answered: a stranded turn must not strand the exit.
  assert.match(
    source,
    /try \{\s*await abortMountedTurnThroughCancelSeam\([\s\S]*?\} finally \{\s*await mountedLease\.close\(\);/,
  );
});

/**
 * The second game attempt is the Game lane's own business, and the Chat lane is no part of it.
 *
 * ADR-0015 §9.4 condition 3: after the per-attempt Guardian, attempt 2 runs in the SAME Host process
 * (settle hands the attempt back, the durable registration issues generation 2, the next launch
 * reaches the platform), and §7 argues structurally that the two surfaces hold nothing of each other.
 * This is that argument as an active reading, over the real production Chat authority and the real
 * Stardew lifecycle coordinator: a turn is durably GENERATING when attempt 2 lands, and what is read
 * afterwards is
 *
 *   1. the generating turn settled with its OWN outcome - `completed`, carrying the reply it had
 *      already committed - and was never cancelled by anything the game lane did;
 *   2. the selection is the same conversation at the same generation: the exact lease that was
 *      mounted before is still the current one, the same thread/surface pair is still readable, and
 *      the turn's own durable attempt still carries the generation it was accepted under;
 *   3. attempt 2 really ran: the durable registration issued generation 2, the readiness view says
 *      `ready` at 2, and the Guardian was asked for a second Player Host launch.
 *
 * The semantic authority owns a real Windows root mutex, so it cannot share this process with another
 * construction: the whole scenario runs in its own child, exactly as the other real-mount readings do.
 * What this does NOT prove, stated so a green run is not read as more than it is: that a real Stardew
 * world hands a cabin over (that needs the game), and that the browser's own snapshot agrees - the
 * surface reads through `state.read`, which this file's composition children are asserted against
 * elsewhere.
 */
const secondGameAttemptScript = `
  const [coordinatorUrl, internalUrl, manifestUrl, pathLockUrl, reclaimerUrl, storeUrl, runtimeUrl,
    acceptanceUrl, claimUrl, guardianPlatformUrl, lifecycleSupportUrl, registrationUrl, manifestPath] =
    process.argv.slice(1);
  const { bindWindowsStaleLockReclaimer } = await import(pathLockUrl);
  const { createBuildWindowsStaleLockReclaimer } = await import(reclaimerUrl);
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const { createSharedSemanticProductionAuthorityFromDeploymentManifest, isCurrentMountedChatRuntimeLease } =
    await import(coordinatorUrl);
  const internal = await import(internalUrl);
  const { loadHostDeploymentManifest } = await import(manifestUrl);
  const { createChatThreadStore } = await import(storeUrl);
  const { identityKey } = await import(runtimeUrl);
  const { createPlayerTurnAcceptor } = await import(acceptanceUrl);
  const { createProviderAttemptClaimer } = await import(claimUrl);
  const { createDesktopGuardianGameRuntimePlatform, createStardewPlayerHostRuntimeLaunchCollaboratorFactory } =
    await import(guardianPlatformUrl);
  const { createFixture } = await import(lifecycleSupportUrl);
  const { readStardewInstallationRegistration } = await import(registrationUrl);

  const manifest = await loadHostDeploymentManifest(manifestPath);
  const out = {};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Monotonic observation times: the ledger CAS rejects a step that steps back.
  let observedAtMs = Date.now();
  const nextTime = async () => {
    await sleep(2);
    observedAtMs = Math.max(observedAtMs + 1, Date.now());
    return observedAtMs;
  };

  // ---- The Chat lane: one real mounted runtime, with a turn that is generating ----
  const shared = await createSharedSemanticProductionAuthorityFromDeploymentManifest(manifest);
  const lease = await shared.chat.startMountedChatRuntime();
  const thread = lease.chatThreadId;
  const surface = lease.chatSurfaceSessionId;
  const store = createChatThreadStore(manifest.runtimeRoot, identityKey(manifest.principal));
  out.selectionBefore = {
    chatThreadId: thread,
    chatSurfaceSessionId: surface,
    selectionGeneration: lease.browserProjection.selectionGeneration,
    chatHandle: lease.browserProjection.chatHandle,
  };

  const playerText = "Synthetic player request";
  const companionText = "A reply the second game attempt must not touch.";
  await createPlayerTurnAcceptor(manifest, lease).accept({
    text: playerText,
    locale: "en-US",
    idempotencyKey: "abcdefghijklmnopqrstuv",
    expectedDraftRevision: 0,
  });
  await createProviderAttemptClaimer(manifest, lease).claim();
  let releaseTurn;
  const turnMayFinish = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  let generating = false;
  const theTurn = internal
    .startMountedAttempt(manifest, lease, (invocation) =>
      internal.consumeMountedAttemptInvocationAdmission(invocation, async (scope) => {
      await scope.transitionStore({ operation: "arm", observedAtMs: await nextTime() });
      await scope.transitionStore({ operation: "running", statusClass: "success", observedAtMs: await nextTime() });
      const committed = await scope.transitionPresentation({
        operation: "commit_presentation",
        cancelEpoch: 0,
        message: { messageId: "response_01", text: companionText, occurredAtMs: await nextTime() },
        committedAtMs: await nextTime(),
      });
      if (committed.status !== "presentation_committed") throw new Error("expected_presentation_committed");
      const releasePrompt = scope.beginActivePrompt();
      generating = true;
      // The generation is in flight while the Game lane runs its second attempt.
      await turnMayFinish;
      await scope.transitionPresentation({ operation: "claim_completion", claimedAtMs: await nextTime() });
      const completed = await scope.transitionPresentation({
        operation: "complete",
        completedAtMs: await nextTime(),
      });
      releasePrompt();
      return completed;
      }),
    )
    // The Game lane runs while this promise is pending, so its rejection is captured here rather
    // than left to surface as an unhandled rejection in the middle of that work.
    .then(
      (settled) => ({ settled }),
      (error) => ({ error }),
    );
  for (let attempt = 0; attempt < 1200 && !generating; attempt += 1) await sleep(5);
  if (!generating) throw new Error("the turn never reached a generating state");

  // ---- The Game lane: attempt 1 to its end, then attempt 2, in this same process ----
  const roleExits = [];
  const launches = [];
  const ack = (operation, role) =>
    Object.freeze({
      operation,
      status: "ok",
      bootstrapId: "bootstrap-coordinator-1",
      generation: "generation-1",
      inventoryDigest: "inventory-1",
      runtimeAdmissionSha256: "admission-1",
      guardianInstanceId: "guardian-instance-coordinator-1",
      guardianEpoch: 1,
      attemptId: "bootstrap-coordinator-1",
      ...(role === undefined ? {} : { role }),
    });
  const guardianSession = Object.freeze({
    onRoleExit(handler) {
      roleExits.push(handler);
    },
    arm: async () => ack("arm_attempt"),
    launch: async (input) => {
      launches.push(input.role);
      return ack("launch_role", input.role);
    },
    contain: async (input) => ack("contain_role", input.role),
    recover: async () => Object.freeze({ outcome: "contained" }),
    close: async () => undefined,
  });
  const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
    createDesktopGuardianGameRuntimePlatform(guardianSession),
  );
  const fixture = await createFixture({
    runtimeRoot: manifest.runtimeRoot,
    seedRegistration: true,
    overrides: { runtimeLaunchContained: collaborator },
  });
  const stage = async () => {
    await fixture.coordinator.activationOwner.activate(fixture.broker.issue("lifecycle_activation"));
    await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
    });
  };
  await stage();
  await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
    apiVersion: 1,
    idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
    expectedInstanceGeneration: 1,
  });
  // Attempt 1's game ends by the player's own hand, and the Guardian reports the code the OS gave it.
  if (roleExits.length !== 1) throw new Error("expected_one_role_exit_watcher");
  for (const watcher of roleExits) watcher(Object.freeze({ role: "player_host", exitCode: 0 }));
  out.attemptOneReadiness = fixture.coordinator.launchReadinessReader.readLaunchReadinessView();

  // Attempt 2 begins where a first attempt begins; the settle inside it is what hands attempt 1 back.
  await stage();
  const registration = await readStardewInstallationRegistration(fixture.runtimeRoot);
  out.registrationGeneration = registration === null ? null : registration.instanceGeneration;
  out.attemptTwoReadiness = fixture.coordinator.launchReadinessReader.readLaunchReadinessView();
  await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
    apiVersion: 1,
    idempotencyKey: "DEiM0RVZneImaq7zN3u_w",
    expectedInstanceGeneration: 2,
  });
  out.playerHostLaunches = launches.slice();

  // ---- The turn the game lane must not have touched finishes on its own ----
  releaseTurn();
  const outcome = await theTurn;
  if (outcome.error !== undefined) throw outcome.error;
  const settled = outcome.settled;
  out.turnStatus = settled === undefined || settled === null ? null : settled.status;
  out.selectionAfter = {
    chatThreadId: lease.chatThreadId,
    chatSurfaceSessionId: lease.chatSurfaceSessionId,
    selectionGeneration: lease.browserProjection.selectionGeneration,
    chatHandle: lease.browserProjection.chatHandle,
    stillTheMountedLease: isCurrentMountedChatRuntimeLease(lease),
  };
  const state = await store.resumeThread(thread, surface);
  const ledger = state.turnLedger;
  out.transcript = {
    messages: state.messages.map((message) => [message.kind, message.text]),
    turnStatus: ledger === null ? null : ledger.status,
    turnSelectionGeneration:
      ledger === null || ledger.attempt === undefined || ledger.attempt === null
        ? null
        : ledger.attempt.selectionGeneration,
  };

  store.close?.();
  await fixture.coordinator.close();
  await fixture.broker.close();
  await lease.close();
  await shared.close();
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
`;

function runSecondGameAttemptScenario(manifestPath: string): Promise<Record<string, unknown>> {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      secondGameAttemptScript,
      new URL(
        "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js",
        import.meta.url,
      ).href,
      new URL(
        "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js",
        import.meta.url,
      ).href,
      new URL("../deployment-manifest.js", import.meta.url).href,
      new URL("../path-lock.js", import.meta.url).href,
      new URL("../windows-stale-lock-reclaimer/index.js", import.meta.url).href,
      new URL("../tavern/chat-thread-store.js", import.meta.url).href,
      new URL("../runtime.js", import.meta.url).href,
      new URL("../tavern/player-turn-acceptance.js", import.meta.url).href,
      new URL("../tavern/provider-attempt-claim.js", import.meta.url).href,
      new URL("./stardew/stardew-guardian-platform.js", import.meta.url).href,
      new URL("../stardew-production-lifecycle-coordinator.test-support.js", import.meta.url).href,
      new URL("../stardew-installation-registration.internal.js", import.meta.url).href,
      manifestPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  return new Promise<Record<string, unknown>>((resolveResult, rejectResult) => {
    let output = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectResult(new Error(`second_game_attempt_scenario_timeout:${stderr || "<no stderr>"}`));
    }, 120_000);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectResult(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      let reading: Record<string, unknown>;
      try {
        reading = JSON.parse(output) as Record<string, unknown>;
      } catch {
        rejectResult(
          new Error(
            `second_game_attempt_scenario_no_reading:exit=${String(code)}:stderr=${stderr || "<none>"}:stdout=${output || "<none>"}`,
          ),
        );
        return;
      }
      resolveResult(reading);
    });
  });
}

type ChatSelectionReading = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  selectionGeneration: number;
  chatHandle: string;
}>;

test(
  "a second game attempt leaves the generating Chat turn and the selected Chat exactly where they were",
  { skip: process.platform !== "win32" ? "requires real Windows production mount construction" : false },
  async (t) => {
    const root = canonicalTestRootSync("gamebuddy-second-game-attempt-");
    try {
      const manifestPath = join(root, "manifest.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: 2,
          topology: "independent_chat_and_game_surfaces",
          runtimeRoot: root,
          principal: Object.freeze({
            playerId: "player_01",
            companionId: "companion_01",
            continuityId: "continuity_01",
          }),
          bootstrapOperationId: "bootstrap_01",
          authorityGeneration: 1,
        }),
      );
      const observed = await runSecondGameAttemptScenario(manifestPath);
      const before = observed.selectionBefore as ChatSelectionReading;
      const after = observed.selectionAfter as ChatSelectionReading & Readonly<{ stillTheMountedLease: boolean }>;
      const transcript = observed.transcript as Readonly<{
        messages: readonly (readonly [string, string])[];
        turnStatus: string | null;
        turnSelectionGeneration: number | null;
      }>;
      t.diagnostic(
        `second attempt: launches ${JSON.stringify(observed.playerHostLaunches)} · registration ${String(observed.registrationGeneration)} · ` +
          `readiness ${JSON.stringify(observed.attemptOneReadiness)} -> ${JSON.stringify(observed.attemptTwoReadiness)} · ` +
          `turn ${String(observed.turnStatus)}/${String(transcript.turnStatus)} · selection ${before.selectionGeneration} -> ${after.selectionGeneration} (current ${String(after.stillTheMountedLease)})`,
      );

      // 1. The turn that was generating when attempt 2 landed settled with its own outcome: it
      //    completed, it kept the reply it had already committed, and nothing cancelled it.
      assert.equal(observed.turnStatus, "completed", "the in-flight turn did not settle by its own completion");
      assert.equal(
        transcript.turnStatus,
        "completed",
        "the durable ledger is not the completed turn the runner returned",
      );
      assert.deepEqual(
        transcript.messages.filter(([kind]) => kind !== "opening"),
        [
          ["player", "Synthetic player request"],
          ["response", "A reply the second game attempt must not touch."],
        ],
        "the durable transcript is not the pair the Chat lane wrote",
      );

      // 2. The selection is the same conversation at the same generation: the same mounted lease is
      //    still current, the same pair is readable, and the turn's own durable attempt still carries
      //    the generation it was accepted under.
      assert.equal(after.stillTheMountedLease, true, "the mounted Chat lease was replaced while the game lane ran");
      assert.deepEqual(
        {
          chatThreadId: after.chatThreadId,
          chatSurfaceSessionId: after.chatSurfaceSessionId,
          selectionGeneration: after.selectionGeneration,
          chatHandle: after.chatHandle,
        },
        before,
        "the selected Chat or its generation moved while the game lane ran",
      );
      assert.equal(
        transcript.turnSelectionGeneration,
        before.selectionGeneration,
        "the settled turn is no longer recorded under the selection generation it was accepted at",
      );

      // 3. And attempt 2 really ran: the durable registration issued generation 2, the readiness view
      //    is `ready` at 2 after attempt 1's ending, and the Guardian was asked to launch again.
      assert.deepEqual(observed.attemptOneReadiness, { generation: 0, status: "failed", playerHostExitCode: 0 });
      assert.deepEqual(observed.attemptTwoReadiness, { generation: 2, status: "ready", playerHostExitCode: null });
      assert.equal(observed.registrationGeneration, 2, "the second attempt is not instance generation 2");
      assert.deepEqual(
        observed.playerHostLaunches,
        ["player_host", "player_host"],
        "the second attempt never reached the platform, so this reading measured nothing about a second attempt",
      );
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
