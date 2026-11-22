/**
 * The falsifier for `tools/check-frontend-reads-have-producers.mjs`: a fixture tree per case, driven through the gate's
 * own entry, so what is asserted is the gate's reading of a tree rather than a description of its source.
 *
 * red-proof: fixture  the presets read with the route removed from the Host - `frontend_reads_route_no_host_serves:
 *   /api/tavern/v1/presets  read at dialogue-web/src/preset-assembly-surface.ts:62` with `stub_only`, exit 1; the same
 *   fixture with the route declared -> no violation ("a read with no producer is named with the route and the file it
 *   is read from", and its served counterpart).
 * red-proof: fixture  a Playwright `page.route` stub for an otherwise unserved route -> still a violation, and the stub is named
 *   in `elsewhere` with `stub_only` true ("a Playwright stub is evidence of absence, not of presence").
 * red-proof: fixture  a route registered only inside `host/src/*.test.ts` -> still a violation ("a route a Host TEST serves is
 *   not a route the Host serves").
 * red-proof: fixture  two shapes in one fixture - the served one passes, the unserved one is named, and the comment-only mention
 *   is not counted as a read at all ("a route written in a comment is a description, not a read").
 * red-proof: fixture  an empty `dialogue-web/src` -> `frontend_route_population_empty`, exit 1 ("a comparison against nothing is
 *   blocked, never green").
 * red-proof: fixture  a `host/src` with no registration position, and a `host/src` with no source at all -> `not_measured` with
 *   the reason named, never a pass ("a Host side that cannot be parsed is not measured, never passed").
 * red-proof: fixture  a closed-union read whose third member has no producer -> a violation naming
 *   `unserved member: /api/tavern/v1/chats/:chatHandle/trash` ("a union member with no producer is named on its own").
 * red-proof: fixture  a route the Host registers through its own constant, and the same constant built from another
 *   one (`` const GAME_LAUNCH_PATH = `${GAME_PATH}/launch` ``) -> served; the constant written wrong -> the read's own
 *   route is a violation ("a route the Host registers through its own constant is served", "a constant built from
 *   another constant is resolved to its value, not left as a name").
 * red-proof: fixture  a registration the resolver cannot fold (`` path: `${BASE}/${suffix}` ``) -> named as
 *   `registration_unreadable` with its expression and file:line, never matched by guess and never dropped ("a
 *   registration this gate cannot resolve is named as unreadable, never guessed or dropped").
 * red-proof: fixture  an interface's `path: string;` beside a local helper `const string = (): string => …` -> not a
 *   registration, so it adds no unreadable line ("a `path:` field that names no route is not a registration").
 *
 * Two readings here are not falsifiers and do not wear the keyword: a declared route nothing reads is advisory only,
 * status passed ("a host route nothing reads is advisory"), and a foreign working directory prints the same population
 * line, because the root is resolved from the module and not from the shell ("the gate does not depend on the caller's
 * working directory").
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";
import {
  checkFrontendReadsHaveProducers,
  frontendRouteReads,
  hostServedRoutes,
} from "./check-frontend-reads-have-producers.mjs";

const REPOSITORY_ROOT = repositoryRoot(import.meta.url);
const GATE = join(REPOSITORY_ROOT, "tools", "check-frontend-reads-have-producers.mjs");

/** A throwaway tree written at the real relative paths, so the gate's own scope rules decide what is read. */
function withFixtureRoot(specs, run) {
  const root = mkdtempSync(join(tmpdir(), "frontend-route-producer-"));
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

const reading = (specs) => withFixtureRoot(specs, (root) => checkFrontendReadsHaveProducers({ root }));

/** A frontend module that reads one route. */
const webRead = (route) => `export async function read() {\n  return await fetch("${route}");\n}\n`;

/** A Host router table whose one registration is `route`, written the way the contract declares them. */
const hostTable = (...routes) =>
  `export const routes = Object.freeze([\n${routes.map((route) => `  { path: "${route}" },`).join("\n")}\n]);\n`;

const routes = (result) => result.violations.map((violation) => violation.route);

const PRESET_READ = "dialogue-web/src/preset-assembly-surface.ts";
const PRESET_ROUTE = "/api/tavern/v1/presets";

test("a read with no producer is named with the route and the file it is read from", () => {
  const result = reading({
    [PRESET_READ]: `\n\nexport const PRESET_ASSEMBLY_ROUTE = "${PRESET_ROUTE}";\n`,
    "host/src/contract.ts": hostTable("/api/tavern/v1/state"),
  });
  assert.deepEqual(routes(result), [PRESET_ROUTE]);
  assert.equal(result.violations[0].code, "frontend_reads_route_no_host_serves");
  assert.equal(result.violations[0].readAt, `${PRESET_READ}:3`);
  assert.equal(result.status, "failed");
});

test("the same read with the route declared by the Host is served", () => {
  const result = reading({
    [PRESET_READ]: `export const PRESET_ASSEMBLY_ROUTE = "${PRESET_ROUTE}";\n`,
    "host/src/contract.ts": hostTable(PRESET_ROUTE),
  });
  assert.deepEqual(result.violations, []);
  assert.equal(result.status, "passed");
});

test("the literal is followed to the constant's use, so the reader lands on the call and not only the declaration", () => {
  const result = reading({
    [PRESET_READ]: [
      `export const PRESET_ASSEMBLY_ROUTE = "${PRESET_ROUTE}";`,
      "",
      "export async function read(transport = fetch) {",
      "  return await transport(PRESET_ASSEMBLY_ROUTE);",
      "}",
      "",
    ].join("\n"),
    "host/src/contract.ts": hostTable("/api/tavern/v1/state"),
  });
  assert.equal(result.violations[0].usedAt, `${PRESET_READ}:4`);
});

test("a Playwright stub is evidence of absence, not of presence", () => {
  const result = reading({
    [PRESET_READ]: webRead(PRESET_ROUTE),
    "host/src/contract.ts": hostTable("/api/tavern/v1/state"),
    "dialogue-web/tests/preset-assembly-surface.spec.ts": [
      'test("x", async ({ page }) => {',
      `  await page.route("**${PRESET_ROUTE}", (route) => route.fulfill({ status: 200 }));`,
      "});",
      "",
    ].join("\n"),
  });
  assert.deepEqual(routes(result), [PRESET_ROUTE]);
  assert.equal(result.violations[0].stubbedOnly, true);
  assert.deepEqual(result.violations[0].elsewhere, [
    "dialogue-web/tests/preset-assembly-surface.spec.ts:2 (test double)",
  ]);
});

test("a route the Host registers through its own constant is served", () => {
  // The composed game broker's shape: the route value is declared once and registered by name. A gate that read only
  // a literal `path: "/api/..."` reported nineteen reads of that surface unserved (measured 2026-11-12).
  const withTable = [
    `const STATE_PATH = "${PRESET_ROUTE}";`,
    'export const routes = Object.freeze([{ id: "state_read", method: "GET", path: STATE_PATH }]);',
    "",
  ].join("\n");
  const served = reading({
    [PRESET_READ]: webRead(PRESET_ROUTE),
    "host/src/broker.ts": withTable,
  });
  assert.deepEqual(served.violations, []);
  assert.equal(served.status, "passed");
  assert.deepEqual(served.unreadableRegistrations, []);

  // red-proof: inject the same registration with its constant written wrong (`${PRESET_ROUTE}-typo`) -> the reading
  // goes `failed` and the violation is named by the read's own route, not by the constant's spelling.
  const changed = reading({
    [PRESET_READ]: webRead(PRESET_ROUTE),
    "host/src/broker.ts": withTable.replace(`"${PRESET_ROUTE}"`, `"${PRESET_ROUTE}-typo"`),
  });
  assert.deepEqual(routes(changed), [PRESET_ROUTE]);
  assert.equal(changed.status, "failed");
});

test("a constant built from another constant is resolved to its value, not left as a name", () => {
  const result = reading({
    "dialogue-web/src/api.ts": webRead("/api/composed-reference-game/v1/game/launch"),
    "host/src/broker.ts": [
      'const GAME_PATH = "/api/composed-reference-game/v1/game";',
      "const GAME_LAUNCH_PATH = `${GAME_PATH}/launch`;",
      'export const routes = Object.freeze([{ method: "POST", path: GAME_LAUNCH_PATH }]);',
      "",
    ].join("\n"),
  });
  assert.deepEqual(result.violations, []);
  assert.equal(result.hostRoutes, 1);
});

test("a registration this gate cannot resolve is named as unreadable, never guessed or dropped", () => {
  const result = reading({
    "dialogue-web/src/api.ts": webRead(PRESET_ROUTE),
    "host/src/contract.ts": hostTable("/api/tavern/v1/state"),
    "host/src/broker.ts": [
      'const BASE = "/api/tavern/v1/presets";',
      'export const routes = Object.freeze([{ method: "GET", path: `${BASE}/${suffix}` }]);',
      "",
    ].join("\n"),
  });
  // Nothing matched, so the read is a violation - and the registration that might have served it is named beside it.
  assert.deepEqual(routes(result), [PRESET_ROUTE]);
  assert.deepEqual(
    result.unreadableRegistrations.map((entry) => `${entry.expression} at ${entry.file}:${entry.line}`),
    ["`${BASE}/${suffix}` at host/src/broker.ts:2"],
  );
});

test("a `path:` field that names no route is not a registration", () => {
  // The tree carries 35 `path:` fields in type positions and file-path values (measured 2026-11-12). One of them is
  // `path: string;` beside a local helper `const string = (): string => …`, so the name alone cannot decide it.
  const result = reading({
    "dialogue-web/src/api.ts": webRead(PRESET_ROUTE),
    "host/src/contract.ts": hostTable(PRESET_ROUTE),
    "host/src/types.ts": [
      "interface OwnedFile {",
      "  path: string;",
      "  owner: string;",
      "}",
      'const string = (): string => "";',
      "export const located = (owner: OwnedFile) => read(owner.path, string());",
      "",
    ].join("\n"),
  });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.unreadableRegistrations, []);
});

