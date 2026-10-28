/**
 * The totality audit: the classes of defect that no test names, enumerated from
 * the authorities instead of from a list somebody remembered to update.
 *
 * Every rule below starts from a *declaration* - a contract schema, a route
 * descriptor, a problem union, a catalogue, a cap constant - reads the rule's
 * own set out of that declaration, and then walks it. Adding a capability
 * therefore fails this audit the moment it is declared, which is the whole
 * point: the owner's question was "can we expose all the problems at once,
 * instead of finding a few at a time", and the honest answer is that a fix for
 * one instance is not a fix for the class.
 *
 * What each class derives, and what it honestly cannot:
 *
 *  - `bounds` reads every `maxItems`/`maxLength`/`maxProperties` in both browser
 *    contracts and pairs it with the writer's own capacity constant. A cap the
 *    wire enforces more tightly than the writer fills (`truncated`) and a cap
 *    the writer enforces more tightly than the wire allows (`refused`) are both
 *    real: the first loses rows silently, the second refuses data the published
 *    contract says is acceptable. The pairing is by name and therefore
 *    incomplete - a writer that bounds a collection with a differently-named
 *    constant is reported as `unpaired`, not as clean. That count is printed.
 *
 *  - `refusal` asks the other half of the same question: a capacity that is
 *    enforced must be refused *before* the write lands and must name the code
 *    that tells the player why. A cap compared with no bounded code in its
 *    refusal branch is a limit the player meets as a generic failure.
 *
 *  - `read-path` is the class that blanked four surfaces in one day: a service
 *    reads its own data, validates it against the published contract, and fails
 *    closed on the mismatch, so one row over a cap removes the whole surface.
 *    The acceptable shapes are a named actionable state or a row-level
 *    degradation. This class finds every fail-closed self-validation site and
 *    asks whether the projection can exceed the schema it validates against.
 *
 *  - `codes` walks both problem unions (tavern and game), both client mirrors,
 *    and the handlers that produce them. A code a handler invents is a code no
 *    client can classify; a mirror that is a stale subset reads a typed refusal
 *    as protocol corruption.
 *
 *  - `routes` derives the route-id list from the contract's descriptor table and
 *    checks it against the dispatchers that actually serve a route.
 *
 *  - `fields` walks every property both contracts declare and asks whether a
 *    Host source produces it and a browser source reads it. It is a name-level
 *    approximation and says so: it reports its own unmatched count, and it
 *    cannot see a field the Host writes under a different name.
 *
 *  - `catalogue`, `prompt`, `promises`, `hygiene` and `duplication` reuse the existing gates
 *    where one exists rather than keeping a second copy of the same reading
 *    (`i18n-parity-gate`, `enum-leak-gate`, `problem-code-gate`,
 *    `memory-notebook-promise-gate`) and add the direction nothing covered: the
 *    catalogue text itself may not carry an engineering artefact, a promise
 *    must name something a player can reach, and a rule with more than one
 *    consumer must be one function those consumers consult rather than several
 *    places that each decide it again.
 *
 * Reporting shape: one summary line, then violations grouped by class and
 * ranked by "a player reaches it and it fails badly". Every violation carries
 * `path:line`. A class that reports by *kind* (today only `hygiene`, whose
 * findings are all instances of one pattern) prints one line per kind with its
 * count and at most ten of its sites, because a list of identical complaints is
 * a report nobody reads; `--verbose` (or `--all-findings`) prints
 * every site, and `--json` carries every site either way. Aggregation is a
 * reading aid, never a smaller total: the counts are the counts that were
 * found. `--only=<class>` runs one class; `--json` emits the same facts as
 * data. Exit status is non-zero when any blocking class has a violation.
 *
 * A gate that is wrong is worse than no gate, so each class's own test
 * (`audit-totality.test.mjs`) injects one violation into a scratch copy of the
 * tree and shows the class red, then green again. The classes are pure functions
 * of a root directory so that proof needs no monkey-patching.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// TypeScript is a per-package dependency here (`host/node_modules`), so it is resolved through the Host's own
// manifest rather than from the repository root, where no `typescript` is installed.
const requireFromHost = createRequire(new URL("../host/package.json", import.meta.url));
const ts = requireFromHost("typescript");

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(HERE, "..");

const HOST = ["host", "src"];
const WEB = ["dialogue-web", "src"];

const TAVERN_CONTRACT = ["host", "src", "tavern", "browser-contract", "index.ts"];
const GAME_CONTRACT = ["host", "src", "game-browser-contract", "index.ts"];

/** Test-only source never produces, reads, or bounds a production fact. */
const TEST_PATH = /(\.test\.(?:ts|tsx)$|[\\/](?:test-support|test-fixtures|__tests__)[\\/]|\.test-support\.ts$)/u;
const SOURCE_FILE = /\.(?:ts|tsx)$/u;
const SOURCE_EXT = /\.(?:ts|tsx)$/u;

// ---------------------------------------------------------------------------
// Source reading
// ---------------------------------------------------------------------------

function relativeTo(root, file) {
  return relative(root, file).replaceAll("\\", "/");
}

