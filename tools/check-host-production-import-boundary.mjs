import { existsSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(here, "..");
export const DEFAULT_ROOTS = Object.freeze(["host/src/main.ts", "host/src/dialogue-web-main.ts"]);
// S0.5 intentionally keeps the legacy production closure blocked. This exact
// finding set is the frozen baseline until S5 removes the legacy reachability.
export const EXPECTED_S5_BLOCKED_FINDINGS = Object.freeze([
  [
    "unresolved_nonrelative_import",
    "host/src/agent-expression.ts",
    "@earendil-works/pi-coding-agent",
    1,
    "nonrelative_specifier_not_permitted",
  ],
  [
    "unresolved_nonrelative_import",
    "host/src/companion-loop.ts",
    "@earendil-works/pi-coding-agent",
    1,
    "nonrelative_specifier_not_permitted",
  ],
  [
    "unresolved_nonrelative_import",
    "host/src/dialogue-controller.ts",
    "@earendil-works/pi-coding-agent",
    2,
    "nonrelative_specifier_not_permitted",
  ],
  [
    "unresolved_dynamic_import",
    "host/src/dialogue-web-main.ts",
    null,
    40,
    "dynamic_imports_are_not_statically_resolvable",
  ],
  ["banned_legacy_module", "host/src/dialogue-web.ts", "./continuity.js", 7, "legacy_authority_module:continuity.ts"],
  [
    "banned_legacy_module",
    "host/src/game-origin-authority/tavern-game-origin-authority.ts",
    "../continuity.js",
    1,
    "legacy_authority_module:continuity.ts",
  ],
  [
    "banned_legacy_module",
    "host/src/game-surface-lease.ts",
    "./continuity.js",
    5,
    "legacy_authority_module:continuity.ts",
  ],
  [
    "unresolved_nonrelative_import",
    "host/src/game-tools.ts",
    "@earendil-works/pi-coding-agent",
    1,
    "nonrelative_specifier_not_permitted",
  ],
  ["unresolved_nonrelative_import", "host/src/game-tools.ts", "typebox", 2, "nonrelative_specifier_not_permitted"],
  [
    "unresolved_nonrelative_import",
    "host/src/gameplay-task-subagent.ts",
    "@earendil-works/pi-coding-agent",
    12,
    "nonrelative_specifier_not_permitted",
  ],
  [
    "unresolved_nonrelative_import",
    "host/src/gameplay-task-subagent.ts",
    "typebox",
    13,
    "nonrelative_specifier_not_permitted",
  ],
  [
    "banned_legacy_module",
    "host/src/integration-bootstrap.ts",
    "./game-surface-lease.js",
    15,
    "legacy_authority_module:game-surface-lease.ts",
  ],
  [
    "banned_legacy_module",
    "host/src/integration-bootstrap.ts",
    "./game-surface-lifecycle/game-surface-lifecycle.js",
    16,
    "legacy_authority_module:game-surface-lifecycle/",
  ],
  [
    "banned_legacy_module",
    "host/src/integration-bootstrap.ts",
    "./continuity.js",
    3,
    "legacy_authority_module:continuity.ts",
  ],
  [
    "banned_legacy_module",
    "host/src/integration-bootstrap.ts",
    "./game-origin-authority/tavern-game-origin-authority.js",
    5,
    "legacy_authority_module:game-origin-authority/",
  ],
  [
    "unresolved_nonrelative_import",
    "host/src/integration-module.ts",
    "@earendil-works/pi-coding-agent",
    2,
    "nonrelative_specifier_not_permitted",
  ],
  [
    "unresolved_nonrelative_import",
    "host/src/knowledge.ts",
    "@earendil-works/pi-coding-agent",
    2,
    "nonrelative_specifier_not_permitted",
  ],
  ["unresolved_nonrelative_import", "host/src/knowledge.ts", "typebox", 3, "nonrelative_specifier_not_permitted"],
  [
    "unresolved_nonrelative_import",
    "host/src/presentation.ts",
    "@earendil-works/pi-coding-agent",
    2,
    "nonrelative_specifier_not_permitted",
  ],
  ["unresolved_nonrelative_import", "host/src/presentation.ts", "typebox", 3, "nonrelative_specifier_not_permitted"],
  [
    "banned_legacy_module",
    "host/src/production-game-continuity.ts",
    "./game-origin-authority/tavern-game-origin-authority.js",
    7,
    "legacy_authority_module:game-origin-authority/",
  ],
  [
    "unresolved_nonrelative_import",
    "host/src/runtime.ts",
    "@earendil-works/pi-coding-agent",
    17,
    "nonrelative_specifier_not_permitted",
  ],
  ["unresolved_nonrelative_import", "host/src/runtime.ts", "typebox", 18, "nonrelative_specifier_not_permitted"],
  ["unresolved_dynamic_import", "host/src/runtime.ts", null, 549, "dynamic_imports_are_not_statically_resolvable"],
  ["unresolved_dynamic_import", "host/src/runtime.ts", null, 557, "dynamic_imports_are_not_statically_resolvable"],
  [
    "unresolved_nonrelative_import",
    "host/src/worldbook.ts",
    "@earendil-works/pi-coding-agent",
    4,
    "nonrelative_specifier_not_permitted",
  ],
  ["unresolved_nonrelative_import", "host/src/worldbook.ts", "typebox", 5, "nonrelative_specifier_not_permitted"],
]);
export function validateHostProductionImportBoundaryBaseline(report, { requireClean = false } = {}) {
  if (report?.verdict === "passed")
    return requireClean
      ? { accepted: true, mode: "clean" }
      : { accepted: false, reason: "clean_pass_unexpected_before_s5" };
  if (requireClean) return { accepted: false, reason: "blocked_after_s5" };
  const actual = (report?.violations ?? []).map(({ kind, importer, specifier, line, detail }) => [
    kind,
    importer,
    specifier,
    line,
    detail,
  ]);
  return JSON.stringify(actual) === JSON.stringify(EXPECTED_S5_BLOCKED_FINDINGS)
    ? { accepted: true, mode: "expected_s5_blocked" }
    : {
        accepted: false,
        reason: "finding_set_differs_from_frozen_s5_baseline",
        expected: EXPECTED_S5_BLOCKED_FINDINGS,
        actual,
      };
}
export const LEGACY_ADOPTION_FUNCTIONS = Object.freeze([
  "adoptLegacyPartition",
  "collectQuiescentLegacyContinuitySnapshot",
  "createQuiescentLegacyContinuitySnapshot",
  "validateQuiescentLegacyContinuitySnapshot",
]);
const LEGACY_MODULES = Object.freeze([
  "continuity.ts",
  "continuity-production-migration/",
  "continuity-authority-coordinator/",
  "continuity-authority-routing/",
  "game-origin-authority/",
  "game-surface-lease.ts",
  "game-surface-recovery.ts",
  "game-surface-lifecycle/",
]);
const SEMANTIC_AUTHORITY_MODULES = Object.freeze(["continuity-semantic-provisioning/", "continuity-semantic-store/"]);
const SEMANTIC_PRODUCTION_COORDINATOR = "continuity-semantic-production-coordinator/";
const SEMANTIC_PRODUCTION_COORDINATOR_PUBLIC_MODULE =
  "continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.ts";
const SEMANTIC_PRODUCTION_COORDINATOR_INTERNAL_MODULE =
  "continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts";
const SEMANTIC_PROVISIONER_MODULE = "continuity-semantic-provisioning/continuity-semantic-provisioning.ts";
const SEMANTIC_PRODUCTION_INTERNAL_MODULE =
  "continuity-semantic-store/continuity-semantic-store.production-internal.ts";
const SEMANTIC_BACKEND_MODULE = "continuity-semantic-backend/";
const LEGACY_BACKEND_MINT_IDENTIFIERS = Object.freeze([
  "createSemanticProductionBackend",
  "SemanticProductionBackend",
  "SemanticProductionBackendOperations",
]);
const SOURCE_EXTENSIONS = Object.freeze([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const PERMITTED_NODE_BUILTIN_SPECIFIERS = new Set(
  builtinModules.flatMap((specifier) => [specifier, `node:${specifier}`]),
);

function lineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}
function display(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

/** Tokenizes just enough TypeScript/JavaScript to avoid treating comments and
 * ordinary strings as import syntax, while retaining string literal locations. */
function quotedEnd(source, index, end) {
  const quote = source[index++];
  while (index < end && source[index] !== quote) {
    if (source[index] === "\\") index += 1;
    index += 1;
  }
  return index < end ? index + 1 : end;
}
function interpolationEnd(source, index, end) {
  let depth = 1;
  while (index < end) {
    const char = source[index];
    if (char === "'" || char === '"') {
      index = quotedEnd(source, index, end);
      continue;
    }
    if (char === "`") {
      index = templateEnd(source, index, end);
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return index;
    index += 1;
  }
  return end;
}
function templateEnd(source, index, end) {
  index += 1;
  while (index < end && source[index] !== "`") {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "$" && source[index + 1] === "{") {
      index = interpolationEnd(source, index + 2, end) + 1;
      continue;
    }
    index += 1;
  }
  return index < end ? index + 1 : end;
}

/** Tokenizes just enough TypeScript/JavaScript to avoid treating comments and
 * ordinary strings as import syntax, while retaining string literal locations. */
function tokens(source, start = 0, end = source.length, result = []) {
  let index = start;
  const add = (type, value, offset) => result.push({ type, value, line: lineAt(source, offset) });
  while (index < end) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0 || index >= end) break;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 || close >= end ? end : close + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const tokenStart = index;
      const quote = char;
      index += 1;
      let value = "";
      while (index < end && source[index] !== quote) {
        if (source[index] === "\\") {
          index += 1;
          if (index < end) value += source[index++];
          continue;
        }
        value += source[index++];
      }
      if (source[index] === quote) index += 1;
      add("string", value, tokenStart);
      continue;
    }
    if (char === "`") {
      const tokenStart = index++;
      while (index < end && source[index] !== "`") {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "$" && source[index + 1] === "{") {
          const expressionStart = index + 2;
          const expressionEnd = interpolationEnd(source, expressionStart, end);
          tokens(source, expressionStart, expressionEnd, result);
          index = expressionEnd + 1;
          continue;
        }
        index += 1;
      }
      if (source[index] === "`") index += 1;
      add("template", "", tokenStart);
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const tokenStart = index++;
      while (/[A-Za-z0-9_$]/.test(source[index] ?? "")) index += 1;
      add("word", source.slice(tokenStart, index), tokenStart);
      continue;
    }
    add("punctuation", char, index++);
  }
  return result;
}

