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
 *   * the DOM each surface owns is derived from the shell's own CONDITIONS: a guard that renders a component
 *     (`{shownSurface === X && <Component />}`, with as many conditions before the element as the product
 *     writes) and a surface rendered unconditionally and told which one is selected
 *     (`<Component selected={shownSurface === X} />`) both name the component that renders that surface, and
 *     that component's own test ids plus its direct relative imports' ids are its vocabulary.
 *
 * THE GUARD IS A CONDITION, NOT A STRING SHAPE. `ComposedReferenceGameApp.tsx` renders Chat with
 * `{shownSurface === CHAT_PANEL && chatProblem === null && (<ChatSurface … />)}`, and the in-region problem
 * card above it with `{shownSurface === CHAT_PANEL && chatProblem !== null && chatProblemCard !== null &&
 * (<div className="state-placeholder">…)}`. A reader that demanded the comparison be immediately followed by
 * `&& (` and the element therefore saw neither: it reported Chat as declared and unreachable while the shell
 * rendered it (measured 2026-11-12). So the condition is read as an expression - the element is the first `<`
 * in CHAIN position, whose preceding non-space, non-parenthesis text ends with `&&`, `||` or `?` - and the
 * element that names the surface is the component, not the region element around it (`<div>` is a container
 * that carries no test ids of its own).
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
 *            surface's control without asserting on it (still `surface_without_journey`), a surface whose
 *            guard carries a second condition before its element (read: the conjunct is a condition, not an
 *            obstacle), two components guarding one surface (`surface_component_ambiguous`, never a guess),
 *            and a panel union that cannot be read (`surface_population_unassessable`, never a silent pass).
 * red-proof: history  the guard above is the real one: with the reader that demanded `&& (<Component` this
 *            gate exited 1 with `surface_without_component:chat` on a tree whose shell renders ChatSurface.
 */

export const gateDeclaration = {
  id: "check-surface-journeys",
  domain: "product",
  tier: "l0",
  kind: "totality",
};

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertionsOf, journeySpecs, parseTests } from "../../tools/lib/journey-source.mjs";
import { rootFromArgv } from "../../tools/lib/gate-preamble.mjs";

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

/** The comparison a surface guard is written with. `shownSurface !== X` does not match: a hidden surface is not a rendered one. */
const SURFACE_COMPARISON = /\bshownSurface\s*===\s*(\w+_PANEL)\b/gu;

/**
 * A character after which a quote opens a string. A quote after a letter, digit or `_` is an apostrophe in prose
 * (`the conversation's own failure`), and reading it as a string start swallowed the brace that closes the guard.
 */
const STRING_PRECEDERS = new Set([
  "(",
  ",",
  "=",
  ":",
  "?",
  "[",
  "{",
  ";",
  "+",
  "-",
  "*",
  "%",
  "!",
  "&",
  "|",
  "<",
  ">",
  "~",
  "^",
  "/",
]);

function opensString(source, index) {
  let previous = index - 1;
  while (previous >= 0 && /\s/u.test(source[previous])) previous -= 1;
  return previous < 0 || STRING_PRECEDERS.has(source[previous]);
}

/**
 * The shell source with its comments blanked out, every offset and newline kept.
 *
 * A guard writes its own prose between the condition and the element it renders (`&& (`, then `// the problem
 * card is drawn where the conversation is drawn`, then `<div …`). That prose is not syntax: reading it as part
 * of the condition made the chain-position test below land on the NEXT guard's element, and a naive string
 * skipper closed nothing over `conversation's`, so the scan walked past the container's own `}` - the same
 * false reading the fixed string shape produced, one layer along.
 */
function blankComments(source) {
  const out = source.split("");
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") out[index++] = " ";
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] !== "\n") out[index] = " ";
        index += 1;
      }
      out[index] = " ";
      out[index + 1] = " ";
      index += 2;
      continue;
    }
    if ((character === '"' || character === "'" || character === "`") && opensString(source, index)) {
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === character) break;
      }
      continue;
    }
    index += 1;
  }
  return out.join("");
}

/**
 * The index of the `}` that closes the expression the comparison sits in, or the end of the file.
 *
 * The container's end is what bounds a guard: without it, a condition that renders nothing (`{cond && helper()}`)
 * would be read on into the NEXT guard's element and attribute that element to the wrong surface. Nested `{}`, `()`
 * and `[]` are counted, and string bodies are skipped, so an attribute expression inside the consequent
 * (`notice={pollFailure !== null ? …}`) does not close it early.
 */
