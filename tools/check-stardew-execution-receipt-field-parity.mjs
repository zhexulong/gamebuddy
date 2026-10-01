// Gate: stardew_execution_receipt_field_parity/v1
//
// Single-authority mechanical check for the execution receipt field contract.
// The Mod-owned wire model `BridgeReceipt` (integrations/stardew/src/Core/Models/
// BridgeProtocolModels.cs) is the authority: every other layer that names a receipt
// field must name exactly the same set (Mod ledger record, TryProjectReceipt
// projection, Host protocol type, Host allowlist validator, wire JSON schema,
// Host adapter receipt type, and both adapter mapping functions).
//
// Layer kinds:
//  - "exact":     must name exactly the authority's full wire field set.
//  - "projection":must name exactly the documented Host-internal projection
//                 subset (authority minus DOCUMENTED_PROJECTION_DROPS).
//  - "validate":  allowlist validator; its unconditional base array must equal the
//                 required fields and its conditional pushes must equal the
//                 optional fields.
//  - "schema":    JSON schema $defs.receipt; properties must equal the full set and
//                 required must equal the required subset.
//  - "count":     Mod TryProjectReceipt must pass every authority field to the wire
//                 model constructor (positional argument count).
//  - "mapping":   Host adapter mapping functions; written object keys must equal the
//                 projection subset and every read must name an authority field.
//
// Host-side intentional extras are legal only when explicitly listed in
// DOCUMENTED_EXTRAS (currently empty) together with a reason.
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gate = "stardew_execution_receipt_field_parity/v1";

const BRIDGE_MODELS_PATH = "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs";
const BRIDGE_SESSION_PATH = "integrations/stardew/BridgeSession.cs";
const PROTOCOL_PATH = "host/src/protocol.ts";
const SCHEMA_PATH = "protocol/bridge-v1.schema.json";
const GAME_ADAPTER_PATH = "host/src/game-integration-adapter.ts";
const STARDEW_ADAPTER_PATH = "host/src/stardew-game-integration-adapter.ts";

/** Fields the Host adapter deliberately drops when projecting the wire receipt. */
export const DOCUMENTED_PROJECTION_DROPS = Object.freeze(["observation", "piggybackedScene"]);

const PROJECTION_DROP_REASON =
  "Host-internal documented projection: observation/piggybackedScene are scene-rich wire facts that the Host " +
  "validates and forwards at the bridge layer; the Agent-facing IntegrationExecutionReceipt deliberately does " +
  "not re-expose them.";

/** Per-layer explicitly recorded intentional extra fields, each with a reason. Currently none. */
export const DOCUMENTED_EXTRAS = Object.freeze({
  "BridgeProtocolModels.cs/LocalExecutionReceipt": Object.freeze([]),
  "protocol.ts/ExecutionReceipt": Object.freeze([]),
  "protocol.ts/validateReceipt": Object.freeze([]),
  "schema.json/$defs.receipt": Object.freeze([]),
  "game-integration-adapter.ts/IntegrationExecutionReceipt": Object.freeze([]),
  "stardew-game-integration-adapter.ts/toIntegrationReceipt": Object.freeze([]),
  "stardew-game-integration-adapter.ts/parseStardewReceipt": Object.freeze([]),
});

// ---------------------------------------------------------------------------
// Tokenizer (comments, strings, words, punctuation)
// ---------------------------------------------------------------------------

function tokenize(source) {
  const result = [];
  for (let index = 0; index < source.length; ) {
    const char = source[index];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") index += 1;
        value += source[index] ?? "";
        index += 1;
      }
      if (source[index] === quote) index += 1;
      result.push({ type: "string", value, offset: index });
      continue;
    }
    if (/[A-Za-z_$]/u.test(char)) {
      const start = index;
      index += 1;
      while (/[A-Za-z0-9_$]/u.test(source[index] ?? "")) index += 1;
      result.push({ type: "word", value: source.slice(start, index), offset: start });
      continue;
    }
    result.push({ type: "punct", value: char, offset: index });
    index += 1;
  }
  return result;
}

/** Index of the token closing the opening token at `openIndex`, or -1. Handles (){}[]<>. */
function balanced(tokens, openIndex) {
  const open = tokens[openIndex]?.value;
  const close = { "(": ")", "[": "]", "{": "}", "<": ">" }[open];
  if (open === undefined || close === undefined) return -1;
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value !== open && value !== close) continue;
    if (value === open) depth += 1;
    else if (--depth === 0) return index;
  }
  return -1;
}

