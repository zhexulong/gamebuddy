#!/usr/bin/env node
/**
 * Surface gate: every surface the product declares needs at least one journey that asserts on it.
 *
 * WHY (measured 2026-11-04)
 *
 * `frontend-coverage-surface.md` ranks its uncovered surface by line count, and its first lesson is
 * that "no spec" reads as 0% and gets ignored: `management-pipeline-session.ts` was 408 lines, imported
 * by nothing, and reached by no journey - a whole surface of behaviour with no test, which a percentage
 * cannot make anyone look at. The population that is missing is not modules but SURFACES: the shell's
 * own union of panels. A surface nobody drives is not a low number, it is an untested product area, and
 * it should fail the build the moment it is added.
 *
 * THE POPULATION comes from the product, twice over, and never from a list here:
 *
 *   * the surfaces are the `export const *_PANEL = "..." as const` declarations of
 *     `dialogue-web/src/composed-surface-route.ts`, which is what the URL, the switcher and every
 *     `shownSurface === X` guard in the shell agree on;
 *   * the DOM each surface owns is derived from the shell: `{shownSurface === X && (<Component` and
 *     `<Component ... selected={shownSurface === X}` name the component that renders that surface, and
 *     that component's own test ids plus its direct relative imports' ids are its vocabulary.
 *
 * A test id two surfaces both render cannot witness either of them - the shared management panel
 * supplies the same controls to four surfaces - so shared ids are removed from attribution and printed
 * as `unassessed:` lines. What is left is the vocabulary that names one surface, and a surface is
 * reached when a mounted journey's assertion mentions one of those ids.
 *
 * ASSERTION, not mention: the id has to appear inside an `expect(...)` call (tools/lib/journey-source.mjs
 * reads those), because a journey that only clicks a control has not said what the player sees.
 *
 * WHY NOT `tests/frontend-coverage-report.mjs`: that gate measures LINE coverage from a browser run -
 * which journeys loaded which module. It cannot answer this question. A journey that opens a panel and
 * asserts nothing covers lines and would pass it; and it needs a mounted run, while this gate must run in
 * the install-free derived gates job. The two readings are different questions about the same corpus, not
 * two meters over one.
 *
 * Usage:
 *   node tools/check-surface-journeys.mjs           # the verdict; exit 1 on a surface no journey reaches
 *   node tools/check-surface-journeys.mjs --json    # every surface with its ids and witnesses
 *   node tools/check-surface-journeys.mjs --root <dir>   # the gate's own fixture
 *
 * red-proof: inject  a declared surface added to a synthetic tree's panel union with no journey asserting
 *            on it -> `surface_without_journey` names it, while the same tree with an assertion on one of
 *            its ids is green (tools/check-surface-journeys.test.mjs). Also injected: a panel declared but
 *            never rendered by the shell (`surface_without_component`), a journey that only CLICKS the
 *            surface's control without asserting on it (still `surface_without_journey`), and a panel
 *            union that cannot be read (`surface_population_unassessable`, never a silent pass).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertionsOf, journeySpecs, parseTests } from "./lib/journey-source.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE_SOURCE = "dialogue-web/src/composed-surface-route.ts";
const SHELL_SOURCE = "dialogue-web/src/components/ComposedReferenceGameApp.tsx";
/** A literal test id. `data-testid={testId}` forwards a variable and names no id of its own here. */
const TEST_ID = /(?:data-testid|testId)=(["`])([^"`]+)\1/gu;

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** The surface union the shell switches on: `export const GAME_PANEL = "game" as const`. */
export function declaredSurfaces(root) {
  const source = read(join(root, ROUTE_SOURCE));
  if (source === null) return null;
  return [...source.matchAll(/export const (\w+_PANEL)\s*=\s*"([\w-]+)" as const/gu)].map((match) => ({
    constant: match[1],
    id: match[2],
  }));
}

/** The module a name is imported from in one file, resolved to a path with its extension. */
function importedModule(root, file, name) {
  const source = read(join(root, file));
  if (source === null) return null;
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/gu)) {
    const names = match[1].split(",").map((entry) => entry.trim().split(/\s+as\s+/u)[0]);
    if (!names.includes(name)) continue;
    const base = join(dirname(file), match[2]);
    for (const candidate of [`${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
      if (existsSync(join(root, candidate))) return candidate.split("\\").join("/");
    }
    return null;
  }
  return null;
}

