#!/usr/bin/env node
/**
 * The falsifier for `gates/arch/check-concurrency-hygiene.mjs`: four red proofs on copies of real Host modules.
 *
 * Every case builds a throwaway tree from COPIES of the modules the real reading is taken from
 * (`host/src/runtime-core.internal.ts`, `host/src/path-lock.ts`, the continuity semantic store, the Chat thread store),
 * injects one defect into a copy, and reads it through the gate's own exported reader - so what is asserted is the
 * finding the gate produces on the shape that shipped, not a shape written here to be found.
 *
 * The four injections are the four checks' failure modes:
 *
 *   `process.env.INJECTED = "1"` at module scope        -> `process_env_write_without_restore`
 *   `const injectedRegistry = new Map()` mutated        -> `module_registry_without_drain`
 *   `new DatabaseSync(path)` outside every container    -> `sqlite_connection_outside_a_factory`
 *   an `async` body handed to a `() => T` helper        -> `lock_body_escapes_the_critical_section`
 *
 * Beside them: the clean tree PASSES all four (a gate that cannot pass has no verdict to give), the two directions of
 * each declared table are exercised (a left-behind `releaseLocal()` and a missing identity guard; a row whose registry
 * is gone), and the CLI's 0/1/2 exit codes are asserted on the same trees.
 *
 * red-proof: inject  `process.env.INJECTED = "1"` at module scope in a copy of the real
 *   `host/src/runtime-core.internal.ts` -> `process_env_write_without_restore` naming that file, its line and the slot,
 *   exit 1, with only `process_global_writes_are_restored` red
 * red-proof: inject  a module-scope `const injectedRegistry = new Map()` mutated through `.set(...)` ->
 *   `module_registry_without_drain` naming the file and the name, while the drained `tails` map beside it is examined
 *   and passes
 * red-proof: inject  `new DatabaseSync(path)` in a function no container names -> `sqlite_connection_outside_a_factory`
 *   naming the file, the line and `injectedOpen`
 * red-proof: inject  `injectedSection(async () => undefined)` where `injectedSection<T>(work: () => T)` ->
 *   `lock_body_escapes_the_critical_section` at the call site and
 *   `sync_lock_body_without_thenable_rejection` on the helper
 * red-proof: inject  a doubled `releaseLocal()` and a `tails.delete` with the identity guard removed in a copy of the
 *   real `path-lock.ts` -> `lock_tail_released_more_than_once` and `lock_tail_deleted_without_identity_check`
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkConcurrencyHygiene, PATH_LOCK, reportDocument, TAIL_MAP } from "./check-concurrency-hygiene.mjs";

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), "check-concurrency-hygiene.mjs");
const REPOSITORY = resolve(dirname(GATE), "..", "..");

/** The real modules the fixture is built from: the two the readings are taken from, and the two stores. */
const COPIED = Object.freeze([
  "host/src/runtime-core.internal.ts",
  PATH_LOCK,
  "host/src/continuity-semantic-store/continuity-semantic-production-store.ts",
  "host/src/tavern/chat-thread-store.ts",
]);

/** A synchronous critical-section helper that refuses a thenable, so the clean tree has one of each family. */
const SECTION_HELPER = [
  "export function runSection<T>(work: () => T): T {",
  "  const value = work();",
  '  if (isThenable(value)) throw new Error("thenable_section");',
  "  return value;",
  "}",
  "",
].join("\n");

/** The tree every case starts from: copies of the real modules plus one declared synchronous helper. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "concurrency-hygiene-"));
  for (const file of COPIED) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(REPOSITORY, file), "utf8"));
  }
  writeFileSync(join(root, "host/src/sections.ts"), SECTION_HELPER);
  return root;
}

/** Append to a file of the fixture, so an injection reads as the addition it is. */
function append(root, file, text) {
  writeFileSync(join(root, file), `${readFileSync(join(root, file), "utf8")}\n${text}\n`);
}

/** Replace a file's text, for injections that have to remove something. */
function replace(root, file, pattern, replacement) {
  const source = readFileSync(join(root, file), "utf8");
  assert.ok(pattern.test(source), `${file} no longer contains the shape this injection edits`);
  writeFileSync(join(root, file), source.replace(pattern, replacement));
}

/** The codes the reading reported, in the order it reported them. */
const codesOf = (reading) => reading.findings.map((finding) => finding.code);

