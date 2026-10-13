/**
 * A hand-written client mirror must accept what the contract declares - required required, optional allowed.
 *
 * The measured defect: `dialogue-web/src/management-pipeline-api.ts` pinned a six-key
 * `MESSAGE_KEYS` and validated messages with it, while the Host's
 * `BrowserMessageV1Schema` declares two ADDITIVE OPTIONAL fields (`swipeInfo`,
 * `openingVariant`). A host that sent either - both legal v1 reads - was rejected
 * as a protocol error, and the whole management surface (every panel) went dark
 * for the time between the contract growing a field and the mirror learning it.
 * The same shape of failure had already happened once, with World Info's `pending`
 * key. Both were repaired by editing one mirror; nothing held the rule, so the
 * next declared-optional field would have done it again.
 *
 * This gate holds it, driven by the contract's own schemas and the mirror's own
 * validators:
 *
 *   - the contract's object shapes come from the exported TypeBox schemas
 *     (`TavernBrowserContractV1.schemas`, `GameBrowserContractV1.schemas`,
 *     `ComposedReferenceGameBrowserRootV1Schema`), walking unions, arrays and
 *     nested properties. Each shape yields its declared, required and optional
 *     keys; no key list lives in this file;
 *   - the mirror side is the *validator function*: the array-of-keys it compares a
 *     payload against (including a "with this optional field" variant and an
 *     inline allowance inside the comparison), and every key name that function
 *     knows. A module-wide vocabulary of enum VALUES (e.g.
 *     `PREREQUISITE_STATUSES`) is never a key set, so it can never be a finding;
 *   - for a validator that claims a contract shape - one of its key sets is
 *     exactly that shape's REQUIRED keys - every key the contract DECLARES for
 *     that shape must be a key the validator knows. Required keys are required
 *     (they are the claimed set), optional keys are allowed (they must be named),
 *     which is the property a stricter-than-contract mirror breaks.
 *
 * The check is scoped per validator, not per module, so a function that allows a
 * variant (`hasExactKeys(v, A) || hasExactKeys(v, B)`) is judged on both, and an
 * arithmetic allowance (`MESSAGE_KEYS.length + optionalKeys.filter(...)`) counts
 * by the keys it names.
 *
 * What this cannot express honestly, and therefore does not claim:
 *  - it is source-level agreement, not an executed payload: it shows the validator
 *    KNOWS the key, not that its exact-key arithmetic admits it. The modules' own
 *    tests carry the executed half (a legal `swipeInfo` message must validate);
 *  - it checks the direction that takes a surface down (mirror stricter than the
 *    contract). A mirror accepting a key no contract declares is not this rule's
 *    subject: the mirrors span four contract profiles (tavern, reference pipeline,
 *    composed reference game, game browser), so a key set matching no declared
 *    shape is counted in the diagnostic and never asserted. The one such key set
 *    today is the composed refusal's `{ code, cause }`
 *    (`composed-reference-game-browser-api.ts`), whose producer really does emit
 *    both fields (`host/src/composed-reference-game-browser.test.ts`) while the
 *    composed contract declares no refusal shape at all - a contract gap, not a
 *    client drift;
 *  - a contract shape no validator claims is not a finding: the mirror's own tests
 *    are what make a profile's shapes reachable.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ComposedReferenceGameBrowserRootV1Schema } from "../../host/src/composed-browser-contract/index.ts";
import { GameBrowserContractV1 } from "../../host/src/game-browser-contract/index.ts";
import { TavernBrowserContractV1 } from "../../host/src/tavern/browser-contract/index.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO, "src");

/** The hand-written mirror modules whose validators must agree with the contracts. */
export const MIRROR_MODULES = [
  "management-pipeline-api.ts",
  "management-pipeline-session.ts",
  "reference-pipeline-api.ts",
  "composed-reference-game-browser-api.ts",
];

/**
 * Every object shape a TypeBox schema declares, walking unions, arrays and nested
 * properties: `{ declared, required, optional }`. Derived, so a contract that
 * grows a field is covered without touching this file.
 */
export function objectShapes(node, out = []) {
  if (node === null || typeof node !== "object") return out;
  if (!Array.isArray(node) && node.type === "object" && node.properties !== undefined) {
    const declared = Object.keys(node.properties);
    const required = Array.isArray(node.required) ? node.required : [];
    out.push({ declared, required, optional: declared.filter((key) => !required.includes(key)) });
  }
  for (const value of Object.values(node)) objectShapes(value, out);
  return out;
}

