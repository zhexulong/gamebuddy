import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assessLiveRunPresetSurface,
  buildReport,
  censusLine,
  gateDeclaration,
  RULES,
} from "./check-live-run-preset-surface.mjs";
import { assertNonVacuous } from "./lib/assert-non-vacuous.mjs";
import {
  LIVE_RUN_PRESETS_DIR,
  LIVE_RUN_SURFACE,
  readPresetDeclarations,
  resolveLiveRunGenerationPreset,
} from "./live-run/core/persona.mjs";

/**
 * The guard this suite is the falsifier for.
 *
 * `tools/live-run/core/persona.mjs` bound the live run's generation preset by name - `amber-deepseek-v4.1.json` - whose
 * own declaration reads 「琥珀 · DeepSeek-V4.1 星露谷伴侣预设」: a model, not a surface. Every Game run mounted it while
 * `amber-game.json`, the preset that declares 「(Game Surface)」, never reached a run. The gate pairs the file the run
 * mounts against that file's own declaration; this suite turns it red on the shipped binding, on a preset declaring the
 * other surface, on two presets claiming one surface, on a directory that declares the run's surface nowhere, and on a
 * directory with no presets at all (which must be BLOCKED, never green).
 */

const GATE = fileURLToPath(new URL("check-live-run-preset-surface.mjs", import.meta.url));

/** The reviewable manifest a preset is, reduced to the two fields a declaration is read from. */
const preset = (name, description = "") =>
  JSON.stringify({ name, description, prompts: [], prompt_order: [] }, null, 2);

/** A world book is not a preset: it carries `entries` and no `prompts`. */
const worldbook = () => JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2);