test("a route a Host TEST serves is not a route the Host serves", () => {
  const result = reading({
    "dialogue-web/src/api.ts": webRead(PRESET_ROUTE),
    "host/src/dispatcher.test.ts": [
      "test('serves it', () => {",
      `  assert.equal(url.pathname === "${PRESET_ROUTE}", true);`,
      "});",
      "",
    ].join("\n"),
  });
  // No registration outside the test, so the Host side is unmeasurable rather than served — and never a pass.
  assert.notEqual(result.status, "passed");
  assert.equal(result.violations[0].code, "host_route_population_not_measured");
});

test("a Host test double beside a real registration is not the thing that serves the unserved route", () => {
  const result = reading({
    "dialogue-web/src/api.ts": webRead(PRESET_ROUTE),
    "host/src/contract.ts": hostTable("/api/tavern/v1/state"),
    "host/src/dispatcher.test.ts": `assert.equal(url.pathname === "${PRESET_ROUTE}", true);\n`,
  });
  assert.deepEqual(routes(result), [PRESET_ROUTE]);
  assert.equal(result.violations[0].stubbedOnly, true);
});

test("a route written in a comment is a description, not a read", () => {
  const result = reading({
    "dialogue-web/src/api.ts": [
      "/**",
      ` * GET ${PRESET_ROUTE}: the readout this surface shows.`,
      " */",
      `// ${PRESET_ROUTE} is served by the Host`,
      `export async function read() {\n  return await fetch("/api/tavern/v1/state");\n}`,
      "",
    ].join("\n"),
    "host/src/contract.ts": hostTable("/api/tavern/v1/state"),
  });
  assert.equal(result.frontendLiterals, 1);
  assert.deepEqual(result.violations, []);
  assert.equal(result.status, "passed");
});