/** A `path:line` a reader can open. */
function at(root, node, sourceFile, file) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${relativeTo(root, file)}:${line + 1}`;
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Parsed sources by absolute path, so the readers share one parse per file. */
class Sources {
  constructor(root) {
    this.root = root;
    this.cache = new Map();
  }

  path(...segments) {
    return join(this.root, ...segments);
  }

  source(file) {
    const cached = this.cache.get(file);
    if (cached !== undefined) return cached;
    const text = readFileSync(file, "utf8");
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    this.cache.set(file, parsed);
    return parsed;
  }

  /** Every non-test TypeScript source under one of the given roots. */
  files(...roots) {
    return this.enumerate(roots, false);
  }

  /** Every TypeScript source, tests included - the importer scan needs them. */
  allFiles(...roots) {
    return this.enumerate(roots, true);
  }

  enumerate(roots, includeTests) {
    const found = [];
    const visit = (directory) => {
      let entries;
      try {
        entries = readdirSync(directory);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry === "node_modules" || entry === "dist" || entry === "dist-test" || entry.startsWith(".")) continue;
        const full = join(directory, entry);
        const stats = statSync(full);
        if (stats.isDirectory()) visit(full);
        else if (SOURCE_FILE.test(entry) && (includeTests || !TEST_PATH.test(full))) found.push(full);
      }
    };
    for (const directory of roots) visit(directory);
    return found.sort();
  }
}

/** `4 * 1024`, `1_048_576`, `MAX_X` - resolved to a number, or null. */
function resolveNumber(node, sourceFile, seen = new Set()) {
  if (node === undefined || node === null) return null;
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll("_", ""));
  if (ts.isParenthesizedExpression(node)) return resolveNumber(node.expression, sourceFile, seen);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const inner = resolveNumber(node.operand, sourceFile, seen);
    return inner === null ? null : -inner;
  }
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return null;
    const initializer = constInitializer(sourceFile, node.text);
    if (initializer === undefined) return null;
    return resolveNumber(initializer, sourceFile, new Set([...seen, node.text]));
  }
  if (ts.isBinaryExpression(node)) {
    const left = resolveNumber(node.left, sourceFile, seen);
    const right = resolveNumber(node.right, sourceFile, seen);
    if (left === null || right === null) return null;
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.AsteriskToken:
        return left * right;
      case ts.SyntaxKind.PlusToken:
        return left + right;
      case ts.SyntaxKind.MinusToken:
        return left - right;
      case ts.SyntaxKind.SlashToken:
        return right === 0 ? null : left / right;
      default:
        return null;
    }
  }
  return null;
}

function constInitializer(sourceFile, name) {
  let found;
  walk(sourceFile, (node) => {
    if (found !== undefined) return;
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== name) return;
    found = node.initializer;
  });
  return found;
}

/** Unwraps `as const`, `satisfies T`, `Object.freeze(...)` and parentheses. */
function unwrap(node) {
  let current = node;
  for (;;) {
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "freeze" &&
      current.arguments.length === 1
    ) {
      current = current.arguments[0];
      continue;
    }
    return current;
  }
}

/** Splits an identifier or a phrase into lowercase concept words. */
function conceptWords(text) {
  const spaced = text
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll(/[^A-Za-z0-9]+/gu, " ")
    .toLowerCase();
  return spaced.split(" ").filter((word) => word.length > 0);
}

const SINGULAR = (word) =>
  word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.endsWith("s") ? word.slice(0, -1) : word;

/** Words that carry no concept: a cap named after them says nothing. */
const GENERIC_WORDS = new Set([
  "max",
  "min",
  "limit",
  "length",
  "chars",
  "bytes",
  "count",
  "index",
  "internal",
  "service",
  "services",
  "store",
  "management",
  "manager",
  "schema",
  "schemas",
  "v1",
  "v2",
  "type",
]);

// ---------------------------------------------------------------------------
// Class: bounds
// ---------------------------------------------------------------------------

const CAP_KINDS = ["maxItems", "maxLength", "maxProperties"];

/**
 * Every schema a contract declares, with its own properties and their caps.
 * A schema is a `const XSchema = strictObject({...})` / `Type.Object({...})`
 * binding; a property's caps are the `maxItems`/`maxLength`/`maxProperties`
 * inside that property's own initializer, so a nested schema's cap is read once,
 * where it is declared, rather than inherited by its parent.
 */
function contractSchemas(sources, file) {
  const sourceFile = sources.source(file);
  const schemas = [];
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    const initializer = node.initializer === undefined ? undefined : unwrap(node.initializer);
    if (initializer === undefined || !ts.isCallExpression(initializer)) return;
    const callee = initializer.expression.getText(sourceFile);
    if (callee !== "strictObject" && callee !== "Type.Object") return;
    const properties = initializer.arguments[0];
    if (properties === undefined || !ts.isObjectLiteralExpression(properties)) return;
    const name = node.name.text;
    const entries = [];
    const fieldNames = [];
    for (const property of properties.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const propertyName = property.name.getText(sourceFile).replaceAll(/["']/gu, "");
      fieldNames.push({ name: propertyName, where: at(sources.root, property, sourceFile, file) });
      for (const cap of CAP_KINDS) {
        let capNode;
        walk(property.initializer, (inner) => {
          if (capNode !== undefined) return;
          if (ts.isPropertyAssignment(inner) && inner.name.getText(sourceFile) === cap) capNode = inner;
        });
        if (capNode === undefined) continue;
        const limit = resolveNumber(capNode.initializer, sourceFile);
        entries.push({
          schema: name,
          property: propertyName,
          kind: cap,
          limit,
          expression: capNode.initializer.getText(sourceFile),
          where: at(sources.root, capNode, sourceFile, file),
          elementSchema: arrayElementSchema(property.initializer, sourceFile),
        });
      }
    }
    schemas.push({ name, file, where: at(sources.root, node, sourceFile, file), properties: entries, fieldNames });
  });
  return schemas;
}

/** The element schema name of a `Type.Array(XSchema, ...)` property. */
function arrayElementSchema(initializer, sourceFile) {
  let found = null;
  walk(initializer, (node) => {
    if (found !== null) return;
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression.getText(sourceFile);
    if (callee !== "Type.Array" && callee !== "Array") return;
    const first = node.arguments[0];
    if (first !== undefined && ts.isIdentifier(first)) found = first.text;
  });
  return found;
}

/**
 * Every capacity constant a Host source declares, as `{name, limit, file,
 * where}`. Only a numeric module constant named as a cap qualifies: a `MAX_*`
 * timeout or a byte guard is not a collection's capacity and is excluded by
 * measurement, not by a list.
 */
function hostCapConstants(sources) {
  const found = [];
  for (const file of sources.files(sources.path(...HOST))) {
    if (TEST_PATH.test(file)) continue;
    const sourceFile = sources.source(file);
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
        const name = declaration.name.text;
        if (!/(?:^MAX_|_MAX$|_LIMIT$)/u.test(name)) continue;
        if (/_MS$|_BYTES$/u.test(name)) continue;
        const limit = resolveNumber(declaration.initializer, sourceFile);
        if (limit === null) continue;
        found.push({
          name,
          limit,
          file,
          where: at(sources.root, declaration, sourceFile, file),
          measuresCharacters: /LENGTH|CHARS/u.test(name),
          concept: new Set(
            conceptWords(name)
              .filter((word) => !GENERIC_WORDS.has(word))
              .map(SINGULAR),
          ),
          fileWords: new Set(
            conceptWords(relativeTo(sources.root, file).split("/").at(-1)?.replace(SOURCE_EXT, "") ?? "")
              .filter((word) => !GENERIC_WORDS.has(word))
              .map(SINGULAR),
          ),
        });
      }
    }
  }
  return found;
}

/**
 * How well a writer's constant names the contract's cap. Higher is more specific; zero means "not this
 * collection", and the cap is then reported unpaired instead of compared against a guess.
 *
 * The constant has to name the **property**, because the property is the collection the cap counts.
 * A concept word in common is not enough on its own: `MAX_CONNECTIONS` shares `connection` with
 * `TavernConnectionThinkingLevelV1Schema`, whose `maxItems: 7` counts thinking levels, and
 * `MAX_SUMMARY` shares `summary` with `StCardImportFieldSummaryV1Schema`, whose array holds one
 * summary per card field. Pairing either would compare two different collections and print a
 * violation no writer can act on.
 */
function capAffinity(entry, constant) {
  if (entry.limit === null || constant.concept.size === 0) return 0;
  const propertyWords = new Set(
    conceptWords(entry.property)
      .filter((word) => !GENERIC_WORDS.has(word))
      .map(SINGULAR),
  );
  const schemaWords = new Set(
    conceptWords(entry.schema)
      .filter((word) => !GENERIC_WORDS.has(word))
      .map(SINGULAR),
  );
  // A constant that names more concepts than the property does is not this
  // property's writer: `MAX_NOTE_TITLE_LENGTH` says nothing about `notes`.
  for (const word of constant.concept) if (!propertyWords.has(word)) return 0;
  let fileFit = 0;
  for (const word of constant.fileWords) {
    const matched = [...schemaWords].some((candidate) => candidate.includes(word) || word.includes(candidate));
    if (matched) fileFit += 1;
  }
  // A constant that names more of the property is a closer name; a constant whose own module is
  // named after the schema breaks the tie between two that name it equally well.
  return constant.concept.size * 10 + fileFit;
}

/** Pairs each contract cap with the single writer constant that best names it. */
function pairCaps(caps, constants) {
  const pairs = [];
  const unpaired = [];
  for (const entry of caps) {
    const scored = constants
      .map((constant) => ({ constant, score: capAffinity(entry, constant) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);
    if (scored.length === 0) {
      unpaired.push(entry);
      continue;
    }
    const best = scored[0];
    const ambiguous = scored.filter((candidate) => candidate.score === best.score);
    pairs.push({ entry, constant: best.constant, tie: ambiguous.length > 1 });
  }
  return { pairs, unpaired };
}

function runBounds(sources) {
  const caps = [
    ...contractSchemas(sources, sources.path(...TAVERN_CONTRACT)).flatMap((schema) => schema.properties),
    ...contractSchemas(sources, sources.path(...GAME_CONTRACT)).flatMap((schema) => schema.properties),
  ];
  const constants = hostCapConstants(sources);
  const { pairs, unpaired } = pairCaps(caps, constants);
  const violations = [];
  const notes = [];
  let compared = 0;
  for (const { entry, constant, tie } of pairs) {
    if (tie) {
      notes.push(
        `${entry.where} ${entry.schema}.${entry.property} ${entry.kind}=${entry.limit} names ${constant.name} ambiguously; not compared`,
      );
      continue;
    }
    // A `maxLength` measures characters and a `maxItems` measures rows; only the
    // same measure can be compared.
    const measuresRows = entry.kind !== "maxLength";
    if (measuresRows === constant.measuresCharacters) continue;
    compared += 1;
    if (entry.limit === constant.limit) continue;
    if (entry.limit > constant.limit) {
      violations.push({
        rank: 2,
        where: `${entry.where} vs ${constant.where}`,
        message: `${entry.schema}.${entry.property} ${entry.kind}=${entry.limit} but the writer caps it at ${constant.limit} (${constant.name}); a request inside the published bound is refused`,
      });
    } else {
      violations.push({
        rank: 2,
        where: `${entry.where} vs ${constant.where}`,
        message: `${entry.schema}.${entry.property} ${entry.kind}=${entry.limit} but the writer fills up to ${constant.limit} (${constant.name}); the wire can only truncate what the writer allows`,
      });
    }
  }

  // One collection, declared twice with two different caps, is the drift no single-schema check can see:
  // the read schema can project a record its own command schema refuses, or keep one the other cannot fill.
  //
  // The collection is named by its property AND by what it holds. Grouping by the element type alone
  // compares two different collections that happen to share a row shape: `deniedActionFamilies` (64) and
  // `deniedActions` (512) both carry `SAFE_ID`, and the writer states both caps on purpose
  // (`STARDEW_DENIED_FAMILY_LIMIT`, `STARDEW_DENIED_ACTION_LIMIT`, one per collection). Two arrays of one
  // element type are not one collection, so they are not one cap.
  const byCollection = new Map();
  for (const entry of caps) {
    if (entry.elementSchema === null) continue;
    const key = `${entry.property}\u0000${entry.elementSchema}`;
    byCollection.set(key, [...(byCollection.get(key) ?? []), entry]);
  }
  for (const entries of byCollection.values()) {
    const limits = new Set(entries.map((entry) => entry.limit));
    if (limits.size <= 1) continue;
    violations.push({
      rank: 2,
      where: entries.map((entry) => entry.where).join(" "),
      message: `${entries[0].property} (${entries[0].elementSchema} rows) is capped ${limits.size} different ways in ${entries.length} schema(s) (${entries.map((entry) => `${entry.schema}=${entry.limit ?? entry.expression}`).join(", ")}); one of them truncates`,
    });
  }

  const unresolved = caps.filter((entry) => entry.limit === null);
  const unpairedRows = unpaired.length;
  notes.push(
    `bounds: ${caps.length} declared cap(s), ${pairs.length} paired with a writer constant (${compared} compared, ${pairs.length - compared} of a different measure), ${unpairedRows} unpaired, ${unresolved.length} whose limit is not a resolvable number`,
  );
  if (unpairedRows > 0)
    notes.push(
      `bounds: an unpaired cap is NOT clean - it means no Host constant names it, so nothing proves the writer stops where the contract says: ${unpaired
        .slice(0, 8)
        .map((entry) => `${entry.schema}.${entry.property}=${entry.limit ?? entry.expression}@${entry.where}`)
        .join(", ")}${unpairedRows > 8 ? `, +${unpairedRows - 8} more` : ""}`,
    );
  return { declared: caps.length, violations, notes };
}

// ---------------------------------------------------------------------------
// Class: refusal
// ---------------------------------------------------------------------------

/** A bounded token: the shape every problem code has. */
const BOUNDED_CODE = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * The string a refusal names, if the branch names one at all.
 *
 * A refusal is spelled three ways in this tree: a `{ code: "…" }` payload, a `sendProblem(response, 400, "…")`
 * call, and a thrown error. The thrown error is the one the rule used to miss: `throw new Error("notes_too_many")`
 * is a `NewExpression` (not a call), and `throw new TavernConnectionInputError("connection_limit_reached")`
 * names its own class. Both put the code in the first string argument of a constructor or function whose name
 * ends in `Error`/`Failure`, which is the one convention every thrower here follows.
 */
function namedCodeIn(node, sourceFile) {
  let found = null;
  const namedByThrower = (callee) => {
    const text = callee.getText(sourceFile);
    return /(?:Error|Failure)$/u.test(text);
  };
  // A refusal is named by a *reason*, and this tree writes reasons three ways: a plain string, a no-substitution
  // template, and a template with the offending value appended (`plan_cap_exceeded:17`). The audit wants to know that
  // the refusal says something specific; a `:value` suffix does not make it less specific, so the static head is the
  // name. Reading only plain strings is how this class reported "0 name their code" on a tree full of named refusals.
  const reasonIn = (expression) => {
    if (ts.isStringLiteral(expression)) return expression.text;
    if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
    if (ts.isTemplateExpression(expression)) return expression.head.text;
    return null;
  };
  const codeIn = (expression) => {
    const reason = reasonIn(expression);
    if (reason === null) return null;
    const head = reason.split(":")[0]?.trim() ?? "";
    return BOUNDED_CODE.test(head) ? head : reason.trim().length > 0 && BOUNDED_CODE.test(reason) ? reason : null;
  };
  // The helpers that refuse on behalf of their caller, by name.
  const namedByRefuser = (callee) => /^(?:refuse|fail|reject)/u.test(callee.getText(sourceFile));
  walk(node, (inner) => {
    if (found !== null) return;
    if (ts.isPropertyAssignment(inner) && inner.name.getText(sourceFile) === "code") {
      const code = codeIn(inner.initializer);
      if (code !== null) found = code;
    }
    if (
      ts.isCallExpression(inner) &&
      ts.isIdentifier(inner.expression) &&
      (/sendProblem|sendBootstrapProblem|sendLifecycleProblem|refuseBootstrap/u.test(inner.expression.text) ||
        namedByRefuser(inner.expression))
    ) {
      for (const argument of inner.arguments) {
        const code = codeIn(argument);
        if (code !== null) found = code;
      }
    }
    const thrower =
      (ts.isNewExpression(inner) || ts.isCallExpression(inner)) && namedByThrower(inner.expression) ? inner : null;
    if (thrower !== null)
      for (const argument of thrower.arguments ?? []) {
        const code = codeIn(argument);
        if (code !== null) found = code;
      }
  });
  return found;
}

function enclosingFunction(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    )
      return current;
    if (ts.isSourceFile(current)) return null;
  }
  return null;
}

/**
 * The nearest enclosing function the module *declared* by name, with its name and the return type it
 * declares.
 *
 * A `const`-bound arrow is one of those: `const isX = (value: string): boolean => …` is a predicate this
 * tree writes, and reading it is the difference between "the caller names this refusal" and "the player
 * meets a generic failure". An anonymous callback (`value.every((item) => …)`) is not - the question it
 * answers is the named function's, not its own - so it is scanned past, not returned.
 */
function declaredFunction(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) return current;
    if (ts.isFunctionExpression(current) && current.name !== undefined) return current;
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const binding = current.parent;
      if (ts.isVariableDeclaration(binding) && ts.isIdentifier(binding.name))
        return { name: binding.name, type: current.type };
      continue;
    }
    if (ts.isSourceFile(current)) return null;
  }
  return null;
}

/**
 * A function that answers a question instead of performing the write: a name this tree uses for predicates
 * (`isX`/`hasX`/`canX`/`validateX`/`assertX`/`allowsX`), or a `boolean` / `value is T` return. Its refusal is named by
 * its caller, which is the one place a single refusal can be given one sentence. Counted, not failed - the audit
 * cannot see the caller's mapping from a predicate.
 */
function answersQuestion(fn) {
  if (fn === null) return false;
  const name = fn.name !== undefined && ts.isIdentifier(fn.name) ? fn.name.text : undefined;
  if (name !== undefined && /^(?:is|has|can|validate|assert|allows)/u.test(name)) return true;
  const type = fn.type;
  if (type === undefined) return false;
  return ts.isTypePredicateNode(type) || type.kind === ts.SyntaxKind.BooleanKeyword;
}

/** A function declared at module level, so a decision can be followed one hop into the helper that refuses. */
function localFunction(sourceFile, name) {
  for (const statement of sourceFile.statements)
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
  return null;
}

/**
 * The statement that decides what a failed capacity comparison means: the `if` that tests it, not the whole
 * function. A function with two refusals must not let one name the other. A comparison no `if` tests - a `filter`
 * callback, a ternary - is decided by the statement that carries it.
 */
function refusalScope(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isIfStatement(current)) return current.thenStatement;
    if (ts.isStatement(current)) return current;
    if (ts.isSourceFile(current)) return null;
  }
  return null;
}

/** The bounded code a decision names, including one hop into a module-level helper it calls (`fail()`). */
function decisionCode(deciding, sourceFile) {
  const own = namedCodeIn(deciding, sourceFile);
  if (own !== null) return own;
  let code = null;
  walk(deciding, (node) => {
    if (code !== null || !ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    const helper = localFunction(sourceFile, node.expression.text);
    if (helper !== null) code = namedCodeIn(helper, sourceFile);
  });
  return code;
}

/**
 * What a decision does with the comparison: refuse the operation, or narrow the value.
 *
 * A refusal is a `throw`, a `send*Problem`/`refuse*` call, or a helper that does one - the branch that stops the
 * operation, and the only place a bounded code belongs. A bound is a `break`, a `slice`/`filter`, or a `return` of
 * nothing: the payload is trimmed or dropped instead of the operation being refused. That is a truncation defect of
 * its own, not a limit the player meets as a generic failure, and this class reports it as a bound rather than as a
 * missing code.
 */
function decisionKind(deciding, sourceFile) {
  let narrows = false;
  let discards = false;
  walk(deciding, (node) => {
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) narrows = true;
    if (ts.isReturnStatement(node)) discards = true;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      /^(?:filter|slice)$/u.test(node.expression.name.text)
    )
      narrows = true;
  });
  return narrows ? "narrows" : discards ? "discards" : "refuses";
}

/**
 * Every comparison of a collection's length against a capacity constant, with the refusal the comparison leads to.
 * A capacity that is enforced without a named code is a limit the player meets as an unexplained failure.
 */
function runRefusal(sources) {
  const constants = hostCapConstants(sources);
  const byName = new Map(constants.map((constant) => [constant.name, constant]));
  const violations = [];
  const notes = [];
  const bounds = [];
  let comparisons = 0;
  let named = 0;
  let delegated = 0;
  let scopeless = 0;
  for (const file of sources.files(sources.path(...HOST))) {
    const sourceFile = sources.source(file);
    walk(sourceFile, (node) => {
      if (!ts.isBinaryExpression(node)) return;
      const left = node.left.getText(sourceFile);
      const right = node.right.getText(sourceFile);
      const constantEntry = [left, right].map((side) => byName.get(side.trim())).find((entry) => entry !== undefined);
      const lengthSide = [left, right].find((side) => /\.length$/u.test(side.trim()));
      if (constantEntry === undefined || lengthSide === undefined) return;
      comparisons += 1;
      if (enclosingFunction(node) === null) {
        scopeless += 1;
        return;
      }
      if (answersQuestion(declaredFunction(node))) {
        delegated += 1;
        return;
      }
      const deciding = refusalScope(node);
      const code = deciding === null ? null : decisionCode(deciding, sourceFile);
      if (code !== null) {
        named += 1;
        return;
      }
      const kind = deciding === null ? "refuses" : decisionKind(deciding, sourceFile);
      const where = at(sources.root, node, sourceFile, file);
      if (kind !== "refuses") {
        bounds.push({
          where,
          kind,
          constant: constantEntry.name,
          limit: constantEntry.limit,
          lengthSide: lengthSide.trim(),
        });
        return;
      }
      violations.push({
        rank: 2,
        where,
        message: `${constantEntry.name} (${constantEntry.limit}) is enforced on ${lengthSide.trim()} with no bounded code in the refusal; the player meets the ceiling as a generic failure`,
      });
    });
  }
  notes.push(
    `refusal: ${comparisons} capacity comparison(s) across ${constants.length} cap constant(s), ${named} name their code, ${delegated} answered by a predicate (named by its caller), ${bounds.length} bound the value instead of refusing it, ${scopeless} outside any function`,
  );
  for (const kind of ["narrows", "discards"]) {
    const ofKind = bounds.filter((bound) => bound.kind === kind);
    if (ofKind.length === 0) continue;
    notes.push(
      `refusal: NOT audited here - ${ofKind.length} comparison(s) ${kind === "narrows" ? "trim the collection (break/slice/filter)" : "discard the value (return null/undefined)"} instead of refusing the operation: ${ofKind
        .slice(0, 6)
        .map((bound) => `${bound.constant}@${bound.where}`)
        .join(", ")}${ofKind.length > 6 ? `, +${ofKind.length - 6} more` : ""}`,
    );
  }
  return { declared: constants.length, violations, notes };
}

// ---------------------------------------------------------------------------
// Class: read-path
// ---------------------------------------------------------------------------

/** `sendProblem`/`throw` remove the whole surface; a windowed list does not. */
function blankingShape(node, sourceFile) {
  let shape = null;
  walk(node, (inner) => {
    if (shape !== null) return;
    if (
      ts.isCallExpression(inner) &&
      ts.isIdentifier(inner.expression) &&
      /^send(?:Problem|BootstrapProblem|LifecycleProblem)$|^refuse/u.test(inner.expression.text)
    )
      shape = `${inner.expression.text}(${inner.arguments
        .map((argument) => argument.getText(sourceFile))
        .join(", ")
        .slice(0, 48)})`;
    if (ts.isThrowStatement(inner)) shape = `throw ${inner.expression?.getText(sourceFile).slice(0, 48) ?? ""}`;
  });
  return shape;
}

/**
 * Every `<Schema>.Check(<projection>)` in a Host module, with the shape of its
 * failure branch. Request validators are not read paths - they decide whether to
 * accept a write - so a site whose argument is the request is excluded by the
 * enclosing name, and a site that only returns a boolean is a predicate.
 *
 * The schema is recorded by its **declaration name** (`NoteListV1Schema`), the
 * same name `contractSchemas` keys its map by. Storing the reference as written
 * (`TavernBrowserValidatorsV1.NoteListV1Schema`) is what made this class vacuous
 * on the product: every site was counted and none was ever resolved.
 */
function failClosedSites(sources) {
  const sites = [];
  for (const file of sources.files(sources.path(...HOST))) {
    const sourceFile = sources.source(file);
    walk(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      if (node.expression.name.text !== "Check") return;
      const reference = node.expression.expression;
      const declared = ts.isIdentifier(reference)
        ? reference.text
        : ts.isPropertyAccessExpression(reference)
          ? reference.name.text
          : null;
      if (declared === null || !/Schema$/u.test(declared)) return;
      const scope = enclosingFunction(node);
      if (scope === null) return;
      const shape = blankingShape(scope, sourceFile);
      sites.push({
        schema: declared,
        file,
        where: at(sources.root, node, sourceFile, file),
        shape,
        blanking: shape !== null,
      });
    });
  }
  return sites;
}

/** The transitive closure of a module's relative imports, as absolute paths. */
function importClosure(sources, file, depth = 3) {
  const seen = new Set([file]);
  let frontier = [file];
  for (let level = 0; level < depth; level += 1) {
    const next = [];
    for (const current of frontier) {
      let sourceFile;
      try {
        sourceFile = sources.source(current);
      } catch {
        continue;
      }
      for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        if (!specifier.startsWith(".")) continue;
        const base = resolve(dirname(current), specifier.replace(/\.js$/u, ""));
        for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
          if (existsSync(candidate) && !seen.has(candidate)) {
            seen.add(candidate);
            next.push(candidate);
          }
        }
      }
    }
    frontier = next;
  }
  return seen;
}

function runReadPath(sources) {
  const sites = failClosedSites(sources);
  const schemas = [
    ...contractSchemas(sources, sources.path(...TAVERN_CONTRACT)),
    ...contractSchemas(sources, sources.path(...GAME_CONTRACT)),
  ];
  const byName = new Map(schemas.map((schema) => [schema.name, schema]));
  // The same capacity constants `bounds` pairs against the wire, so a projection's producer is measured by
  // the same reading in both classes. Paired by name, not by presence: a constant sharing no concept with the
  // capped property does not bound it, and counting it as a bound is how this class printed fifteen findings
  // about constants that measure a different collection.
  const constants = hostCapConstants(sources);
  const violations = [];
  const notes = [];
  let blanking = 0;
  let exceeded = 0;
  let within = 0;
  let unbound = 0;
  for (const site of sites) {
    if (!site.blanking) continue;
    blanking += 1;
    const schema = byName.get(site.schema);
    if (schema === undefined) continue;
    const capped = schema.properties.filter((property) => property.kind === "maxItems" && property.limit !== null);
    if (capped.length === 0) continue;
    const reachable = hostCapConstantsWithin(constants, importClosure(sources, site.file));
    for (const property of capped) {
      const naming = reachable.filter((constant) => capAffinity(property, constant) > 0);
      if (naming.length === 0) {
        unbound += 1;
        continue;
      }
      const larger = naming.filter((constant) => constant.limit > property.limit);
      if (larger.length === 0) {
        within += 1;
        continue;
      }
      exceeded += 1;
      const worst = larger.sort((left, right) => right.limit - left.limit)[0];
      violations.push({
        rank: 1,
        where: `${site.where} vs ${worst.where}`,
        message: `${site.schema}.${property.property} is capped at ${property.limit} (${property.where}) but this read path's own dependency tree fills it to ${worst.limit} (${worst.name}); one row over the cap and ${site.shape} removes the whole surface`,
      });
    }
  }
  notes.push(
    `read-path: ${sites.length} schema self-validation site(s), ${blanking} remove the surface on mismatch, ${exceeded} cap(s) that the projection can exceed, ${within} bounded by a constant that names it, ${unbound} capped field(s) no reachable constant names (NOT clean: the producer is bounded outside the read path's dependency tree)`,
  );
  return { declared: sites.length, violations, notes };
}

