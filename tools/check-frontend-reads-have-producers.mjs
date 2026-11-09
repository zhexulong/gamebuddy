#!/usr/bin/env node
/**
 * Every route `dialogue-web` reads on its own origin must be served by the Host that answers it.
 *
 * WHY THIS EXISTS. `dialogue-web/src/preset-assembly-surface.ts` read `GET /api/tavern/v1/presets` and the panel
 * rendered a read-failure banner against a real Host, because `host/src` served no such route. The Host had the
 * projection (`presetAssemblySurface()` in `host/src/preset-assembly-surface.ts`) and the browser had the read and the
 * whole surface, and the only thing that ever answered the route was a Playwright `page.route(...)` stub in
 * `dialogue-web/tests/preset-assembly-surface.spec.ts`. Every gate in the tree was green: the spec passed because the
 * double answered, and no gate asked whether a producer existed at all. A route is the one fact that crosses two
 * languages and two build roots, and it had two hand-written halves with nothing comparing them.
 *
 * POPULATION, from both authorities on every run. Neither side is listed here.
 *
 *   FRONTEND - every route literal in `dialogue-web/src/**\/*.{ts,tsx}`: a quoted string or template literal whose
 *   value starts with `/api/`, wherever it sits (`fetch(\`/api/...\`)`, `exchange(fetchLike, "GET", "/api/...")`, a
 *   named constant like `PRESET_ASSEMBLY_ROUTE`). Comments are blanked before the scan, so a route discussed in prose
 *   is not a read. A template placeholder (`${turnHandle}`) is normalised to a `:param` segment, the same shape the
 *   contract declares.
 *
 *   HOST - the routes the Host's own registration names, read out of `host/src/**\/*.ts` with test files and
 *   `test-fixtures/` left out:
 *     1. every `path: "/api/..."` field, which is the router table `RouteDescriptors` in
 *        `host/src/tavern/browser-contract/index.ts` (published as `TavernBrowserContractV1.routes`);
 *     2. every exact `url.pathname === "/api/..."` comparison, and the same comparison through a route constant
 *        (`const BOOTSTRAP_PATH = "/api/..."` then `pathname === BOOTSTRAP_PATH`), which is how the two dispatchers
 *        and the composed broker decide what they own.
 *   A `pathname.startsWith("/api/tavern/")` comparison is NOT a producer: it chooses which dispatcher attempts a
 *   path, and that dispatcher still answers 404 for anything it does not match exactly
 *   (`host/src/tavern/composed-reference-game-static-shell-composition.ts:316-321` routes on prefixes and
 *   `declaresRoute` then matches exact route paths). Counting a prefix as a producer would make this gate blind to
 *   the very defect it was written for - `/api/tavern/v1/presets` sits under `/api/tavern/`.
 *   Which composition MOUNTS a declared route (profile `routeIds`) is a different fact with its own owner,
 *   `host/src/composition/desktop-presentation-admission-owner.test.ts`; this gate does not restate it.
 *
 * THE SUBTLE RULE. A route whose ONLY non-comment occurrences outside `dialogue-web/src` are in a spec or test file
 * counts as UNSERVED, and the report names that stub. A `page.route(...)` handler, a fixture server, a Host test's
 * fake dispatcher - each is a test double, and a test double is evidence of ABSENCE, not of presence: it proves the
 * route was never served by anything but the test. This is the rule the defect above needed, because a stub is
 * exactly what made the missing producer invisible.
 *
 * READINGS. Both directions are reported, with numbers:
 *
 *   frontend_reads_route_no_host_serves: <route>  read at <file:line>     violation, exit 1
 *   host_route_never_read: <route>                                        advisory only - other clients exist
 *
 * A zero population on the frontend side is `frontend_route_population_empty` and exits 1: a gate that scanned
 * nothing agrees with itself. A Host side that cannot be parsed is `not_measured` with the reason named and exits 1 -
 * the producer half is the comparison, and without it there is no verdict to print.
 *
 *   node tools/check-frontend-reads-have-producers.mjs              the verdict; exit 1 on any violation
 *   node tools/check-frontend-reads-have-producers.mjs --advisory   violations only, no host_route_never_read lines
 *
 * The last line is the JSON self-report `tools/lib/harness-conformance.mjs` reads, so this gate is registered as
 * self-verifying rather than excused.
 *
 * red-proof: the tree at HEAD `f383b9bb`, measured by this gate before the presets route landed - `examined 101
 *   frontend route literal(s) and 76 host route(s)`, exit 1, three violations:
 *
 *     frontend_reads_route_no_host_serves: /api/tavern/v1/presets  read at
 *       dialogue-web/src/preset-assembly-surface.ts:62
 *       the literal is a named constant; it is used at dialogue-web/src/preset-assembly-surface.ts:76
 *       stub_only: every other non-comment mention is a spec or a test - a stub is evidence of absence
 *       also named in dialogue-web/tests/preset-assembly-surface.spec.ts:252 (test double)
 *
 *   beside `/api/tavern/v1/settings/ui-language` (stub_only, one Playwright stub) and `/api/tavern/v1/world-info/export`
 *   (named nowhere else in the tree at all). The whole class, not one instance.
 * red-proof: the same read after those three routes landed in `host/src` - `examined 101 frontend route literal(s) and
 *   79 host route(s)`, `"violations":[]`, exit 0. Red before, green after, same command: the gate measured the tree
 *   rather than a list someone maintained.
 * red-proof: inject a read of a route only a spec stubs -> named as a violation with `stub_only` evidence, exit 1.
 * red-proof: inject a route registered ONLY in a `host/src/**\/*.test.ts` fake dispatcher -> still a violation: the
 *   test double is not a producer.
 * red-proof: inject an empty `dialogue-web/src` -> `frontend_route_population_empty`, exit 1.
 * red-proof: inject a `dialogue-web/src` read with the Host's registration positions removed ->
 *   `host_route_population_not_measured`, exit 1, naming what could not be read.
 * red-proof: inject a union member with no producer (`trash` removed from the Host's retention routes) -> the read is
 *   a violation naming `unserved member: /api/tavern/v1/chats/:chatHandle/trash`, which the shape alone would pass.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

const WEB = "dialogue-web/src";
const HOST = "host/src";

/**
 * Where a route can be named outside the frontend, and what is not source.
 *
 * The three roots are measured, not assumed: `git grep -l '/api/'` over this tree answers 84 files in `dialogue-web`,
 * 39 in `host` and 22 in `tools`, and nothing in any other root. `integrations/stardew` speaks the Mod's named-pipe
 * protocol and never names a browser route; `design/` is a mounted docs repository. Both are outside the population,
 * which is stated here rather than discovered by an empty scan.
 */
