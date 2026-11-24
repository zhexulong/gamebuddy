/**
 * A browser-held identity must be a fact about what it names, not about the process that answered.
 *
 * The defect this gate exists for: `host/src/tavern/memory-management/memory-management.ts` built every
 * Memory handle and the projection revision with `createHmac("sha256", randomBytes(32))`, where the secret was
 * drawn when the service was constructed. A handle names a durable Memory row and the revision is the
 * contract's own "content fingerprint of the projected rows", so both must be reproducible from the
 * store - but keyed on the process they were not: after a mount rotation, a Chat teardown/remount or a Host
 * restart the browser still held the projection it had read, and every write from it was answered 409 for a
 * row that had not changed. Nothing failed loudly. `read()` was deterministic *within* one service instance,
 * so every test that built one service saw stable handles and a stable revision.
 *
 * What this gate holds:
 *
 *  1. **The names a client holds** are read out of the frozen contract, never typed here: a field that ends
 *     `handle|revision|generation|token|cursor` and appears in some route's `success` schema AND in some
 *     route's `request`/`pathParams`/`query` (or its `expectedX` form) is a value the browser receives and
 *     sends back later - a client-held identity.
 *  2. **The producers** are found by scanning production sources for a module that binds a value drawn at
 *     runtime (`randomBytes`/`randomUUID`) and turns it into an identity with a digest. Its published names
 *     are collected from the module's own property assignments, and a name counts as *computed from that
 *     draw* when its value is a digest call over such a binding, or calls a module-local computation that
 *     contains one (closed over those computations).
 *  3. **The two together are refused**: a client-held identity computed from a runtime draw does not survive
 *     the process, so it may only exist with a declared lifetime - the thing it actually names, which is not
 *     durable - and a declaration that stops being reached fails, so an exemption cannot outlive its reason.
 *
 * Both populations are printed and neither may be empty: `0 violations` over `0 examined` is a gate agreeing
 * with itself. Deliberately out of scope: a *fresh random* handle minted per projection (the World Info
 * library does this: `mintHandle` in `tavern/world-info-binding`, one nonce per state projection, refused as
 * stale after any read). That value is not derived from anything, so it cannot be "re-derived" - the
 * contract calls it a handle "from the last validated state projection" rather than a fingerprint, and the
 * class this gate holds is the derived one, where a durable fact was keyed to a process.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { TavernBrowserContractV1 } from "./tavern/browser-contract/index.js";

const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = join(HOST_ROOT, "src");

/** A value a client receives and sends back later: handles, revisions, generations, tokens, cursors. */
const CLIENT_HELD_NAME = /(?:handle|revision|generation|token|cursor)$/iu;