function syntheticPresets(files) {
  const dir = mkdtempSync(join(tmpdir(), "preset-surface-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, "utf8");
  return dir;
}

function runGate(argv) {
  const result = spawnSync(process.execPath, [GATE, ...argv], { encoding: "utf8" });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

test("the declaration this gate is filed under keeps it in the one gate registry", () => {
  // The registry refuses `gate_declaration_invalid:<path>:id` unless the id is the file's slug, and a gate whose
  // declaration drifts out of the closed sets leaves the population silently - so the pairing is asserted, not assumed.
  assert.equal(gateDeclaration.id, "check-live-run-preset-surface");
  assert.equal(gateDeclaration.domain, "product");
  assert.equal(gateDeclaration.tier, "l1");
  assert.equal(gateDeclaration.kind, "contract");
});

test("the real tree: the run mounts the preset whose own declaration is the Game surface's", () => {
  const assessment = assessLiveRunPresetSurface();
  const declarations = readPresetDeclarations();
  assert.equal(assessment.status, "passed", JSON.stringify(assessment.findings));
  // Derived, not pinned to a count: the population is every preset document in the reviewed directory.
  assert.equal(assessment.examined, declarations.length);
  assert.equal(assessment.declaredSurface + assessment.declaredNone, assessment.examined);
  assert.ok(assessment.examined > 0);
  // The two halves of the pair, from their own authorities: the file the harness copies, and that file's declaration.
  const resolved = resolveLiveRunGenerationPreset();
  assert.equal(assessment.binding, resolved.file);
  assert.equal(assessment.bindingSurface, LIVE_RUN_SURFACE);
  assert.equal(assessment.declaredNone, declarations.filter((entry) => entry.surfaces.length === 0).length);
  // The file that produced the defect is IN the "declares none" bucket and is classified by its own text, so a reader
  // of the census sees the model-named preset rather than a number that hides it.
  const silent = declarations.filter((entry) => entry.surfaces.length === 0);
  assert.ok(
    silent.some((entry) => entry.surfaces.length === 0 && entry.name !== null),
    `examined ${declarations.length} preset(s): every one that declares no surface must still carry the name that says why`,
  );
  assert.equal(
    declarations.filter((entry) => entry.surfaces.includes(LIVE_RUN_SURFACE)).length,
    1,
    `exactly one preset may declare ${LIVE_RUN_SURFACE}`,
  );
});

test("RED on the shipped binding: the model-named preset the lane replaced is refused by name", () => {
  // The literal `tools/live-run/core/persona.mjs` carried. Nothing is edited to replay it: the gate judges the binding
  // it is given, which is what makes this the falsifier for the gate rather than a restatement of the fix.
  const shipped = join(LIVE_RUN_PRESETS_DIR, "amber-deepseek-v4.1.json");
  const assessment = assessLiveRunPresetSurface({ bindingPath: shipped });
  assert.equal(assessment.status, "failed");
  assert.deepEqual(
    assessment.findings.map((finding) => `${finding.code}:${finding.id}`),
    ["live_run_uses_a_preset_for_another_surface:amber-deepseek-v4.1.json:none"],
  );
  // The finding says WHY none: a declaration naming a model is the case that shipped, and a bare "none" would send the
  // next reader to the file to re-derive that.
  assert.match(assessment.findings[0].detail, /names a model, not a surface/u);
  assert.match(assessment.findings[0].detail, /DeepSeek-V4\.1/u);
});

test("RED when the bound preset declares the other surface", () => {
  const dir = syntheticPresets({
    "game.json": preset("琥珀 (Game Surface)"),
    "chat.json": preset("琥珀 (Chat Surface)"),
  });
  try {
    const assessment = assessLiveRunPresetSurface({ presetsDir: dir, bindingPath: join(dir, "chat.json") });
    assert.equal(assessment.status, "failed");
    assert.deepEqual(
      assessment.findings.map((finding) => `${finding.code}:${finding.id}`),
      ["live_run_uses_a_preset_for_another_surface:chat.json:Chat Surface"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RED when two presets claim the run's surface, and when none does", () => {
  const ambiguous = syntheticPresets({
    "game-a.json": preset("琥珀 (Game Surface)"),
    "game-b.json": preset("第二版 (Game Surface)"),
  });
  const missing = syntheticPresets({ "chat.json": preset("琥珀 (Chat Surface)"), "book.json": worldbook() });
  try {
    const both = assessLiveRunPresetSurface({ presetsDir: ambiguous });
    assert.equal(both.status, "failed");
    assert.equal(both.findings[0].code, "live_run_preset_surface_ambiguous");
    assert.equal(both.findings[0].id, "Game Surface:game-a.json,game-b.json");
    // A refusal that says "ambiguous" and not WHICH presets, and what each declares, sends the next reader to the
    // directory to re-derive the one fact the gate already had.
    assert.match(both.findings[0].detail, /game-a\.json declares Game Surface/u);
    assert.match(both.findings[0].detail, /game-b\.json declares Game Surface/u);

    // A world book is not a preset, so this directory's population is one preset that declares the other surface: the
    // run's surface is declared nowhere and the gate must say so rather than fall back to the only file it can see.
    const none = assessLiveRunPresetSurface({ presetsDir: missing });
    assert.equal(none.status, "failed");
    assert.equal(none.examined, 1, "a world book must not join the preset population");
    assert.equal(none.findings[0].code, "live_run_preset_surface_missing");
    assert.match(none.findings[0].detail, /chat\.json declares Chat Surface/u);
  } finally {
    rmSync(ambiguous, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
  }
});

test("RED on a preset that declares two surfaces, and on a bound file that is not a preset at all", () => {
  const dir = syntheticPresets({
    "both.json": preset("双表面预设 (Game Surface) (Chat Surface)"),
    "book.json": worldbook(),
  });
  try {
    const conflict = assessLiveRunPresetSurface({ presetsDir: dir, bindingPath: join(dir, "both.json") });
    const conflictFinding = conflict.findings.find((entry) => entry.code === "live_run_preset_surface_conflict");
    assert.notEqual(conflictFinding, undefined, JSON.stringify(conflict.findings));
    assert.equal(conflictFinding.id, "both.json");
    // `book.json` is a real file in the directory but not a preset document: the binding must not be excused by being
    // present, only by declaring this surface.
    const notPreset = assessLiveRunPresetSurface({ presetsDir: dir, bindingPath: join(dir, "book.json") });
    const notPresetFinding = notPreset.findings.find((entry) => entry.code === "live_run_preset_not_in_population");
    assert.notEqual(notPresetFinding, undefined, JSON.stringify(notPreset.findings));
    assert.equal(notPresetFinding.id, "book.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BLOCKED, not green, on a directory with no presets at all", () => {
  const dir = syntheticPresets({ "book.json": worldbook() });
  try {
    const assessment = assessLiveRunPresetSurface({ presetsDir: dir });
    assert.equal(assessment.status, "blocked");
    assert.equal(assessment.reason, "presets_population_empty");
    assert.equal(assessment.examined, 0);
    const missingDir = join(dir, "absent");
    assert.equal(assessLiveRunPresetSurface({ presetsDir: missingDir }).status, "blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the report is a measurement a harness can refuse on, and the CLI's exit code follows the verdict", () => {
  const assessment = assessLiveRunPresetSurface();
  const report = buildReport(assessment);
  assert.equal(report.status, "passed");
  assert.equal(report.population, assessment.examined);
  assert.ok(report.checks.length >= RULES.length);
  // The shared judge, not a restatement of it: `passed` beside a zero population is not a measurement.
  assert.notEqual(assertNonVacuous(report).status, "blocked");
  for (const rule of RULES)
    assert.ok(
      report.checks.some((check) => check.id === rule),
      `${rule} has no verdict entry`,
    );
  assert.match(censusLine(assessment), /^presets examined \d+ · declare a surface \d+ · declare none \d+$/u);

  const green = runGate([]);
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /^presets examined \d+ · declare a surface \d+ · declare none \d+$/mu);

  const red = runGate(["--binding", join(LIVE_RUN_PRESETS_DIR, "amber-deepseek-v4.1.json")]);
  assert.equal(red.status, 1, red.stdout);
  assert.match(red.stdout, /^live_run_uses_a_preset_for_another_surface:amber-deepseek-v4\.1\.json:none/mu);

  const empty = syntheticPresets({ "book.json": worldbook() });
  try {
    const blocked = runGate(["--presets-dir", empty, "--json"]);
    assert.equal(blocked.status, 2, blocked.stdout);
    assert.equal(JSON.parse(blocked.stdout).status, "blocked");
    assert.equal(JSON.parse(blocked.stdout).population, 0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
