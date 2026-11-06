#!/usr/bin/env node
/**
 * Collision report: a journey whose title names a route it replaces with a fixture is a journey that
 * cannot see the defect it claims to catch.
 *
 * WHY (measured 2026-11-04)
 *
 * `app-bar-status-narrow.spec.ts` placed a status dot and asserted the dot; it stubbed no settings
 * route at all, so the dot it drew was the one the app draws when the settings read never arrives - the
 * spec was checking the fallback, and the fallback was the bug. The same class is a spec that stubs the
 * very projection it claims to test: the fixture answers, the assertion passes, and the production path
 * is never exercised.
 *
 * THE ROUTES A SPEC STUBS are not only the literals in its own text. Two shapes hide them, and both
 * were measurably missed by a first version of this report:
 *
 *   * a spec that stubs through a helper module (`./draft-surfaces` answers 19 routes for the spec that
 *     imports it), so a spec's route set is read through its own relative imports;
 *   * a spec that names its routes by constant (`page.route(BOOTSTRAP_ROUTE, …)`), so a pattern is
 *     resolved through the `const NAME = "…"` declarations in the spec and its helpers. An identifier
 *     that resolves to nothing is printed as `unassessed:` rather than counted as "stubs nothing".
 *
 * THREE READINGS, and none of them is a verdict:
 *
 *   `collisions`      a title names the resource of a route the spec stubs. A heuristic: a fixture may
 *                     legitimately stand in for the subject, so every line is a question for its owner -
 *                     "does the fixture stand in for the thing the title claims, or does it decide it?"
 *   `decides_nothing` a spec stubs no route, drives no probe page and names its routes by no constant,
 *                     so its claims are decided by whatever the app does when nothing answers. This is
 *                     the shape that produced tonight's false green.
 *   `unassessed`      a spec that mounts a probe page instead of the shell (its double is in-page, so no
 *                     app route is under test), or whose route names this gate could not resolve.
 *
 * WHY REPORT-ONLY: a heuristic collision is a question, and a build that fails on a question teaches its
 * readers to ignore the list. The exit status is 0 whatever is found; the deliverable is that the list
 * exists and nobody has to remember to look.
 *
 * Usage:
 *   node tools/check-stub-subject-collision.mjs           # the list; always exit 0
 *   node tools/check-stub-subject-collision.mjs --json    # the same reading, for a tool
 *   node tools/check-stub-subject-collision.mjs --root <dir>   # the report's own fixture
 *
 * red-proof: self-check  a spec added to a synthetic tree whose title names the resource it stubs is
 *            listed, while a spec that stubs the same route under a title naming something else is not
 *            (tools/check-stub-subject-collision.test.mjs). The report is also seen to name a spec that
 *            stubs nothing at all, one that stubs through an imported helper, and one whose route is
 *            named by an unresolvable constant - the three shapes that made a first reading wrong.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { journeySpecs, parseTests } from "./lib/journey-source.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Path segments that name a version or a transport rather than a resource. */