/** A value drawn when this module ran, rather than read from durable state. */
const RUNTIME_DRAW = /(?:^|\.)random(?:Bytes|UUID)\(/u;

/** The factories that turn an authority into an identity. */
const DIGEST_CALL = /\bcreate(?:Hmac|Hash|Cipheriv|Sign)\(/u;

/**
 * Identities computed from a runtime draw that are allowed to be, because the thing they name dies with the
 * process: the declared lifetime is what has to be true, and `staleRefusal` is why a browser holding one from
 * a previous process gets a refusal it can act on instead of a wrong answer.
 */
const DECLARED_LIFETIMES: Readonly<
  Record<string, Readonly<{ names: readonly string[]; names_: string; staleRefusal: string }>>
> = Object.freeze({
  "src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts": Object.freeze({
    names: Object.freeze(["chatHandle"]),
    names_:
      "a mounted Chat lease - `MountedChatBrowserProjection` is declared `per-mounted-lease reference; never a durable Chat identifier`, so the handle must not outlive the mount it names",
    staleRefusal:
      "a handle from a previous mount resolves against no current lease (`isCurrentMountedChatRuntimeLease`), the mount is re-admitted and the surface re-reads its projection",
  }),
});

/** How a command names the produced value it expects: `projectionRevision` -> `expectedProjectionRevision`. */
function expectedForm(name: string): string {
  return `expected${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}

/** Every property name a schema declares, at any depth (objects, arrays, unions). */
function propertyNames(schema: unknown, into = new Set<string>()): ReadonlySet<string> {
  if (schema === null || typeof schema !== "object") return into;
  if (Array.isArray(schema)) {
    for (const entry of schema) propertyNames(entry, into);
    return into;
  }
  const record = schema as Record<string, unknown>;
  if (record["properties"] !== null && typeof record["properties"] === "object")
    for (const name of Object.keys(record["properties"] as Record<string, unknown>)) into.add(name);
  for (const key of ["anyOf", "oneOf", "allOf", "items", "additionalProperties", "not"]) {
    if (record[key] !== undefined) propertyNames(record[key], into);
  }
  return into;
}

const producedAtLeastOnce = new Set<string>();
const consumedAtLeastOnce = new Set<string>();
for (const route of TavernBrowserContractV1.routes) {
  // Some routes answer without taking a body at all, so the request side is optional on the union.
  const request = (route as Readonly<{ request?: unknown }>).request ?? {};
  propertyNames(route.success.schema, producedAtLeastOnce);
  propertyNames(request, consumedAtLeastOnce);
  propertyNames(route.pathParams ?? {}, consumedAtLeastOnce);
  propertyNames(route.query ?? {}, consumedAtLeastOnce);
}
/** The contract's client-held identities: produced by a reply, and carried back by a later request. */
const clientHeldNames: ReadonlySet<string> = new Set(
  [...producedAtLeastOnce].filter(
    (name) =>
      CLIENT_HELD_NAME.test(name) &&
      (consumedAtLeastOnce.has(name) || consumedAtLeastOnce.has(expectedForm(name))),
  ),
);

/** Every production `*.ts` the Host compiles: tests and fixtures never answer a browser. */
function productionSources(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test-fixtures") continue;
      found.push(...productionSources(path));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (/\.test(-support|-fixtures)?\.ts$/u.test(entry.name)) continue;
    found.push(path);
  }
  return found;
}

type PublishedName = Readonly<{ name: string; value: string }>;

type ModuleReading = Readonly<{
  path: string;
  drawn: readonly string[];
  identities: readonly string[];
  computed: readonly string[];
}>;

function wordPattern(name: string): RegExp {
  return new RegExp(`\\b${name}\\b`, "u");
}

/** One module's browser-published names computed from a value it drew at runtime. */
function readModule(path: string): ModuleReading | undefined {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const drawn = new Set<string>();
  /** Module-local names and the expressions they stand for, so a projection through one is followed. */
  const localComputations = new Map<string, string>();
  const published: PublishedName[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const initializer = node.initializer;
      if (RUNTIME_DRAW.test(initializer.getText(file))) drawn.add(node.name.text);
      localComputations.set(node.name.text, initializer.getText(file));
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) localComputations.set(node.name.text, node.getText(file));
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
      if (name !== undefined) published.push({ name, value: node.initializer.getText(file) });
    }
    // `{ projectionRevision }` publishes the binding of that name, so the binding's own expression decides.
    if (ts.isShorthandPropertyAssignment(node)) published.push({ name: node.name.text, value: node.name.text });
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  if (drawn.size === 0) return undefined;

  const keyed = (text: string): boolean =>
    DIGEST_CALL.test(text) && [...drawn].some((name) => wordPattern(name).test(text));
  const identifies = new Set([...localComputations].filter(([, text]) => keyed(text)).map(([name]) => name));
  const callsIdentity = (text: string): boolean =>
    [...identifies].some((name) => new RegExp(`\\b${name}\\(`, "u").test(text));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, text] of localComputations) {
      if (identifies.has(name) || !callsIdentity(text)) continue;
      identifies.add(name);
      changed = true;
    }
  }
  const computed = [
    ...new Set(
      published
        .filter(({ name, value }) => (value === name ? identifies.has(name) : keyed(value) || callsIdentity(value)))
        .map(({ name }) => name)
        .filter((name) => clientHeldNames.has(name)),
    ),
  ].sort();
  return {
    path: relative(HOST_ROOT, path).split(sep).join("/"),
    drawn: [...drawn].sort(),
    identities: [...identifies].sort(),
    computed,
  };
}

const readings = productionSources(SOURCE_ROOT)
  .map(readModule)
  .filter((reading): reading is ModuleReading => reading !== undefined);
const examined = readings.filter((reading) => reading.identities.length > 0);
const offenders = examined.filter((reading) => reading.computed.length > 0);

function populationReading(): string {
  const lines = [
    `host_identity_durability_reading:production_sources=${productionSources(SOURCE_ROOT).length}`,
    `host_identity_durability_reading:modules_binding_a_runtime_draw=${readings.length}`,
    `host_identity_durability_reading:modules_deriving_an_identity=${examined.length}`,
    `host_identity_durability_reading:client_held_names=${[...clientHeldNames].sort().join(",")}`,
  ];
  for (const reading of examined)
    lines.push(
      `host_identity_durability_reading:module=${reading.path}:drawn=${reading.drawn.join(",")}:computed=${reading.computed.join(",") || "none"}`,
    );
  return lines.join("\n");
}

test("the gate reads its population from the contract and the sources, and examines a non-empty set", () => {
  process.stderr.write(`${populationReading()}\n`);
  assert.ok(
    clientHeldNames.size > 0,
    `no client-held identity name is declared by ${join("tavern", "browser-contract", "index.ts")}: a field produced by a reply and carried back by a request is what this gate holds, and an empty set would compare nothing against nothing`,
  );
  assert.ok(
    readings.length > 0,
    "no production module binds a value drawn with randomBytes/randomUUID: the scan reached no source, so a clean verdict would mean nothing",
  );
  assert.ok(
    examined.length > 0,
    `of ${readings.length} module(s) binding a runtime draw, none derives an identity with a digest - the derivation this gate holds is gone, so restate or remove it rather than reading green over an empty set`,
  );
});

test("no browser-held identity is computed from a value drawn at runtime, unless its lifetime is declared", () => {
  const undeclared = offenders.flatMap((reading) =>
    reading.computed
      .filter((name) => !(DECLARED_LIFETIMES[reading.path]?.names ?? []).includes(name))
      .map(
        (name) =>
          `${reading.path}: \`${name}\` is a client-held identity (the contract produces it and a command sends it back) computed from a value drawn at runtime (${reading.drawn.join(", ")}), so it is re-keyed whenever this module runs - a browser holding it across a mount rotation or a Host restart is refused for a row that did not change. Derive it from the durable subject it names (host/src/tavern/memory-management/memory-management.ts), or declare its lifetime in DECLARED_LIFETIMES with the thing it names and the refusal a stale one earns`,
      ),
  );
  assert.deepEqual(undeclared, []);
});