/** The component the shell renders for each surface constant, read from its own guards. */
export function surfaceComponents(root) {
  const source = read(join(root, SHELL_SOURCE));
  if (source === null) return new Map();
  const components = new Map();
  // The parentheses are style, not meaning: `{cond && (<Panel />)}` and `{cond && <Panel />}` are the same guard, and
  // requiring the paren made this reader blind to a surface that was in fact guarded and rendered.
  for (const match of source.matchAll(/\{shownSurface === (\w+_PANEL) && \(?\s*<(\w+)/gu)) {
    components.set(match[1], match[2]);
  }
  // A surface rendered unconditionally and told which one is selected is the same fact, written once.
  for (const match of source.matchAll(/<(\w+)\s[^>]*?selected=\{shownSurface === (\w+_PANEL)\}/gu)) {
    components.set(match[2], match[1]);
  }
  return components;
}

/** Every test id a module renders, plus those of the modules it imports directly. */
function vocabularyOf(root, file) {
  const source = read(join(root, file));
  if (source === null) return { ids: new Set(), files: [] };
  const ids = new Set([...source.matchAll(TEST_ID)].map((match) => match[2]));
  const files = [file];
  for (const match of source.matchAll(/from "(\.[^"]+)"/gu)) {
    const base = join(dirname(file), match[1]);
    for (const candidate of [`${base}.tsx`, `${base}.ts`]) {
      if (!existsSync(join(root, candidate))) continue;
      const imported = candidate.split("\\").join("/");
      files.push(imported);
      for (const id of read(join(root, imported)).matchAll(TEST_ID)) ids.add(id[2]);
    }
  }
  return { ids, files };
}

/**
 * The whole reading: each declared surface, the ids that name only it, and the journeys that assert on
 * them. `unreached` is the finding set; `shared` is the vocabulary that cannot witness one surface.
 */
export function auditSurfaceJourneys({ root = REPOSITORY_ROOT } = {}) {
  const surfaces = declaredSurfaces(root);
  if (surfaces === null || surfaces.length === 0) {
    return {
      surfaces: [],
      unreached: [],
      shared: [],
      unassessed: [`unassessed: ${ROUTE_SOURCE} - no panel union could be read, so no surface can be judged`],
      findings: [
        {
          code: "surface_population_unassessable",
          detail: `${ROUTE_SOURCE} declares no \`*_PANEL\` constant, so no surface can be judged`,
          surface: null,
        },
      ],
    };
  }

  const components = surfaceComponents(root);
  const journeys = journeySpecs({ root }).map((spec) => ({
    file: spec.file,
    assertions: parseTests(spec.source).flatMap((entry) => assertionsOf(entry.body)),
  }));

  const declared = surfaces.map((surface) => {
    const component = components.get(surface.constant) ?? null;
    const module = component === null ? null : importedModule(root, SHELL_SOURCE, component);
    const vocabulary = module === null ? { ids: new Set(), files: [] } : vocabularyOf(root, module);
    return { ...surface, component, module, ids: vocabulary.ids, files: vocabulary.files };
  });

  // An id four surfaces render names none of them: the shared management panel supplies the same
  // controls to chats, characters, settings and memory, so it cannot witness one of those.
  const owners = new Map();
  for (const surface of declared) for (const id of surface.ids) owners.set(id, [...(owners.get(id) ?? []), surface.id]);
  const shared = [...owners.entries()]
    .filter(([, claimants]) => new Set(claimants).size > 1)
    .map(([id, claimants]) => ({ id, surfaces: [...new Set(claimants)] }));
  const sharedIds = new Set(shared.map((entry) => entry.id));

  const findings = [];
  const measured = declared.map((surface) => {
    const own = [...surface.ids].filter((id) => !sharedIds.has(id)).sort();
    const witnesses = own.flatMap((id) =>
      journeys
        .filter((journey) => journey.assertions.some((assertion) => assertion.text.includes(`"${id}"`)))
        .map((journey) => ({ journey: journey.file, id })),
    );
    if (surface.component === null)
      findings.push({
        code: "surface_without_component",
        surface: surface.id,
        detail: `no \`shownSurface === ${surface.constant}\` guard in ${SHELL_SOURCE} renders it, so the surface is declared and unreachable`,
      });
    return { ...surface, own, witnesses };
  });

  for (const surface of measured) {
    if (surface.witnesses.length === 0 && surface.component !== null)
      findings.push({
        code: "surface_without_journey",
        surface: surface.id,
        detail:
          surface.own.length === 0
            ? `nothing renders a test id that names only this surface, so no journey can assert on it`
            : `no journey asserts on ${surface.own.slice(0, 4).join(", ")}${surface.own.length > 4 ? ", …" : ""}`,
      });
  }

  return {
    surfaces: measured.map((surface) => ({
      id: surface.id,
      constant: surface.constant,
      component: surface.component,
      module: surface.module,
      own: surface.own,
      witnesses: surface.witnesses,
    })),
    unreached: measured.filter((surface) => surface.witnesses.length === 0).map((surface) => surface.id),
    shared,
    unassessed: shared.map(
      (entry) => `unassessed: test id "${entry.id}" - rendered by ${entry.surfaces.join(", ")} alike, so it names none`,
    ),
    findings,
  };
}

function report(reading) {
  process.stdout.write(
    `surface_journeys surfaces=${reading.surfaces.length} reached=${reading.surfaces.length - reading.unreached.length} ` +
      `unreached=${reading.unreached.length} shared_ids=${reading.shared.length}\n`,
  );
  for (const surface of reading.surfaces) {
    const witness =
      surface.witnesses[0] === undefined ? "(none)" : `${surface.witnesses[0].journey} -> ${surface.witnesses[0].id}`;
    process.stdout.write(
      `  ${surface.id}: component=${surface.component ?? "(none)"} own_ids=${surface.own.length} ` +
        `witnesses=${surface.witnesses.length} first=${witness}\n`,
    );
  }
  for (const line of reading.unassessed) process.stdout.write(`  ${line}\n`);
  for (const finding of reading.findings)
    process.stderr.write(`surface_journeys_${finding.code}:${finding.surface ?? "-"}: ${finding.detail}\n`);
  return reading.findings.length === 0 ? 0 : 1;
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : REPOSITORY_ROOT;
  const reading = auditSurfaceJourneys({ root });
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(reading, null, 2)}\n`);
    return reading.findings.length === 0 ? 0 : 1;
  }
  const status = report(reading);
  if (status !== 0)
    process.stderr.write(
      "  fix: drive the surface from a mounted journey and assert on something it renders - a control's\n" +
        "       text, its state, its geometry or the request it makes. A control that exists is not a\n" +
        "       surface that works.\n",
    );
  return status;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