const SCAN_ROOTS = ["dialogue-web", "host", "tools"];

/**
 * Directories that hold no source: dependencies, build output, and the scratch trees builds leave behind.
 *
 * `host/` holds 52 directories named `dist-*` on a working checkout, all of them emitted JavaScript, and
 * `dialogue-web/.build-staging` holds compiled bundles. A route named only inside a build artifact is a copy of a
 * source route, so counting it would make every read look served by the compiler's output rather than by the Host.
 */
const SCAN_SKIP =
  /^(?:node_modules|\.git|\.worktrees|vendor|\.tmp.*|scratch|tmp|dist.*|build|\.build.*|out|coverage|generations|\.cache)$/u;
const SCAN_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|md|json|ya?ml)$/u;

/**
 * What the tree-wide scan will not read: a lockfile, or anything past a megabyte.
 *
 * A route a player can reach is named in code or in prose, never inside a dependency graph - and a scan that reads
 * every lockfile once per unserved route turns a static gate into a minute of I/O. The cap is measured, not guessed:
 * the largest file in `dialogue-web`, `host` or `tools` that names a `/api/` route is 408 KB
 * (`host/src/stardew-production-lifecycle-coordinator.internal.test.ts`, measured 2026-11-10).
 */
const SCAN_SKIP_FILE = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|[^/]+\.lock)$/u;
const SCAN_MAX_BYTES = 1_048_576;