/** The object shapes of every contract this client mirrors, deduplicated by signature. */
export function contractShapes() {
  const raw = [
    ...Object.values(TavernBrowserContractV1.schemas).flatMap((schema) => objectShapes(schema)),
    ...objectShapes(ComposedReferenceGameBrowserRootV1Schema),
    ...Object.values(GameBrowserContractV1.schemas).flatMap((schema) => objectShapes(schema)),
  ];
  const seen = new Set();
  const shapes = [];
  for (const shape of raw) {
    const signature = [...shape.declared].sort().join("\u0000");
    if (seen.has(signature)) continue;
    seen.add(signature);
    shapes.push(shape);
  }
  return shapes;
}

/** True when two key lists hold exactly the same keys. */
export function sameKeys(left, right) {
  return (
    left.length === new Set(left).size &&
    left.length === right.length &&
    new Set(right).size === right.length &&
    left.every((key) => right.includes(key))
  );
}

function unwrap(node) {
  let current = node;
  while (
    current !== undefined &&
    (ts.isSatisfiesExpression(current) || ts.isAsExpression(current) || ts.isParenthesizedExpression(current))
  )
    current = current.expression;
  return current;
}

/**
 * Every validator function of one mirror module: the key sets it compares against
 * (named, spread or inline, with the keys resolved) and every key name it knows.
 * `management-pipeline-session.ts` delegates its validation and legitimately has
 * none; the module count in the diagnostic shows that rather than hiding it.
 */
export function validatorsOf(name) {
  const path = join(SRC, name);
  const sourceFile = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const arrays = new Map();
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const initializer = unwrap(node.initializer);
      if (initializer !== undefined && ts.isArrayLiteralExpression(initializer)) arrays.set(node.name.text, initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const keysOf = (array, depth = 0) => {
    const keys = [];
    for (const element of array.elements) {
      if (ts.isStringLiteral(element)) keys.push(element.text);
      else if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression) && depth < 4) {
        const spread = arrays.get(element.expression.text);
        if (spread !== undefined) keys.push(...keysOf(spread, depth + 1));
      }
    }
    return keys;
  };

  const validators = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body !== undefined) {
      const accepted = [];
      const seen = new Set();
      const known = new Set();
      /**
       * A key set the validator CLAIMS: the array it hands to `hasExactKeys`, or a
       * SCREAMING `*_KEYS*` list it compares against. Everything else a body names
       * (an enum's values, a single name) only widens what the validator knows.
       */
      const claim = (name, keys, line) => {
        const signature = `${name}\u0000${line}\u0000${keys.join(",")}`;
        if (seen.has(signature)) return;
        seen.add(signature);
        accepted.push({ name, keys, line });
      };
      const learn = (keys) => {
        for (const key of keys) known.add(key);
      };
      const knownKeysOf = (argument) => {
        if (ts.isArrayLiteralExpression(argument)) return keysOf(argument);
        if (ts.isIdentifier(argument) && arrays.has(argument.text)) return keysOf(arrays.get(argument.text));
        return [];
      };
      const walkBody = (inner) => {
        if (ts.isStringLiteral(inner)) known.add(inner.text);
        if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === "hasExactKeys") {
          const keys = knownKeysOf(inner.arguments[1]);
          if (keys.length > 0) {
            const argument = inner.arguments[1];
            claim(ts.isIdentifier(argument) ? argument.text : "(inline)", keys, lineOf(argument));
            learn(keys);
          }
        } else if (ts.isArrayLiteralExpression(inner)) {
          learn(keysOf(inner));
        } else if (ts.isIdentifier(inner) && arrays.has(inner.text)) {
          const keys = keysOf(arrays.get(inner.text));
          if (/^[A-Z][A-Z0-9_]*KEYS[A-Z0-9_]*$/u.test(inner.text)) {
            claim(inner.text, keys, lineOf(arrays.get(inner.text)));
          }
          learn(keys);
        }
        ts.forEachChild(inner, walkBody);
      };
      walkBody(node.body);
      const declared = node.name !== undefined && ts.isIdentifier(node.name) ? node.name.text : "(anonymous)";
      validators.push({ file: name, name: declared, line: lineOf(node), accepted, known: [...known] });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return validators;
}

/** True when a validator's own function name or a key-set name reads as a validator. */
function looksLikeValidator(validator) {
  return /^(is|has|validate|assert)/u.test(validator.name) || validator.accepted.length > 0;
}