/** The capacity constants whose declaring module is in a read path's own dependency tree. */
function hostCapConstantsWithin(constants, moduleSet) {
  return constants.filter((constant) => moduleSet.has(constant.file));
}

const CLASS_IMPLEMENTATIONS = [
  { id: "read-path", rank: 1, title: "a read path cannot blank its own surface", run: runReadPath },
  { id: "bounds", rank: 2, title: "the contract's cap and the writer's cap agree", run: runBounds },
  { id: "refusal", rank: 2, title: "a capacity is refused before the write, by name", run: runRefusal },
];

export function runAudit({ root = DEFAULT_ROOT, only = null } = {}) {
  const sources = new Sources(root);
  const results = [];
  const byId = new Map();
  for (const auditClass of CLASSES) {
    if (only !== null && !only.includes(auditClass.id)) continue;
    const outcome =
      auditClass.run === null
        ? { declared: 0, violations: [], notes: [`${auditClass.id}: delegated; see its own gate`] }
        : auditClass.run(sources);
    const result = {
      id: auditClass.id,
      rank: auditClass.rank,
      title: auditClass.title,
      declared: outcome.declared,
      violations: outcome.violations.map((violation) => ({ ...violation, class: auditClass.id })),
      notes: outcome.notes ?? [],
    };
    result.advisory = ADVISORY.has(result.id);
    results.push(result);
    byId.set(result.id, result);
  }
  for (const gate of DELEGATED) {
    const target = byId.get(gate.into ?? gate.id);
    if (target === undefined) continue;
    const outcome = runDelegated(sources, gate);
    target.declared += outcome.declared;
    target.violations.push(...outcome.violations.map((violation) => ({ ...violation, class: target.id })));
    target.notes.push(...outcome.notes);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** How many sites of one kind the report prints; `--verbose` lifts it. Nothing is lost, only bounded. */
const SAMPLE_LIMIT = 10;

/** How much of a sampled finding's message a sample line prints before it clips. */
const SAMPLE_MESSAGE = 160;

export function totals(results) {
  const violations = results.flatMap((result) => result.violations);
  // Advisory classes still report; they do not decide the exit code, and `ADVISORY` states why each one is listed.
  // The count below is the count that was found, advisory or not.
  const blocking = results.filter((result) => result.advisory !== true).flatMap((result) => result.violations);
  return {
    classes: results.length,
    declared: results.reduce((total, result) => total + result.declared, 0),
    violations: violations.length,
    blocking: blocking.length,
    advisory: violations.length - blocking.length,
  };
}

export function formatReport(results, { all = false } = {}) {
  const summary = totals(results);
  const lines = [
    `audit-totality: ${summary.classes} classes, ${summary.declared} declared items walked, ${summary.violations} violations`,
  ];
  const width = Math.max(...results.map((result) => result.id.length), 8);
  for (const result of results)
    lines.push(
      `  ${result.id.padEnd(width)}  ${String(result.declared).padStart(5)} declared  ${String(result.violations.length).padStart(4)} violation(s)  ${result.title}`,
    );
  for (const note of results.flatMap((result) => result.notes)) lines.push(`  note  ${note}`);
  const ranked = [...results.flatMap((result) => result.violations)].sort((left, right) => left.rank - right.rank);
  if (ranked.length === 0) return lines.join("\n");
  lines.push("", "violations, worst first:");
  // A violation that carries a `kind` is reported by kind: one line with the count, then at most `SAMPLE_LIMIT` of
  // its sites. A violation without one is reported by site, as every class except `hygiene` does. Both keep the
  // count that was found - the sample bounds what is printed, never what is reported. `all` lifts the bound.
  const perKind = new Map();
  for (const violation of ranked)
    if (violation.kind !== undefined) {
      const key = `${violation.class}: ${violation.kind}`;
      perKind.set(key, (perKind.get(key) ?? 0) + 1);
    }
  const printed = new Map();
  for (const violation of ranked) {
    if (violation.kind === undefined || all) {
      lines.push(`  [${violation.rank}] ${violation.class}: ${violation.where}`, `        ${violation.message}`);
      continue;
    }
    const key = `${violation.class}: ${violation.kind}`;
    const found = perKind.get(key) ?? 0;
    const shown = printed.get(key) ?? 0;
    if (shown === 0) lines.push(`  [${violation.rank}] ${key} - ${found} finding(s)`);
    if (shown < SAMPLE_LIMIT) lines.push(`          ${violation.where}  ${sampled(violation.message)}`);
    else if (shown === SAMPLE_LIMIT)
      lines.push(`          … ${found - SAMPLE_LIMIT} more site(s) of this kind; --verbose prints every one`);
    printed.set(key, shown + 1);
  }
  return lines.join("\n");
}

/** A sample line's message, clipped: the sample carries the site, `--verbose` carries the whole finding. */
function sampled(message) {
  return message.length <= SAMPLE_MESSAGE ? message : `${message.slice(0, SAMPLE_MESSAGE)}…`;
}

function parseArguments(argv) {
  const options = { root: DEFAULT_ROOT, only: null, json: false, all: false };
  for (const argument of argv) {
    if (argument.startsWith("--only=")) options.only = argument.slice("--only=".length).split(",");
    else if (argument === "--json") options.json = true;
    else if (argument === "--verbose" || argument === "--all-findings") options.all = true;
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const results = runAudit(options);
  const summary = totals(results);
  if (options.json) process.stdout.write(`${JSON.stringify({ summary, results }, null, 2)}\n`);
  else process.stdout.write(`${formatReport(results, { all: options.all })}\n`);
  process.exitCode = summary.blocking > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Class: codes
// ---------------------------------------------------------------------------

/** The handlers whose vocabulary the tavern contract declares. */
const TAVERN_HANDLERS = [
  ["host", "src", "reference-pipeline-dialogue-web.core.ts"],
  ["host", "src", "reference-pipeline-dialogue-web.ts"],
  ["host", "src", "tavern-management-dialogue-web.ts"],
  ["host", "src", "composed-reference-game-browser.ts"],
];

/** The browser's own copies of the declared vocabularies. */
const TAVERN_MIRRORS = [
  ["dialogue-web", "src", "reference-pipeline-api.ts"],
  ["dialogue-web", "src", "management-pipeline-api.ts"],
];
const GAME_MIRROR = ["dialogue-web", "src", "composed-reference-game-browser-api.ts"];
const CORE_HANDLER = ["host", "src", "reference-pipeline-dialogue-web.core.ts"];

/** The string literals of a named `const`, read from the declaration itself. */
function literalsInDeclaration(sources, file, name, property = null) {
  const sourceFile = sources.source(file);
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== name) return;
    const scope =
      property === null
        ? node
        : (() => {
            let hit = null;
            walk(node, (inner) => {
              if (ts.isPropertyAssignment(inner) && inner.name.getText(sourceFile) === property) hit = inner;
            });
            return hit;
          })();
    if (scope === null) return;
    walk(scope, (inner) => {
      if (ts.isStringLiteral(inner) && BOUNDED_CODE.test(inner.text))
        found.push({ value: inner.text, where: at(sources.root, inner, sourceFile, file) });
    });
  });
  return found;
}

/** The literal members of a named type alias. */
function literalsInTypeAlias(sources, file, name) {
  const sourceFile = sources.source(file);
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== name) return;
    const members = ts.isUnionTypeNode(node.type) ? node.type.types : [node.type];
    for (const member of members) {
      if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) continue;
      found.push({ value: member.literal.text, where: at(sources.root, member, sourceFile, file) });
    }
  });
  return found;
}