/** A test double: a Playwright spec or a Host test. Named so the report can say which one answered instead. */
const TEST_FILE = /(?:\.spec|\.test)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;

const ROUTE_PREFIX = "/api/";

/**
 * Blank the comments out of a source file, keeping every offset and newline in place.
 *
 * A route written in prose (`* GET /api/tavern/v1/draft` in a doc comment) is a description, not a read, and the
 * frontend api modules document their routes exactly that way: `management-pipeline-api.ts` holds 23 route lines inside
 * comments (measured 2026-11-10), and counting them would report every documented route as read by a client that only
 * described it. String bodies are skipped so a `"//"` inside a literal cannot open a comment. Same length in, same
 * length out: a line number stays the line number the editor shows.
 */
function stripComments(source) {
  const out = source.split("");
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") out[index++] = " ";
      continue;
    }
    if (char === "/" && next === "*") {
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] !== "\n") out[index] = " ";
        index += 1;
      }
      out[index] = " ";
      out[index + 1] = " ";
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === char) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return out.join("");
}

function lineAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text[cursor] === "\n") line += 1;
  return line;
}

function walk(root, directory, out = []) {
  const rooted = join(root, directory);
  if (!existsSync(rooted)) return out;
  for (const entry of readdirSync(rooted).sort()) {
    if (SCAN_SKIP.test(entry)) continue;
    const relative = directory === "." ? entry : `${directory}/${entry}`;
    // A directory that vanished between the listing and the stat (a concurrent build removing `dist-test`, a broken
    // link in a sibling worktree) is not source this gate examines. Throwing here made a routes gate look like a
    // broken Node install, so the absence is skipped rather than trusted.
    let stats;
    try {
      stats = statSync(join(root, relative));
    } catch {
      continue;
    }
    if (stats.isDirectory()) walk(root, relative, out);
    else out.push(relative);
  }
  return out;
}

/** `{ file, text }` for every file under `directory` this gate reads, comments already blanked. */
function sources(root, directory, { extensions = /\.tsx?$/u, skip = () => false } = {}) {
  return walk(root, directory)
    .filter((file) => extensions.test(file) && !SCAN_SKIP_FILE.test(file))
    .filter((file) => !skip(file))
    .map((file) => ({ file, text: join(root, file) }))
    .filter(({ text: path }) => {
      try {
        return statSync(path).size <= SCAN_MAX_BYTES;
      } catch {
        return false;
      }
    })
    .map(({ file, text: path }) => ({ file, text: stripComments(readFileSync(path, "utf8")) }));
}