const GENERIC = new Set(["api", "v1", "v2", "v3", "http", "https", "127.0.0.1", "localhost"]);
const ROUTE_CALL = /\.route\s*\(\s*/gu;
const LITERAL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])([^"'`]*)\2/gu;

const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

/** The spec's own source plus the modules it imports from its own directory. */
function sourcesOf(root, file) {
  const source = read(join(root, file));
  if (source === null) return [];
  const sources = [source];
  for (const match of source.matchAll(/from "(\.[^"]+)"/gu)) {
    for (const suffix of [".ts", ".tsx", "/index.ts"]) {
      const candidate = join(dirname(file), `${match[1]}${suffix}`);
      const imported = read(join(root, candidate));
      if (imported !== null) {
        sources.push(imported);
        break;
      }
    }
  }
  return sources;
}

/**
 * Every route pattern these sources stub, plus the identifiers that name a route but resolve to no
 * literal - a route this report cannot read, which is never the same as a route that is not stubbed.
 */
export function stubbedRoutesOf(sources) {
  const constants = new Map();
  for (const source of sources) {
    for (const match of source.matchAll(LITERAL)) constants.set(match[1], match[3]);
  }
  const patterns = new Set();
  const unresolved = new Set();
  for (const source of sources) {
    for (const call of source.matchAll(ROUTE_CALL)) {
      const rest = source.slice(call.index + call[0].length);
      const literal = /^(["'`])([^"'`]*)\1/u.exec(rest);
      if (literal !== null) {
        patterns.add(literal[2]);
        continue;
      }
      const identifier = /^([A-Za-z_$][\w$]*)/u.exec(rest);
      if (identifier === null) continue;
      const resolved = constants.get(identifier[1]);
      if (resolved === undefined) unresolved.add(identifier[1]);
      else patterns.add(resolved);
    }
  }
  return { patterns: [...patterns], unresolved: [...unresolved] };
}

/** The segments of one stub pattern, minus the wildcards, the parameters, the versions and the host. */
function segmentsOf(pattern) {
  return pattern
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "" && segment !== "**" && !segment.startsWith(":"))
    .filter((segment) => !GENERIC.has(segment.toLowerCase()) && !/^\d+$/u.test(segment));
}

/** Whether a title names a segment, treating `profile-store`, `profile_store` and `profile store` as one. */
function names(title, segment) {
  const words = segment.toLowerCase().replace(/[_-]+/gu, " ");
  const haystack = title.toLowerCase().replace(/[_-]+/gu, " ");
  return new RegExp(`(?:^|[^a-z0-9])${words.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:$|[^a-z0-9])`, "u").test(
    haystack,
  );
}

/** The whole reading: per spec its routes, its titles, the collisions, and the shapes it cannot answer. */
export function auditStubSubjectCollisions({ root = REPOSITORY_ROOT } = {}) {
  const specs = journeySpecs({ root }).map((spec) => {
    const { patterns, unresolved } = stubbedRoutesOf(sourcesOf(root, spec.file));
    // A word that sits MID-path in this spec's own routes names a route family (`game`, `chat`,
    // `stardew`), so a title mentioning it is not naming a resource the fixture answers. Only a LEAF
    // names one thing. No length or frequency threshold is applied: a filter like that would silently
    // narrow the list the first time someone added a shorter resource name.
    const routes = patterns.map(segmentsOf);
    const families = new Set(routes.flatMap((segments) => segments.slice(0, -1)));
    const subjects = [...new Set(routes.map((segments) => segments[segments.length - 1]))]
      .filter((subject) => subject !== undefined && subject.length > 3 && !families.has(subject))
      .sort();
    const tests = parseTests(spec.source).map((entry) => ({ title: entry.title, line: entry.line }));
    const collisions = [];
    for (const entry of tests) {
      for (const subject of subjects) if (names(entry.title, subject)) collisions.push({ ...entry, subject });
    }
    const probePage = /["'`]\/tests\/[\w.-]+\.html["'`]/u.test(spec.source);
    return { file: spec.file, routes: patterns.length, subjects, tests, collisions, probePage, unresolved };
  });

  const collisions = specs.flatMap((spec) => spec.collisions.map((collision) => ({ file: spec.file, ...collision })));
  return {
    specs,
    stubbedRoutes: specs.reduce((total, spec) => total + spec.routes, 0),
    collisions,
    decidesNothing: specs
      .filter((spec) => spec.routes === 0 && !spec.probePage && spec.unresolved.length === 0)
      .map((spec) => spec.file),
    probeMounted: specs.filter((spec) => spec.probePage).map((spec) => spec.file),
    unresolved: specs
      .filter((spec) => spec.unresolved.length > 0)
      .map((spec) => ({ file: spec.file, names: spec.unresolved })),
    unassessed:
      specs.length === 0 ? ["unassessed: dialogue-web/tests - no mounted journey found, so nothing can be judged"] : [],
  };
}

function report(reading) {
  process.stdout.write(
    `stub_subject_collision specs=${reading.specs.length} stubbed_routes=${reading.stubbedRoutes} ` +
      `collisions=${reading.collisions.length} decides_nothing=${reading.decidesNothing.length} ` +
      `probe_mounted=${reading.probeMounted.length} unresolved_route_names=${reading.unresolved.length}\n`,
  );
  for (const line of reading.unassessed) process.stdout.write(`  ${line}\n`);
  // The specs that decide nothing come first: one that stubs nothing is the shape that produced
  // tonight's false green, and it must be readable before a hundred heuristic collisions scroll past.
  for (const file of reading.decidesNothing)
    process.stdout.write(
      `  decides_nothing:${file} - stubs no route, so its claims are decided by the app's fallback\n`,
    );
  for (const entry of reading.unresolved)
    process.stdout.write(
      `  unassessed: ${entry.file} - route names ${entry.names.join(", ")} resolve to no literal here, so its stubs cannot be read\n`,
    );
  for (const file of reading.probeMounted)
    process.stdout.write(
      `  unassessed: ${file} - mounts its own probe page instead of the shell, so no app route is under test\n`,
    );
  for (const collision of reading.collisions)
    process.stdout.write(
      `  collision:${collision.file}:${collision.line} stubs a route naming "${collision.subject}" - ${collision.title}\n`,
    );
  process.stdout.write(
    "  every collision is a question for its owner: a fixture may stand in for the subject, or it may BE the subject.\n",
  );
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : REPOSITORY_ROOT;
  const reading = auditStubSubjectCollisions({ root });
  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(reading, null, 2)}\n`);
  else report(reading);
  // Report only, by design: a heuristic collision is a question, and a build that fails on a question
  // teaches its readers to ignore the list. The exit status is 0 whatever was found.
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