/**
 * Validators that claim a contract shape (one of their key sets is exactly the
 * shape's required keys) but do not know a key the contract declares for it: the
 * mirror is stricter than the contract, and a legal response is refused.
 *
 * `shapes` and `validators` are parameters so the mutation test below runs the
 * exact rule the real gate runs.
 */
export function mirrorStricterThanContract(validators, shapes = contractShapes()) {
  const findings = [];
  const seen = new Set();
  for (const validator of validators) {
    if (!looksLikeValidator(validator)) continue;
    const known = new Set(validator.known);
    for (const accepted of validator.accepted) {
      const shape = shapes.find((candidate) => sameKeys(accepted.keys, candidate.required));
      if (shape === undefined) continue;
      for (const key of shape.declared) {
        if (known.has(key)) continue;
        const finding = `${validator.file}:${validator.line}: ${validator.name} claims the contract's required keys [${shape.required.join(", ")}] but does not know the declared key ${key}`;
        if (seen.has(finding)) continue;
        seen.add(finding);
        findings.push(finding);
      }
    }
  }
  return findings;
}

/** Key sets claimed by no declared shape's required keys, for the diagnostic only. */
export function unmatchedKeySets(validators, shapes = contractShapes()) {
  const unmatched = [];
  for (const validator of validators)
    for (const accepted of validator.accepted)
      if (!shapes.some((candidate) => sameKeys(accepted.keys, candidate.required)))
        unmatched.push(`${validator.file}:${accepted.line}: ${accepted.name} [${accepted.keys.join(", ")}]`);
  return unmatched;
}

const VALIDATORS = MIRROR_MODULES.flatMap((name) => validatorsOf(name));

test("mirror-keys.1: a validator that keeps a declared contract key out is a finding", (t) => {
  const shapes = contractShapes();
  const validators = MIRROR_MODULES.flatMap((name) => validatorsOf(name));
  const findings = mirrorStricterThanContract(validators, shapes);
  const accepted = validators.reduce((total, validator) => total + validator.accepted.length, 0);
  const unmatched = unmatchedKeySets(validators, shapes);
  t.diagnostic(
    `mirror-keys.1: ${MIRROR_MODULES.length} mirror module(s) (${MIRROR_MODULES.map((name) => `${name}:${validatorsOf(name).length} validator(s)`).join(", ")}), ${accepted} claimed key set(s), ${shapes.length} contract shape(s) of which ${shapes.filter((shape) => shape.optional.length > 0).length} carry a declared optional key; ${findings.length} violation(s); ${unmatched.length} claimed key set(s) matching no declared shape (not asserted: the mirrors span four profiles)`,
  );
  assert.deepEqual(findings, [], "a validator stricter than the contract refuses a legal response and takes the surface down with it");
});

test("mirror-keys.2: the enumeration is real, so a silently empty scan cannot pass", (t) => {
  const shapes = contractShapes();
  const claiming = VALIDATORS.filter((validator) =>
    validator.accepted.some((accepted) => shapes.some((shape) => sameKeys(accepted.keys, shape.required))),
  );
  assert.ok(VALIDATORS.length >= MIRROR_MODULES.length, "every named mirror module must be readable");
  assert.ok(claiming.length >= 10, `expected validators to claim declared shapes, found ${claiming.length}`);
  assert.ok(
    shapes.some((shape) => shape.optional.includes("swipeInfo") && shape.optional.includes("openingVariant")),
    "the message shape's optional facts must be derived from the contract's own schema",
  );
  t.diagnostic(
    `mirror-keys.2: ${claiming.length} validator(s) claim a declared shape; the message shape's optional facts are read from BrowserMessageV1Schema`,
  );
});

test("mirror-keys.3 (mutation): a planted contract key the validator omits is reported", (t) => {
  const shapes = [{ declared: ["handle", "role", "swipeInfo"], required: ["handle", "role"], optional: ["swipeInfo"] }];
  const planted = {
    file: "planted-mirror.ts",
    name: "isBrowserMessage",
    line: 7,
    accepted: [{ name: "MESSAGE_KEYS", keys: ["handle", "role"], line: 7 }],
    known: ["handle", "role", "text"],
  };
  assert.deepEqual(mirrorStricterThanContract([planted], shapes), [
    "planted-mirror.ts:7: isBrowserMessage claims the contract's required keys [handle, role] but does not know the declared key swipeInfo",
  ]);
  const learning = { ...planted, known: [...planted.known, "swipeInfo"] };
  assert.deepEqual(mirrorStricterThanContract([learning], shapes), [], "a validator that knows the declared key is clean");
  t.diagnostic("mirror-keys.3: the planted omission is reported with its location; knowing the declared key clears it");
});
