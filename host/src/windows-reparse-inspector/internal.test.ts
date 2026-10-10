import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { createInspectorCapability, inspectorState, type SpawnHelper } from "./internal.js";
import { inspectWindowsReparse } from "./index.js";

const spawnHelper: SpawnHelper = ((() => {
  throw new Error("test-only-helper-must-not-spawn");
}) as unknown) as SpawnHelper;

/**
 * The regression this pins: the production build holds two instances of this module
 * (the artifact builder imports the staged adapter, and the browser build's config
 * loader bundles its own copy). A capability minted by one instance must be
 * recognised by the other, or every path inspection is refused and the browser build
 * fails with `windows_reparse_inspection_unavailable` for no real reason.
 */
test("a capability minted by one module instance is recognised by another instance", async () => {
  const first = await import("./internal.js");
  const duplicateSpecifier: string = "./internal.js?duplicate-instance";
  const second = (await import(duplicateSpecifier)) as typeof first;
  assert.notEqual(first, second, "the two imports must be distinct module instances");

  const state = { executable: "C:\\test\\helper.exe", spawnHelper } as const;
  const capability = first.createInspectorCapability(state);
  const seen = second.inspectorState(capability);
  assert.equal(seen?.executable, state.executable);
  assert.equal(seen?.spawnHelper, state.spawnHelper);
});

/** The capability must stay an opaque token: nothing enumerable, nothing serialisable. */
test("the capability exposes no enumerable state", () => {
  const capability = createInspectorCapability({ executable: "C:\\test\\helper.exe", spawnHelper });
  assert.equal(Object.isFrozen(capability), true);
  assert.deepEqual(Object.keys(capability), []);
  assert.deepEqual(Object.getOwnPropertyNames(capability), []);
  assert.equal(JSON.stringify(capability), "{}");
  assert.deepEqual({ ...capability }, {});
});

/** Anything that is not a capability this module minted must be refused, not trusted. */
test("a forged or malformed capability yields no state and is refused by the inspector", async () => {
  const state = inspectorState({} as object);
  assert.equal(state, undefined);
  assert.equal(inspectorState(undefined), undefined);

  // A plain object carrying the same global symbol but an unusable state is refused.
  const forged: Record<symbol, unknown> = {};
  Object.defineProperty(forged, Symbol.for("gamebuddy.windows-reparse-inspector.state.v1"), {
    value: { executable: 7, spawnHelper: "not-a-function" },
    enumerable: false,
  });
  assert.equal(inspectorState(forged), undefined);

  // And the inspector itself fails closed rather than pretending the path is fine.
  await assert.rejects(
    inspectWindowsReparse(forged as object, resolve("absolute", "test-path")),
    /windows_reparse_inspection_unavailable/,
  );
});

/** A malformed state cannot be minted into a capability in the first place. */
test("creating a capability from an unusable state is refused", () => {
  assert.throws(
    () => createInspectorCapability({ executable: "x" } as never),
    /windows_reparse_inspector_state_invalid/,
  );
  assert.throws(
    () => createInspectorCapability({ executable: 1, spawnHelper } as never),
    /windows_reparse_inspector_state_invalid/,
  );
});