/** callee name -> index of its parameter named `code`, read from the handlers. */
function codeArity(sources) {
  const map = new Map();
  for (const segments of TAVERN_HANDLERS) {
    const file = sources.path(...segments);
    const sourceFile = sources.source(file);
    const record = (name, parameters) => {
      const index = parameters.findIndex(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === "code",
      );
      if (index >= 0) map.set(name, index);
    };
    walk(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) record(node.name.text, node.parameters);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
          record(node.name.text, node.initializer.parameters);
      }
    });
  }
  return map;
}

function insideProblemCodeFunction(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current.name !== undefined && /ProblemCode$/u.test(current.name.text);
    if (ts.isSourceFile(current)) return false;
  }
  return false;
}

/** Every problem code a handler file can produce, with the line that names it. */
function producedCodes(sources, file) {
  const sourceFile = sources.source(file);
  const arity = codeArity(sources);
  const found = [];
  walk(sourceFile, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(sourceFile) === "code" &&
      ts.isStringLiteral(node.initializer) &&
      BOUNDED_CODE.test(node.initializer.text)
    )
      found.push({ value: node.initializer.text, where: at(sources.root, node.initializer, sourceFile, file) });
    if (
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      ts.isStringLiteral(node.expression) &&
      BOUNDED_CODE.test(node.expression.text) &&
      insideProblemCodeFunction(node)
    )
      found.push({ value: node.expression.text, where: at(sources.root, node.expression, sourceFile, file) });
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    const index = arity.get(node.expression.text);
    if (index === undefined) return;
    const argument = node.arguments[index];
    if (argument !== undefined && ts.isStringLiteral(argument) && BOUNDED_CODE.test(argument.text))
      found.push({ value: argument.text, where: at(sources.root, argument, sourceFile, file) });
  });
  return found;
}

function codeAuthorities(sources) {
  const tavern = new Set(
    literalsInDeclaration(sources, sources.path(...TAVERN_CONTRACT), "ProblemCode").map((entry) => entry.value),
  );
  const turn = new Set(
    literalsInDeclaration(sources, sources.path(...TAVERN_CONTRACT), "BrowserTurnV1Schema", "problemCode").map(
      (entry) => entry.value,
    ),
  );
  const game = new Set(
    literalsInDeclaration(sources, sources.path(...GAME_CONTRACT), "GameProblemCode").map((entry) => entry.value),
  );
  const transport = new Set(
    literalsInTypeAlias(sources, sources.path(...CORE_HANDLER), "ProblemCode").map((entry) => entry.value),
  );
  return { tavern, turn, game, transport };
}

/** The two ways a mirror drifts from the declared set, named by code. */
function codeSetDrift(where, mirrored, authority, noun) {
  return [
    ...[...authority]
      .filter((code) => !mirrored.has(code))
      .map((code) => `${where} does not recognise declared code ${JSON.stringify(code)}`),
    ...[...mirrored]
      .filter((code) => !authority.has(code))
      .map((code) => `${where} recognises a code no ${noun} declares ${JSON.stringify(code)}`),
  ];
}

function runCodes(sources) {
  const { tavern, game, turn, transport } = codeAuthorities(sources);
  const declaredTavern = new Set([...tavern, ...transport]);
  const violations = [];
  const notes = [];
  let produced = 0;
  const producedSet = new Set();
  for (const segments of TAVERN_HANDLERS) {
    const file = sources.path(...segments);
    for (const entry of producedCodes(sources, file)) {
      produced += 1;
      producedSet.add(entry.value);
      if (!declaredTavern.has(entry.value) && !game.has(entry.value))
        violations.push({
          rank: 3,
          where: entry.where,
          message: `produces undeclared code ${JSON.stringify(entry.value)}`,
        });
    }
  }
  let mirrored = 0;
  for (const segments of TAVERN_MIRRORS) {
    const file = sources.path(...segments);
    const where = relativeTo(sources.root, file);
    for (const name of ["PROBLEM_CODES"]) {
      const entries = literalsInDeclaration(sources, file, name);
      mirrored += entries.length;
      for (const drift of codeSetDrift(
        where,
        new Set(entries.map((entry) => entry.value)),
        declaredTavern,
        "tavern route",
      ))
        violations.push({ rank: 3, where, message: drift });
    }
    const turnEntries = literalsInDeclaration(sources, file, "TURN_PROBLEM_CODES");
    mirrored += turnEntries.length;
    for (const drift of codeSetDrift(where, new Set(turnEntries.map((entry) => entry.value)), turn, "turn"))
      violations.push({ rank: 3, where, message: drift });
  }
  const gameFile = sources.path(...GAME_MIRROR);
  const gameEntries = literalsInDeclaration(sources, gameFile, "GAME_PROBLEM_CODES");
  mirrored += gameEntries.length;
  for (const drift of codeSetDrift(
    relativeTo(sources.root, gameFile),
    new Set(gameEntries.map((entry) => entry.value)),
    game,
    "game route",
  ))
    violations.push({ rank: 3, where: relativeTo(sources.root, gameFile), message: drift });

  // A code the contract declares that nothing produces and nothing mirrors is a
  // branch no player can reach: the contract promises a refusal that does not exist.
  const mirroredAll = new Set([
    ...TAVERN_MIRRORS.flatMap((segments) =>
      literalsInDeclaration(sources, sources.path(...segments), "PROBLEM_CODES").map((entry) => entry.value),
    ),
    ...gameEntries.map((entry) => entry.value),
  ]);
  for (const [noun, union] of [
    ["tavern", declaredTavern],
    ["game", game],
  ]) {
    for (const code of union) {
      if (producedSet.has(code) || mirroredAll.has(code)) continue;
      violations.push({
        rank: 3,
        where: `${noun} contract`,
        message: `declares ${JSON.stringify(code)} but no handler produces it and no client mirror names it`,
      });
    }
  }
  if (declaredTavern.size === 0 || game.size === 0)
    violations.push({
      rank: 3,
      where: "host/src",
      message: "the problem unions could not be read; every rule below them is vacuous",
    });
  notes.push(
    `codes: ${declaredTavern.size} tavern (+${transport.size} transport), ${turn.size} turn, ${game.size} game declared; ${produced} produced across ${TAVERN_HANDLERS.length} handler(s), ${mirrored} mirrored across ${TAVERN_MIRRORS.length + 1} mirror(s)`,
  );
  return { declared: declaredTavern.size + turn.size + game.size, violations, notes };
}

