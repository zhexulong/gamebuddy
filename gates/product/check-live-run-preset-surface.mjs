#!/usr/bin/env node
/**
 * Guard: the preset a Game live run mounts is the one that DECLARES itself the Game Surface's.
 *
 * WHY. `tools/live-run/core/persona.mjs` bound the run's generation preset by file name - `amber-deepseek-v4.1.json` -
 * and that file's own declaration reads 「琥珀 · DeepSeek-V4.1 星露谷伴侣预设」: it names a MODEL, not a surface. So
 * every Game run after that binding landed mounted a model-specific preset while `amber-game.json` - the preset whose
 * declaration ends 「(Game Surface)」 - never reached a run at all. The two are not interchangeable: the DeepSeek
 * preset's `main` entry carries the OTHER surface's instruction ("独立聊天界面（Chat Surface）：解除严格字数压制，放宽至
 * 50~100 字"), which is the opposite of the Game surface's 8~20 字 rule, and it is missing the Game preset's operating
 * sentences (「有新安排、阶段收工或搭档说话时再开麦」, 「深夜 01:30 催促一起回屋睡觉」). A run measured against a
 * preset it did not mount cannot be attributed to that preset, which is exactly the failure the freshness gate beside
 * this one exists to refuse one layer up.
 *
 * WHAT THE BINDING IS, AND WHY THIS GATE IS NOT TAUTOLOGICAL. The binding is one fact read from
 * `persona.mjs` (`liveRunPersonaPaths().presetPath` - the path provisioning copies to the runtime cwd as
 * `preset.json`); the declaration is another fact read from the bound file's own `name`/`description`. This gate pairs
 * them, so it stays red if the binding is named again, and it stays red if the preset the binding resolves stops
 * declaring this surface. The verdict is never "the derivation agrees with itself": the file it judges is the file the
 * run will mount.
 *
 * POPULATION. Every preset document under `assets/tavern/presets/*.json`, classified by its OWN declaration: a file
 * carrying `prompts` is a preset (a world book carries `entries` and is not one). The counts are printed -
 * `presets examined N · declare a surface M · declare none K` - because a file that declares nothing is the case that
 * produced this defect, and a run that examined zero presets agrees with itself.
 *
 * THE RULES, each printed as a `checks[]` entry so a refusal names which one broke:
 *   `live_run_uses_a_preset_for_another_surface:<file>:<declared>`  the bound file declares another surface, or none.
 *   `live_run_preset_surface_missing:<surface>`                     no preset declares the run's surface.
 *   `live_run_preset_surface_ambiguous:<surface>:<files>`           two presets claim it, so no single answer.
 *   `live_run_preset_not_in_population:<file>`                      the bound file is not a preset document here.
 *   `live_run_presets_population_empty`                             nothing was measured - BLOCKED, exit 2, never green.
 *
 * VERDICT. `status: "passed"` with exit 0, `"failed"` with exit 1 on any finding, `"blocked"` with exit 2 when the
 * population is empty or the directory cannot be read. A witness line (`presets examined ...`), the findings, a verdict
 * line and one JSON report are printed in that order.
 *
 * red-proof: inject `--binding assets/tavern/presets/amber-deepseek-v4.1.json` - the literal binding this gate was
 *   built for - -> `live_run_uses_a_preset_for_another_surface:amber-deepseek-v4.1.json:none`, exit 1, and the
 *   finding says the file's declaration names a model (tools/live-run/core/persona.test.mjs)
 * red-proof: fixture a synthetic presets directory with a `(Game Surface)` preset and a `(Chat Surface)` one, bound to
 *   the chat file -> `...:chat.json:Chat Surface`, exit 1; two presets claiming one surface ->
 *   `live_run_preset_surface_ambiguous`; a directory with no presets -> `live_run_presets_population_empty`, exit 2
 *   (tools/live-run/core/persona.test.mjs)
 *
 * WHY THE FALSIFIER IS IN THE PERSONA SUITE. This gate's cases live in `tools/live-run/core/persona.test.mjs`, the
 * file `suite:live-run-harness` runs. A suite beside this gate would be a falsifier nothing invokes - the red-proof
 * audit reports exactly that as `red_proof_nothing_runs`, and an unrun case is indistinguishable from a passing one.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LIVE_RUN_PRESETS_DIR,
  LIVE_RUN_SURFACE,
  readPresetDeclarations,
  resolveLiveRunGenerationPreset,
} from "../../tools/live-run/core/persona.mjs";

export const gateDeclaration = {
  id: "check-live-run-preset-surface",
  domain: "product",
  tier: "l1",
  kind: "contract",
};

/** The rules this gate can report red, in the order a reader wants them. */
export const RULES = Object.freeze([
  "live_run_uses_a_preset_for_another_surface",
  "live_run_preset_surface_missing",
  "live_run_preset_surface_ambiguous",
  "live_run_preset_surface_conflict",
  "live_run_preset_not_in_population",
  "live_run_presets_population_empty",
]);

