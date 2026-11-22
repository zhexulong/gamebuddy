/**
 * red-proof: inject  a games/stardew module importing bootstrap/roots/stardew-private-mod-profile-staging ->
 *                    verdict `blocked`, violation `game_imports_generic_layer` naming that importer, target and
 *                    line 1, exit 1 (tools/check-host-game-physical-seam.mjs)
 * red-proof: history the tree at 65dcc6b3, where the wire awaited `deployCompanionGameMod` from the composition root ->
 *   `bootstrap_names_game_symbol` naming `host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts` line 14,
 *   identifier `deployCompanionGameMod`, token `game`, plus `bootstrap_calls_game_typed_value` on its call site at
 *   line 172, verdict `blocked` (re-run of the checker over `git archive HEAD host/src`)
 */

export const gateDeclaration = {
  id: "check-host-game-physical-seam",
  domain: "product",
  tier: "l0",
  kind: "contract",
};

import { builtinModules, createRequire } from "node:module";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot as findRepositoryRoot } from "../../tools/lib/repository-root.mjs";

const requireFromHost = createRequire(resolve(findRepositoryRoot(import.meta.url), "host/package.json"));
const ts = requireFromHost("typescript");
const repositoryRoot = findRepositoryRoot(import.meta.url);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const IGNORED_DIRECTORIES = new Set([
  ".worktrees",
  "dist",
  "dist-test",
  "node_modules",
  "fixtures",
  "test-support",
  "test-fixtures",
  "__fixtures__",
  "fixture",
  "generated",
]);
const GENERIC_LAYERS = new Set(["bootstrap", "containment", "composition"]);
// ADR-0007's frozen dependency direction separates the two generic layers that
// must never reach a game from the composition root that must:
//
//   bootstrap/{entry,wire,roots} -> composition/private platform assembly only
//   composition -> containment/runtime/core + one selected game adapter
//   bootstrap/**, containment/runtime/** -/-> any game
//
// The direction matters, so the checker keeps two predicates rather than one:
//   - `genericPath` (all three layers) answers "is this a generic target a game
//     may not reach?" — a game still must not import composition either.
//   - `gameFreeGenericPath` (bootstrap, containment) answers "is this an
//     importer that may not reach a game?" — composition is the composition
//     root and must reach exactly one selected game adapter.
const GAME_FREE_GENERIC_LAYERS = new Set(["bootstrap", "containment"]);
// The one generic path a game may import: the stable game-facing containment
// contract. ADR-0007 states `games/stardew` may import the contract and must
// never import `runtime/core`, auth transport, bootstrap roots, Desktop,
// Guardian, Windows or native. Only the exact contract module is exempt.
const GAME_IMPORTABLE_GENERIC_PATH = "containment/runtime/contract/game-runtime";
const STARDew_PROCESS_IMPLEMENTATIONS = "games/stardew/lifecycle/stardew-process-implementations";
const STARDew_REGISTRATION = "stardew-installation-registration.internal";
const STARDew_REGISTRATION_OWNER = "games/stardew/lifecycle/stardew-private-bootstrap-composer.core.internal";
const STARDew_REGISTRATION_OWNER_FACADE = "withStardewLifecycleInstallationRegistrationOwner";
const ALLOWED_STARDew_GENERIC_IMPORTERS = new Map([
  [
    "bootstrap/roots/stardew-private-mod-profile-staging",
    new Set(["games/stardew/lifecycle/stardew-private-bootstrap-composer.internal"]),
  ],
]);
const RAW_STARDew_MODULES = [
  "windows-bootstrap-guardian",
  "windows-stardew-folder-picker",
  "windows-stale-lock-reclaimer",
  "windows-reparse-inspector",
];
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const RAW_BUILTIN_MODULES = new Set([
  "child_process",
  "node:child_process",
  "process",
  "node:process",
  "worker_threads",
  "node:worker_threads",
  "ffi-napi",
  "node:ffi-napi",
  "winreg",
  "node:winreg",
]);
const APPROVED_STARDew_RAW_BUILTIN_MODULES = new Set(["node:child_process"]);
// `containment/runtime/README.md`:6-7 -- "Does not know: Game names, game rules,
// installation or recipe facts" -- so a source of that layer must not NAME a game
// either, not merely be unable to import one. The port used to declare
// `FarmhandBridgeConnectionNotAvailableError`, a refusal about one game's bridge
// connection authority, inside the layer every game shares.
//
// The vocabulary is derived rather than listed, because a written list only ever
// covers the games that already existed: every directory under `games/` is a game
// identity, and the game's own proper nouns are the residue a directory walk cannot
// see -- words only one game's world uses.
const GENERIC_RUNTIME_PREFIX = "containment/runtime/";
const GAME_PROPER_NOUNS = Object.freeze(["cabin", "farmhand", "junimo", "pelican"]);
// `host/src/composition/README.md`: "bootstrap/**, containment/runtime/** ─/→ any game, Mod, action or game
// recipe". A game identity (`stardew`, derived from `games/`) and a proper noun (`cabin`, ...) are not the only
// words that sentence forbids, and reading import PATHS alone could not see the one call that broke it: the wire
// awaited `deployCompanionGameMod` from the generic composition root, so the target of the import was a generic
// layer module, the identity never appeared, and the gate reported `passed` over a bootstrap that staged a game
// installation at boot. The concept the sentence names - a game, a Mod - is therefore vocabulary here too, and
// the layer it is answered against is the wire: `containment/runtime` is spelled with those words on purpose (its
// game-facing contract is `game-runtime.ts`) and its own identifier rule above already covers it.
const WIRE_LAYER = "bootstrap";
const WIRE_FORBIDDEN_NOUNS = Object.freeze(["game", "mod"]);
function shown(path, root = repositoryRoot) {
  return relative(root, path).replaceAll("\\", "/");
}
// Test-only sources are excluded from the production seam: `.test.*`,
// `.test-support.*`, `.test-support-internal.*`, `.test-fixtures.*` and any
// `*-fixture-*.ts` / `fixture-*.ts` helper. The last two are included because a
// module that exists only to hold fixtures for a test is not a production
// module: treating them as production reported their own test-only imports
// (and a deliberate `import()` of a mocked module URL) as seam violations.
function isTest(path) {
  const normalized = path.replaceAll("\\", "/");
  if (/(?:^|[/.])(?:[^/]*\.test(?:-support(?:-internal)?)?|(?:[^/]*\.)?test-fixtures)\.[cm]?[jt]sx?$/.test(normalized))
    return true;
  return /(?:^|[/-])(?:fixture|fixtures)[-/][^/]*\.[cm]?[jt]sx?$/.test(normalized);
}
function isInside(path, root) {
  const r = relative(root, path);
  return r === "" || (r !== ".." && !r.startsWith(`..${path.includes("\\") ? "\\" : "/"}`) && !/^[A-Za-z]:/.test(r));
}
function filesUnder(directory, integrity, root) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const lexical = join(directory, entry.name);
    let stat;
    try {
      stat = lstatSync(lexical);
    } catch {
      integrity.push({ path: lexical, detail: "source_entry_cannot_be_inspected" });
      continue;
    }
    if (stat.isSymbolicLink()) {
      integrity.push({ path: lexical, detail: "symlink_or_reparse_source_is_not_allowed" });
      continue;
    }
    if (stat.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) result.push(...filesUnder(lexical, integrity, root));
      continue;
    }
    if (!SOURCE_EXTENSIONS.includes(extname(entry.name)) || isTest(lexical)) continue;
    let canonical;
    try {
      canonical = realpathSync(lexical);
    } catch {
      integrity.push({ path: lexical, detail: "source_canonical_path_unavailable" });
      continue;
    }
    if (!isInside(canonical, root) || canonical !== lexical)
      integrity.push({ path: lexical, detail: "source_canonical_path_escapes_scoped_root" });
    else result.push(canonical);
  }
  return result;
}
function resolveSource(importer, specifier, sourceRoot) {
  const raw = resolve(dirname(importer), specifier);
  if (!isInside(raw, sourceRoot)) return { kind: "escaped", base: raw };
  const extension = extname(raw).toLowerCase();
  const explicit = SOURCE_EXTENSIONS.includes(extension);
  const base = explicit ? raw.slice(0, -extension.length) : raw;
  const alternatives =
    explicit && extension !== ".js"
      ? [raw]
      : [
          ...SOURCE_EXTENSIONS.map((item) => `${base}${item}`),
          ...SOURCE_EXTENSIONS.map((item) => join(base, `index${item}`)),
        ];
  const existing = [...new Set(alternatives)].filter(
    (candidate) =>
      existsSync(candidate) && !isTest(candidate) && SOURCE_EXTENSIONS.includes(extname(candidate).toLowerCase()),
  );
  if (existing.length !== 1) return { kind: existing.length === 0 ? "missing" : "ambiguous", candidates: existing };
  let canonical;
  try {
    canonical = realpathSync(existing[0]);
  } catch {
    return { kind: "canonical-unavailable" };
  }
  if (!isInside(canonical, sourceRoot) || canonical !== existing[0]) return { kind: "unsafe", target: canonical };
  return { kind: "resolved", target: canonical };
}
function layer(path, root) {
  return relative(resolve(root, "host/src"), path).replaceAll("\\", "/").split("/")[0];
}
function gamePath(path, root) {
  const p = relative(resolve(root, "host/src"), path).replaceAll("\\", "/");
  return p === "games" || p.startsWith("games/");
}
function genericPath(path, root) {
  return GENERIC_LAYERS.has(layer(path, root));
}
function gameFreeGenericPath(path, root) {
  return GAME_FREE_GENERIC_LAYERS.has(layer(path, root));
}
function sourcePath(path, root) {
  return relative(resolve(root, "host/src"), path)
    .replaceAll("\\", "/")
    .replace(/\.[^.]+$/, "");
}
function isStardewProcessImplementation(path, root) {
  return sourcePath(path, root) === STARDew_PROCESS_IMPLEMENTATIONS;
}
function isStardewRegistration(path, root) {
  return sourcePath(path, root) === STARDew_REGISTRATION;
}
function isStardewRegistrationOwner(path, root) {
  return sourcePath(path, root) === STARDew_REGISTRATION_OWNER;
}
function isAllowedStardewGenericImport(importer, target, root) {
  const targetPath = sourcePath(target, root);
  if (targetPath === GAME_IMPORTABLE_GENERIC_PATH) return true;
  return ALLOWED_STARDew_GENERIC_IMPORTERS.get(targetPath)?.has(sourcePath(importer, root)) === true;
}
/**
 * The game identities this tree ships, read from `games/` itself so a second game is
 * covered the day its directory exists. An unreadable directory derives nothing,
 * which the report shows as an empty identity set rather than as a clean seam.
 */