test("every declared lifetime still explains a value the scan actually reaches", () => {
  const stale = Object.entries(DECLARED_LIFETIMES).flatMap(([path, declaration]) => {
    const reading = examined.find((candidate) => candidate.path === path);
    if (reading === undefined)
      return [
        `${path}: declared in DECLARED_LIFETIMES, but the scan finds no runtime-drawn identity there any more - the exemption outlived the code it excused, so delete it`,
      ];
    return declaration.names
      .filter((name) => !reading.computed.includes(name))
      .map(
        (name) =>
          `${path}: \`${name}\` is declared as naming ${declaration.names_}, but nothing in that module computes it from a runtime draw any more - delete the declaration`,
      );
  });
  assert.deepEqual(stale, []);
  // The declarations are non-empty for the same reason the populations above are: an expiry check over an
  // empty table passes without looking at anything.
  assert.ok(Object.keys(DECLARED_LIFETIMES).length > 0, "DECLARED_LIFETIMES is empty");
});

test("each declared lifetime is a thing that dies with the process, and says how a stale value is refused", () => {
  for (const [path, declaration] of Object.entries(DECLARED_LIFETIMES)) {
    assert.ok(declaration.names.length > 0, `${path}: declares no identity names`);
    // Both halves have to be stated: what the value names, and what a holder of a dead one is answered.
    assert.ok(declaration.names_.length > 40, `${path}: names_ does not say what the value names`);
    assert.ok(declaration.staleRefusal.length > 40, `${path}: staleRefusal does not say how a stale value is refused`);
  }
});