test("a comparison against nothing is blocked, never green", () => {
  const result = reading({
    "dialogue-web/src/api.ts": `export const nothing = 1;\n`,
    "host/src/contract.ts": hostTable("/api/tavern/v1/state"),
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.violations[0].code, "frontend_route_population_empty");
  assert.equal(result.population, 0);
});

test("a Host side that cannot be parsed is not measured, never passed", () => {
  const empty = reading({ "dialogue-web/src/api.ts": webRead(PRESET_ROUTE), "host/src/notes.ts": "export {};\n" });
  assert.equal(empty.status, "not_measured");
  assert.equal(empty.violations[0].code, "host_route_population_not_measured");
  assert.match(empty.violations[0].detail, /host_registration_positions_not_found/u);

  const absent = reading({ "dialogue-web/src/api.ts": webRead(PRESET_ROUTE) });
  assert.equal(absent.status, "not_measured");
  assert.match(absent.violations[0].detail, /host_source_population_empty/u);
});

test("a union member with no producer is named on its own", () => {
  const specs = {
    "dialogue-web/src/api.ts": [
      "export async function transition(chatHandle: string, operation: `archive` | `restore` | `trash`) {",
      "  return await fetch(`/api/tavern/v1/chats/${chatHandle}/${operation}`);",
      "}",
      "",
    ]
      .join("\n")
      .replaceAll("`", '"'),
    "host/src/dispatcher.ts": [
      'if (url.pathname === "/api/tavern/v1/chats/:chatHandle/archive") handle();',
      'if (url.pathname === "/api/tavern/v1/chats/:chatHandle/restore") handle();',
      'if (url.pathname === "/api/tavern/v1/chats/:chatHandle/trash") handle();',
      "",
    ].join("\n"),
  };
  const complete = reading(specs);
  assert.deepEqual(complete.violations, []);

  const missingTrash = reading({
    ...specs,
    "host/src/dispatcher.ts": [
      'if (url.pathname === "/api/tavern/v1/chats/:chatHandle/archive") handle();',
      'if (url.pathname === "/api/tavern/v1/chats/:chatHandle/restore") handle();',
      "",
    ].join("\n"),
  });
  assert.deepEqual(
    missingTrash.violations.map((violation) => violation.unserved),
    [["/api/tavern/v1/chats/:chatHandle/trash"]],
  );
});

test("a placeholder segment matches the Host's own named parameter", () => {
  const result = reading({
    "dialogue-web/src/api.ts": [
      "export async function cancel(turnHandle: string) {",
      "  return await fetch(`/api/tavern/v1/turns/${turnHandle}/cancel`);",
      "}",
      "",
    ].join("\n"),
    "host/src/contract.ts": hostTable("/api/tavern/v1/turns/:turnHandle/cancel"),
  });
  assert.deepEqual(result.violations, []);
});

test("a host route nothing reads is advisory", () => {
  const result = reading({
    "dialogue-web/src/api.ts": webRead("/api/tavern/v1/state"),
    "host/src/contract.ts": hostTable("/api/tavern/v1/state", "/api/tavern/v1/profile/backup/export"),
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(result.advisory, [{ code: "host_route_never_read", route: "/api/tavern/v1/profile/backup/export" }]);
});

test("the real tree is measured: both populations are read, and every violation names a file and a line", () => {
  const reads = frontendRouteReads();
  const served = hostServedRoutes();
  const result = checkFrontendReadsHaveProducers();
  assert.ok(reads.length > 0, "no frontend route literal was found in dialogue-web/src");
  assert.equal(served.notMeasured, null, "the Host's registration positions could not be read");
  assert.ok(served.routes.length > 0, "the Host declares no route");
  assert.equal(result.population, reads.length);
  assert.equal(result.hostRoutes, served.routes.length);
  for (const violation of result.violations)
    assert.match(violation.readAt ?? "", /^dialogue-web\/src\/.+\.tsx?:\d+$/u, violation.code);
});

test("the gate does not depend on the caller's working directory", () => {
  const run = spawnSync(process.execPath, [GATE], {
    cwd: join(REPOSITORY_ROOT, "tools"),
    encoding: "utf8",
  });
  assert.match(run.stdout, /^examined \d+ frontend route literal\(s\) and \d+ host route\(s\)$/mu);
  assert.match(run.stdout, /"gate":"frontend-reads-have-producers"/u);
  assert.match(run.stdout, /"checks":\[\{"id":"every_frontend_route_read_has_a_host_producer"/u);
});