function expressionEnd(source, from) {
  let depth = 0;
  for (let index = from; index < source.length; index += 1) {
    const character = source[index];
    if ((character === '"' || character === "'" || character === "`") && opensString(source, index)) {
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === character) break;
      }
      continue;
    }
    if (character === "{" || character === "(" || character === "[") depth += 1;
    else if (character === "}" || character === ")" || character === "]") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return source.length;
}

/**
 * The element a guard's condition renders, or `null` when it renders none.
 *
 * What identifies the element is its POSITION, not its distance from the comparison: a `<` whose preceding
 * non-space, non-parenthesis text ends with an operator (`&&`, `||`, `?`) opens the consequent. So the second
 * condition of `chatProblem === null` is just another term of the same condition, while a `<` that is a comparison
 * (`count < 3`) or a fragment of JSX text is not mistaken for one.
 *
 * What is deliberately NOT read: a consequent that is not an element - a call (`{shownSurface === X && renderChat()}`),
 * a variable holding JSX, a `map` callback. The component's identity is then in a callee this reader does not
 * follow, and naming it would be a guess; the surface is reported without a component instead.
 */
function renderedElement(source, from) {
  const end = expressionEnd(source, from);
  for (let index = from; index < end; index += 1) {
    if (source[index] !== "<") continue;
    if (!/[A-Za-z_$>]/u.test(source[index + 1] ?? "")) continue;
    let before = source.slice(Math.max(from, index - 400), index).trimEnd();
    while (before.endsWith("(")) before = before.slice(0, -1).trimEnd();
    if (!/(?:&&|\|\||\?)$/u.test(before)) continue;
    const named = /^<([A-Za-z_$][\w$]*)/u.exec(source.slice(index, end));
    // `<>` is a fragment: it renders its children, and names no component of its own.
    return { component: named === null ? null : named[1] };
  }
  return null;
}

/**
 * The component the shell renders for each surface constant, read from its own guards.
 *
 * Two spellings say the same fact and both are read: a guard that renders the component, and a component rendered
 * unconditionally and told which surface is selected. A DOM element leading the consequent (`<div>` holding the
 * in-region problem card) is a REGION, not the surface's component - it carries no test ids and its children are a
 * different reading - so it does not name one. A constant two different components guard is `ambiguous`: the gate
 * refuses to pick one, because the id vocabulary of both would be attributed to a surface only one of them draws.
 */
export function surfaceComponents(root) {
  const file = read(join(root, SHELL_SOURCE));
  const components = new Map();
  const ambiguous = new Map();
  if (file === null) return { components, ambiguous };
  const source = blankComments(file);
  const rendered = new Map();
  const note = (constant, component) => rendered.set(constant, new Set([...(rendered.get(constant) ?? []), component]));
  for (const match of source.matchAll(SURFACE_COMPARISON)) {
    const element = renderedElement(source, match.index + match[0].length);
    if (element === null || element.component === null) continue;
    // `div`, `section`, `p`: the region's own elements. A component that owns a surface starts with a capital.
    if (!/^[A-Z]/u.test(element.component)) continue;
    note(match[1], element.component);
  }
  // A surface rendered unconditionally and told which one is selected is the same fact, written once.
  for (const match of source.matchAll(/<(\w+)\s[^>]*?selected=\{shownSurface === (\w+_PANEL)\}/gu))
    note(match[2], match[1]);
  for (const [constant, names] of rendered) {
    if (names.size === 1) components.set(constant, [...names][0]);
    else ambiguous.set(constant, [...names].sort());
  }
  return { components, ambiguous };
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

  const { components, ambiguous } = surfaceComponents(root);
  const journeys = journeySpecs({ root }).map((spec) => ({
    file: spec.file,
    assertions: parseTests(spec.source).flatMap((entry) => assertionsOf(entry.body)),
  }));

  const declared = surfaces.map((surface) => {
    const component = components.get(surface.constant) ?? null;
    const module = component === null ? null : importedModule(root, SHELL_SOURCE, component);
    const vocabulary = module === null ? { ids: new Set(), files: [] } : vocabularyOf(root, module);
    return {
      ...surface,
      component,
      ambiguous: ambiguous.get(surface.constant) ?? null,
      module,
      ids: vocabulary.ids,
      files: vocabulary.files,
    };
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
    if (surface.ambiguous !== null)
      findings.push({
        code: "surface_component_ambiguous",
        surface: surface.id,
        detail:
          `${SHELL_SOURCE} guards \`${surface.constant}\` with ${surface.ambiguous.join(" and ")}, so which ` +
          "one's test ids name this surface cannot be read - one condition, one component",
      });
    else if (surface.component === null)
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
  const root = rootFromArgv(argv, REPOSITORY_ROOT);
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
