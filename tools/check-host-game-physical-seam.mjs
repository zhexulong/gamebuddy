import { builtinModules, createRequire } from "node:module";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromHost = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "../host/package.json"));
const ts = requireFromHost("typescript");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const IGNORED_DIRECTORIES = new Set([".worktrees", "dist", "dist-test", "node_modules", "fixtures", "test-support", "test-fixtures", "__fixtures__", "fixture", "generated"]);
const GENERIC_LAYERS = new Set(["bootstrap", "containment", "composition"]);
// The lifecycle may consume only these published, non-platform contracts from
// generic layers: authenticated containment and Stardew artifact provenance.
const ALLOWED_GENERIC_MODULES = new Set([
  "containment/auth/desktop-guardian-session.internal",
  "bootstrap/roots/stardew-private-mod-profile-staging",
]);
const STARDew_PROCESS_IMPLEMENTATIONS = "games/stardew/lifecycle/stardew-process-implementations";
const STARDew_REGISTRATION = "stardew-installation-registration.internal";
const STARDew_REGISTRATION_OWNER = "games/stardew/lifecycle/stardew-private-bootstrap-composer.core";
const STARDew_REGISTRATION_OWNER_FACADE = "withStardewLifecycleInstallationRegistrationOwner";
const ALLOWED_STARDew_GENERIC_IMPORTERS = new Map([
  ["containment/auth/desktop-guardian-session.internal", new Set([
    "games/stardew/lifecycle/stardew-private-bootstrap-composer.internal",
    "games/stardew/lifecycle/stardew-bootstrap-guardian.private",
  ])],
  ["bootstrap/roots/stardew-private-mod-profile-staging", new Set([
    "games/stardew/lifecycle/stardew-private-bootstrap-composer.internal",
  ])],
]);
const RAW_STARDew_MODULES = [
  "windows-stardew-bootstrap-guardian", "windows-stardew-folder-picker",
  "windows-stale-lock-reclaimer", "windows-reparse-inspector",
];
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const RAW_BUILTIN_MODULES = new Set([
  "child_process", "node:child_process", "process", "node:process",
  "worker_threads", "node:worker_threads", "ffi-napi", "node:ffi-napi",
  "winreg", "node:winreg",
]);
const APPROVED_STARDew_RAW_BUILTIN_MODULES = new Set(["node:child_process"]);