function matchingToken(all, index, open, close) {
  let depth = 0;
  for (let cursor = index; cursor < all.length; cursor += 1) {
    if (all[cursor].value === open) depth += 1;
    if (all[cursor].value === close && --depth === 0) return cursor;
  }
  return -1;
}
function isMethodDeclaration(all, index) {
  let cursor = index + 1;
  if (all[cursor]?.value === "<") {
    cursor = matchingToken(all, cursor, "<", ">");
    if (cursor < 0) return false;
    cursor += 1;
  }
  if (all[cursor]?.value !== "(") return false;
  cursor = matchingToken(all, cursor, "(", ")");
  if (cursor < 0) return false;
  const next = all[cursor + 1]?.value;
  // A return-type annotation can stand between a method's parameters and body.
  // A dynamic import expression cannot be followed by one, so this remains
  // fail-closed for actual dynamic imports (including import(`...`)).
  return next === "{" || next === ":";
}

function staticReferences(source) {
  const result = [];
  const all = tokens(source);
  const factoryBindings = new Set();
  const requireBindings = new Set();
  const moduleBindings = new Set(["module"]);
  const requireCallIndexes = new Set();
  for (let index = 0; index < all.length; index += 1) {
    const token = all[index];
    if (token.type !== "word") continue;
    if (token.value === "import") {
      if (all[index + 1]?.value === "(" && all[index - 1]?.value !== "." && !isMethodDeclaration(all, index)) {
        result.push({ kind: "dynamic_import", specifier: null, line: token.line });
        continue;
      }
      // TypeScript import-equals is a static CommonJS ingress, not an ES import.
      if (
        all[index + 1]?.type === "word" &&
        all[index + 2]?.value === "=" &&
        all[index + 3]?.value === "require" &&
        all[index + 4]?.value === "("
      ) {
        requireCallIndexes.add(index + 3);
        const argument = all[index + 5];
        result.push(
          argument?.type === "string"
            ? { kind: "require", specifier: argument.value, line: argument.line }
            : { kind: "dynamic_require", specifier: null, line: all[index + 3].line },
        );
        continue;
      }
      if (all[index + 1]?.type === "string") {
        result.push({ kind: "import", specifier: all[index + 1].value, line: all[index + 1].line });
        continue;
      }
      for (let cursor = index + 1; cursor < all.length && all[cursor].value !== ";"; cursor += 1) {
        if (all[cursor].value === "from" && all[cursor + 1]?.type === "string") {
          result.push({ kind: "import", specifier: all[cursor + 1].value, line: all[cursor + 1].line });
          if (all[cursor + 1].value === "node:module")
            for (let binding = index + 1; binding < cursor; binding += 1) {
              if (all[binding].value === "createRequire")
                factoryBindings.add(all[binding + 1]?.value === "as" ? all[binding + 2]?.value : "createRequire");
              // A direct default import is the module namespace object for this
              // scanner's createRequire/module.require member tracking.
              if (binding === index + 1 && all[binding]?.type === "word") moduleBindings.add(all[binding].value);
              if (all[binding].value === "*" && all[binding + 1]?.value === "as" && all[binding + 2]?.type === "word")
                moduleBindings.add(all[binding + 2].value);
            }
          break;
        }
      }
    }
    if (token.value === "export")
      for (let cursor = index + 1; cursor < all.length && all[cursor].value !== ";"; cursor += 1) {
        if (all[cursor].value === "from" && all[cursor + 1]?.type === "string") {
          result.push({ kind: "re_export", specifier: all[cursor + 1].value, line: all[cursor + 1].line });
          break;
        }
      }
  }
  // Follow simple lexical aliases only. Anything more indirect is not recognized as a
  // require ingress; recognized factory calls with non-literals still fail closed below.
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < all.length; index += 1) {
      const name = all[index];
      const declaration = ["const", "let", "var"].includes(all[index - 1]?.value);
      // const { createRequire: factory } = require("node:module") or Module.
      if (
        name?.value === "createRequire" &&
        all[index - 1]?.value === "{" &&
        ["const", "let", "var"].includes(all[index - 2]?.value)
      ) {
        const close = matchingToken(all, index - 1, "{", "}");
        const binding = all[index + 1]?.value === ":" ? all[index + 2]?.value : "createRequire";
        const isNodeModuleRequire =
          all[close + 2]?.value === "require" &&
          all[close + 3]?.value === "(" &&
          all[close + 4]?.type === "string" &&
          all[close + 4].value === "node:module";
        const isModuleBinding = moduleBindings.has(all[close + 2]?.value);
        if (
          close >= 0 &&
          all[close + 1]?.value === "=" &&
          (isNodeModuleRequire || isModuleBinding) &&
          !factoryBindings.has(binding)
        ) {
          factoryBindings.add(binding);
          changed = true;
        }
      }
      // const { require: load } = module; follows the same policy as require().
      if (
        name?.value === "require" &&
        all[index - 1]?.value === "{" &&
        ["const", "let", "var"].includes(all[index - 2]?.value)
      ) {
        const close = matchingToken(all, index - 1, "{", "}");
        const binding = all[index + 1]?.value === ":" ? all[index + 2]?.value : "require";
        if (
          close >= 0 &&
          all[close + 1]?.value === "=" &&
          moduleBindings.has(all[close + 2]?.value) &&
          !requireBindings.has(binding)
        ) {
          requireBindings.add(binding);
          changed = true;
        }
      }
      if (name?.type !== "word" || all[index + 1]?.value !== "=") continue;
      // A declaration name or assignment target can only acquire a simple alias.
      if (!declaration && all[index - 1]?.value === ".") continue;
      const rhs = all[index + 2];
      if (!rhs) continue;
      const isNodeModuleRequire =
        rhs.value === "require" &&
        all[index + 3]?.value === "(" &&
        all[index + 4]?.type === "string" &&
        all[index + 4].value === "node:module";
      if (isNodeModuleRequire && !moduleBindings.has(name.value)) {
        moduleBindings.add(name.value);
        changed = true;
      }
      const isFactoryMember =
        moduleBindings.has(rhs.value) && all[index + 3]?.value === "." && all[index + 4]?.value === "createRequire";
      const isRequireMember =
        moduleBindings.has(rhs.value) && all[index + 3]?.value === "." && all[index + 4]?.value === "require";
      const isFactoryCall =
        (factoryBindings.has(rhs.value) && all[index + 3]?.value === "(") ||
        (isFactoryMember && all[index + 5]?.value === "(");
      if ((isFactoryCall || isRequireMember) && !requireBindings.has(name.value)) {
        requireBindings.add(name.value);
        changed = true;
      }
      if (!isFactoryCall && (factoryBindings.has(rhs.value) || isFactoryMember) && !factoryBindings.has(name.value)) {
        factoryBindings.add(name.value);
        changed = true;
      }
      if (moduleBindings.has(rhs.value) && all[index + 3]?.value !== "." && !moduleBindings.has(name.value)) {
        moduleBindings.add(name.value);
        changed = true;
      }
      if (
        (rhs.value === "require" || requireBindings.has(rhs.value)) &&
        all[index + 3]?.value !== "(" &&
        !requireBindings.has(name.value)
      ) {
        requireBindings.add(name.value);
        changed = true;
      }
    }
  }
  const addRequireCall = (open, line) => {
    const argument = all[open + 1];
    result.push(
      argument?.type === "string"
        ? { kind: "require", specifier: argument.value, line: argument.line }
        : { kind: "dynamic_require", specifier: null, line },
    );
  };
  for (let index = 0; index < all.length; index += 1) {
    const token = all[index];
    if (token.type !== "word") continue;
    if (
      moduleBindings.has(token.value) &&
      all[index + 1]?.value === "." &&
      all[index + 2]?.value === "require" &&
      all[index + 3]?.value === "("
    ) {
      const close = matchingToken(all, index + 3, "(", ")");
      // module.require is an intended CommonJS ingress, except when it is a method declaration.
      if (close < 0 || all[close + 1]?.value !== "{") addRequireCall(index + 3, token.line);
      continue;
    }
    if (
      moduleBindings.has(token.value) &&
      all[index + 1]?.value === "." &&
      all[index + 2]?.value === "createRequire" &&
      all[index + 3]?.value === "("
    ) {
      const close = matchingToken(all, index + 3, "(", ")");
      if (close >= 0 && all[close + 1]?.value === "(") addRequireCall(close + 1, token.line);
      continue;
    }
    if (all[index - 1]?.value === ".") continue;
    if (factoryBindings.has(token.value) && all[index + 1]?.value === "(") {
      const close = matchingToken(all, index + 1, "(", ")");
      if (close >= 0 && all[close + 1]?.value === "(") addRequireCall(close + 1, token.line);
      continue;
    }
    if (
      (token.value === "require" || requireBindings.has(token.value)) &&
      all[index + 1]?.value === "(" &&
      !requireCallIndexes.has(index)
    ) {
      const close = matchingToken(all, index + 1, "(", ")");
      // Object/class methods and function declarations are not CommonJS ingress.
      if (close < 0 || all[close + 1]?.value !== "{") addRequireCall(index + 1, token.line);
    }
  }
  return { references: result, tokens: all };
}

