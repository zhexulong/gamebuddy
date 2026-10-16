/**
 * One opaque value has one declared shape, and every HTTP router agrees with it.
 *
 * The contract declares what an opaque handle is twice over: `OPAQUE_HANDLE_PATTERN`
 * (`^[A-Za-z0-9_-]{22,128}$`) and the `OpaqueHandle` schema's minLength/maxLength, and every
 * handle-addressed route binds its path parameter to that schema (`ConnectionPath`,
 * `CompanionPath`, `ImportPath`, `:chatHandle`, `:turnHandle`). A router that matches a
 * *narrower* length range accepts a handle the contract calls legal at the path level and then
 * answers the router's own "no such operation" 404 instead of the handler's bounded
 * not-found answer - and the drift is silent, because everything the Host mints is 43
 * characters, so no live path ever exercises the declared edges. Exactly that was live: five
 * matchers in `tavern-management-dialogue-web.ts` accepted only `{43}`, while a 22- or
 * 128-character handle - both declared legal - fell through the router.
 *
 * So this gate reads the declared shape OUT of the contract's source (it never re-types a
 * range) and holds three things against it:
 *
 *  1. the contract itself: `OpaqueHandle`'s minLength/maxLength ARE the range inside
 *     `OPAQUE_HANDLE_PATTERN`, that pattern IS the `pattern` the schema names, and the
 *     pattern's character class is exactly `BASE64URL_ALPHABET` (a handle the pattern accepts
 *     but the canonical-base64url format refuses would be contract-legal and unroutable at
 *     once);
 *  2. every opaque-shape literal in a module that matches a `/api/tavern/v1/` request path is
 *     one the contract declares - a module at the browser boundary may not invent a fourth
 *     bound (this is what names the file when a handle pattern drifts);
 *  3. every contract route whose path declares a parameter: some router pattern matches it with
 *     the parameter filled by a handle of the declared minimum length, by one of the declared
 *     maximum length, and NOT by one longer than the maximum. This is the handle-specific
 *     agreement, and it is also what keeps the gate non-vacuous - a router that lost its
 *     matcher, or a contract route that gained a parameter, fails here by name instead of
 *     passing on an empty scan.
 *
 * Deliberately out of scope: `tavern/connection-store.ts`'s `CONNECTION_ID_PATTERN` is `{43}`
 * and stays `{43}`. It validates ids the store itself wrote into its durable document
 * (`isConnectionId` is used only by the document reader), so it must stay exactly as wide as
 * its own mint, not as wide as what a browser may send. It is not a router module (it matches
 * no request path), so the scan below cannot reach it.
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
const CONTRACT_SOURCE = join(SOURCE_ROOT, "tavern", "browser-contract", "index.ts");
const REQUEST_PATH = "/api/tavern/v1/";

/** An opaque-shape literal: `[A-Za-z0-9_-]{n}` or `[A-Za-z0-9_-]{n,m}`. */
const OPAQUE_SHAPE_LITERAL = /\[A-Za-z0-9_-\]\{\d+(?:,\d+)?\}/gu;
const HANDLE_PATTERN_DECLARATION = /const OPAQUE_HANDLE_PATTERN = "([^"]*)";/u;
const HANDLE_SCHEMA_DECLARATION = /const OpaqueHandle = Type\.String\(\{([^}]*)\}\)/u;
const DECLARED_PATTERN_CONSTANTS = /const ([A-Z_]+_PATTERN) = "([^"]*)";/gu;
const BOUNDED_CHARACTER_CLASS = /^\^(\[[^\]]+\])\{(\d+),(\d+)\}\$$/u;
const ALPHABET_DECLARATION = /const BASE64URL_ALPHABET = "([^"]*)";/u;

const contractSource = readFileSync(CONTRACT_SOURCE, "utf8");

