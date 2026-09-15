import assert from "node:assert/strict";
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
type _DesktopPrivateHostCompositionHasOnlyLifecycle = Assert<
  HasExactKeys<DesktopPrivateHostComposition, "close">
>;

test("desktop composition keeps the Stardew Guardian adapter in a private closure", async () => {
  const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "composition", "desktop-host-composition.ts");
  const source = await readFile(sourcePath, "utf8");
  assert.match(source, /type StardewBootstrapGuardianOwnerFactory =/);
  assert.match(source, /const stardewBootstrapGuardianOwnerFactory: StardewBootstrapGuardianOwnerFactory =/);
  assert.match(source, /createStardewBootstrapGuardianOwnerFromDesktopSession\(owner, session, deadlineUnixMs, operationWaitBudgetMs\)/);
  assert.match(source, /facade below intentionally projects lifecycle only/i);
  assert.doesNotMatch(source, /export\s+(?:type|interface)\s+StardewBootstrapGuardianOwnerFactory/);
  assert.doesNotMatch(source, /readonly\s+stardewBootstrapGuardianOwnerFactory/);
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
test("desktop product composition wires the semantic authority and Stardew lifecycle owner into reverse-order children", async () => {
  const source = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "composition", "desktop-host-composition.ts"), "utf8");
  assert.match(source, /createSharedSemanticProductionAuthorityFromDeploymentManifest\(input\.manifest, input\.gameSessionMode\)/);
  assert.match(source, /createStardewProductionLifecycleCoordinator\(\s*input\.manifest,\s*folderPicker,\s*shared\.game,\s*runtimeCollaboratorFactory,\s*\)/s);
  assert.match(source, /createStardewPlayerHostRuntimeLaunchCollaboratorFactory\(createDesktopGuardianGameRuntimePlatform\(session\)\)/);
  assert.match(source, /createDesktopPrivateHostComposition\(rootLayoutCapability, session, \[shared, lifecycleCoordinator\]\)/);
  assert.match(source, /await lifecycleCoordinator\?\.close\(\)/);
  assert.match(source, /await shared\?\.close\(\)/);
  // The bootstrap mode and principal come only from the Host-owned manifest
  // input; the composition never derives them from root layout/bootstrap facts.
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /dataRoot|bootstrapId|programRoot|principal\s*:/);
  assert.doesNotMatch(source, /export\s*\{/);
  assert.doesNotMatch(source, /export\s+(?:type|interface|function|const)\s+(?:createSharedSemanticProductionAuthorityFromDeploymentManifest|createStardewProductionLifecycleCoordinator|DesktopGuardianSession|DesktopGuardianSessionBinding)/);
});