/** The one finding with a code, asserting there is exactly one so a second cannot hide behind it. */
function only(root, code) {
  const reading = checkConcurrencyHygiene({ root });
  const matching = reading.findings.filter((finding) => finding.code === code);
  assert.equal(matching.length, 1, `expected exactly one ${code}, got ${JSON.stringify(codesOf(reading))}`);
  return { reading, finding: matching[0] };
}

test("the clean tree passes all four checks and prints what it examined", () => {
  const root = fixture();
  try {
    const reading = checkConcurrencyHygiene({ root });
    assert.deepEqual(reading.findings, []);
    assert.equal(reading.status, "passed");
    assert.deepEqual(
      reading.checks.map((check) => check.id),
      [
        "process_global_writes_are_restored",
        "module_registries_are_bounded",
        "store_connections_are_opened_by_a_factory",
        "lock_bodies_and_signatures_agree",
      ],
    );
    assert.ok(reading.examined > 0, "a passing reading still names a population");
    // The four populations are each non-zero on this tree, so a passing verdict is a comparison rather than an
    // absent subject: this is the block-check in the passing direction.
    assert.ok(reading.process.production > 0);
    assert.ok(reading.registries.strong.length > 0);
    assert.ok(reading.connections.production > 0);
    assert.ok(reading.locks.helpers.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a process.env write with no restore is named at its own line, and only that check goes red", () => {
  const root = fixture();
  try {
    append(
      root,
      "host/src/runtime-core.internal.ts",
      ["export function injectedLeak(): void {", '  process.env.INJECTED = "1";', "}"].join("\n"),
    );
    const { reading, finding } = only(root, "process_env_write_without_restore");
    assert.match(finding.at, /^host\/src\/runtime-core\.internal\.ts:\d+$/u);
    assert.match(finding.detail, /INJECTED/u);
    assert.equal(reading.status, "failed");
    assert.equal(reading.checks.find((check) => check.id === "process_global_writes_are_restored").status, "failed");
    assert.equal(reading.checks.filter((check) => check.status === "failed").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a module-scope Map that is mutated and never drains is named, and a drained one is not", () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, "host/src/injected-registry.ts"),
      [
        "const injectedRegistry = new Map<string, string>();",
        "export function rememberInjected(key: string, value: string): void {",
        "  injectedRegistry.set(key, value);",
        "}",
        "",
      ].join("\n"),
    );
    const { reading, finding } = only(root, "module_registry_without_drain");
    assert.equal(finding.at, "host/src/injected-registry.ts:1");
    assert.match(finding.detail, /`injectedRegistry`/u);
    // `tails` in the same tree is mutated and DOES drain, so it is examined and passes - the rule is not "no maps".
    assert.ok(
      reading.registries.mutatedStrong.some((name) => name.endsWith(`:${TAIL_MAP}`)),
      "the drained registry is still part of the population",
    );
    assert.deepEqual(
      codesOf(reading).filter((code) => code !== "module_registry_without_drain"),
      [],
      "the injection reds only the check it belongs to",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a writable connection opened outside every declared factory is named with the function that opened it", () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, "host/src/injected-open.ts"),
      [
        'import { DatabaseSync } from "node:sqlite";',
        "export function injectedOpen(path: string) {",
        "  return new DatabaseSync(path);",
        "}",
        "",
      ].join("\n"),
    );
    const { reading, finding } = only(root, "sqlite_connection_outside_a_factory");
    assert.equal(finding.at, "host/src/injected-open.ts:3");
    assert.match(finding.detail, /injectedOpen/u);
    assert.match(finding.detail, /openProductionContinuityStore/u);
    assert.equal(
      reading.checks.find((check) => check.id === "store_connections_are_opened_by_a_factory").status,
      "failed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an async body handed to a synchronous helper escapes the section and is named at the call site", () => {
  const root = fixture();
  try {
    append(
      root,
      "host/src/sections.ts",
      [
        "export const injectedSection = <T>(work: () => T): T => work();",
        "export function injectedCaller(): unknown {",
        "  return injectedSection(async () => undefined);",
        "}",
      ].join("\n"),
    );
    const { reading, finding } = only(root, "lock_body_escapes_the_critical_section");
    assert.match(finding.at, /^host\/src\/sections\.ts:\d+$/u);
    assert.match(finding.detail, /`injectedSection`/u);
    const helper = only(root, "sync_lock_body_without_thenable_rejection");
    assert.match(helper.finding.detail, /`injectedSection`/u);
    assert.equal(reading.checks.find((check) => check.id === "lock_bodies_and_signatures_agree").status, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the tail protocol is read in both directions: a second release and a delete with no identity check", () => {
  const doubled = fixture();
  try {
    replace(doubled, PATH_LOCK, /(\n\s+)releaseLocal\(\);/u, "$1releaseLocal();$1releaseLocal();");
    const { finding } = only(doubled, "lock_tail_released_more_than_once");
    assert.match(finding.detail, /calls `releaseLocal\(\)` 2 time\(s\)/u);
  } finally {
    rmSync(doubled, { recursive: true, force: true });
  }

  const unguarded = fixture();
  try {
    replace(
      unguarded,
      PATH_LOCK,
      /\bif \(tails\.get\(target\) === tail\) tails\.delete\(target\);/u,
      "tails.delete(target);",
    );
    const { finding } = only(unguarded, "lock_tail_deleted_without_identity_check");
    assert.match(finding.detail, /`tails\.get\(…\) === tail`/u);
  } finally {
    rmSync(unguarded, { recursive: true, force: true });
  }
});

test("a declared registry row whose registry is gone is stale, so the table cannot outlive its subject", () => {
  const root = fixture();
  try {
    replace(
      root,
      "host/src/continuity-semantic-store/continuity-semantic-production-store.ts",
      /^const (?:expectedColumns|approvedTables|approvedIndexes|approvedDdl) = new Map.*$\n/gmu,
      "",
    );
    const reading = checkConcurrencyHygiene({ root });
    const stale = reading.findings.filter((finding) => finding.code === "stale_registry_declaration");
    assert.equal(stale.length, 4, `expected four stale rows, got ${JSON.stringify(codesOf(reading))}`);
    for (const finding of stale) assert.match(finding.at, /^host\/src\/continuity-semantic-store\//u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tree with no Host source, and one whose population is empty, BLOCK rather than pass", () => {
  const empty = mkdtempSync(join(tmpdir(), "concurrency-hygiene-empty-"));
  try {
    const reading = checkConcurrencyHygiene({ root: empty });
    assert.equal(reading.status, "blocked");
    assert.equal(reading.examined, 0);
    assert.match(reading.blocked.join("\n"), /concurrency_hygiene_no_host_source/u);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }

  const silent = mkdtempSync(join(tmpdir(), "concurrency-hygiene-silent-"));
  try {
    mkdirSync(join(silent, "host/src"), { recursive: true });
    writeFileSync(
      join(silent, "host/src/quiet.ts"),
      ["export function quiet(value: string): string {", "  return value;", "}", ""].join("\n"),
    );
    const reading = checkConcurrencyHygiene({ root: silent });
    assert.equal(reading.status, "blocked");
    const reasons = reading.blocked.join("\n");
    assert.match(reasons, /process_global_population_empty/u);
    assert.match(reasons, /module_scope_strong_population_empty/u);
    assert.match(reasons, /sqlite_connection_population_empty/u);
    assert.match(reasons, /lock_helper_population_empty/u);
    assert.match(reasons, /lock_tail_protocol_subject_missing/u);
  } finally {
    rmSync(silent, { recursive: true, force: true });
  }
});

test("the CLI exits 0 passed, 1 failed, 2 blocked, and prints one report document either way", () => {
  const passed = fixture();
  const failed = fixture();
  const blocked = mkdtempSync(join(tmpdir(), "concurrency-hygiene-cli-"));
  try {
    append(
      failed,
      "host/src/runtime-core.internal.ts",
      ["export function injectedLeak(): void {", '  process.env.INJECTED = "1";', "}"].join("\n"),
    );
    const run = (root, extra = []) =>
      spawnSync(process.execPath, [GATE, "--root", root, ...extra], { encoding: "utf8" });

    const green = run(passed);
    assert.equal(green.status, 0, green.stderr);
    const greenReport = JSON.parse(green.stdout.trim().split("\n").at(-1));
    assert.equal(greenReport.status, "passed");
    assert.ok(greenReport.examined > 0);

    const json = run(passed, ["--json"]);
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout), greenReport, "one reading, two invocations");
    assert.deepEqual(JSON.parse(json.stdout), reportDocument(checkConcurrencyHygiene({ root: passed })));

    const red = run(failed);
    assert.equal(red.status, 1, red.stderr);
    assert.match(red.stdout, /process_env_write_without_restore:/u);

    const empty = run(blocked);
    assert.equal(empty.status, 2, empty.stderr);
    assert.match(empty.stdout, /blocked: concurrency_hygiene_no_host_source/u);
  } finally {
    for (const root of [passed, failed, blocked]) rmSync(root, { recursive: true, force: true });
  }
});