/** Every opacity bound the contract declares, as the exact literal a module must spell. */
const declaredOpaqueShapes: ReadonlySet<string> = new Set(
  [...contractSource.matchAll(DECLARED_PATTERN_CONSTANTS)].flatMap((declaration) =>
    [...declaration[2]!.matchAll(OPAQUE_SHAPE_LITERAL)].map((match) => match[0]),
  ),
);

const handleShape = ((): Readonly<{
  characterClass: string;
  minLength: number;
  maxLength: number;
  literal: string;
}> => {
  const declaredPattern = HANDLE_PATTERN_DECLARATION.exec(contractSource);
  assert.ok(declaredPattern !== null, `${CONTRACT_SOURCE}: OPAQUE_HANDLE_PATTERN is not declared`);
  const bounded = BOUNDED_CHARACTER_CLASS.exec(declaredPattern[1]!);
  assert.ok(
    bounded !== null,
    `${CONTRACT_SOURCE}: OPAQUE_HANDLE_PATTERN ${declaredPattern[1]} is not a bounded character class quantifier`,
  );
  const characterClass = bounded[1]!;
  const minLength = Number(bounded[2]);
  const maxLength = Number(bounded[3]);
  assert.ok(minLength < maxLength, `${CONTRACT_SOURCE}: OPAQUE_HANDLE_PATTERN declares an empty range`);

  const declaredSchema = HANDLE_SCHEMA_DECLARATION.exec(contractSource);
  assert.ok(declaredSchema !== null, `${CONTRACT_SOURCE}: OpaqueHandle is not declared as a Type.String`);
  const schemaBody = declaredSchema[1]!;
  assert.equal(
    /pattern:\s*([A-Za-z_$][\w$]*)/u.exec(schemaBody)?.[1],
    "OPAQUE_HANDLE_PATTERN",
    `${CONTRACT_SOURCE}: OpaqueHandle does not name the OPAQUE_HANDLE_PATTERN this gate read`,
  );
  assert.equal(
    Number(/minLength:\s*(\d+)/u.exec(schemaBody)?.[1]),
    minLength,
    `${CONTRACT_SOURCE}: OpaqueHandle minLength disagrees with OPAQUE_HANDLE_PATTERN`,
  );
  assert.equal(
    Number(/maxLength:\s*(\d+)/u.exec(schemaBody)?.[1]),
    maxLength,
    `${CONTRACT_SOURCE}: OpaqueHandle maxLength disagrees with OPAQUE_HANDLE_PATTERN`,
  );

  const alphabet = new Set((ALPHABET_DECLARATION.exec(contractSource)?.[1] ?? "").split(""));
  assert.deepEqual(
    [...expandCharacterClass(characterClass)].sort(),
    [...alphabet].sort(),
    `${CONTRACT_SOURCE}: ${characterClass} is not BASE64URL_ALPHABET`,
  );
  return Object.freeze({
    characterClass,
    minLength,
    maxLength,
    literal: `${characterClass}{${minLength},${maxLength}}`,
  });
})();

/** `[A-Za-z0-9_-]` as the characters it denotes, so the class can be compared to a written alphabet. */
function expandCharacterClass(characterClass: string): readonly string[] {
  const body = characterClass.slice(1, -1);
  const characters: string[] = [];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index + 1] === "-" && index + 2 < body.length) {
      for (let code = body.charCodeAt(index); code <= body.charCodeAt(index + 2); code += 1)
        characters.push(String.fromCharCode(code));
      index += 2;
      continue;
    }
    characters.push(body[index]!);
  }
  return characters;
}

/** Every `*.ts` a production build compiles: tests and fixtures are not routers. */
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

type Literal = Readonly<{ kind: "regex" | "string"; text: string }>;