/** Split tokens into top-level groups on `separator`, ignoring nesting of (){}[]<>. */
function splitTopLevel(tokens, separator) {
  const groups = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === "(" || value === "[" || value === "{" || value === "<") depth += 1;
    else if (value === ")" || value === "]" || value === "}" || value === ">") {
      depth = Math.max(0, depth - 1);
    } else if (value === separator && depth === 0) {
      groups.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  groups.push(tokens.slice(start));
  return groups;
}

/** First token index (from `from`) whose value equals `value` at nesting depth 0, or -1. */
function topLevelIndexOf(tokens, value, from = 0) {
  let depth = 0;
  for (let index = from; index < tokens.length; index += 1) {
    const token = tokens[index].value;
    if (token === "(" || token === "[" || token === "{" || token === "<") depth += 1;
    else if (token === ")" || token === "]" || token === "}" || token === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0 && token === value) return index;
  }
  return -1;
}

/** The last word token in a group, or null (parameter-name position). */
function lastWord(tokens) {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index].type === "word") return tokens[index].value;
  }
  return null;
}

function camelCase(name) {
  return name.length === 0 ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

// ---------------------------------------------------------------------------
// C# record parsing (authority + ledger model)
// ---------------------------------------------------------------------------

/**
 * Parse the fields of a `public sealed record <name>(...)` declaration.
 * Returns { wire: string[], required: string[], optional: Set<string> } where
 * `optional` holds the wire names whose property carries `JsonIgnore WhenWritingNull`.
 */
export function extractCSharpRecordFields(source, recordName) {
  const tokens = tokenize(source);
  const recordAt = tokens.findIndex(
    (token, index) =>
      token.type === "word" && token.value === "record" &&
      tokens[index + 1]?.type === "word" && tokens[index + 1].value === recordName &&
      tokens[index + 2]?.value === "(",
  );
  if (recordAt < 0) throw new Error(`C# record '${recordName}' declaration not found`);
  const open = recordAt + 2;
  const close = balanced(tokens, open);
  if (close < 0) throw new Error(`C# record '${recordName}' has unbalanced parentheses`);
  const body = tokens.slice(open + 1, close);

  const fields = [];
  for (const parameter of splitTopLevel(body, ",")) {
    if (parameter.length === 0) continue;
    let index = 0;
    let optional = false;
    while (parameter[index]?.value === "[") {
      const attrClose = balanced(parameter, index);
      if (attrClose < 0) throw new Error(`C# record '${recordName}' has an unbalanced attribute list`);
      const attribute = parameter.slice(index + 1, attrClose);
      if (attribute.some((token) => token.type === "word" && token.value === "WhenWritingNull")) optional = true;
      index = attrClose + 1;
    }
    const remaining = parameter.slice(index);
    const eq = topLevelIndexOf(remaining, "=");
    const lhs = eq < 0 ? remaining : remaining.slice(0, eq);
    const name = lastWord(lhs);
    if (name === null) throw new Error(`C# record '${recordName}' has an unparseable parameter`);
    fields.push({ wire: camelCase(name), optional });
  }
  return Object.freeze({
    wire: Object.freeze(fields.map((field) => field.wire)),
    required: Object.freeze(fields.filter((field) => !field.optional).map((field) => field.wire)),
    optional: new Set(fields.filter((field) => field.optional).map((field) => field.wire)),
  });
}

// ---------------------------------------------------------------------------
// C# TryProjectReceipt projection
// ---------------------------------------------------------------------------

/** Count the positional args of the `new BridgeReceipt(...)` call inside TryProjectReceipt. */
export function extractProjectionArgCount(source) {
  const tokens = tokenize(source);
  const fnIndex = tokens.findIndex(
    (token, index) => token.type === "word" && token.value === "TryProjectReceipt" && tokens[index + 1]?.value === "(",
  );
  if (fnIndex < 0) throw new Error("TryProjectReceipt declaration not found");
  const signatureClose = balanced(tokens, fnIndex + 1);
  if (signatureClose < 0) throw new Error("TryProjectReceipt signature has unbalanced parentheses");
  let bodyOpen = -1;
  for (let index = signatureClose + 1; index < tokens.length; index += 1) {
    if (tokens[index].value === "{") {
      bodyOpen = index;
      break;
    }
  }
  if (bodyOpen < 0) throw new Error("TryProjectReceipt body not found");
  const bodyClose = balanced(tokens, bodyOpen);
  if (bodyClose < 0) throw new Error("TryProjectReceipt body has unbalanced braces");
  const body = tokens.slice(bodyOpen + 1, bodyClose);

  const newAt = body.findIndex(
    (token, index) =>
      token.value === "new" && body[index + 1]?.type === "word" &&
      body[index + 1].value === "BridgeReceipt" && body[index + 2]?.value === "(",
  );
  if (newAt < 0) throw new Error("new BridgeReceipt(...) call not found inside TryProjectReceipt");
  const argsClose = balanced(body, newAt + 2);
  if (argsClose < 0) throw new Error("new BridgeReceipt(...) call has unbalanced parentheses");
  const args = body.slice(newAt + 3, argsClose);
  return splitTopLevel(args, ",").filter((group) => group.length > 0).length;
}

// ---------------------------------------------------------------------------
// TS type parsing (ExecutionReceipt / IntegrationExecutionReceipt)
// ---------------------------------------------------------------------------

/** String offsets of `export type X = Readonly<{ ... }>` — start at `{`, end just past `}`. */
export function findTsTypeBodyRange(source, typeName) {
  const anchor = `type ${typeName} = Readonly<{`;
  const start = source.indexOf(anchor);
  if (start < 0) throw new Error(`TS type '${typeName}' not found (expected '${anchor}')`);
  const tokens = tokenize(source.slice(start));
  const open = tokens.findIndex((token) => token.value === "{");
  if (open < 0) throw new Error(`TS type '${typeName}' has no object body`);
  const inner = tokens.slice(open);
  const close = balanced(inner, 0);
  if (close < 0) throw new Error(`TS type '${typeName}' object body is unbalanced`);
  return { start: start + tokens[open].offset, end: start + inner[close].offset + 1 };
}

/** Parse `export type X = Readonly<{...}>` into { fields: string[], optional: Set<string> }. */
export function extractTsTypeProperties(source, typeName) {
  const { start, end } = findTsTypeBodyRange(source, typeName);
  const body = source.slice(start, end);
  const tokens = tokenize(body).slice(1, -1); // drop the '{' and '}'
  const fields = [];
  const optional = new Set();
  for (const statement of splitTopLevel(tokens, ";")) {
    const meaningful = statement.filter((token) => token.type === "word" || token.type === "punct");
    if (meaningful.length === 0 || meaningful[0].type !== "word") continue;
    if (meaningful[1]?.value === ":") {
      fields.push(meaningful[0].value);
    } else if (meaningful[1]?.value === "?" && meaningful[2]?.value === ":") {
      fields.push(meaningful[0].value);
      optional.add(meaningful[0].value);
    }
  }
  return Object.freeze({ fields: Object.freeze(fields), optional });
}

// ---------------------------------------------------------------------------
// validateReceipt allowlist parsing
// ---------------------------------------------------------------------------

export function extractValidateReceiptSets(source) {
  const tokens = tokenize(source);
  const fnIndex = tokens.findIndex(
    (token, index) =>
      token.type === "word" && token.value === "function" &&
      tokens[index + 1]?.type === "word" && tokens[index + 1].value === "validateReceipt" &&
      tokens[index + 2]?.value === "(",
  );
  if (fnIndex < 0) throw new Error("function validateReceipt not found");
  const signatureClose = balanced(tokens, fnIndex + 2);
  if (signatureClose < 0) throw new Error("validateReceipt signature unbalanced");
  let bodyOpen = -1;
  for (let index = signatureClose + 1; index < tokens.length; index += 1) {
    if (tokens[index].value === "{") {
      bodyOpen = index;
      break;
    }
  }
  if (bodyOpen < 0) throw new Error("validateReceipt body not found");
  const bodyClose = balanced(tokens, bodyOpen);
  if (bodyClose < 0) throw new Error("validateReceipt body unbalanced");
  const body = tokens.slice(bodyOpen + 1, bodyClose);

  const allowedAt = body.findIndex(
    (token, index) =>
      token.type === "word" && token.value === "allowedKeys" &&
      body[index + 1]?.value === "=" && body[index + 2]?.value === "[",
  );
  if (allowedAt < 0) throw new Error("validateReceipt allowedKeys array not found");
  const arrayClose = balanced(body, allowedAt + 2);
  if (arrayClose < 0) throw new Error("validateReceipt allowedKeys array unbalanced");
  const base = [];
  for (const group of splitTopLevel(body.slice(allowedAt + 3, arrayClose), ",")) {
    if (group.length === 1 && group[0].type === "string") base.push(group[0].value);
  }
  const pushes = [];
  for (let index = 0; index < body.length; index += 1) {
    if (
      body[index]?.type === "word" && body[index].value === "allowedKeys" &&
      body[index + 1]?.value === "." && body[index + 2]?.type === "word" &&
      body[index + 2].value === "push" && body[index + 3]?.value === "(" &&
      body[index + 4]?.type === "string" && body[index + 5]?.value === ")"
    ) {
      pushes.push(body[index + 4].value);
    }
  }
  return Object.freeze({ base: Object.freeze(base), pushes: Object.freeze(pushes) });
}

// ---------------------------------------------------------------------------
// Schema parsing
// ---------------------------------------------------------------------------

export function extractSchemaReceipt(source) {
  const schema = JSON.parse(source);
  const receipt = schema?.$defs?.receipt;
  if (receipt === undefined || typeof receipt !== "object") throw new Error("schema $defs.receipt not found");
  const properties = receipt.properties === undefined ? null : Object.keys(receipt.properties);
  const required = Array.isArray(receipt.required) ? receipt.required : null;
  return Object.freeze({
    properties: properties === null ? null : Object.freeze(properties),
    required: required === null ? null : Object.freeze(required),
  });
}

// ---------------------------------------------------------------------------
// Adapter mapping function parsing (toIntegrationReceipt / parseStardewReceipt)
// ---------------------------------------------------------------------------

export function extractMappingKeysAndReads(source, functionName, readVariable) {
  const tokens = tokenize(source);
  const fnIndex = tokens.findIndex(
    (token, index) =>
      token.type === "word" && token.value === "function" &&
      tokens[index + 1]?.type === "word" && tokens[index + 1].value === functionName &&
      tokens[index + 2]?.value === "(",
  );
  if (fnIndex < 0) throw new Error(`function ${functionName} not found`);
  const signatureClose = balanced(tokens, fnIndex + 2);
  if (signatureClose < 0) throw new Error(`${functionName} signature unbalanced`);
  let bodyOpen = -1;
  for (let index = signatureClose + 1; index < tokens.length; index += 1) {
    if (tokens[index].value === "{") {
      bodyOpen = index;
      break;
    }
  }
  if (bodyOpen < 0) throw new Error(`${functionName} body not found`);
  const bodyClose = balanced(tokens, bodyOpen);
  if (bodyClose < 0) throw new Error(`${functionName} body unbalanced`);
  const body = tokens.slice(bodyOpen + 1, bodyClose);

  const returnAt = body.findIndex(
    (token, index) => token.type === "word" && token.value === "return" && body[index + 1]?.value === "{",
  );
  if (returnAt < 0) throw new Error(`${functionName} has no 'return {'`);
  const objectClose = balanced(body, returnAt + 1);
  if (objectClose < 0) throw new Error(`${functionName} return object unbalanced`);
  const object = body.slice(returnAt + 2, objectClose);

  const written = new Set();
  for (const entry of splitTopLevel(object, ",")) {
    if (entry.length === 0) continue;
    if (entry[0].value === "." && entry[1]?.value === "." && entry[2]?.value === ".") {
      const spread = entry.slice(3);
      let braceDepth = 0;
      for (let index = 0; index < spread.length; index += 1) {
        const token = spread[index];
        if (token.value === "{") braceDepth += 1;
        else if (token.value === "}") braceDepth -= 1;
        else if (braceDepth === 1 && token.type === "word" && spread[index + 1]?.value === ":") {
          written.add(token.value);
          index += 1;
        }
      }
    } else if (entry[0].type === "word" && entry[1]?.value === ":") {
      written.add(entry[0].value);
    }
  }

  const reads = new Set();
  for (let index = 0; index < body.length; index += 1) {
    if (
      body[index]?.type === "word" && body[index].value === readVariable && body[index + 1]?.value === "." &&
      body[index + 2]?.type === "word"
    ) {
      reads.add(body[index + 2].value);
    }
  }
  return Object.freeze({ written, reads });
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

function defaultRead(root, relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

/**
 * @param {{ root?: string, overrides?: Record<string, string> }} options
 */
export function checkStardewExecutionReceiptFieldParity({ root = repositoryRoot, overrides = {} } = {}) {
  const read = (relativePath) => overrides[relativePath] ?? defaultRead(root, relativePath);
  const authority = extractCSharpRecordFields(read(BRIDGE_MODELS_PATH), "BridgeReceipt");
  const fullSet = new Set(authority.wire);
  const requiredSet = new Set(authority.required);
  const projectionSet = new Set(authority.wire.filter((field) => !DOCUMENTED_PROJECTION_DROPS.includes(field)));
  const violations = [];

  const pushViolation = (layerName, pathname, field, issue, detail) =>
    violations.push({ layer: layerName, path: pathname, field, issue, detail });

  const checkFieldSet = ({ name, pathname, actualFields, expectedSet, actualOptional = null, expectedOptional = null, extraAllowlist = [] }) => {
    const actual = new Set(actualFields);
    for (const field of expectedSet) {
      if (!actual.has(field)) pushViolation(name, pathname, field, "missing", `authority field '${field}' is not named by this layer`);
    }
    for (const field of actual) {
      if (!expectedSet.has(field) && !extraAllowlist.includes(field)) {
        pushViolation(name, pathname, field, "extra", `field '${field}' is named here but is not part of the expected ${[...expectedSet].length}-field set`);
      }
    }
    if (actualOptional !== null && expectedOptional !== null) {
      for (const field of expectedOptional) {
        if (!actualOptional.has(field)) pushViolation(name, pathname, field, "not_optional", `field '${field}' must be marked optional here`);
      }
      for (const field of actualOptional) {
        if (!expectedOptional.has(field)) pushViolation(name, pathname, field, "optional_misclassified", `field '${field}' is marked optional here but must not be`);
      }
    }
  };

  // 1. Mod ledger model (LocalExecutionReceipt) — exact full set.
  const ledger = extractCSharpRecordFields(read(BRIDGE_MODELS_PATH), "LocalExecutionReceipt");
  checkFieldSet({
    name: "BridgeProtocolModels.cs/LocalExecutionReceipt",
    pathname: BRIDGE_MODELS_PATH,
    actualFields: ledger.wire,
    expectedSet: fullSet,
    extraAllowlist: DOCUMENTED_EXTRAS["BridgeProtocolModels.cs/LocalExecutionReceipt"],
  });

  // 2. Mod projection (TryProjectReceipt) — must pass every authority field.
  const argCount = extractProjectionArgCount(read(BRIDGE_SESSION_PATH));
  if (argCount !== authority.wire.length) {
    pushViolation(
      "BridgeSession.cs/TryProjectReceipt",
      BRIDGE_SESSION_PATH,
      "<wire-constructor>",
      "count",
      `new BridgeReceipt(...) has ${argCount} positional args but the wire model declares ${authority.wire.length} fields (${authority.wire.join(", ")})`,
    );
  }

  // 3. Host protocol type (ExecutionReceipt) — exact full set + optional markers.
  const executionType = extractTsTypeProperties(read(PROTOCOL_PATH), "ExecutionReceipt");
  checkFieldSet({
    name: "protocol.ts/ExecutionReceipt",
    pathname: PROTOCOL_PATH,
    actualFields: executionType.fields,
    expectedSet: fullSet,
    actualOptional: executionType.optional,
    expectedOptional: authority.optional,
    extraAllowlist: DOCUMENTED_EXTRAS["protocol.ts/ExecutionReceipt"],
  });

  // 4. Host allowlist validator (validateReceipt).
  const validator = extractValidateReceiptSets(read(PROTOCOL_PATH));
  const validatorUnion = new Set([...validator.base, ...validator.pushes]);
  for (const field of authority.wire) {
    if (!validatorUnion.has(field)) {
      pushViolation("protocol.ts/validateReceipt", PROTOCOL_PATH, field, "missing", "allowedKeys (base array + conditional pushes) never names this authority field");
    }
  }
  for (const field of validatorUnion) {
    if (!fullSet.has(field)) pushViolation("protocol.ts/validateReceipt", PROTOCOL_PATH, field, "extra", "allowedKeys names a field that is not part of the authority");
  }
  for (const field of requiredSet) {
    if (!validator.base.includes(field)) {
      pushViolation("protocol.ts/validateReceipt", PROTOCOL_PATH, field, "required_not_unconditional", "required field must live in the unconditional allowedKeys base array, not a conditional push");
    }
  }
  for (const field of authority.optional) {
    if (!validator.pushes.includes(field)) {
      pushViolation("protocol.ts/validateReceipt", PROTOCOL_PATH, field, "optional_not_conditional", "optional field must be in a conditional 'allowedKeys.push'");
    }
  }

  // 5. Wire JSON schema ($defs.receipt) — properties equal full set, required equal required subset.
  const schema = extractSchemaReceipt(read(SCHEMA_PATH));
  checkFieldSet({
    name: "schema.json/$defs.receipt",
    pathname: SCHEMA_PATH,
    actualFields: schema.properties ?? [],
    expectedSet: fullSet,
    extraAllowlist: DOCUMENTED_EXTRAS["schema.json/$defs.receipt"],
  });
  if (schema.required !== null) {
    const schemaRequired = new Set(schema.required);
    for (const field of requiredSet) {
      if (!schemaRequired.has(field)) pushViolation("schema.json/$defs.receipt", SCHEMA_PATH, field, "required_missing", "$defs.receipt.required lacks this always-serialized authority field");
    }
    for (const field of schemaRequired) {
      if (!fullSet.has(field)) pushViolation("schema.json/$defs.receipt", SCHEMA_PATH, field, "extra", "$defs.receipt.required names a field that is not part of the authority");
    }
  }

  // 6. Host adapter receipt type — documented projection subset.
  const integrationType = extractTsTypeProperties(read(GAME_ADAPTER_PATH), "IntegrationExecutionReceipt");
  checkFieldSet({
    name: "game-integration-adapter.ts/IntegrationExecutionReceipt",
    pathname: GAME_ADAPTER_PATH,
    actualFields: integrationType.fields,
    expectedSet: projectionSet,
    actualOptional: integrationType.optional,
    expectedOptional: new Set(["nativeNotices"]),
    extraAllowlist: DOCUMENTED_EXTRAS["game-integration-adapter.ts/IntegrationExecutionReceipt"],
  });

  // 7. stardew adapter toIntegrationReceipt — written keys equal projection subset, reads ⊆ authority.
  const toIntegration = extractMappingKeysAndReads(read(STARDEW_ADAPTER_PATH), "toIntegrationReceipt", "receipt");
  checkMapping("stardew-game-integration-adapter.ts/toIntegrationReceipt", STARDEW_ADAPTER_PATH, toIntegration, projectionSet, fullSet, pushViolation);

  // 8. stardew adapter parseStardewReceipt — written keys equal projection subset, reads ⊆ authority.
  const parseReceipt = extractMappingKeysAndReads(read(STARDEW_ADAPTER_PATH), "parseStardewReceipt", "value");
  checkMapping("stardew-game-integration-adapter.ts/parseStardewReceipt", STARDEW_ADAPTER_PATH, parseReceipt, projectionSet, fullSet, pushViolation);

  violations.sort((left, right) =>
    `${left.layer}:${left.field}:${left.issue}`.localeCompare(`${right.layer}:${right.field}:${right.issue}`),
  );
  return Object.freeze({
    gate,
    verdict: violations.length === 0 ? "passed" : "blocked",
    authority: Object.freeze({ record: "BridgeReceipt", wireFields: Object.freeze([...authority.wire]), required: Object.freeze([...requiredSet]), optional: Object.freeze([...authority.optional]) }),
    projection: Object.freeze({ drops: Object.freeze([...DOCUMENTED_PROJECTION_DROPS]), reason: PROJECTION_DROP_REASON }),
    violations: Object.freeze(violations),
  });
}

function checkMapping(name, pathname, mapping, projectionSet, fullSet, pushViolation) {
  for (const field of projectionSet) {
    if (!mapping.written.has(field)) pushViolation(name, pathname, field, "missing", "mapping never writes this projected authority field");
  }
  for (const field of mapping.written) {
    if (!fullSet.has(field)) pushViolation(name, pathname, field, "extra", "mapping writes a field that is not part of the authority");
  }
  for (const field of mapping.reads) {
    if (!fullSet.has(field)) pushViolation(name, pathname, field, "extra_read", "mapping reads a field that is not part of the authority");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkStardewExecutionReceiptFieldParity();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.verdict === "passed" ? 0 : 1;
}