function gameIdentities(sourceRoot) {
  try {
    return readdirSync(join(sourceRoot, "games"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name.toLowerCase())
      .sort();
  } catch {
    return [];
  }
}
/** Camel, Pascal, snake and kebab spellings all split to the same words. */
function vocabularyTokens(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}
/**
 * Every name the source declares or writes, split into words and answered against the
 * forbidden vocabulary. Identifiers and string literals are the semantic surface a
 * consumer reads; comments are excluded on purpose, so a comment that explains what
 * the layer does NOT know stays writable.
 */
function namedGameVocabulary(file, forbidden) {
  const found = [];
  file.forEachChild(function visit(node) {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const token = vocabularyTokens(node.text).find((candidate) => forbidden.has(candidate));
      if (token !== undefined)
        found.push({
          identifier: node.text,
          token,
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        });
    }
    ts.forEachChild(node, visit);
  });
  return found;
}
function violation(kind, importer, specifier, target, line, detail, root) {
  return {
    kind,
    importer: shown(importer, root),
    specifier,
    target: target ? shown(target, root) : null,
    line,
    detail,
  };
}
function scriptKind(path) {
  return [".js", ".jsx", ".mjs", ".cjs"].includes(extname(path)) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}
/** The name an imported binding carries into the importing file, and where it came from. */
function importedBindings(file) {
  const bindings = new Map();
  file.forEachChild(function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause !== undefined && clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          bindings.set(element.name.text, {
            imported: (element.propertyName ?? element.name).text,
            specifier: node.moduleSpecifier.text,
            line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  });
  return bindings;
}
/**
 * The declared return type of one exported declaration, as written.
 *
 * It is read off the declaration rather than resolved through the type checker: the question is whether the
 * importer can NAME a game, a Mod or an installation, and an annotation that spells one already answers it. A
 * declaration whose type is inferred reports `null`, which is the honest reading - nothing was written down to
 * judge - and an inferred game type therefore reaches the call-site rule only through its own name.
 */
function declaredReturnType(file, name) {
  let declared = null;
  file.forEachChild(function visit(node) {
    if (declared !== null) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      declared = node.type?.getText() ?? null;
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const initializer = node.initializer;
      if (initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)))
        declared = initializer.type?.getText() ?? null;
      return;
    }
    ts.forEachChild(node, visit);
  });
  return declared;
}
function architectureBareSpecifier(specifier) {
  const first = specifier.replace(/^node:/, "").split(/[\\/]/)[0];
  return (
    specifier.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(specifier) ||
    specifier.startsWith("host/") ||
    GENERIC_LAYERS.has(first) ||
    first === "games" ||
    RAW_STARDew_MODULES.includes(first)
  );
}
function rawTarget(target, root) {
  const p = relative(resolve(root, "host/src"), target).replaceAll("\\", "/").toLowerCase();
  return (
    RAW_STARDew_MODULES.some((name) => p === name || p.startsWith(`${name}/`)) ||
    /(?:^|\/)(?:desktop|guardian|windows|win32|native)(?:[-_/]|$)/i.test(p)
  );
}
function registrationFacadeUsage(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))) return true;
    return Boolean(
      clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.some(
          (element) => (element.propertyName ?? element.name).text === STARDew_REGISTRATION_OWNER_FACADE,
        ),
    );
  }
  if (ts.isExportDeclaration(node)) {
    if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return true;
    return (
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.some(
        (element) => (element.propertyName ?? element.name).text === STARDew_REGISTRATION_OWNER_FACADE,
      )
    );
  }
  // Import-equals and require expose the module object, so the facade cannot be
  // ruled out statically and must remain owner-only.
  return ts.isImportEqualsDeclaration(node) || ts.isCallExpression(node);
}