// ---------------------------------------------------------------------------
// Class: routes
// ---------------------------------------------------------------------------

/**
 * Every route descriptor the tavern contract declares, and every table entry the reader could not read.
 *
 * The count of `routeId` properties in the file is not a count of routes: the same module declares the
 * `routeId` member of a schema and the `routeId` key of a profile. An entry the reader cannot read is
 * the only honest signal that its reading is incomplete - a table entry that is not an object literal,
 * or whose `routeId` is not a string literal, is a route this rule would silently not see.
 */
function routeDescriptors(sources) {
  const file = sources.path(...TAVERN_CONTRACT);
  const sourceFile = sources.source(file);
  const routes = [];
  const unresolved = [];
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "route") return;
    const argument = node.arguments[0];
    if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
      unresolved.push(at(sources.root, node, sourceFile, file));
      return;
    }
    const entry = { where: at(sources.root, node, sourceFile, file) };
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name.getText(sourceFile);
      if (["routeId", "method", "path"].includes(name) && ts.isStringLiteral(property.initializer))
        entry[name] = property.initializer.text;
    }
    if (entry.routeId === undefined) {
      unresolved.push(entry.where);
      return;
    }
    routes.push(entry);
  });
  return { routes, unresolved };
}

function runRoutes(sources) {
  const { routes, unresolved } = routeDescriptors(sources);
  const declared = new Set(routes.map((route) => route.routeId));
  const violations = [];
  const notes = [];
  const hostFiles = sources.files(sources.path(...HOST)).filter((file) => !/browser-contract/u.test(file));
  const text = new Map();
  for (const file of hostFiles) {
    const sourceFile = sources.source(file);
    const literals = new Set();
    walk(sourceFile, (node) => {
      if (ts.isStringLiteral(node)) literals.add(node.text);
    });
    text.set(file, literals);
  }
  const servedBy = (needle) => hostFiles.filter((file) => text.get(file).has(needle));
  let served = 0;
  for (const route of routes) {
    const owners = [...new Set([...servedBy(route.routeId), ...servedBy(route.path)])];
    if (owners.length === 0) {
      violations.push({
        rank: 3,
        where: route.where,
        message: `${route.routeId} (${route.method} ${route.path}) is declared but no Host dispatcher names its id or its path; the route a client calls answers nothing`,
      });
      continue;
    }
    served += 1;
  }
  // The reverse direction: a route id a dispatcher branches on must be declared.
  for (const file of hostFiles) {
    const sourceFile = sources.source(file);
    walk(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      if (node.expression.name.text !== "includes" && node.expression.name.text !== "some") return;
      const receiver = node.expression.expression.getText(sourceFile);
      if (!/routeIds|ROUTE_IDS|routeId/iu.test(receiver)) return;
      for (const argument of node.arguments) {
        if (!ts.isStringLiteral(argument) || !/^[a-z][a-z0-9._-]*$/u.test(argument.text)) continue;
        if (declared.has(argument.text)) continue;
        violations.push({
          rank: 3,
          where: at(sources.root, argument, sourceFile, file),
          message: `serves route ${JSON.stringify(argument.text)} which the contract does not declare`,
        });
      }
    });
  }
  if (unresolved.length > 0)
    violations.push({
      rank: 3,
      where: unresolved[0],
      message: `${unresolved.length} route table entr${unresolved.length === 1 ? "y" : "ies"} could not be read as an object literal with a string \`routeId\` (${unresolved.join(", ")}), so this rule is incomplete`,
    });
  notes.push(
    `routes: ${routes.length} declared route descriptor(s), ${unresolved.length} table entry(ies) the reader could not read, ${served} named by a Host dispatcher, ${hostFiles.length} dispatcher candidates scanned`,
  );
  return { declared: routes.length, violations, notes };
}

// ---------------------------------------------------------------------------
// Class: fields
// ---------------------------------------------------------------------------

/** Every property name both contracts declare, with the schema that declares it. */
function declaredFields(sources) {
  const fields = new Map();
  for (const file of [sources.path(...TAVERN_CONTRACT), sources.path(...GAME_CONTRACT)]) {
    for (const schema of contractSchemas(sources, file))
      for (const field of schema.fieldNames) {
        const known = fields.get(field.name);
        if (known === undefined) fields.set(field.name, { schema: schema.name, where: field.where, count: 1 });
        else known.count += 1;
      }
  }
  return fields;
}

/**
 * Every name a source spells, with the first place it appears: an identifier, or a string literal when
 * the key is quoted.
 *
 * A schema field reaches a source in more forms than `field: value`. `{ chats }` is a shorthand
 * assignment, `<Row companionHandle={...}>` is a JSX attribute, `const { chats } = list` is a binding
 * element, and a projection usually reads the value into a local of the same name before it fills the
 * schema. All of those are identifiers, so the name - not the syntax around it - is what counts as a
 * mention. Anything narrower reads production as absence.
 */
function namesIn(sources, roots, skip) {
  const seen = new Map();
  for (const file of sources.files(...roots)) {
    if (skip.has(file)) continue;
    const sourceFile = sources.source(file);
    walk(sourceFile, (node) => {
      const name = ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null;
      if (name === null || seen.has(name)) return;
      seen.set(name, at(sources.root, node, sourceFile, file));
    });
  }
  return seen;
}

function runFields(sources) {
  const fields = declaredFields(sources);
  const contractFiles = new Set([sources.path(...TAVERN_CONTRACT), sources.path(...GAME_CONTRACT)]);
  const hostNames = namesIn(sources, [sources.path(...HOST)], contractFiles);
  const webNames = namesIn(sources, [sources.path(...WEB)], new Set());
  const violations = [];
  const notes = [];
  let produced = 0;
  let read = 0;
  const unproduced = [];
  const unread = [];
  for (const [field, entry] of fields) {
    if (hostNames.has(field)) produced += 1;
    else unproduced.push({ field, ...entry });
    if (webNames.has(field)) read += 1;
    else unread.push({ field, ...entry });
  }
  // A field nobody names is only dead when the schema around it is unnamed too: a side that names the
  // schema can still produce or read the field through a spread or a projection it derives from that
  // schema, and the reader cannot see which members such a value carries. That is unverified, and it
  // is reported as a count rather than as a violation.
  const unverified = (rows, names) => rows.filter((entry) => names.has(entry.schema));
  for (const entry of unproduced) {
    if (hostNames.has(entry.schema)) continue;
    violations.push({
      rank: 3,
      where: entry.where,
      message: `${entry.schema}.${entry.field} is declared but no Host source names it, nor the schema that declares it; a declared member with nothing behind it reads as a capability a player waits for`,
    });
  }
  for (const entry of unread) {
    if (webNames.has(entry.schema)) continue;
    violations.push({
      rank: 4,
      where: entry.where,
      message: `${entry.schema}.${entry.field} is declared but no browser source names it, nor the schema that declares it; the wire carries a field nothing reads`,
    });
  }
  const unverifiedProducer = unverified(unproduced, hostNames);
  const unverifiedConsumer = unverified(unread, webNames);
  notes.push(
    `fields: ${fields.size} distinct declared field name(s), ${produced} named by a Host source, ${read} named by a browser source; a field whose schema a side names but whose own name it does not is counted unverified (${unverifiedProducer.length} producer, ${unverifiedConsumer.length} consumer), not dead`,
  );
  if (unverifiedProducer.length + unverifiedConsumer.length > 0)
    notes.push(
      `fields: unverified - the name is spelled nowhere on that side, so a spread or a schema-derived projection could still carry it: ${[...unverifiedProducer.map((entry) => `${entry.schema}.${entry.field}`), ...unverifiedConsumer.map((entry) => `${entry.schema}.${entry.field}`)].slice(0, 12).join(", ")}`,
    );
  return { declared: fields.size, violations, notes };
}

// ---------------------------------------------------------------------------
// Classes: catalogue, prompt, promises
// ---------------------------------------------------------------------------

/** The catalogue files that carry player-visible sentences. */
const CATALOGUE_FILE = /(?:^|[\\/])(?:i18n\.ts|[^\\/]*labels\.ts)$/u;