function shown(path, root = repositoryRoot) { return relative(root, path).replaceAll("\\", "/"); }
function isTest(path) { return /(?:^|[/.])[^/]*\.test(?:-support(?:-internal)?)?\.[cm]?[jt]sx?$/.test(path.replaceAll("\\", "/")); }
function isInside(path, root) { const r = relative(root, path); return r === "" || (r !== ".." && !r.startsWith(`..${path.includes("\\") ? "\\" : "/"}`) && !(/^[A-Za-z]:/.test(r))); }
function filesUnder(directory, integrity, root) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const lexical = join(directory, entry.name);
    let stat;
    try { stat = lstatSync(lexical); } catch { integrity.push({ path: lexical, detail: "source_entry_cannot_be_inspected" }); continue; }
    if (stat.isSymbolicLink()) { integrity.push({ path: lexical, detail: "symlink_or_reparse_source_is_not_allowed" }); continue; }
    if (stat.isDirectory()) { if (!IGNORED_DIRECTORIES.has(entry.name)) result.push(...filesUnder(lexical, integrity, root)); continue; }
    if (!SOURCE_EXTENSIONS.includes(extname(entry.name)) || isTest(lexical)) continue;
    let canonical;
    try { canonical = realpathSync(lexical); } catch { integrity.push({ path: lexical, detail: "source_canonical_path_unavailable" }); continue; }
    if (!isInside(canonical, root) || canonical !== lexical) integrity.push({ path: lexical, detail: "source_canonical_path_escapes_scoped_root" });
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
  const alternatives = explicit && extension !== ".js" ? [raw] : [...SOURCE_EXTENSIONS.map((item) => `${base}${item}`), ...SOURCE_EXTENSIONS.map((item) => join(base, `index${item}`))];
  const existing = [...new Set(alternatives)].filter((candidate) => existsSync(candidate) && !isTest(candidate) && SOURCE_EXTENSIONS.includes(extname(candidate).toLowerCase()));
  if (existing.length !== 1) return { kind: existing.length === 0 ? "missing" : "ambiguous", candidates: existing };
  let canonical;
  try { canonical = realpathSync(existing[0]); } catch { return { kind: "canonical-unavailable" }; }
  if (!isInside(canonical, sourceRoot) || canonical !== existing[0]) return { kind: "unsafe", target: canonical };
  return { kind: "resolved", target: canonical };
}
function layer(path, root) { return relative(resolve(root, "host/src"), path).replaceAll("\\", "/").split("/")[0]; }
function gamePath(path, root) { const p = relative(resolve(root, "host/src"), path).replaceAll("\\", "/"); return p === "games" || p.startsWith("games/"); }
function genericPath(path, root) { return GENERIC_LAYERS.has(layer(path, root)); }
function sourcePath(path, root) { return relative(resolve(root, "host/src"), path).replaceAll("\\", "/").replace(/\.[^.]+$/, ""); }
function isStardewLifecycleImporter(path, root) { return sourcePath(path, root).startsWith("games/stardew/lifecycle/"); }
function isStardewProcessImplementation(path, root) { return sourcePath(path, root) === STARDew_PROCESS_IMPLEMENTATIONS; }
function isStardewRegistration(path, root) { return sourcePath(path, root) === STARDew_REGISTRATION; }
function isStardewRegistrationOwner(path, root) { return sourcePath(path, root) === STARDew_REGISTRATION_OWNER; }
function isAllowedStardewGenericImport(importer, target, root) {
  const targetPath = sourcePath(target, root);
  return ALLOWED_STARDew_GENERIC_IMPORTERS.get(targetPath)?.has(sourcePath(importer, root)) === true;
}
function violation(kind, importer, specifier, target, line, detail, root) { return { kind, importer: shown(importer, root), specifier, target: target ? shown(target, root) : null, line, detail }; }
function scriptKind(path) { return [".js", ".jsx", ".mjs", ".cjs"].includes(extname(path)) ? ts.ScriptKind.JS : ts.ScriptKind.TS; }
function architectureBareSpecifier(specifier) { const first = specifier.replace(/^node:/, "").split(/[\\/]/)[0]; return specifier.startsWith("/") || /^[A-Za-z]:[\\/]/.test(specifier) || specifier.startsWith("host/") || GENERIC_LAYERS.has(first) || first === "games" || RAW_STARDew_MODULES.includes(first); }
function rawTarget(target, root) { const p = relative(resolve(root, "host/src"), target).replaceAll("\\", "/").toLowerCase(); return RAW_STARDew_MODULES.some((name) => p === name || p.startsWith(`${name}/`)) || /(?:^|\/)(?:desktop|guardian|windows|win32|native)(?:[-_/]|$)/i.test(p); }
function registrationFacadeUsage(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))) return true;
    return Boolean(clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.some((element) => (element.propertyName ?? element.name).text === STARDew_REGISTRATION_OWNER_FACADE));
  }
  if (ts.isExportDeclaration(node)) {
    if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return true;
    return ts.isNamedExports(node.exportClause) && node.exportClause.elements.some((element) => (element.propertyName ?? element.name).text === STARDew_REGISTRATION_OWNER_FACADE);
  }
  // Import-equals and require expose the module object, so the facade cannot be
  // ruled out statically and must remain owner-only.
  return ts.isImportEqualsDeclaration(node) || ts.isCallExpression(node);
}