function isWithin(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
function resolveRelative(importer, specifier) {
  const requested = resolve(dirname(importer), specifier.replaceAll("\\", "/"));
  const extension = extname(requested);
  // A dotted basename such as `*.test-support` is not a source extension;
  // always try appending recognized source extensions before replacement.
  const candidates = extension
    ? [
        requested,
        ...SOURCE_EXTENSIONS.map((item) => requested + item),
        ...SOURCE_EXTENSIONS.filter((item) => item !== extension).map(
          (item) => requested.slice(0, -extension.length) + item,
        ),
      ]
    : SOURCE_EXTENSIONS.map((item) => requested + item);
  candidates.push(...SOURCE_EXTENSIONS.map((item) => resolve(requested, `index${item}`)));
  const candidate = candidates.find(existsSync);
  return candidate ? realpathSync(candidate) : null;
}
function sourcePath(root, target) {
  const path = display(resolve(root, "host/src"), target);
  return path.endsWith(".ts") ? path : `${path}.ts`;
}
function isBanned(root, target) {
  const path = sourcePath(root, target);
  return LEGACY_MODULES.find((module) => path === module || path.startsWith(module)) ?? null;
}
function semanticAuthorityModule(root, target) {
  const path = sourcePath(root, target);
  return SEMANTIC_AUTHORITY_MODULES.find((module) => path.startsWith(module)) ?? null;
}
function isSemanticProductionCoordinator(root, importer) {
  return sourcePath(root, importer).startsWith(SEMANTIC_PRODUCTION_COORDINATOR);
}
function isSemanticProductionCoordinatorPublic(root, importer) {
  return (
    sourcePath(root, importer).replace(/\.ts$/, "") ===
    SEMANTIC_PRODUCTION_COORDINATOR_PUBLIC_MODULE.replace(/\.ts$/, "")
  );
}
function isSemanticProductionCoordinatorInternal(root, target) {
  return (
    sourcePath(root, target).replace(/\.ts$/, "") ===
    SEMANTIC_PRODUCTION_COORDINATOR_INTERNAL_MODULE.replace(/\.ts$/, "")
  );
}
function isTestOnlyPath(root, target) {
  return /(?:^|\/)[^/]*\.(?:test|test-support)(?:\.[^/]+)?$/.test(sourcePath(root, target));
}
function isSemanticProductionProvisioner(root, importer) {
  return sourcePath(root, importer).replace(/\.ts$/, "") === SEMANTIC_PROVISIONER_MODULE.replace(/\.ts$/, "");
}
function isSemanticProductionInternal(root, target) {
  return sourcePath(root, target).replace(/\.ts$/, "") === SEMANTIC_PRODUCTION_INTERNAL_MODULE.replace(/\.ts$/, "");
}
function isSemanticBackend(root, target) {
  return sourcePath(root, target).startsWith(SEMANTIC_BACKEND_MODULE);
}
function violation(kind, importer, specifier, line, detail) {
  return { kind, importer, specifier, line, detail };
}

export function checkHostProductionImportBoundary({
  root = repositoryRoot,
  roots = DEFAULT_ROOTS,
  readFile = (path) => readFileSync(path, "utf8"),
} = {}) {
  const canonicalSourceRoot = realpathSync(resolve(root, "host/src"));
  const absoluteRoots = roots.map((path) => resolve(root, path));
  const pending = [];
  const visited = new Set();
  const violations = [];
  for (const suppliedRoot of absoluteRoots) {
    if (!existsSync(suppliedRoot)) {
      violations.push(violation("invalid_root", display(root, suppliedRoot), null, 1, "root_source_not_found"));
      continue;
    }
    let canonicalRoot;
    try {
      canonicalRoot = realpathSync(suppliedRoot);
    } catch {
      violations.push(violation("invalid_root", display(root, suppliedRoot), null, 1, "root_source_unreadable"));
      continue;
    }
    if (!isWithin(canonicalSourceRoot, canonicalRoot)) {
      violations.push(violation("invalid_root", display(root, suppliedRoot), null, 1, "root_outside_host_src"));
      continue;
    }
    pending.push(canonicalRoot);
  }
  while (pending.length > 0) {
    const importer = pending.pop();
    if (visited.has(importer)) continue;
    visited.add(importer);
    let source;
    try {
      source = readFile(importer);
    } catch {
      violations.push(violation("unresolved_root", display(root, importer), null, 1, "root_source_unreadable"));
      continue;
    }
    const parsed = staticReferences(source);
    for (const reference of parsed.references) {
      const shownImporter = display(root, importer);
      if (reference.kind === "dynamic_import") {
        violations.push(
          violation(
            "unresolved_dynamic_import",
            shownImporter,
            null,
            reference.line,
            "dynamic_imports_are_not_statically_resolvable",
          ),
        );
        continue;
      }
      if (reference.kind === "dynamic_require") {
        violations.push(
          violation(
            "unresolved_dynamic_require",
            shownImporter,
            null,
            reference.line,
            "dynamic_requires_are_not_statically_resolvable",
          ),
        );
        continue;
      }
      if (!reference.specifier.startsWith(".")) {
        if (PERMITTED_NODE_BUILTIN_SPECIFIERS.has(reference.specifier)) continue;
        violations.push(
          violation(
            reference.kind === "require" ? "unresolved_require_style_import" : "unresolved_nonrelative_import",
            shownImporter,
            reference.specifier,
            reference.line,
            reference.kind === "require"
              ? "require_style_specifier_not_permitted"
              : "nonrelative_specifier_not_permitted",
          ),
        );
        continue;
      }
      const requested = resolve(dirname(importer), reference.specifier.replaceAll("\\", "/"));
      if (!isWithin(canonicalSourceRoot, requested)) {
        violations.push(
          violation(
            "relative_import_escapes_host_source",
            shownImporter,
            reference.specifier,
            reference.line,
            "relative_target_outside_host_src",
          ),
        );
        continue;
      }
      const target = resolveRelative(importer, reference.specifier);
      if (!target) {
        violations.push(
          violation(
            "unresolved_relative_import",
            shownImporter,
            reference.specifier,
            reference.line,
            "relative_source_not_found",
          ),
        );
        continue;
      }
      if (!isWithin(canonicalSourceRoot, target)) {
        violations.push(
          violation(
            "relative_import_escapes_host_source",
            shownImporter,
            reference.specifier,
            reference.line,
            "relative_target_outside_host_src",
          ),
        );
        continue;
      }
      if (isTestOnlyPath(root, target)) {
        violations.push(
          violation(
            "production_reaches_test_only_module",
            shownImporter,
            reference.specifier,
            reference.line,
            "test_only_module_in_production_closure",
          ),
        );
      }
      if (
        isSemanticProductionCoordinatorInternal(root, target) &&
        !isSemanticProductionCoordinatorPublic(root, importer)
      ) {
        violations.push(
          violation(
            "unauthorized_coordinator_internal_import",
            shownImporter,
            reference.specifier,
            reference.line,
            `coordinator_internal_import_requires:${SEMANTIC_PRODUCTION_COORDINATOR_PUBLIC_MODULE}`,
          ),
        );
      }
      const banned = isBanned(root, target);
      if (banned)
        violations.push(
          violation(
            "banned_legacy_module",
            shownImporter,
            reference.specifier,
            reference.line,
            `legacy_authority_module:${banned}`,
          ),
        );
      const internalProductionModule = isSemanticProductionInternal(root, target);
      if (internalProductionModule && !isSemanticProductionProvisioner(root, importer)) {
        violations.push(
          violation(
            "unauthorized_production_store_internal_import",
            shownImporter,
            reference.specifier,
            reference.line,
            `production_store_internal_import_requires:${SEMANTIC_PROVISIONER_MODULE}`,
          ),
        );
      }
      const authorityModule = semanticAuthorityModule(root, target);
      if (
        authorityModule &&
        !isSemanticProductionCoordinator(root, importer) &&
        !(internalProductionModule && isSemanticProductionProvisioner(root, importer))
      ) {
        violations.push(
          violation(
            "unauthorized_semantic_authority_import",
            shownImporter,
            reference.specifier,
            reference.line,
            `semantic_authority_import_requires:${SEMANTIC_PRODUCTION_COORDINATOR}`,
          ),
        );
      }
      if (isSemanticBackend(root, target)) {
        violations.push(
          violation(
            "banned_semantic_backend_module",
            shownImporter,
            reference.specifier,
            reference.line,
            `semantic_authority_module:${SEMANTIC_BACKEND_MODULE}`,
          ),
        );
      }
      pending.push(target);
    }
    for (const token of parsed.tokens) {
      if (token.type !== "word") continue;
      if (LEGACY_ADOPTION_FUNCTIONS.includes(token.value)) {
        violations.push(
          violation(
            "banned_legacy_adoption_function",
            display(root, importer),
            token.value,
            token.line,
            "legacy_adoption_function",
          ),
        );
      }
      if (LEGACY_BACKEND_MINT_IDENTIFIERS.includes(token.value)) {
        violations.push(
          violation(
            "banned_legacy_backend_mint_identifier",
            display(root, importer),
            token.value,
            token.line,
            "legacy_backend_mint_identifier",
          ),
        );
      }
    }
  }
  violations.sort((left, right) =>
    `${left.importer}:${left.line}:${left.kind}:${left.specifier}`.localeCompare(
      `${right.importer}:${right.line}:${right.kind}:${right.specifier}`,
    ),
  );
  return {
    gate: "host_production_import_boundary/v1",
    verdict: violations.length === 0 ? "passed" : "blocked",
    roots: absoluteRoots.map((path) => display(root, path)),
    inspectedFiles: [...visited].map((path) => display(root, path)).sort(),
    violations,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = checkHostProductionImportBoundary();
  console.log(JSON.stringify(report, null, 2));
  if (report.verdict !== "passed") process.exitCode = 2;
}