/** Every `en`/`zh` catalogue entry under `dialogue-web/src`, by key. */
function catalogueStrings(sources) {
  const entries = [];
  for (const file of sources.files(sources.path(...WEB))) {
    if (!CATALOGUE_FILE.test(file)) continue;
    const sourceFile = sources.source(file);
    walk(sourceFile, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
      if (node.name.text !== "en" && node.name.text !== "zh") return;
      if (node.initializer === undefined) return;
      const initializer = unwrap(node.initializer);
      if (!ts.isObjectLiteralExpression(initializer)) return;
      for (const property of initializer.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        if (!ts.isStringLiteral(property.initializer) && !ts.isNoSubstitutionTemplateLiteral(property.initializer))
          continue;
        entries.push({
          locale: node.name.text === "en" ? "en" : "zh-CN",
          key: property.name.getText(sourceFile).replaceAll(/["']/gu, ""),
          text: property.initializer.text,
          where: at(sources.root, property, sourceFile, file),
        });
      }
    });
  }
  return entries;
}

/**
 * Strings a rendered prompt may not carry. Each is a thing a developer writes
 * for themselves and a model reads as content: a digest, a revision counter, an
 * internal id, or an unsubstituted macro.
 */
const PROMPT_ARTEFACTS = Object.freeze([
  { id: "canonical-hash", pattern: /canonical[-_ ]?hash/iu },
  { id: "revision-counter", pattern: /\brevision\s*[=:]\s*\d/iu },
  { id: "sha256-digest", pattern: /\bsha-?256\b|\b[0-9a-f]{32,}\b/u },
  { id: "internal-id", pattern: /\b(?:wb|mem|chat|companion|persona|scenario)-entry-[A-Za-z0-9]/u },
  { id: "unsubstituted-macro", pattern: /\{\{/u },
  { id: "raw-enum-member", pattern: /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/u },
]);

function runPrompt(sources) {
  const entries = catalogueStrings(sources);
  const violations = [];
  const notes = [];
  const hits = new Map();
  for (const entry of entries) {
    for (const artefact of PROMPT_ARTEFACTS) {
      if (!artefact.pattern.test(entry.text)) continue;
      hits.set(artefact.id, (hits.get(artefact.id) ?? 0) + 1);
      // A macro in the catalogue is legitimate when the surface substitutes it
      // (`{{name}}`, `{{code}}`); what is not is a `{{` a renderer never fills.
      const macros = entry.text.match(/\{\{[A-Za-z0-9_]+\}\}/gu) ?? [];
      const loose = entry.text.replace(/\{\{[A-Za-z0-9_]+\}\}/gu, "");
      if (artefact.id === "unsubstituted-macro" && macros.length > 0 && !loose.includes("{{")) continue;
      violations.push({
        rank: 4,
        where: entry.where,
        message: `${entry.locale}.${entry.key} carries a ${artefact.id} into player-visible text: ${JSON.stringify(entry.text.slice(0, 96))}`,
      });
    }
  }
  notes.push(
    `prompt: ${entries.length} catalogue sentence(s) across ${new Set(entries.map((entry) => entry.where.split("/").slice(0, -1).join("/"))).size} catalogue file(s) checked against ${PROMPT_ARTEFACTS.length} artefact shape(s); ${[...hits.entries()].map(([id, count]) => `${id}=${count}`).join(" ") || "no hits"}`,
  );
  return { declared: entries.length, violations, notes };
}

/**
 * Promise families, and the capability each one names. This is a CHECKLIST, not
 * an invariant: it cannot catch a promise nobody thought of, and it says so in
 * its own note. What it does catch is the promise that names a capability the
 * product does not have - the shape that made the notebook claim an automatic
 * writer for months.
 */
const PROMISE_FAMILIES = Object.freeze([
  {
    id: "restore-later",
    pattern: /\b(?:restore|recover|bring back|undo)\b[^.]{0,40}\blater\b|\bfrom the (?:next|last) conversation\b/iu,
    capability: ["restore", "recover"],
  },
  {
    id: "automatic-writer",
    pattern: /\b(?:automatically|by itself|by herself|on its own|without asking)\b|自动|自己记下|不用动手/iu,
    capability: [],
  },
  {
    id: "built-in-default",
    pattern: /\bbuilt-in\b|\bdefault connection\b|内置/iu,
    capability: ["connection", "provider"],
  },
  { id: "applies-next", pattern: /\bapplies?\b[^.]{0,40}\bnext\b|下次/iu, capability: [] },
  { id: "kept-forever", pattern: /\b(?:kept|saved|stored) (?:forever|permanently)\b|永久/iu, capability: [] },
]);

/** True when the tree carries a route, control or state named after the capability. */
function capabilityReachable(sources, capability) {
  if (capability.length === 0) return true;
  const routes = routeDescriptors(sources).routes.map((route) => route.routeId.toLowerCase());
  if (routes.some((routeId) => capability.some((token) => routeId.includes(token)))) return true;
  for (const file of sources.files(sources.path(...WEB))) {
    // The promise's own sentence is not evidence that the capability exists.
    if (CATALOGUE_FILE.test(file)) continue;
    const sourceFile = sources.source(file);
    let found = false;
    walk(sourceFile, (node) => {
      if (!found && ts.isStringLiteral(node) && capability.some((token) => node.text.toLowerCase().includes(token)))
        found = true;
    });
    if (found) return true;
  }
  return false;
}

function runPromises(sources) {
  const entries = catalogueStrings(sources);
  const violations = [];
  const notes = [];
  let promised = 0;
  for (const entry of entries) {
    for (const family of PROMISE_FAMILIES) {
      if (!family.pattern.test(entry.text)) continue;
      promised += 1;
      if (capabilityReachable(sources, family.capability)) continue;
      violations.push({
        rank: 4,
        where: entry.where,
        message: `${entry.locale}.${entry.key} promises ${family.id} but nothing in the tree names ${family.capability.join("/")}: ${JSON.stringify(entry.text.slice(0, 96))}`,
      });
    }
  }
  notes.push(
    `promises: ${entries.length} sentence(s) checked against ${PROMISE_FAMILIES.length} curated promise family/families, ${promised} promise(s) found; this class is a checklist, not an invariant - a promise nobody listed is not audited`,
  );
  return { declared: entries.length, violations, notes };
}

// ---------------------------------------------------------------------------
// Class: hygiene
// ---------------------------------------------------------------------------

const SUPPRESSION =
  /(?:@ts-(?:ignore|expect-error|nocheck)\b|\beslint-disable(?:-next-line|-line)?\b|\boxlint-disable\b|\bbiome-ignore\b|\bprettier-ignore\b|\bstylelint-disable(?:-next-line|-line)?\b|\b(?:c8|istanbul) ignore\b|\bNOLINT\b)/u;
const COMMENTED_CODE =
  /^\s*\/\/\s*(?:const|let|var|return|if|for|while|await|import|export|function|class|throw|switch|case)\b.*(?:[;{}]|=>)\s*$/u;

/**
 * The readings `hygiene` reports, each with what a count of it means.
 *
 * Every finding this class reports today is one pattern, and the owner cannot act on a list that long: either the
 * pattern is accepted wholesale (and the rule is withdrawn) or it is one defect with a mechanical sweep, and neither
 * is a decision about a line. So each kind carries its own reading, every site stays a finding, and the report prints
 * the count with a bounded sample instead of every line.
 *
 * `decision` is a broad pattern one ruling settles; `defect` is a site that is wrong on its own terms.
 */
const HYGIENE_KINDS = Object.freeze([
  {
    id: "test-only export",
    readsAs: "decision",
    note: "every finding is the same pattern - a Host export no production code reaches: the modules that import it are tests, resolved through re-export barrels, and the module that declares it never names it - so one ruling settles all of them (move the helper to a test-support module, or drop the export); editing sites one at a time is not the fix",
  },
  {
    id: "commented-out code",
    readsAs: "defect",
    note: "each site is a line the compiler never reads; the fix is to delete that line, site by site",
  },
  {
    id: "suppression directive",
    readsAs: "defect",
    note: "each site hides one specific defect from the compiler or the linter; the fix belongs at that defect, not at the directive",
  },
]);

/**
 * One module's export surface, read the way an importer sees it: the names it declares, the names it aliases
 * from another module (`export { a } from`, and `export { a }` of a binding it imported), the modules whose
 * whole surface it repeats (`export * from`), and what it imports (so a local `export { a }` list resolves to
 * the module that declares `a`).
 */
function moduleSurface(sources, file) {
  const sourceFile = sources.source(file);
  const surface = { declared: new Map(), aliases: new Map(), stars: [], imports: new Map() };
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings))
      continue;
    for (const element of clause.namedBindings.elements)
      surface.imports.set(element.name.text, {
        specifier: statement.moduleSpecifier.text,
        inner: (element.propertyName ?? element.name).text,
      });
  }
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const named =
        statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)
          ? statement.exportClause.elements
          : null;
      if (statement.moduleSpecifier === undefined) {
        for (const element of named ?? []) {
          const imported = surface.imports.get(element.name.text);
          if (imported === undefined) surface.declared.set(element.name.text, statement);
          else surface.aliases.set(element.name.text, imported);
        }
        continue;
      }
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (named === null) {
        if (statement.exportClause === undefined) surface.stars.push(specifier);
        continue;
      }
      for (const element of named)
        surface.aliases.set(element.name.text, {
          specifier,
          inner: (element.propertyName ?? element.name).text,
        });
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined)
      surface.declared.set(statement.name.text, statement);
    if (ts.isClassDeclaration(statement) && statement.name !== undefined)
      surface.declared.set(statement.name.text, statement);
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement))
      surface.declared.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) surface.declared.set(declaration.name.text, statement);
  }
  return surface;
}

/** The audited module a relative specifier names, or null when it names nothing the audit parses. */
function resolveSpecifier(surfaces, from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    base.replace(/\.js$/u, ".ts"),
    base.replace(/\.js$/u, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ])
    if (surfaces.has(candidate)) return candidate;
  return null;
}

/** Every name a module exposes to an importer, its star re-exports included. */
function exposedNames(surfaces, file, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  const surface = surfaces.get(file);
  const names = [...surface.declared.keys(), ...surface.aliases.keys()];
  for (const specifier of surface.stars) {
    const target = resolveSpecifier(surfaces, file, specifier);
    if (target !== null) names.push(...exposedNames(surfaces, target, seen));
  }
  return names;
}

/** The module that declares what `file` exposes as `name`, following re-export barrels to the origin. */
function declaringModule(surfaces, file, name, seen = new Set()) {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const surface = surfaces.get(file);
  if (surface === undefined) return null;
  if (surface.declared.has(name)) return file;
  const alias = surface.aliases.get(name);
  if (alias !== undefined) {
    const target = resolveSpecifier(surfaces, file, alias.specifier);
    return target === null ? null : declaringModule(surfaces, target, alias.inner, seen);
  }
  for (const specifier of surface.stars) {
    const target = resolveSpecifier(surfaces, file, specifier);
    if (target === null) continue;
    const found = declaringModule(surfaces, target, name, seen);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Every reference to an export, keyed by the module that declares it.
 *
 * A reference is an import that names it, a namespace import or dynamic import of the module that exposes it,
 * or a type-position `import("…").Name`. A re-export is not one: a barrel is transparent, so a consumer of
 * the barrel is recorded against the module that declares the symbol, which is what makes a test that imports
 * through a facade read as a test consumer.
 */
function exportConsumers(sources, files, surfaces) {
  const consumers = new Map();
  const record = (declarer, name, from) => {
    if (declarer === null) return;
    const key = `${declarer}#${name}`;
    if (!consumers.has(key)) consumers.set(key, new Set());
    consumers.get(key).add(from);
  };
  const recordSurface = (target, from) => {
    for (const name of exposedNames(surfaces, target)) record(declaringModule(surfaces, target, name), name, from);
  };
  for (const file of files) {
    walk(sources.source(file), (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveSpecifier(surfaces, file, node.moduleSpecifier.text);
        if (target === null || node.importClause === undefined) return;
        const clause = node.importClause;
        if (clause.name !== undefined) record(declaringModule(surfaces, target, "default"), "default", file);
        if (clause.namedBindings === undefined) return;
        if (ts.isNamespaceImport(clause.namedBindings)) {
          recordSurface(target, file);
          return;
        }
        for (const element of clause.namedBindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          record(declaringModule(surfaces, target, imported), imported, file);
        }
        return;
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal) &&
        node.qualifier !== undefined &&
        ts.isIdentifier(node.qualifier)
      ) {
        const target = resolveSpecifier(surfaces, file, node.argument.literal.text);
        const name = node.qualifier.text;
        if (target !== null) record(declaringModule(surfaces, target, name), name, file);
        return;
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument === undefined || !ts.isStringLiteral(argument)) return;
        const target = resolveSpecifier(surfaces, file, argument.text);
        if (target !== null) recordSurface(target, file);
      }
    });
  }
  return consumers;
}

/**
 * Whether `name` is used inside the module that declares it, anywhere other than the declaration itself.
 *
 * A name-level reading with no scope model, so a shadowing local of the same name would read as a use. It is
 * asked only to withhold a finding - a module that names its own export ships it - so the approximation can
 * cost a missed finding, never a reported one.
 */
function referencedInModule(sources, file, name, declaration) {
  let found = false;
  const isName = (node) => {
    const parent = node.parent;
    if (parent === undefined) return true;
    if (parent.name === node) return true;
    if (ts.isQualifiedName(parent) && parent.right === node) return true;
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)) return true;
    return false;
  };
  const within = (node) => {
    for (let current = node; current !== undefined; current = current.parent) if (current === declaration) return true;
    return false;
  };
  walk(sources.source(file), (node) => {
    if (found || !ts.isIdentifier(node) || node.text !== name || isName(node) || within(node)) return;
    found = true;
  });
  return found;
}