export function checkHostGamePhysicalSeam({ root = repositoryRoot } = {}) {
  const actualSourceRoot = resolve(root, "host/src");
  const canonicalRoot = (() => { try { return realpathSync(actualSourceRoot); } catch { return actualSourceRoot; } })();
  const integrity = [];
  const allFiles = filesUnder(actualSourceRoot, integrity, canonicalRoot);
  const productionFiles = allFiles.filter((path) => genericPath(path, root) || gamePath(path, root));
  const violations = integrity.map(({ path, detail }) => violation("unsafe_source_path", path, null, null, 0, detail, root));
  // Placement is checked independently of import traversal so a stale copy cannot
  // hide merely because no inspected production module imports it.
  for (const source of allFiles) {
    const sourcePath = relative(actualSourceRoot, source).replaceAll("\\", "/");
    if (sourcePath.startsWith("containment/windows/stardew-process-implementations.")) {
      violations.push(violation("stardew_implementation_in_generic_windows", source, null, null, 0, "stardew_process_implementations_must_live_under_games_stardew_lifecycle", root));
    }
  }
  for (const importer of productionFiles) {
    const source = readFileSync(importer, "utf8");
    const file = ts.createSourceFile(importer, source, ts.ScriptTarget.Latest, true, scriptKind(importer));
    const references = [];
    file.forEachChild(function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) references.push({ specifier: node.moduleSpecifier.text, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, registrationFacadeUsage: registrationFacadeUsage(node) });
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const expression = node.moduleReference.expression;
        references.push({ specifier: ts.isStringLiteral(expression) ? expression.text : null, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, registrationFacadeUsage: registrationFacadeUsage(node) });
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const argument = node.arguments[0];
        references.push({ specifier: argument && ts.isStringLiteral(argument) ? argument.text : null, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, registrationFacadeUsage: registrationFacadeUsage(node) });
      }
      ts.forEachChild(node, visit);
    });
    for (const reference of references) {
      const importerIsGame = gamePath(importer, root);
      if (reference.specifier === null) { violations.push(violation("unresolved_dynamic_import", importer, null, null, reference.line, "dynamic_imports_are_not_statically_resolvable", root)); continue; }
      if (RAW_BUILTIN_MODULES.has(reference.specifier) && importerIsGame && (!isStardewProcessImplementation(importer, root) || !APPROVED_STARDew_RAW_BUILTIN_MODULES.has(reference.specifier))) { violations.push(violation("game_imports_desktop_raw_module", importer, reference.specifier, null, reference.line, "stardew_must_not_import_desktop_guardian_process_or_native_modules", root)); continue; }
      if (!reference.specifier.startsWith(".")) {
        if (!NODE_BUILTINS.has(reference.specifier) && architectureBareSpecifier(reference.specifier)) violations.push(violation("unresolved_non_relative_import", importer, reference.specifier, null, reference.line, "non_relative_internal_architecture_edge_is_not_allowed", root));
        continue;
      }
      const resolution = resolveSource(importer, reference.specifier, canonicalRoot);
      if (resolution.kind !== "resolved") {
        const lexicalTarget = resolve(dirname(importer), reference.specifier);
        if (resolution.kind === "missing" && genericPath(importer, root) && gamePath(lexicalTarget, root)) violations.push(violation("generic_layer_imports_game", importer, reference.specifier, lexicalTarget, reference.line, "bootstrap_containment_and_composition_must_not_import_games", root));
        else if (resolution.kind === "missing" && importerIsGame && rawTarget(lexicalTarget, root)) violations.push(violation("game_imports_desktop_raw_module", importer, reference.specifier, lexicalTarget, reference.line, "stardew_must_not_import_desktop_guardian_process_or_native_modules", root));
        else violations.push(violation(resolution.kind === "escaped" ? "relative_import_escapes_source_root" : resolution.kind === "ambiguous" ? "ambiguous_relative_import" : "unresolved_relative_import", importer, reference.specifier, resolution.target ?? null, reference.line, `relative_source_${resolution.kind}`, root));
        continue;
      }
      const target = resolution.target;
      if (isStardewRegistration(target, root) && reference.registrationFacadeUsage && !isStardewRegistrationOwner(importer, root)) {
        violations.push(violation("stardew_registration_import_not_owner", importer, reference.specifier, target, reference.line, "stardew_installation_registration_owner_facade_must_have_one_lifecycle_consumer", root));
        continue;
      }
      const targetIsGame = gamePath(target, root);
      if (importerIsGame && genericPath(target, root) && !isAllowedStardewGenericImport(importer, target, root)) violations.push(violation("game_imports_generic_layer", importer, reference.specifier, target, reference.line, "games_must_not_import_bootstrap_containment_or_composition", root));
      else if (genericPath(importer, root) && targetIsGame) violations.push(violation("generic_layer_imports_game", importer, reference.specifier, target, reference.line, "bootstrap_containment_and_composition_must_not_import_games", root));
      else if (importerIsGame && !isAllowedStardewGenericImport(importer, target, root) && rawTarget(target, root)) violations.push(violation("game_imports_desktop_raw_module", importer, reference.specifier, target, reference.line, "stardew_must_not_import_desktop_guardian_process_or_native_modules", root));
    }
  }
  violations.sort((a, b) => (a.target === null && a.kind === "game_imports_desktop_raw_module" ? -1 : 0) - (b.target === null && b.kind === "game_imports_desktop_raw_module" ? -1 : 0) || a.importer.localeCompare(b.importer) || a.line - b.line || String(a.specifier).localeCompare(String(b.specifier)));
  return { verdict: violations.length === 0 ? "passed" : "blocked", inspectedFiles: productionFiles.map((path) => shown(path, root)).sort(), violations };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const report = checkHostGamePhysicalSeam();
  if (report.verdict !== "passed") console.error(JSON.stringify(report, null, 2)); else console.log(`host game physical seam: passed (${report.inspectedFiles.length} production files)`);
  process.exitCode = report.verdict === "passed" ? 0 : 1;
}