/** The raw route string of every literal in `text` whose value starts with `/api/`, with where it sits. */
function routeLiterals(text) {
  const found = [];
  for (const match of text.matchAll(/(["'`])(\/api\/[^"'`\n]*)\1/gu)) {
    found.push({ raw: match[2], index: match.index });
  }
  return found;
}

/**
 * A route in the shape the Host declares it: no query, no hash, and every template placeholder a `:name` segment.
 *
 * `\`/api/tavern/v1/turns/${turnHandle}/cancel\`` becomes the shape the contract writes as `:turnHandle`. Keeping the
 * placeholder's NAME is what lets a closed union be expanded against it below; a placeholder that is an expression
 * rather than an identifier is `:param`, which matches one Host segment and nothing more.
 */
function normalizeRoute(raw) {
  return raw
    .split(/[?#]/u)[0]
    .replace(/\$\{([^}]*)\}/gu, (_, inner) => {
      const name = inner.trim();
      return /^[A-Za-z_$][\w$]*$/u.test(name) ? `:${name}` : ":param";
    })
    .replace(/\/+$/u, "");
}

/** Every string literal in `text`, in order. */
function stringLiterals(text) {
  return [...text.matchAll(/"([^"\\]+)"|'([^'\\]+)'/gu)].map((match) => match[1] ?? match[2]);
}

/**
 * The closed set of values a template placeholder can take, read from the source's own declaration.
 *
 * `transitionChatLifecycle(chatHandle, operation: "archive" | "restore" | "trash", ...)` builds
 * `\`/api/tavern/v1/chats/${chatHandle}/${operation}\``, and the Host declares the three concrete paths
 * `/api/tavern/v1/chats/:chatHandle/{archive,restore,trash}`. Treating `:operation` as unconstrained would report this
 * read unserved - a false red on a correct tree - while treating it as matching ANY literal segment would accept a typo.
 * The union is the authority for what the read can be, so it is expanded and every member is matched. A member the Host
 * does not serve is then named on its own, which is stricter than the shape alone could be.
 */
function placeholderValues(text, name, before) {
  const pattern = new RegExp(`\\b${name}\\s*:\\s*([^,)=\\n]+)`, "gu");
  let chosen = null;
  for (const match of text.matchAll(pattern)) {
    if (match.index >= before) break;
    const declared = match[1].trim();
    // A union written inline. A single quoted value is a command FIELD (`operation: "create"` inside a request body),
    // not the parameter's type, and reading it as one names the wrong operations - which is what made this gate report
    // the Memory mutation verbs as the Chat retention verbs on its first run.
    if (declared.includes("|")) {
      const values = stringLiterals(declared);
      if (values.length > 0) chosen = values;
      continue;
    }
    if (!/^[A-Za-z_$][\w$]*$/u.test(declared)) continue;
    const alias = new RegExp(`type\\s+${declared}\\s*=\\s*([^;]+);`, "u").exec(text);
    const values = alias === null ? [] : stringLiterals(alias[1]);
    if (values.length > 0) chosen = values;
  }
  return chosen;
}

/** Cap on the concrete routes one read shape may expand to: a union is a closed set, not a search space. */
const MAX_EXPANSIONS = 16;

/** The concrete routes a read shape can be, with each closed union expanded and every other placeholder left as one. */
function expandRead(route, text, literalIndex) {
  let candidates = [[]];
  for (const segment of route.split("/")) {
    const values =
      segment.startsWith(":") && segment !== ":param" ? placeholderValues(text, segment.slice(1), literalIndex) : null;
    if (values === null) {
      for (const candidate of candidates) candidate.push(segment);
      continue;
    }
    const expanded = [];
    for (const candidate of candidates) for (const value of values) expanded.push([...candidate, value]);
    candidates = expanded.slice(0, MAX_EXPANSIONS);
  }
  return candidates.map((parts) => parts.join("/"));
}

/** The declared route a read shape matches, or `null`. One `:param` segment absorbs exactly one non-empty one. */
function matchDeclared(declared, read) {
  const declaredParts = declared.split("/");
  const readParts = read.split("/");
  if (declaredParts.length !== readParts.length) return null;
  for (let index = 0; index < declaredParts.length; index += 1) {
    if (declaredParts[index].startsWith(":")) {
      if (readParts[index] === "") return null;
      continue;
    }
    if (declaredParts[index] !== readParts[index]) return null;
  }
  return declared;
}

const ROUTE_CONSTANT = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^;\n]+)/gu;

/** Split a `+` concatenation outside string and template literals, or `null` when it cannot be read simply. */
function concatenationParts(expression) {
  const parts = [];
  let quote = null;
  let current = "";
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (quote !== null) {
      current += char;
      if (char === "\\") {
        current += expression[index + 1] ?? "";
        index += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "+") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (quote !== null) return null;
  parts.push(current.trim());
  return parts;
}

/**
 * A route constant's value, or `null` when it cannot be resolved.
 *
 * Three shapes, all measured in `host/src`: a plain literal (`BOOTSTRAP_PATH`), a template built from another one
 * (`` GAME_LAUNCH_PATH = `${GAME_PATH}/launch` ``), and a concatenation. The composed broker declares twenty of its
 * twenty-one paths in the second shape, which is why a gate that read only plain literals reported the whole composed
 * game surface as unserved - a false red is the same defect as a false green, one layer along.
 */
function evaluateRoute(expression, resolve) {
  const parts = concatenationParts(expression);
  if (parts === null) return null;
  let value = "";
  for (const part of parts) {
    const quote = part[0];
    if ((quote === '"' || quote === "'") && part.length >= 2 && part.endsWith(quote)) {
      value += part.slice(1, -1);
      continue;
    }
    if (quote === "`" && part.length >= 2 && part.endsWith("`")) {
      let unresolved = false;
      const body = part.slice(1, -1).replace(/\$\{([^}]*)\}/gu, (_, inner) => {
        const name = inner.trim();
        const resolved = /^[A-Za-z_$][\w$]*$/u.test(name) ? resolve(name) : undefined;
        if (resolved === undefined) {
          unresolved = true;
          return "";
        }
        return resolved;
      });
      if (unresolved) return null;
      value += body;
      continue;
    }
    if (/^[A-Za-z_$][\w$]*$/u.test(part)) {
      const resolved = resolve(part);
      if (resolved === undefined) return null;
      value += resolved;
      continue;
    }
    return null;
  }
  return value;
}

/**
 * Every route constant `host/src` declares, resolved to its value.
 *
 * The map is built across the whole Host rather than per file, because a dispatcher and its constants need not share a
 * module. A name declared twice with two different values resolves to nothing: an ambiguous name is not a route, and
 * guessing which declaration the dispatcher meant would be the exact drift this gate exists to find.
 */
function hostRouteConstants(files) {
  const expressions = new Map();
  for (const { text } of files) {
    for (const match of text.matchAll(ROUTE_CONSTANT)) {
      const name = match[1];
      const expression = match[2].trim();
      if (!expressions.has(name)) expressions.set(name, new Set());
      expressions.get(name).add(expression);
    }
  }
  const resolved = new Map();
  const resolve = (name) => resolved.get(name);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [name, values] of expressions) {
      if (resolved.has(name) || values.size !== 1) continue;
      const value = evaluateRoute([...values][0], resolve);
      if (value === null) continue;
      resolved.set(name, value);
      progressed = true;
    }
  }
  return resolved;
}