function runHygiene(sources) {
  const violations = [];
  const notes = [];
  const hostFiles = sources.files(sources.path(...HOST));
  const webFiles = sources.files(sources.path(...WEB));
  for (const file of [...hostFiles, ...webFiles]) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (SUPPRESSION.test(line)) {
        violations.push({
          rank: 4,
          kind: "suppression directive",
          where: `${relativeTo(sources.root, file)}:${index + 1}`,
          message: `suppression directive ${JSON.stringify(line.trim().slice(0, 72))}; a compiler or linter silenced by hand hides the next defect`,
        });
      }
      if (COMMENTED_CODE.test(line)) {
        violations.push({
          rank: 4,
          kind: "commented-out code",
          where: `${relativeTo(sources.root, file)}:${index + 1}`,
          message: `commented-out code ${JSON.stringify(line.trim().slice(0, 72))}`,
        });
      }
    }
  }

  // An export whose only readers are tests is a production path a test keeps alive: nothing ships it, and
  // deleting the test would expose it as dead. The reading resolves each relative specifier to the module it
  // names and counts a module's own use of its export, because the bare-name scan it replaces counted only
  // `import` declarations: `MAX_PLAN_NODES` read by the file that declares it, with a test importing it, was
  // reported as a production path with no production consumer. A re-export barrel is transparent here - a
  // consumer of the barrel is recorded against the module that declares the symbol - so a barrel neither
  // launders a test-only export nor hides a production one.
  const audited = sources.allFiles(sources.path(...HOST), sources.path(...WEB));
  const surfaces = new Map(audited.map((file) => [file, moduleSurface(sources, file)]));
  const consumers = exportConsumers(sources, audited, surfaces);
  let testOnly = 0;
  let examinedExports = 0;
  for (const file of hostFiles) {
    const sourceFile = sources.source(file);
    for (const [name, declaration] of surfaces.get(file).declared) {
      const users = [...(consumers.get(`${file}#${name}`) ?? [])].filter((user) => user !== file);
      if (users.length === 0) continue;
      examinedExports += 1;
      if (users.some((user) => !TEST_PATH.test(user))) continue;
      if (referencedInModule(sources, file, name, declaration)) continue;
      testOnly += 1;
      violations.push({
        rank: 4,
        kind: "test-only export",
        where: at(sources.root, declaration, sourceFile, file),
        message: `${name} is exported and only a test reaches it (${users.map((user) => relativeTo(sources.root, user)).join(", ")}); no production code names it`,
      });
    }
  }
  const kinds = HYGIENE_KINDS.map((kind) => ({
    ...kind,
    count: violations.filter((violation) => violation.kind === kind.id).length,
  }));
  notes.push(
    `hygiene: ${violations.length} finding(s) in ${kinds.filter((kind) => kind.count > 0).length} kind(s) across ${hostFiles.length + webFiles.length} source file(s); ${examinedExports} imported export(s) examined, ${testOnly} reached only from tests`,
  );
  for (const kind of kinds) notes.push(`hygiene: ${kind.id} (${kind.count}) reads as a ${kind.readsAs}: ${kind.note}`);
  return { declared: hostFiles.length + webFiles.length, violations, notes };
}

// ---------------------------------------------------------------------------
// Class: duplication
// ---------------------------------------------------------------------------

/**
 * The verbs that name a *decision* in this tree: a function whose name begins with one of these
 * answers a question the product asks in more than one place.
 */
const DECISION_VERB = /^(?:resolve|select|pick|decide|derive|should)[A-Z0-9_]/u;

/**
 * The surfaces this class counts separately, derived from the layout rather than typed.
 *
 * A surface is a workspace's `src` plus the first directory under it, so `host/src/tavern` and
 * `dialogue-web/src/components` are different surfaces while `host/src` itself is the workspace's
 * root modules. Deriving it means a new workspace, or a new top-level directory in one, becomes a
 * counted surface the moment it exists; no constant here has to be kept in step with the tree.
 */
function surfaceOf(root, file) {
  const parts = relativeTo(root, file).split("/");
  const src = parts.indexOf("src");
  if (src === -1) return parts.slice(0, -1).join("/");
  return parts.length > src + 2 ? parts.slice(0, src + 2).join("/") : parts.slice(0, src + 1).join("/");
}

/** Every directory this class reads: a workspace `src`, found from the repository layout. */
function workspaceSourceRoots(sources) {
  const roots = [];
  for (const entry of readdirSync(sources.root)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const source = join(sources.root, entry, "src");
    if (existsSync(source) && statSync(source).isDirectory()) roots.push(source);
  }
  // The workspace globs also cover `packages/*`, whose `src` is one level deeper than a workspace's own.
  const packages = join(sources.root, "packages");
  if (existsSync(packages)) {
    for (const entry of readdirSync(packages)) {
      const source = join(packages, entry, "src");
      if (existsSync(source) && statSync(source).isDirectory()) roots.push(source);
    }
  }
  return roots.sort();
}

/**
 * Whether a type member names the absence of an answer rather than an answer.
 *
 * `undefined` and `null` in a return type mean "there was nothing to return", which is not a state a
 * caller chooses between: every call site handles it the same way, with one `?? fallback` or one
 * early return. `selected | no_model | unreadable` names three states of the world, and a caller has
 * to tell them apart - that is what this class counts.
 */
function namesAbsence(typeNode) {
  if (typeNode.kind === ts.SyntaxKind.UndefinedKeyword || typeNode.kind === ts.SyntaxKind.NullKeyword) return true;
  return ts.isLiteralTypeNode(typeNode) && typeNode.literal.kind === ts.SyntaxKind.NullKeyword;
}

/**
 * How many distinct answers a declared answer admits, read from the declaration rather than from the
 * function's body: `boolean` is two, a union of N answers is N, and a single structural answer (a paths
 * object, one record) is one.
 *
 * This is what separates a *constructor* from a *decision*. `resolveRuntimePaths` answers exactly one
 * shape, so a second caller cannot receive an answer the first did not - it is a pure name for one
 * object, not a rule two places could state differently. `resolveSurfaceModelSelection` answers
 * `selected | no_model | unreadable`, which is three outcomes a caller has to act on, and that is the
 * kind of function a second call site can disagree about.
 *
 * An optional answer is one answer, not two. `resolveWindowsPowerShell` returns `string | undefined`,
 * and `undefined` there is "this environment names no SystemRoot" - every one of its call sites then
 * applies the same `?? "powershell.exe"`. A caller has nothing to choose, so there is no rule that two
 * of them could state differently.
 */
function answerOutcomes(typeNode, sourceFile, seen = new Set()) {
  if (typeNode === undefined || typeNode === null) return null;
  if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) return 2;
  if (ts.isParenthesizedTypeNode(typeNode)) return answerOutcomes(typeNode.type, sourceFile, seen);
  // Every answer of a union is one the caller has to tell apart, whatever shape it carries: a union of
  // three discriminated object literals is three, not one. A union of one answer is a single answer,
  // which is why the floor is 2 for a boolean and 1 for one member below.
  if (ts.isUnionTypeNode(typeNode)) {
    const answers = typeNode.types.filter((member) => !namesAbsence(member));
    return Math.max(1, answers.length);
  }
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const name = typeNode.typeName.text;
    if (
      (name === "Promise" || name === "Readonly" || name === "PromiseLike") &&
      typeNode.typeArguments?.[0] !== undefined
    )
      return answerOutcomes(typeNode.typeArguments[0], sourceFile, seen);
    if (seen.has(name)) return 1;
    const alias = sourceFile.statements.find(
      (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
    );
    return alias === undefined ? 1 : answerOutcomes(alias.type, sourceFile, new Set([...seen, name]));
  }
  return 1;
}

/**
 * The exported decision-verb functions of one module, with the outcomes their declaration admits.
 * A `const`-bound arrow is read too, because this tree declares some deciders that way.
 */
function declaredDeciders(sources, file) {
  const sourceFile = sources.source(file);
  const found = [];
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)) continue;
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      DECISION_VERB.test(statement.name.text)
    ) {
      found.push({
        name: statement.name.text,
        outcomes: answerOutcomes(statement.type, sourceFile),
        where: at(sources.root, statement, sourceFile, file),
      });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !DECISION_VERB.test(declaration.name.text)) continue;
      const initializer = declaration.initializer;
      if (initializer === undefined) continue;
      if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) continue;
      found.push({
        name: declaration.name.text,
        outcomes: answerOutcomes(initializer.type, sourceFile),
        where: at(sources.root, declaration, sourceFile, file),
      });
    }
  }
  return found;
}

/** A relative specifier resolved to the module this class parsed, or null. */
function parsedSpecifier(parsed, from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    base.replace(/\.js$/u, ".ts"),
    base.replace(/\.js$/u, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ])
    if (parsed.has(candidate)) return candidate;
  return null;
}

/**
 * The module that *declares* a decider a file exposes as `name`, following a re-export to its origin.
 * A barrel is transparent: a consumer of the barrel is a consumer of the module that declares the rule,
 * which is the only reading under which a re-export cannot launder a second decider.
 */
function decidingModule(parsed, deciders, file, name, seen = new Set()) {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  if (deciders.has(file) && deciders.get(file).some((decider) => decider.name === name)) return file;
  const sourceFile = parsed.get(file);
  if (sourceFile === undefined) return null;
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    if (statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = parsedSpecifier(parsed, file, statement.moduleSpecifier.text);
    if (target === null) continue;
    if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if ((element.propertyName ?? element.name).text !== name) continue;
        const found = decidingModule(parsed, deciders, target, element.name.text, seen);
        if (found !== null) return found;
      }
      continue;
    }
    const found = decidingModule(parsed, deciders, target, name, seen);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Every call site of every exported decision-verb function, keyed by the module that declares the rule.
 *
 * A call is a `CallExpression` whose callee is an identifier bound to the decider, either imported from
 * the declaring module (directly or through a barrel) or declared in the same file. That binding is what
 * makes the reading a name resolution rather than a text scan: a method named `resolveX` on an unrelated
 * object, and a local variable that happens to share the name, are both excluded by construction.
 */
function deciderCallSites(sources, parsed, deciders) {
  const sites = new Map();
  for (const [file, sourceFile] of parsed) {
    const binding = new Map();
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (statement.importClause === undefined) continue;
      const target = parsedSpecifier(parsed, file, statement.moduleSpecifier.text);
      if (target === null) continue;
      const named = statement.importClause.namedBindings;
      if (named === undefined || !ts.isNamedImports(named)) continue;
      for (const element of named.elements) {
        const imported = (element.propertyName ?? element.name).text;
        const declarer = decidingModule(parsed, deciders, target, imported);
        if (declarer !== null) binding.set(element.name.text, { declarer, name: imported });
      }
    }
    if (binding.size === 0) continue;
    walk(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
      const bound = binding.get(node.expression.text);
      if (bound === undefined) return;
      if (bound.declarer === file) return;
      const key = `${bound.declarer}#${bound.name}`;
      if (!sites.has(key)) sites.set(key, []);
      sites.get(key).push({ file, where: at(sources.root, node, sourceFile, file) });
    });
  }
  return sites;
}

/**
 * The deciders that are called from more than one module inside one surface, with those call sites.
 *
 * A rule consulted by several modules of one surface is a rule those modules each had to reach for;
 * that is the shape a second implementation grows in. One caller per surface - the shape
 * `resolveSurfaceModelSelection` has, one per Chat, Game and Preview - is exactly the pattern this looks
 * for and does not report.
 */