/**
 * The reading. Never throws for a condition it can name: a caller that gets `status: "blocked"` must refuse.
 *
 * `bindingPath` is the file the run will mount. Omitted, it is the one the harness resolves from the presets' own
 * declarations; given, it is judged as-is - which is how the shipped binding is replayed without editing the harness.
 */
export function assessLiveRunPresetSurface({ presetsDir = LIVE_RUN_PRESETS_DIR, bindingPath } = {}) {
  const blocked = (reason) =>
    Object.freeze({
      status: "blocked",
      reason,
      presetsDir,
      examined: 0,
      declaredSurface: 0,
      declaredNone: 0,
      binding: null,
      bindingSurface: null,
      declarations: Object.freeze([]),
      findings: Object.freeze([]),
    });

  if (!existsSync(presetsDir)) return blocked(`presets_dir_missing:${presetsDir}`);
  let declarations;
  try {
    declarations = readPresetDeclarations({ presetsDir });
  } catch (error) {
    return blocked(String(error?.message ?? error));
  }
  if (declarations.length === 0) return blocked("presets_population_empty");

  const findings = [];
  const finding = (code, id, detail) => findings.push(Object.freeze({ code, id, detail }));
  const declaredSurface = declarations.filter((entry) => entry.surfaces.length > 0).length;
  for (const entry of declarations)
    if (entry.surfaces.length > 1)
      finding(
        "live_run_preset_surface_conflict",
        entry.file,
        `declares ${entry.surfaces.join("+")} - one preset, one surface, or the binding is a guess`,
      );

  const binding = bindingPath === undefined ? resolvedBinding({ presetsDir, finding }) : path.resolve(bindingPath);
  const bindingSurface = binding === null ? null : judgeBinding({ binding, presetsDir, declarations, finding });

  return Object.freeze({
    status: findings.length === 0 ? "passed" : "failed",
    reason: null,
    presetsDir,
    examined: declarations.length,
    declaredSurface,
    declaredNone: declarations.length - declaredSurface,
    binding: binding === null ? null : path.relative(presetsDir, binding).replace(/\\/gu, "/"),
    bindingSurface,
    declarations,
    findings: Object.freeze(findings),
  });
}

/**
 * The file the harness will mount, or null with the reason recorded as a finding.
 *
 * The resolver's own refusals are this gate's findings, not its crashes. Its message already names what every preset
 * in the directory declares, so the file that names a model is in the refusal rather than inferred from it.
 */
function resolvedBinding({ presetsDir, finding }) {
  try {
    return resolveLiveRunGenerationPreset({ presetsDir }).path;
  } catch (error) {
    const detail = String(error?.message ?? error).replace(/^[^:]+:/u, "");
    const [head, ...rest] = detail.split(" - ");
    if (error?.code === "live_run_generation_preset_ambiguous")
      finding("live_run_preset_surface_ambiguous", head, rest.join(" - "));
    else finding("live_run_preset_surface_missing", LIVE_RUN_SURFACE, detail);
    return null;
  }
}

/**
 * The surface the bound file declares, paired against the surface this harness runs - the whole gate in one place.
 *
 * A file that is not a preset document is refused too: `--binding` naming a world book must not be excused by the
 * file existing, only by declaring this surface.
 */
