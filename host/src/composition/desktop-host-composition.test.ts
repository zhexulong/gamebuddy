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

test("desktop composition exposes only the typed invocation factory and keeps platform transport private", async () => {
  const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "composition", "desktop-host-composition.ts");
  const source = await readFile(sourcePath, "utf8");
  assert.match(source, /createStardewBootstrapGuardianOwnerFromDesktopSession\(owner, session, deadlineUnixMs, operationWaitBudgetMs\)/);
  assert.match(source, /create:\s*\(owner, deadlineUnixMs, operationWaitBudgetMs\)/);
  assert.doesNotMatch(source, /DesktopGuardianSession[^\n]*StardewBootstrapGuardianOwnerFactory/);
  assert.doesNotMatch(source, /stardewBootstrapGuardianOwnerFactory[^\n]*(pipe|token|pid|path)/i);

  let closeCalls = 0;
  const session = Object.freeze({
    arm: async () => { throw new Error("unused"); },
    launch: async () => { throw new Error("unused"); },
    contain: async () => { throw new Error("unused"); },
    close: async () => { closeCalls += 1; },
  });
  const composition = createDesktopPrivateHostComposition(rootLayoutCapability, session);
  const factory = composition.stardewBootstrapGuardianOwnerFactory;

  assert.deepEqual(Object.keys(composition), ["stardewBootstrapGuardianOwnerFactory", "close"]);
  assert.deepEqual(Object.keys(factory), ["create"]);
  assert.equal("session" in factory, false);
  assert.equal("pipeName" in factory, false);
  assert.equal("token" in factory, false);
  assert.equal("pid" in factory, false);
  assert.equal("path" in factory, false);
  assert.equal(factory.create.length, 3);
  const typedComposition: DesktopPrivateHostComposition = composition;
  assert.equal(typeof typedComposition.stardewBootstrapGuardianOwnerFactory.create, "function");
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

  assert.deepEqual(Object.keys(composition), ["stardewBootstrapGuardianOwnerFactory", "close"]);
  assert.deepEqual(Object.keys(composition.stardewBootstrapGuardianOwnerFactory), ["create"]);
  assert.equal("session" in composition.stardewBootstrapGuardianOwnerFactory, false);
  assert.equal("pipeName" in composition.stardewBootstrapGuardianOwnerFactory, false);
  assert.equal("token" in composition.stardewBootstrapGuardianOwnerFactory, false);
  assert.equal("pid" in composition.stardewBootstrapGuardianOwnerFactory, false);
  assert.equal("path" in composition.stardewBootstrapGuardianOwnerFactory, false);
  const typedComposition: DesktopPrivateHostComposition = composition;
  assert.equal(typeof typedComposition.stardewBootstrapGuardianOwnerFactory.create, "function");
  await Promise.all([composition.close(), composition.close()]);
  assert.equal(closeCalls, 1);
});