export function checkHostGamePhysicalSeam({ root = repositoryRoot } = {}) {
  const actualSourceRoot = resolve(root, "host/src");
  const canonicalRoot = (() => {
    try {
      return realpathSync(actualSourceRoot);
    } catch {
      return actualSourceRoot;
    }
  })();
  const integrity = [];
  const allFiles = filesUnder(actualSourceRoot, integrity, canonicalRoot);
  // Every non-test production module under host/src is inspected as an importer,
  // not only the three generic layers plus games. The flat `host/src/*.ts` layer
  // holds most product producers (the launcher, run manifest, operational gate
  // evidence, integration adapter, ...), and leaving it out meant the rules below
  // could never fire for those files at all -- the registration plan's gate 10
  // names several of them as producers that must not reach registration core or
  // `containment/runtime/core`. Placement is still checked separately below.
  const productionFiles = allFiles.filter((path) => !isTest(path));
  // A walk that read no production module has not shown that a seam is clean: `passed` over zero files is the same
  // verdict this gate would print over nine hundred, and the root or the filter having moved would be invisible.
  if (productionFiles.length === 0 && integrity.length === 0) {
    return Object.freeze({
      verdict: "blocked",
      blocked: [
        `host_game_physical_seam_read_nothing: examined 0 production module(s) under ${shown(actualSourceRoot, root)}`,
      ],
      inspectedFiles: [],
      violations: [],
    });
  }
  const violations = integrity.map(({ path, detail }) =>
    violation("unsafe_source_path", path, null, null, 0, detail, root),
  );
  // Placement is checked independently of import traversal so a stale copy cannot
  // hide merely because no inspected production module imports it.
  for (const source of allFiles) {
    const sourcePath = relative(actualSourceRoot, source).replaceAll("\\", "/");
    if (sourcePath.startsWith("containment/windows/stardew-process-implementations.")) {
      violations.push(
        violation(
          "stardew_implementation_in_generic_windows",
          source,
          null,
          null,
          0,
          "stardew_process_implementations_must_live_under_games_stardew_lifecycle",
          root,
        ),
      );
    }
  }
  // The generic runtime's own vocabulary, answered against words read from the game
  // side. Both halves derive from the tree: the population by walking the layer, the
  // game identities from `games/` and the residue nouns declared above.
  const genericRuntimeFiles = productionFiles.filter((path) =>
    sourcePath(path, root).startsWith(GENERIC_RUNTIME_PREFIX),
  );
  const identities = gameIdentities(resolve(root, "host/src"));
  // `examined 0` is never a pass. The rule is not applicable to a partial fixture that
  // models no containment layer at all -- those fixtures build narrow game/import
  // graphs -- but a tree carrying containment sources and none under `runtime` is the
  // layer having moved or emptied, and that must block instead of reading as clean.
  const blocked = [];
  if (
    genericRuntimeFiles.length === 0 &&
    productionFiles.some((path) => sourcePath(path, root).startsWith("containment/"))
  )
    blocked.push(
      `generic_runtime_vocabulary_read_nothing: examined 0 production source(s) under host/src/${GENERIC_RUNTIME_PREFIX}`,
    );
  const forbiddenVocabulary = new Set([...identities, ...GAME_PROPER_NOUNS]);
  for (const path of genericRuntimeFiles) {
    const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, scriptKind(path));
    for (const hit of namedGameVocabulary(file, forbiddenVocabulary))
      violations.push({
        ...violation(
          "generic_runtime_names_game",
          path,
          null,
          null,
          hit.line,
          "containment_runtime_must_not_name_a_game",
          root,
        ),
        token: hit.token,
        identifier: hit.identifier,
      });
  }
  for (const importer of productionFiles) {
    const source = readFileSync(importer, "utf8");
    const file = ts.createSourceFile(importer, source, ts.ScriptTarget.Latest, true, scriptKind(importer));
    const references = [];
    file.forEachChild(function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
          references.push({
            specifier: node.moduleSpecifier.text,
            line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            registrationFacadeUsage: registrationFacadeUsage(node),
          });
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const expression = node.moduleReference.expression;
        references.push({
          specifier: ts.isStringLiteral(expression) ? expression.text : null,
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          registrationFacadeUsage: registrationFacadeUsage(node),
        });
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const argument = node.arguments[0];
        references.push({
          specifier: argument && ts.isStringLiteral(argument) ? argument.text : null,
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          registrationFacadeUsage: registrationFacadeUsage(node),
        });
      } else if (
        ts.isImportTypeNode(node) &&
        node.argument &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        // A type-only `import("path").Type` is an architecture edge exactly like
        // `import type { X } from "path"`, but it is neither an import/export
        // declaration nor a call expression, so the checker was blind to it. That is
        // how a forbidden layer could be re-imported with the gate still reporting
        // `passed`; the decision loop below only ever sees recorded references.
        references.push({
          specifier: node.argument.literal.text,
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          registrationFacadeUsage: registrationFacadeUsage(node),
        });
      }
      ts.forEachChild(node, visit);
    });
    for (const reference of references) {
      const importerIsGame = gamePath(importer, root);
      if (reference.specifier === null) {
        violations.push(
          violation(
            "unresolved_dynamic_import",
            importer,
            null,
            null,
            reference.line,
            "dynamic_imports_are_not_statically_resolvable",
            root,
          ),
        );
        continue;
      }
      if (
        RAW_BUILTIN_MODULES.has(reference.specifier) &&
        importerIsGame &&
        (!isStardewProcessImplementation(importer, root) ||
          !APPROVED_STARDew_RAW_BUILTIN_MODULES.has(reference.specifier))
      ) {
        violations.push(
          violation(
            "game_imports_desktop_raw_module",
            importer,
            reference.specifier,
            null,
            reference.line,
            "stardew_must_not_import_desktop_guardian_process_or_native_modules",
            root,
          ),
        );
        continue;
      }
      if (!reference.specifier.startsWith(".")) {
        if (!NODE_BUILTINS.has(reference.specifier) && architectureBareSpecifier(reference.specifier))
          violations.push(
            violation(
              "unresolved_non_relative_import",
              importer,
              reference.specifier,
              null,
              reference.line,
              "non_relative_internal_architecture_edge_is_not_allowed",
              root,
            ),
          );
        continue;
      }
      const resolution = resolveSource(importer, reference.specifier, canonicalRoot);
      if (resolution.kind !== "resolved") {
        const lexicalTarget = resolve(dirname(importer), reference.specifier);
        if (resolution.kind === "missing" && gameFreeGenericPath(importer, root) && gamePath(lexicalTarget, root))
          violations.push(
            violation(
              "generic_layer_imports_game",
              importer,
              reference.specifier,
              lexicalTarget,
              reference.line,
              "bootstrap_containment_and_composition_must_not_import_games",
              root,
            ),
          );
        else if (resolution.kind === "missing" && importerIsGame && rawTarget(lexicalTarget, root))
          violations.push(
            violation(
              "game_imports_desktop_raw_module",
              importer,
              reference.specifier,
              lexicalTarget,
              reference.line,
              "stardew_must_not_import_desktop_guardian_process_or_native_modules",
              root,
            ),
          );
        else
          violations.push(
            violation(
              resolution.kind === "escaped"
                ? "relative_import_escapes_source_root"
                : resolution.kind === "ambiguous"
                  ? "ambiguous_relative_import"
                  : "unresolved_relative_import",
              importer,
              reference.specifier,
              resolution.target ?? null,
              reference.line,
              `relative_source_${resolution.kind}`,
              root,
            ),
          );
        continue;
      }
      const target = resolution.target;
      if (
        isStardewRegistration(target, root) &&
        reference.registrationFacadeUsage &&
        !isStardewRegistrationOwner(importer, root)
      ) {
        violations.push(
          violation(
            "stardew_registration_import_not_owner",
            importer,
            reference.specifier,
            target,
            reference.line,
            "stardew_installation_registration_owner_facade_must_have_one_lifecycle_consumer",
            root,
          ),
        );
        continue;
      }
      const targetIsGame = gamePath(target, root);
      if (importerIsGame && genericPath(target, root) && !isAllowedStardewGenericImport(importer, target, root))
        violations.push(
          violation(
            "game_imports_generic_layer",
            importer,
            reference.specifier,
            target,
            reference.line,
            "games_must_not_import_bootstrap_containment_or_composition",
            root,
          ),
        );
      else if (gameFreeGenericPath(importer, root) && targetIsGame)
        violations.push(
          violation(
            "generic_layer_imports_game",
            importer,
            reference.specifier,
            target,
            reference.line,
            "bootstrap_containment_and_composition_must_not_import_games",
            root,
          ),
        );
      else if (importerIsGame && !isAllowedStardewGenericImport(importer, target, root) && rawTarget(target, root))
        violations.push(
          violation(
            "game_imports_desktop_raw_module",
            importer,
            reference.specifier,
            target,
            reference.line,
            "stardew_must_not_import_desktop_guardian_process_or_native_modules",
            root,
          ),
        );
    }
  }
  // The wire's own names and call sites. `host/src/bootstrap/README.md` says the wire "does not know Stardew
  // lifecycle policy or game-specific guardian behavior" and the composition README says it may not reach "any
  // game, Mod, action or game recipe": both sentences are about what the file NAMES, and the import-path rule
  // above cannot see a name - `deployCompanionGameMod` lives in the generic composition root, so the path rule had
  // nothing to report while the wire staged a game installation at boot.
  //
  // The population excludes the paths this gate itself declares game-facing in `ALLOWED_STARDew_GENERIC_IMPORTERS`
  // (`bootstrap/roots/stardew-private-mod-profile-staging`, whose README owns "published Stardew artifact provenance
  // verification"). The exclusion is therefore not a second list: it is read from the one declaration the gate
  // already carries, and it expires the day that row is deleted. `callSites` is printed because a tree whose wire
  // imports nothing to call would otherwise agree with itself; the run is already blocked when the tree holds no
  // production module at all.
  const wireFiles = productionFiles.filter(
    (path) => layer(path, root) === WIRE_LAYER && !ALLOWED_STARDew_GENERIC_IMPORTERS.has(sourcePath(path, root)),
  );
  const wireVocabulary = new Set([...identities, ...GAME_PROPER_NOUNS, ...WIRE_FORBIDDEN_NOUNS]);
  const parsedTargets = new Map();
  const targetOf = (path) => {
    const cached = parsedTargets.get(path);
    if (cached !== undefined) return cached;
    const parsed = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      scriptKind(path),
    );
    parsedTargets.set(path, parsed);
    return parsed;
  };
  let wireCallSites = 0;
  for (const path of wireFiles) {
    const file = targetOf(path);
    const bindings = importedBindings(file);
    for (const binding of bindings.values()) {
      const token = vocabularyTokens(binding.imported).find((candidate) => wireVocabulary.has(candidate));
      if (token === undefined) continue;
      violations.push({
        ...violation(
          "bootstrap_names_game_symbol",
          path,
          binding.specifier,
          null,
          binding.line,
          "bootstrap_wire_must_not_name_a_game_mod_or_installation",
          root,
        ),
        identifier: binding.imported,
        token,
      });
    }
    const calls = [];
    file.forEachChild(function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node);
      ts.forEachChild(node, visit);
    });
    for (const call of calls) {
      const binding = bindings.get(call.expression.text);
      if (binding === undefined) continue;
      wireCallSites += 1;
      const resolution = resolveSource(path, binding.specifier, canonicalRoot);
      if (resolution.kind !== "resolved") continue;
      const declared = declaredReturnType(targetOf(resolution.target), binding.imported);
      if (declared === null) continue;
      const token = vocabularyTokens(declared).find((candidate) => wireVocabulary.has(candidate));
      if (token === undefined) continue;
      violations.push({
        ...violation(
          "bootstrap_calls_game_typed_value",
          path,
          binding.specifier,
          resolution.target,
          file.getLineAndCharacterOfPosition(call.getStart(file)).line + 1,
          `bootstrap_wire_calls_a_value_whose_declared_type_names_${token}`,
          root,
        ),
        identifier: binding.imported,
        declared,
        token,
      });
    }
  }
  violations.sort(
    (a, b) =>
      (a.target === null && a.kind === "game_imports_desktop_raw_module" ? -1 : 0) -
        (b.target === null && b.kind === "game_imports_desktop_raw_module" ? -1 : 0) ||
      a.importer.localeCompare(b.importer) ||
      a.line - b.line ||
      String(a.specifier).localeCompare(String(b.specifier)),
  );
  return {
    verdict: violations.length === 0 && blocked.length === 0 ? "passed" : "blocked",
    inspectedFiles: productionFiles.map((path) => shown(path, root)).sort(),
    violations,
    blocked,
    vocabulary: { examined: genericRuntimeFiles.length, gameIdentities: identities },
    wire: { files: wireFiles.length, callSites: wireCallSites },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const report = checkHostGamePhysicalSeam();
  if (report.verdict !== "passed") console.error(JSON.stringify(report, null, 2));
  else
    console.log(
      `host game physical seam: passed (${report.inspectedFiles.length} production files; generic runtime vocabulary read ${report.vocabulary.examined} source(s) against ${report.vocabulary.gameIdentities.length} game identit${report.vocabulary.gameIdentities.length === 1 ? "y" : "ies"} plus ${GAME_PROPER_NOUNS.length} game noun(s); wire read ${report.wire.files} file(s) and ${report.wire.callSites} imported call site(s))`,
    );
  process.exitCode = report.verdict === "passed" ? 0 : (report.blocked?.length ?? 0) > 0 ? 2 : 1;
}