/**
 * Route paths a Host source names in a registration position.
 *
 * A `path:` descriptor field and an exact `pathname ===` comparison are registrations. A `pathname.startsWith(...)` is
 * not: it picks a dispatcher, and that dispatcher still answers 404 for a path it does not match exactly.
 */
function hostRegistrations(source, constants) {
  const declared = [];
  for (const match of source.matchAll(/path:\s*(["'`])(\/api\/[^"'`\n]*)\1/gu)) declared.push(normalizeRoute(match[2]));
  for (const match of source.matchAll(/pathname\s*===\s*(["'`])(\/api\/[^"'`\n]*)\1/gu))
    declared.push(normalizeRoute(match[2]));
  for (const match of source.matchAll(/pathname\s*===\s*([A-Za-z_$][\w$]*)/gu)) {
    const resolved = constants.get(match[1]);
    if (resolved !== undefined && resolved.startsWith(ROUTE_PREFIX)) declared.push(normalizeRoute(resolved));
  }
  return declared;
}

/**
 * The first place a named constant is used after the literal it is declared with, or `null` if it is never used.
 *
 * The literal sits AFTER the name in `const X = "..."`, so a search started at the literal already skips the
 * declaration and lands on the call site - which is the line a reader wants when a route has no producer.
 */
function constantUse(file, text, index, name) {
  if (name === null) return null;
  const pattern = new RegExp(`\\b${name}\\b`, "gu");
  pattern.lastIndex = index;
  const use = pattern.exec(text);
  return use === null ? null : `${file}:${lineAt(text, use.index)}`;
}

/** The frontend's route reads: one entry per literal, with the file:line a reader would open. */
export function frontendRouteReads({ root = ROOT, web = WEB } = {}) {
  const reads = [];
  for (const { file, text } of sources(root, web)) {
    for (const { raw, index } of routeLiterals(text)) {
      const before = text.slice(Math.max(0, index - 120), index);
      const declaration = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*$/u.exec(before);
      const constant = declaration === null ? null : declaration[1];
      reads.push({
        route: normalizeRoute(raw),
        candidates: expandRead(normalizeRoute(raw), text, index),
        raw,
        file,
        line: lineAt(text, index),
        constant,
        usedAt: constantUse(file, text, index, constant),
      });
    }
  }
  return reads;
}

/** The Host's served routes, and the reason it could not be read when it could not be. */
export function hostServedRoutes({ root = ROOT, host = HOST } = {}) {
  const files = sources(root, host, {
    skip: (file) => TEST_FILE.test(file) || /\/test-fixtures\//u.test(file),
  });
  if (files.length === 0)
    return { routes: [], sites: new Map(), notMeasured: `host_source_population_empty: no source under ${host}` };

  const sites = new Map();
  const constants = hostRouteConstants(files);
  for (const { file, text } of files) {
    for (const route of hostRegistrations(text, constants)) {
      if (!sites.has(route)) sites.set(route, file);
    }
  }
  if (sites.size === 0)
    return {
      routes: [],
      sites,
      notMeasured:
        `host_registration_positions_not_found: ${files.length} source file(s) under ${host} name no ` +
        "`path:` descriptor and no exact `pathname ===` route, so the producer half of this comparison is unavailable",
    };
  return { routes: [...sites.keys()].sort(), sites, notMeasured: null };
}

/**
 * The route as a pattern over source text: a `:param` segment matches the literal handle OR a template placeholder, so
 * a stub written as `page.route("**\/api/x/" + handle)` still counts as a mention of the shape being read.
 */
function routeShape(route) {
  const segments = route
    .split("/")
    .map((segment) => (segment === ":param" ? "[^\"'`\\s/]+" : segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  return new RegExp(segments.join("/"), "u");
}

/** Every non-comment occurrence of `route` outside the frontend, each labelled with what kind of file it is in. */
function otherOccurrences(route, treeSources) {
  const found = [];
  const shape = routeShape(route);
  for (const { file, text } of treeSources) {
    const index = shape.exec(text)?.index;
    if (index === undefined) continue;
    found.push({ file, line: lineAt(text, index), testDouble: TEST_FILE.test(file) });
  }
  return found;
}

/**
 * The comparison. Returns the verdict, both readings, and the numbers every line carries.
 *
 * `population` is the frontend literal count the report's non-vacuity rule reads; `hostRoutes` is the producer half.
 */
export function checkFrontendReadsHaveProducers({ root = ROOT, web = WEB, host = HOST } = {}) {
  const reads = frontendRouteReads({ root, web });
  const served = hostServedRoutes({ root, host });
  const result = {
    gate: "frontend-reads-have-producers",
    frontendLiterals: reads.length,
    frontendRoutes: new Set(reads.map((read) => read.route)).size,
    hostRoutes: served.routes.length,
    population: reads.length,
    violations: [],
    advisory: [],
    status: "passed",
  };

  if (reads.length === 0) {
    return {
      ...result,
      status: "blocked",
      violations: [
        {
          code: "frontend_route_population_empty",
          detail: `no /api/ route literal in any source under ${web}; a comparison against nothing is not a pass`,
        },
      ],
    };
  }

  if (served.notMeasured !== null) {
    return {
      ...result,
      status: "not_measured",
      violations: [{ code: "host_route_population_not_measured", detail: served.notMeasured }],
    };
  }

  const readFiles = new Set(reads.map((read) => read.file));
  // The tree-wide scan is built once, on the first violation: a run with nothing to explain reads only the two
  // authorities, and a run with six unserved routes does not walk the checkout six times.
  let treeSources = null;
  const tree = () =>
    (treeSources ??= SCAN_ROOTS.flatMap((directory) =>
      sources(root, directory, {
        extensions: SCAN_EXTENSIONS,
        skip: (candidate) => readFiles.has(candidate),
      }),
    ));
  const servedRoutes = new Set(served.routes);
  const unmatched = new Map();
  for (const read of reads) {
    const hits = served.routes.filter((route) =>
      read.candidates.some((candidate) => matchDeclared(route, candidate) !== null),
    );
    // A read is served only when EVERY value it can take is served. A closed union of three operations whose third has
    // no producer is a defect for that third one, not a pass because the other two answered.
    const unserved = read.candidates.filter(
      (candidate) => !served.routes.some((route) => matchDeclared(route, candidate) !== null),
    );
    for (const hit of hits) servedRoutes.delete(hit);
    if (unserved.length === 0) continue;
    if (unmatched.has(read.route)) continue;
    unmatched.set(read.route, { read, unserved });
  }

  for (const [route, { read, unserved }] of unmatched) {
    const others = otherOccurrences(route, tree());
    result.violations.push({
      code: "frontend_reads_route_no_host_serves",
      route,
      readAt: `${read.file}:${read.line}`,
      usedAt: read.usedAt,
      // A read shape that expanded to a closed union names the members with no producer, so the reader sees the value
      // the Host is missing rather than the template that hides it.
      unserved: unserved.length === read.candidates.length ? [] : unserved,
      // The reason this gate exists: when every other mention is a spec or a test, the only thing that ever answered
      // this route was a test double. Naming it is what turns "no producer" into "the stub was the producer".
      stubbedOnly: others.length > 0 && others.every((entry) => entry.testDouble),
      elsewhere: others.map((entry) => `${entry.file}:${entry.line}${entry.testDouble ? " (test double)" : ""}`),
    });
  }

  for (const route of [...servedRoutes].sort()) result.advisory.push({ code: "host_route_never_read", route });
  result.status = result.violations.length === 0 ? "passed" : "failed";
  return result;
}

export function renderFrontendReadsReport(result, out = process.stdout, { advisory = true } = {}) {
  out.write(`examined ${result.frontendLiterals} frontend route literal(s) and ${result.hostRoutes} host route(s)\n`);
  out.write(
    `  ${result.frontendRoutes} distinct route(s) read from ${WEB}, ${result.hostRoutes} declared by ${HOST}\n`,
  );
  for (const violation of result.violations) {
    if (violation.code === "frontend_reads_route_no_host_serves") {
      out.write(`${violation.code}: ${violation.route}  read at ${violation.readAt}\n`);
      for (const candidate of violation.unserved) out.write(`  unserved member: ${candidate}\n`);
      if (violation.usedAt !== null && violation.usedAt !== undefined)
        out.write(`  the literal is a named constant; it is used at ${violation.usedAt}\n`);
      if (violation.stubbedOnly)
        out.write("  stub_only: every other non-comment mention is a spec or a test - a stub is evidence of absence\n");
      for (const entry of violation.elsewhere) out.write(`  also named in ${entry}\n`);
      if (violation.elsewhere.length === 0) out.write("  named nowhere else in the tree at all\n");
      continue;
    }
    out.write(`${violation.code}${violation.detail === undefined ? "" : `: ${violation.detail}`}\n`);
  }
  if (advisory)
    for (const entry of result.advisory)
      out.write(`${entry.code}: ${entry.route}  (advisory: other clients read the same Host)\n`);
  out.write(
    `${JSON.stringify({
      gate: result.gate,
      population: result.population,
      frontendRoutes: result.frontendRoutes,
      hostRoutes: result.hostRoutes,
      violations: result.violations,
      advisory: result.advisory.length,
      // The rule this run verified. The harness reads `checks` to tell a gate that asserted something from one that
      // only printed a table, and the status here is the gate's own verdict rather than a second opinion.
      checks: [{ id: "every_frontend_route_read_has_a_host_producer", status: result.status }],
      status: result.status,
    })}\n`,
  );
}

const main = () => {
  const result = checkFrontendReadsHaveProducers();
  renderFrontendReadsReport(result, process.stdout, { advisory: !process.argv.includes("--advisory") });
  return result.status === "passed" ? 0 : 1;
};

if (process.argv[1]?.replaceAll("\\", "/").endsWith("check-frontend-reads-have-producers.mjs")) process.exit(main());