function judgeBinding({ binding, presetsDir, declarations, finding }) {
  const file = path.basename(binding);
  const entry = declarations.find((candidate) => candidate.file === file);
  if (entry === undefined) {
    finding(
      "live_run_preset_not_in_population",
      file,
      `the run mounts ${binding}, which is not a preset document under ${presetsDir}`,
    );
    return null;
  }
  if (entry.surfaces.includes(LIVE_RUN_SURFACE)) return entry.surfaces.length === 1 ? entry.surfaces[0] : null;
  const declared = entry.surfaces.length === 0 ? "none" : entry.surfaces.join("+");
  const detail =
    entry.surfaces.length === 0
      ? `the run mounts ${file}, whose declaration is ${JSON.stringify(entry.name)} - it names a model, not a surface, so nothing says it is the ${LIVE_RUN_SURFACE}'s`
      : `the run mounts ${file}, which declares ${declared} while the run is the ${LIVE_RUN_SURFACE}`;
  finding("live_run_uses_a_preset_for_another_surface", `${file}:${declared}`, detail);
  return entry.surfaces.length === 1 ? entry.surfaces[0] : null;
}

/** The one-line population census. `K` is a real bucket: a preset that declares nothing is the defect's own shape. */
export const censusLine = (assessment) =>
  `presets examined ${assessment.examined} · declare a surface ${assessment.declaredSurface} · declare none ${assessment.declaredNone}`;

/** The report a harness reads. `population` is the count above, so `passed` beside a zero is not a measurement. */
export function buildReport(assessment) {
  const head = assessment.binding === null ? "unresolved" : assessment.binding;
  const declared = assessment.bindingSurface === null ? "" : ` (${assessment.bindingSurface})`;
  const checks = [
    {
      id: "presets_declare_a_surface",
      status: censusStatus(assessment),
      detail:
        assessment.status === "blocked"
          ? (assessment.reason ?? "not measured")
          : `${censusLine(assessment)} · binding ${head}${declared}`,
    },
  ];
  for (const rule of RULES) {
    const members = assessment.findings.filter((finding) => finding.code === rule);
    checks.push({
      id: rule,
      status: ruleStatus({ assessment, rule, members }),
      detail:
        members.length === 0 ? "0 member(s)" : members.map((finding) => `${finding.id} - ${finding.detail}`).join("; "),
    });
  }
  return {
    gate: "live_run_preset_surface/v1",
    status: assessment.status,
    ...(assessment.reason === null ? {} : { reason: assessment.reason }),
    population: assessment.examined,
    examined: assessment.examined,
    declaredSurface: assessment.declaredSurface,
    declaredNone: assessment.declaredNone,
    binding: assessment.binding,
    bindingSurface: assessment.bindingSurface,
    checks,
    findings: assessment.findings.map((finding) => ({ code: finding.code, id: finding.id, detail: finding.detail })),
  };
}

function censusStatus(assessment) {
  if (assessment.status === "blocked") return "blocked";
  return assessment.declaredSurface === 0 ? "failed" : "passed";
}

function ruleStatus({ assessment, rule, members }) {
  if (rule === "live_run_presets_population_empty")
    return assessment.reason === "presets_population_empty" ? "blocked" : "passed";
  if (assessment.status === "blocked") return "not_measured";
  return members.length > 0 ? "failed" : "passed";
}

/** 0 passed, 1 failed, 2 blocked - and an empty population is never 0. */
function exitCodeFor(status) {
  if (status === "passed") return 0;
  return status === "blocked" ? 2 : 1;
}

function verdictLine(assessment) {
  if (assessment.status === "passed")
    return `live_run_preset_surface: passed - ${assessment.binding} declares ${assessment.bindingSurface}`;
  if (assessment.status === "blocked")
    return "live_run_preset_surface: blocked - a run whose preset cannot be shown to be this surface's cannot be attributed";
  return `live_run_preset_surface: failed - ${assessment.findings.length} finding(s)`;
}

/** `node tools/check-live-run-preset-surface.mjs [--presets-dir DIR] [--binding FILE] [--json]` */
async function main(argv) {
  const argument = (name, fallback = undefined) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
  };
  const presetsDir = path.resolve(argument("--presets-dir", LIVE_RUN_PRESETS_DIR));
  const bindingPath = argument("--binding", undefined);
  const assessment = assessLiveRunPresetSurface({
    presetsDir,
    ...(bindingPath === undefined ? {} : { bindingPath }),
  });
  const report = buildReport(assessment);

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return exitCodeFor(assessment.status);
  }

  process.stdout.write(`${censusLine(assessment)}\n`);
  for (const finding of assessment.findings)
    process.stdout.write(`${finding.code}:${finding.id} - ${finding.detail}\n`);
  if (assessment.reason !== null) process.stdout.write(`live_run_preset_surface_not_measured:${assessment.reason}\n`);
  process.stdout.write(`${verdictLine(assessment)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return exitCodeFor(assessment.status);
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2));