function crowdedDeciders(sources, parsed, deciders) {
  const sites = deciderCallSites(sources, parsed, deciders);
  const crowded = [];
  let consulted = 0;
  for (const [key, calls] of sites) {
    consulted += 1;
    const [declarer, name] = key.split("#");
    const perSurface = new Map();
    for (const call of calls) {
      const surface = surfaceOf(sources.root, call.file);
      if (!perSurface.has(surface)) perSurface.set(surface, new Set());
      perSurface.get(surface).add(call.file);
    }
    const over = [...perSurface].filter(([, callers]) => callers.size > 1);
    if (over.length === 0) continue;
    const decider = deciders.get(declarer).find((entry) => entry.name === name);
    crowded.push({ declarer, name, decider, surfaces: over, calls });
  }
  return { crowded, consulted };
}

/**
 * Whether a crowded decider's answer can carry two or more distinct outcomes, i.e. whether two call
 * sites could disagree about it.
 *
 * This is the class's promotion criterion as a reading of the declaration: a decider answering one shape
 * is a constructor, and a constructor cannot diverge - it names one object, so no caller receives an
 * answer another did not. A decider answering `boolean`, or a union, is a rule a caller has to act on,
 * and that is the shape a second call site can state differently.
 */
function canDiverge(decider) {
  return decider.outcomes !== null && decider.outcomes >= 2;
}

function runDuplication(sources) {
  const roots = workspaceSourceRoots(sources);
  const files = roots.flatMap((root) => sources.files(root));
  const parsed = new Map(files.map((file) => [file, sources.source(file)]));
  const deciders = new Map();
  for (const file of files) {
    const declared = declaredDeciders(sources, file);
    if (declared.length > 0) deciders.set(file, declared);
  }
  const { crowded, consulted } = crowdedDeciders(sources, parsed, deciders);
  const declaredCount = [...deciders.values()].reduce((total, entries) => total + entries.length, 0);

  const violations = [];
  const constructors = [];
  let diverging = 0;
  for (const entry of crowded) {
    const surfaces = entry.surfaces
      .map(
        ([surface, callers]) => `${surface} (${[...callers].map((file) => relativeTo(sources.root, file)).join(", ")})`,
      )
      .join("; ");
    if (!canDiverge(entry.decider)) {
      constructors.push(`${entry.name} (one outcome) -> ${surfaces}`);
      continue;
    }
    diverging += 1;
    violations.push({
      rank: 3,
      where: entry.calls[0].where,
      message: `${entry.name} (${entry.declarer.slice(sources.root.length + 1).replaceAll("\\", "/")}) admits ${entry.decider.outcomes} outcomes and is called from more than one module inside a surface: ${surfaces}; ${entry.calls.map((call) => call.where).join(", ")}`,
    });
  }

  const notes = [];
  notes.push(
    `duplication: ${declaredCount} exported decision-verb function(s) declared across ${files.length} source file(s), ${consulted} called from another module, ${crowded.length} called from more than one module inside one surface (${crowded.length - diverging} of them constructors)`,
  );
  if (constructors.length > 0)
    notes.push(
      `duplication: crowded by construction, cannot diverge - each answers exactly one outcome, so no two call sites can receive answers that disagree: ${constructors.join("; ")}`,
    );
  notes.push(
    `duplication: promotion condition - this class is blocking for a crowded decider whose declared answer admits two or more answers a caller has to tell apart (a boolean, or a union of two or more members that are not the absence of an answer). It reports ${diverging} such decider(s) today${diverging === 0 ? ", so nothing here blocks; the class stays advisory only because no such decider exists yet" : ", which is why it is advisory: promoting it now would veto a plurality this tree already holds, and resolving that plurality is a product edit"}`,
  );
  notes.push(
    "duplication: what it cannot see - two implementations with different names (nothing here reads intent), a decision inlined into a caller with no decider function at all, and a decider whose second consumer reaches it through an `export *` barrel with no `index.ts`, which the specifier resolver does not follow",
  );
  return { declared: declaredCount, violations, notes };
}

// ---------------------------------------------------------------------------
// Classes: delegated gates
// ---------------------------------------------------------------------------

/**
 * The gates that already own a reading this audit must not keep a second copy
 * of. Each runs as its own process (they load TypeScript and the browser
 * modules through `tsx`) and the audit lifts the failure names and the walked
 * count out of their TAP output.
 */
const DELEGATED = Object.freeze([
  {
    id: "codes",
    into: "codes",
    file: "dialogue-web/tests/problem-code-gate.test.mjs",
    tests: ["problem-code.8", "problem-code.9", "problem-code.10"],
  },
  { id: "catalogue", into: null, file: "dialogue-web/tests/i18n-parity-gate.test.mjs", tests: ["i18n.7"] },
  { id: "prompt", into: null, file: "dialogue-web/tests/enum-leak-gate.test.mjs", tests: ["enum."] },
  {
    id: "promises",
    into: null,
    file: "dialogue-web/tests/memory-notebook-promise-gate.test.mjs",
    tests: ["notebook-promise."],
  },
]);

/** `not ok N - name` blocks from a TAP stream, with their message and the diagnostics. */
function parseTap(output) {
  const failures = [];
  const diagnostics = [];
  const lines = output.split("\n");
  let current = null;
  for (const line of lines) {
    const failed = /^not ok \d+ - (.*)$/u.exec(line);
    if (failed !== null) {
      current = { name: failed[1], message: [] };
      failures.push(current);
      continue;
    }
    if (/^ok \d+ - /u.test(line) || /^\d+\.\.\d+$/u.test(line)) {
      current = null;
      continue;
    }
    if (line.startsWith("# ")) {
      diagnostics.push(line.slice(2));
      continue;
    }
    if (current === null) continue;
    const message = /^\s+error: \|?-?$|^\s+message: (.*)$/u.exec(line);
    if (message !== null) {
      if (message[1] !== undefined) current.message.push(message[1]);
      continue;
    }
    if (/^\s{4,}\S/u.test(line)) current.message.push(line.trim());
  }
  return {
    failures: failures.map((failure) => ({ name: failure.name, message: failure.message.join("\n").trim() })),
    diagnostics,
  };
}

function runDelegated(sources, gate) {
  if (!existsSync(sources.path(...gate.file.split("/"))))
    return {
      id: gate.id,
      rank: 3,
      title: "delegated gate",
      declared: 0,
      violations: [],
      notes: [`${gate.id}: ${gate.file} is absent; the delegated reading did not run`],
    };
  const [packageDirectory] = gate.file.split("/");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-reporter=tap", gate.file.slice(packageDirectory.length + 1)],
    { cwd: sources.path(packageDirectory), encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const { failures, diagnostics } = parseTap(output);
  const relevant = failures.filter((failure) => gate.tests.some((prefix) => failure.name.startsWith(prefix)));
  const violations = relevant.map((failure) => ({
    rank: 3,
    where: `${gate.file} :: ${failure.name.split(":")[0]}`,
    message: failure.message.length > 0 ? failure.message.slice(0, 900) : "gate failed",
  }));
  const walked = diagnostics
    .filter((line) => gate.tests.some((prefix) => line.startsWith(`${prefix}:`)))
    .map((line) => Number(/(\d+)/u.exec(line)?.[1] ?? "0"))
    .reduce((total, value) => Math.max(total, value), 0);
  const notes = [
    `${gate.id}: delegated to ${gate.file} (${gate.tests.join(", ")}); ${failures.length} failing test(s) in that file, ${relevant.length} owned by this class`,
  ];
  if (result.error !== undefined) notes.push(`${gate.id}: the delegated gate could not run (${result.error.message})`);
  return {
    id: gate.id,
    rank: 3,
    title: `the gate that already owns this reading (${gate.file.split("/").at(-1)})`,
    declared: walked,
    violations,
    notes,
  };
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/**
 * Classes whose findings print but do not fail the run.
 *
 * A class belongs here for one reason: its findings are a ruling the owner has not taken, so a red from it would
 * veto an unmade decision rather than report a defect this repository already holds wrong. That is not a licence
 * for a rule that cannot read its own fixture - such a rule would be a broken gate, and every rule here is proved
 * clean-then-red-then-clean on the scratch tree before it is trusted.
 *
 * `hygiene` is the member, and the argument is its own note: every one of its 152 findings is one pattern, a Host
 * export no production code reaches, which one ruling settles - accept it wholesale and withdraw the rule, or treat
 * it as one defect and sweep it mechanically. Until that ruling exists the class reports by kind with counts and a
 * bounded sample, and it does not block.
 *
 * That count only became a reading when the importer detection was resolved (`759b588a`). The scan it replaced keyed
 * importers by the bare name of an `import` declaration, so an export the declaring module itself names - a constant
 * the file uses, `MAX_PLAN_NODES` at `body-program-script.ts:66`, with a test importing it - was reported as a
 * production path with no production consumer, and an import that renamed the binding cleared the wrong symbol. 286 of
 * the 287 findings the fix removed were the first shape; the rest moved to the declaration a re-export list aliases.
 * The class now resolves a relative specifier to the module it names, treats a re-export barrel as transparent, and
 * counts a module's own use of its export; its own test proves both directions, and the 152 that remain are real.
 *
 * `read-path` left this list when the rule learned the namespaced schema reference the product writes (`e9efd15e`):
 * its fixture now resolves the site, goes red on a projection bounded above the schema it validates against, and
 * goes green again, so it blocks - and the real tree reports `0 cap(s) that the projection can exceed`.
 *
 * `bounds`, `fields` and `routes` are not here. Their heuristics were triaged, and each now compares only what
 * it can prove: a cap is paired with a constant only when that constant names the same property, a field counts
 * as produced or read when the side that produces or reads it spells the name in any form (property, shorthand,
 * JSX attribute, binding, literal), and a route table entry is checked as an entry rather than as an occurrence
 * of the word `routeId`. What remains uncertain - a cap no constant names, a field no source spells while the
 * schema around it is used - prints as a note and is never reported as a violation, so a green run means the
 * class found nothing it can prove, not that it stopped looking.
 *
 * `duplication` is still here, but no longer because of a defect it reports: since the class learned that an
 * optional answer is one answer, `resolveWindowsPowerShell` (`string | undefined`) is a constructor like the
 * other two - its `undefined` is "this environment names no SystemRoot", and every call site applies the same
 * `?? "powershell.exe"`, so no two of them can disagree. The class reports zero diverging deciders today, and
 * the note says so. It stays advisory for the reason every class here does: a red from it would veto a ruling
 * the owner has not taken rather than report a defect this repository holds wrong. The promotion condition is
 * unchanged and still testable - a crowded decider whose answer is a boolean or a union of two real answers.
 */
export const ADVISORY = Object.freeze(new Set(["hygiene", "duplication"]));

export const CLASSES = Object.freeze([
  ...CLASS_IMPLEMENTATIONS,
  { id: "codes", rank: 3, title: "every problem code is declared, produced, mirrored and named", run: runCodes },
  { id: "routes", rank: 3, title: "every declared route has a handler and vice versa", run: runRoutes },
  { id: "fields", rank: 3, title: "every declared field is produced and read", run: runFields },
  { id: "catalogue", rank: 4, title: "every declared catalogue key is read or recorded", run: null },
  { id: "prompt", rank: 4, title: "no rendered text carries an engineering artefact", run: runPrompt },
  { id: "promises", rank: 4, title: "a promise names something reachable", run: runPromises },
  { id: "hygiene", rank: 4, title: "no test-only production path, suppression or dead comment", run: runHygiene },
  {
    id: "duplication",
    rank: 4,
    title: "a decision-verb function is consulted by one module per surface",
    run: runDuplication,
  },
]);

// The gate `package.json` runs, and only that: a test that imports the class list must not run a whole audit
// as a side effect of the import.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
