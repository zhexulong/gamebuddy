/**
 * The proofs for `tools/check-stale-line-age.mjs`, one per way the gate can be wrong.
 *
 * <p>
 * Every case here was red once on a real injected violation, not on a shape somebody imagined. The injections are the
 * two halves of the round75 defect: the renderer that prints the reading's count and the composition that never hands it
 * a fresher one. A gate that only checked the first would stay green with the second in place, which is the silence
 * wearing more code - so the wiring is its own member and its own proof.
 * </p>
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditStaleLines, COMPOSER_SOURCE, PROTOCOL_SOURCE, VOCABULARY_SOURCE } from "./check-stale-line-age.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPOSITORY_ROOT, "tools", "check-stale-line-age.mjs");

const readReal = (relative) => readFileSync(join(REPOSITORY_ROOT, ...relative.split("/")), "utf8");

/** A throwaway tree at the real relative paths, so the gate reads the product's own file names. */
function withFixtureRoot(specs, run) {
  const root = mkdtempSync(join(tmpdir(), "stale-line-age-"));
  try {
    for (const [relativePath, contents] of Object.entries(specs)) {
      const path = join(root, ...relativePath.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The real tree, with one file replaced: the smallest fixture that is still the product's own declaration. */
function withComposer(contents, run) {
  return withFixtureRoot(
    {
      [COMPOSER_SOURCE]: contents,
      [PROTOCOL_SOURCE]: readReal(PROTOCOL_SOURCE),
      [VOCABULARY_SOURCE]: readReal(VOCABULARY_SOURCE),
    },
    run,
  );
}

const runGate = (root) => {
  const result = spawnSync(process.execPath, [GATE, "--root", root, "--json"], {
    encoding: "utf8",
    cwd: REPOSITORY_ROOT,
  });
  const report = result.stdout.trim() === "" ? { violations: [] } : JSON.parse(result.stdout);
  return { status: result.status, codes: (report.violations ?? []).map((violation) => violation.code), result };
};

test("the real tree passes, and it examined a population rather than nothing", () => {
  const reading = auditStaleLines();
  assert.equal(
    reading.status,
    "passed",
    `violations: ${reading.violations.map((violation) => violation.code).join(", ")}`,
  );
  assert.ok(reading.examined >= 1, "a gate with no population agrees with itself");
  assert.ok(
    reading.reemitted >= 1,
    `the pack lines consult the delivery's proof: ${JSON.stringify(reading.dispositions)}`,
  );
  assert.equal(reading.canGoStale, 0);
});

test("red: a pack renderer that prints the reading's count and no proof is named by the line it composes", () => {
  // THE INJECTION IS THE PRE-FIX BODY, verbatim from the commit this gate was written in: the count straight out of
  // `heldCount`, no `freshness`, no age. This is what shipped for fifty turns.
  const before = readReal(COMPOSER_SOURCE);
  const start = before.indexOf("function formatHeldSeeds(");
  assert.ok(start > 0, "the renderer this proof injects into is declared");
  const end = before.indexOf("\n}\n", start);
  assert.ok(end > start, "the renderer's body is closed");
  const prefix = before.slice(0, start);
  const suffix = before.slice(end + 3);
  const shallow = [
    "function formatHeldSeeds(world: Snapshot): string {",
    "  const rows = world.seedSupplyTargets;",
    '  if (!Array.isArray(rows)) return "";',
    '  if (rows.length === 0) return "种子: 0（背包里没有种子）";',
    "  const seeds: string[] = [];",
    "  const seen = new Set<string>();",
    "  for (const row of rows) {",
    "    if (seen.has(row.qualifiedItemId)) continue;",
    "    seen.add(row.qualifiedItemId);",
    "    const name =",
    '      typeof row.displayName === "string" && row.displayName.trim() !== ""',
    "        ? row.displayName.trim()",
    "        : row.qualifiedItemId;",
    "    seeds.push(Number.isFinite(row.heldCount) ? `${String(row.heldCount)} ${name}` : `${name}（数量未测）`);",
    "  }",
    '  return `种子: ${seeds.join("、")}`;',
    "}",
    "",
  ].join("\n");
  withComposer(`${prefix}${shallow}${suffix}`, (root) => {
    const { status, codes } = runGate(root);
    assert.equal(status, 1, "the gate fails on the pre-fix renderer");
    assert.ok(
      codes.includes("a_line_can_go_stale_without_saying_so:formatHeldSeeds"),
      `the violation names the renderer: ${codes.join(", ")}`,
    );
  });
});

test("red: dropping the proof from the composition is its own member, not covered by the renderer", () => {
  // A renderer that reads a map nobody filled is the same silence with more code, so the wiring must fail on its own.
  const before = readReal(COMPOSER_SOURCE);
  const wired = "composeWorldState(input.snapshot, provedPackCounts(input.events))";
  assert.ok(before.includes(wired), "the composition hands the proof to the block today");
  withComposer(before.replace(wired, "composeWorldState(input.snapshot)"), (root) => {
    const { status, codes } = runGate(root);
    assert.equal(status, 1, "the gate fails on an unwired proof");
    assert.ok(
      codes.includes("pack_proof_not_wired:composeFactBrief"),
      `the wiring is its own member: ${codes.join(", ")}`,
    );
  });
});

test("red: a second pack line added to the block joins the gate without an edit here", () => {
  // THE FUTURE MEMBER. A renderer that prints a pack count is a pack line the day it is pushed, so the population cannot
  // silently narrow to the two lines that exist today.
  const before = readReal(COMPOSER_SOURCE);
  const marker = '  const seeds = formatHeldSeeds(world, freshness);\n  if (seeds !== "") parts.push(seeds);';
  assert.ok(before.includes(marker), "the block's seed line is where this proof appends beside");
  const injected = [marker, "  const pads = formatSeedPads(world);", '  if (pads !== "") parts.push(pads);'].join("\n");
  const renderer = [
    "function formatSeedPads(world: Snapshot): string {",
    "  const rows = world.seedSupplyTargets;",
    '  return Array.isArray(rows) ? String(rows.length) : "";',
    "}",
    "",
  ].join("\n");
  withComposer(`${before.replace(marker, injected)}\n${renderer}`, (root) => {
    const { status, codes } = runGate(root);
    assert.equal(status, 1, "the new line is judged");
    assert.ok(
      codes.includes("a_line_can_go_stale_without_saying_so:formatSeedPads"),
      `the new renderer joins the population: ${codes.join(", ")}`,
    );
  });
});

test("red: a block with no line to judge is blocked, never green", () => {
  const before = readReal(COMPOSER_SOURCE);
  const start = before.indexOf("export function composeWorldState(");
  const end = before.indexOf("\n}\n", start);
  assert.ok(start > 0 && end > start, "the composer is declared");
  const emptied = [
    "export function composeWorldState(reading: WorldStateReading | undefined): string {",
    '  return reading === undefined ? "" : "";',
    "}",
    "",
  ].join("\n");
  withComposer(`${before.slice(0, start)}${emptied}${before.slice(end + 3)}`, (root) => {
    const { status } = runGate(root);
    assert.equal(status, 2, "an empty population is blocked, not green");
  });
});