/** Every regex and string literal body: the only two spellings a bound has in this codebase. */
function literalsIn(path: string): readonly Literal[] {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const literals: Literal[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isRegularExpressionLiteral(node)) {
      // A regex literal's text keeps its `\/` escapes; one `/` is the path it matches either way.
      literals.push({ kind: "regex", text: node.text.replaceAll("\\/", "/") });
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.push({ kind: "string", text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return literals;
}

const discoveredByModule = productionSources(SOURCE_ROOT).map((path) => ({
  path: relative(HOST_ROOT, path).split(sep).join("/"),
  literals: literalsIn(path),
}));
/** A router: a module that matches a `/api/tavern/v1/` request path. */
const routerModules = discoveredByModule.filter((module) =>
  module.literals.some((literal) => literal.kind === "regex" && literal.text.includes(REQUEST_PATH)),
);
const opaqueLiterals = routerModules.flatMap((module) =>
  module.literals.flatMap((literal) =>
    [...literal.text.matchAll(OPAQUE_SHAPE_LITERAL)].map((match) => ({ path: module.path, literal: match[0] })),
  ),
);
const routerPatterns = routerModules.flatMap((module) =>
  module.literals
    .filter((literal) => literal.kind === "regex" && literal.text.includes(REQUEST_PATH))
    .map((literal) => {
      const parts = /^\/([\s\S]*)\/([a-z]*)$/u.exec(literal.text);
      assert.ok(parts !== null, `${module.path}: ${literal.text} is not a readable regex literal`);
      return new RegExp(parts[1]!, parts[2]!);
    }),
);

/** The contract's own path with every declared parameter filled by one probe handle. */
function pathWithHandle(contractPath: string, handle: string): string {
  return contractPath
    .split("/")
    .map((segment) => (segment.startsWith(":") ? handle : segment))
    .join("/");
}

test("the declared handle shape is read out of the contract, not re-typed here", () => {
  assert.equal(handleShape.literal, `${handleShape.characterClass}{${handleShape.minLength},${handleShape.maxLength}}`);
  assert.equal(declaredOpaqueShapes.has(handleShape.literal), true);
  // The gate must not be comparing an empty scan to itself.
  assert.ok(routerModules.length > 0, "no module matches a /api/tavern/v1/ request path");
  assert.deepEqual(
    [...new Set(opaqueLiterals.map((entry) => entry.path))].sort(),
    routerModules.map((module) => module.path).sort(),
    "a module matches an /api/tavern/v1/ request path without declaring any opacity bound as a literal",
  );
});

test("no router module invents an opacity bound the contract does not declare", () => {
  const invented = opaqueLiterals
    .filter((entry) => !declaredOpaqueShapes.has(entry.literal))
    .map((entry) => `${entry.path}: ${entry.literal} (the contract declares ${[...declaredOpaqueShapes].join(", ")})`);
  assert.deepEqual(invented, []);
});

test("every contract route with a path parameter accepts the declared handle range, and no longer one", () => {
  const shortest = "A".repeat(handleShape.minLength);
  const longest = "A".repeat(handleShape.maxLength);
  const tooLong = "A".repeat(handleShape.maxLength + 1);
  const parameterisedPaths = TavernBrowserContractV1.routes
    .map((route) => route.path)
    .filter((path) => path.includes("/:"));
  assert.ok(parameterisedPaths.length > 0, "the contract declares no parameterised route to check");

  const failures: string[] = [];
  for (const contractPath of parameterisedPaths) {
    for (const [label, handle] of [
      [`${handleShape.minLength}`, shortest],
      [`${handleShape.maxLength}`, longest],
    ] as const) {
      if (!routerPatterns.some((pattern) => pattern.test(pathWithHandle(contractPath, handle))))
        failures.push(
          `${contractPath}: no router pattern in ${routerModules.map((module) => module.path).join(", ")} matches a ${label}-character handle`,
        );
    }
    if (routerPatterns.some((pattern) => pattern.test(pathWithHandle(contractPath, tooLong))))
      failures.push(`${contractPath}: a router pattern matches a ${handleShape.maxLength + 1}-character handle`);
  }
  assert.deepEqual(failures, []);
});
