import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findViolations, isProductionSource, main } from "./check-error-identity-classification.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_SOURCE = join(REPOSITORY_ROOT, "host", "src");

/**
 * Writes a source tree under a throwaway root. Each fixture is a whole file, so
 * the checks below are the gate's own rule, not a hand-written expectation about
 * a real module.
 */
function withFixtureRoot(build) {
  const root = mkdtempSync(join(tmpdir(), "gb-error-identity-"));
  try {
    const files = build();
    for (const [relativePath, contents] of Object.entries(files)) {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    return { root, findings: findViolations({ root }) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("flags a cross-module comparison against another module's typed error message", () => {
  const { findings } = withFixtureRoot(() => ({
    "a.ts": 'export class FooFailedError extends Error {\n  constructor() {\n    super("foo_failed");\n  }\n}\n',
    "b.ts": 'export function classify(error: unknown): boolean {\n  return error instanceof Error && error.message === "foo_failed";\n}\n',
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "b.ts");
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].literal, "foo_failed");
  assert.equal(findings[0].definedIn, "a.ts");
});

test("flags a local copy of another module's typed error message", () => {
  const { findings } = withFixtureRoot(() => ({
    "a.ts": 'export class FooFailedError extends Error {\n  constructor() {\n    super("foo_failed");\n  }\n}\n',
    "b.ts":
      'export function classify(error: unknown): boolean {\n  const message = error instanceof Error ? error.message : "";\n  return message === "foo_failed";\n}\n',
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "b.ts");
  assert.equal(findings[0].line, 3);
  assert.equal(findings[0].form, "aliased-local");
  assert.equal(findings[0].local, "message");
  assert.equal(findings[0].literal, "foo_failed");
  assert.equal(findings[0].definedIn, "a.ts");
});

test("does not flag a local copy compared against a literal that is not an error identity", () => {
  const { findings } = withFixtureRoot(() => ({
    "b.ts": 'export function classify(error: Error): boolean {\n  const message = error.message;\n  return message === "not_an_identity";\n}\n',
  }));
  assert.deepEqual(findings, []);
});

test("does not follow an alias declared after the comparison", () => {
  const { findings } = withFixtureRoot(() => ({
    "a.ts": 'export class FooFailedError extends Error {\n  constructor() {\n    super("foo_failed");\n  }\n}\n',
    "b.ts": 'export function classify(error: Error): boolean {\n  const hit = message === "foo_failed";\n  const message = error.message;\n  return hit;\n}\n',
  }));
  assert.deepEqual(findings, []);
});

test("does not follow a local copy of a property other than .message", () => {
  const { findings } = withFixtureRoot(() => ({
    "a.ts": 'export class FooFailedError extends Error {\n  constructor() {\n    super("foo_failed");\n  }\n}\n',
    "b.ts": 'export function classify(error: { name: string }): boolean {\n  const label = error.name;\n  return label === "foo_failed";\n}\n',
  }));
  assert.deepEqual(findings, []);
});

test("does not flag a module matching its own typed error message", () => {
  const { findings } = withFixtureRoot(() => ({
    "a.ts":
      'export class FooFailedError extends Error {\n  constructor() {\n    super("foo_failed");\n  }\n}\nexport function classify(error: unknown): boolean {\n  return error.message === "foo_failed";\n}\n',
  }));
  assert.deepEqual(findings, []);
});

test("does not flag a literal that also has a bare Error producer", () => {
  const { findings } = withFixtureRoot(() => ({
    "a.ts":
      'export class AmbiguousError extends Error {\n  constructor() {\n    super("ambiguous_failed");\n  }\n}\nexport function alsoThrow(): never {\n  throw new Error("ambiguous_failed");\n}\n',
    "b.ts": 'export function classify(error: unknown): boolean {\n  return error instanceof Error && error.message === "ambiguous_failed";\n}\n',
  }));
  assert.deepEqual(findings, []);
});

test("does not flag comparison against a literal that is not an error identity", () => {
  const { findings } = withFixtureRoot(() => ({
    "a.ts": 'export function classify(error: unknown): boolean {\n  return error instanceof Error && error.message === "not_an_identity";\n}\n',
  }));
  assert.deepEqual(findings, []);
});

test("does not resolve a class whose message is a constructor argument", () => {
  const { findings } = withFixtureRoot(() => ({
    "a.ts":
      'export class CodeError extends Error {\n  constructor(readonly code: string) {\n    super(code);\n  }\n}\nexport function make(): never {\n  throw new CodeError("variable_message_failed");\n}\n',
    "b.ts": 'export function classify(error: unknown): boolean {\n  return error instanceof Error && error.message === "variable_message_failed";\n}\n',
  }));
  assert.deepEqual(findings, []);
});

test("production-source filter excludes committed tests and fixtures", () => {
  assert.equal(isProductionSource("tavern/chat-thread-store.ts"), true);
  assert.equal(isProductionSource("tavern/chat-thread-store.test.ts"), false);
  assert.equal(isProductionSource("tavern/loose.test-support.ts"), false);
  assert.equal(isProductionSource("test-support/helper.ts"), false);
  assert.equal(isProductionSource("test-fixtures/worker.ts"), false);
  assert.equal(isProductionSource("tavern/types.d.ts"), false);
});

test("the CLI reports the planted violation and exits non-zero", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-error-identity-cli-"));
  try {
    writeFileSync(
      join(root, "a.ts"),
      'export class FooFailedError extends Error {\n  constructor() {\n    super("foo_failed");\n  }\n}\n',
    );
    writeFileSync(join(root, "b.ts"), 'export const x = (error: Error): boolean => error.message === "foo_failed";\n');
    assert.equal(main([root]), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI reports the planted aliased violation and exits non-zero", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-error-identity-alias-"));
  try {
    writeFileSync(
      join(root, "a.ts"),
      'export class FooFailedError extends Error {\n  constructor() {\n    super("foo_failed");\n  }\n}\n',
    );
    writeFileSync(
      join(root, "b.ts"),
      'export const classify = (error: Error): boolean => {\n  const message = error.message;\n  return message === "foo_failed";\n};\n',
    );
    assert.equal(main([root]), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repository's host production sources carry no cross-module message classification", () => {
  assert.deepEqual(findViolations({ root: HOST_SOURCE }), []);
});
