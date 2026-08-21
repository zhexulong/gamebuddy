import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TEST_ARTIFACT = /(?:^|\/)(?:[^/]*\.(?:test|test-support)(?:\.[^/]+)?|test-fixtures|[^/]*(?:physical-)?fixture-worker[^/]*)(?:\/|$)|legacy-writer-fixture/i;
// Production is a fresh semantic-continuity authority. Reject legacy module
// *namespaces* rather than a list of files that happened to exist before the
// destructive cutover: a future reintroduction under any nested path fails
// before reachability can make it look harmless.
const LEGACY_CONTINUITY_ARTIFACT_NAMESPACE = /^(?:(?:continuity-authority-(?:coordinator|routing)|continuity-production-migration|continuity-semantic-backend)\/.*|continuity\.js|game-origin-authority\/.*|game-surface-(?:lease|recovery)\.js|game-surface-lifecycle\/.*|(?:integration|local)-bootstrap\.js)$/;
const forbiddenLegacyContinuityModule = (emittedPath) =>
  LEGACY_CONTINUITY_ARTIFACT_NAMESPACE.test(emittedPath) ? emittedPath : null;
const POINTER = "current.json";
const GENERATIONS = "generations";
const PUBLISHER_LOCK = ".publisher.lock";
const PUBLISHER_LOCK_WAIT_MS = 5_000;
const PUBLISHER_LOCK_RETRY_MS = 50;
const slash = (path) => path.replaceAll("\\", "/");
const inside = (root, path) => { const value = relative(root, path); return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value)); };
const digest = (content) => createHash("sha256").update(content).digest("hex");
const configuredEntry = (entryRoots, entry) => typeof entry === "string" && entryRoots.includes(entry) && basename(entry) === entry && !entry.includes("/") && !entry.includes("\\") && !entry.includes("..");
const configuredVerificationRoot = (value) => typeof value === "string"
  && /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.js$/.test(value);
const REQUIRED_VERIFICATION_ROOTS = Object.freeze([
  "tavern/p4-durable-turn-acceptance.js",
  "tavern/p4-provider-attempt.js",
  "tavern/chat-provider-start.js",
  "tavern/p3-static-shell-composition.js",
  "reference-pipeline-dialogue-web.js",
  "tavern-management-dialogue-web.js",
  "tavern/tavern-management-static-shell-composition.js",
]);
const allVerificationRoots = (config) => [...config.entryRoots, ...config.verificationRoots];
const declaredExternalPackage = (value) => typeof value === "string" && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(value);
const packageName = (specifier) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
const nodeBuiltin = (specifier) => specifier.startsWith("node:");
// `node:module` exposes createRequire(), which can load an unreviewed package
// after artifact verification. Node resolves the bare `module` alias to that
// same builtin, so reject both static ingress spellings before builtin/package
// closure handling. This ESM artifact has no legitimate module-loader ingress.
const moduleLoaderIngress = (specifier) => specifier === "node:module" || specifier === "module";
const dynamicExternalImportKey = (rule) => `${rule.package}:${rule.module}:${rule.expression}:${rule.occurrence}`;
const dynamicExternalImportTargetKey = (rule) => `${rule.module}:${rule.expression}`;
const BROWSER_ARTIFACT = Object.freeze({
  kind: "verified_tavern_browser_artifact",
  destination: "browser/tavern/v1",
  browserContract: "tavern_browser_api/v1",
  profileId: "gamebuddy.tavern.browser.v1",
  manifest: "tavern-browser-artifact-manifest.json",
});
const BROWSER_ARTIFACT_ASSET = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9_-]{8,}\.(?:js|css|svg|png|webp|woff2)$/;
const BROWSER_ARTIFACT_MIMES = new Map([["js", "text/javascript"], ["css", "text/css"], ["svg", "image/svg+xml"], ["png", "image/png"], ["webp", "image/webp"], ["woff2", "font/woff2"]]);
const WINDOWS_REPARSE_INSPECTOR = Object.freeze({
  kind: "verified_windows_reparse_inspector",
  destination: "native/windows-reparse-inspector/win-x64",
  helper: "GameBuddy.WindowsReparseInspector.exe",
  manifest: "windows-reparse-inspector.manifest.json",
  // Fixed optional passive audit output. It never authorizes a live release.
  probeEvidence: "windows-reparse-inspector.probe-evidence.json",
});
const WINDOWS_STALE_LOCK_RECLAIMER = Object.freeze({
  kind: "verified_windows_stale_lock_reclaimer",
  destination: "native/windows-stale-lock-reclaimer/win-x64",
  helper: "GameBuddy.WindowsStaleLockReclaimer.exe",
  manifest: "windows-stale-lock-reclaimer.manifest.json",
});
const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const artifactRelativeModule = (artifactRoot, importer, specifier, artifactFileSet) => {
  // ESM output must name an exact regular file in the selected immutable
  // generation. Node never needs package-style or extension guessing here.
  const importerPath = resolve(artifactRoot, importer);
  const target = resolve(dirname(importerPath), specifier.replaceAll("/", sep));
  if (!inside(artifactRoot, target) || target === artifactRoot) throw new Error(`production_relative_module_escapes_artifact:${importer}:${specifier}`);
  const relativeTarget = slash(relative(artifactRoot, target));
  if (!relativeTarget.endsWith(".js") || !artifactFileSet.has(relativeTarget)) throw new Error(`production_relative_module_missing_from_artifact:${importer}:${specifier}`);
  if (TEST_ARTIFACT.test(relativeTarget)) throw new Error(`production_relative_module_test_artifact_forbidden:${importer}:${specifier}`);
  return relativeTarget;
};
const declaredDynamicExternalImport = (value, packages) => value !== null && typeof value === "object" && !Array.isArray(value)
  && typeof value.package === "string" && packages.includes(value.package)
  && typeof value.module === "string" && /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.js$/.test(value.module)
  && typeof value.expression === "string" && value.expression === "pathToFileURL(magicContextEntry).href"
  && Number.isInteger(value.occurrence) && value.occurrence >= 0;

/** A fail-closed TypeScript lexical parser. Comments and strings are syntax,
 * never regex input; malformed emitted JavaScript is rejected. */
function lexicalModuleIngress(content) {
  const source = ts.createSourceFile("artifact.js", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length > 0) throw new Error("production_module_lexical_parse_failed");
  const staticSpecifiers = []; const dynamicCalls = []; const processBuiltinModuleIngresses = [];
  const unwrapTransparentGlobalReceiver = (value) => {
    let current = value;
    while (ts.isParenthesizedExpression(current)) current = current.expression;
    return current;
  };
  const globalObject = (value) => {
    const unwrapped = unwrapTransparentGlobalReceiver(value);
    return ts.isIdentifier(unwrapped) && (unwrapped.text === "globalThis" || unwrapped.text === "global");
  };
  const globalSelfAliasAcquisition = (node) =>
    (ts.isPropertyAccessExpression(node) && globalObject(node.expression)
      && (node.name.text === "global" || node.name.text === "globalThis"))
    || (ts.isElementAccessExpression(node) && globalObject(node.expression)
      && ts.isStringLiteral(node.argumentExpression)
      && (node.argumentExpression.text === "global" || node.argumentExpression.text === "globalThis"));
  const globalProcessPath = (value) => {
    const unwrapped = unwrapTransparentGlobalReceiver(value);
    return (ts.isPropertyAccessExpression(unwrapped) && globalObject(unwrapped.expression) && unwrapped.name.text === "process")
      || (ts.isElementAccessExpression(unwrapped) && globalObject(unwrapped.expression)
        && ts.isStringLiteral(unwrapped.argumentExpression) && unwrapped.argumentExpression.text === "process");
  };
  const processCapablePath = (value) => {
    const unwrapped = unwrapTransparentGlobalReceiver(value);
    return (ts.isIdentifier(unwrapped) && unwrapped.text === "process") || globalProcessPath(unwrapped);
  };
  const processBuiltinModuleProperty = (node) => (ts.isPropertyAccessExpression(node)
    && processCapablePath(node.expression) && node.name.text === "getBuiltinModule")
    || (ts.isElementAccessExpression(node)
      && processCapablePath(node.expression)
      && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "getBuiltinModule");
  const globalProcessAcquisition = (node) =>
    (ts.isPropertyAccessExpression(node) && globalObject(node.expression) && node.name.text === "process")
    || (ts.isElementAccessExpression(node) && globalObject(node.expression)
      && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "process");
  const computedGlobalMember = (node) => ts.isElementAccessExpression(node)
    && globalObject(node.expression)
    && !ts.isStringLiteral(node.argumentExpression);
  const computedGlobalProcessMember = (node) => ts.isElementAccessExpression(node)
    && globalProcessPath(node.expression)
    && !ts.isStringLiteral(node.argumentExpression);
  const transparentProcessAliasAcquisition = (node) => ts.isVariableDeclaration(node)
    && node.initializer !== undefined && processCapablePath(node.initializer);
  const processBuiltinModuleReflection = (node) => {
    if (!ts.isCallExpression(node) || node.arguments.length < 1
      || !processCapablePath(node.arguments[0])) return false;
    const reflectionCallee = (target, member, allowDynamicMember = false) => (ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === target
      && node.expression.name.text === member)
      || (ts.isElementAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === target
        && (ts.isStringLiteral(node.expression.argumentExpression)
          ? node.expression.argumentExpression.text === member
          : allowDynamicMember));
    const staticBuiltinProperty = node.arguments.length >= 2
      && ts.isStringLiteral(node.arguments[1])
      && node.arguments[1].text === "getBuiltinModule";
    const objectDescriptor = (ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object"
      && node.expression.name.text === "getOwnPropertyDescriptor"
      && staticBuiltinProperty)
      || (ts.isElementAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object"
        && (ts.isStringLiteral(node.expression.argumentExpression)
          ? node.expression.argumentExpression.text === "getOwnPropertyDescriptor" && staticBuiltinProperty
          : true));
    return (staticBuiltinProperty && reflectionCallee("Reflect", "get")) || objectDescriptor;
  };
  const processBuiltinModuleDestructuring = (node) => ts.isVariableDeclaration(node)
    && ts.isObjectBindingPattern(node.name)
    && node.initializer !== undefined && ts.isIdentifier(node.initializer) && node.initializer.text === "process"
    && node.name.elements.some((element) => element.propertyName === undefined
      ? ts.isIdentifier(element.name) && element.name.text === "getBuiltinModule"
      : (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
        && element.propertyName.text === "getBuiltinModule");
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) throw new Error("production_module_lexical_parse_failed");
      staticSpecifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      if (node.arguments.length !== 1) throw new Error("production_dynamic_module_ingress_forbidden");
      const argument = node.arguments[0];
      dynamicCalls.push({ kind: node.expression.kind === ts.SyntaxKind.ImportKeyword ? "import" : "require", expression: ts.isStringLiteral(argument) ? JSON.stringify(argument.text) : argument.getText(source) });
    }
    // This intentionally bounded syntax policy rejects direct property access,
    // variable destructuring, and the two exact reflective access forms only;
    // it does not attempt alias or general data-flow analysis.
    if (processBuiltinModuleProperty(node) || globalSelfAliasAcquisition(node) || globalProcessAcquisition(node) || computedGlobalMember(node) || computedGlobalProcessMember(node) || transparentProcessAliasAcquisition(node) || processBuiltinModuleReflection(node) || processBuiltinModuleDestructuring(node)) processBuiltinModuleIngresses.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { staticSpecifiers, dynamicCalls, processBuiltinModuleIngresses };
}
/* Legacy fallback scanner retained below only as unreachable implementation
 * detail for a future parser removal. */
function unusedLegacyLexicalModuleIngress(content) {
  const staticSpecifiers = []; const dynamicCalls = []; const length = content.length;
  const wordAt = (index, word) => content.startsWith(word, index) && !/[\w$]/.test(content[index - 1] ?? "") && !/[\w$]/.test(content[index + word.length] ?? "");
  const skipSpace = (index) => { while (index < length && /\s/.test(content[index])) index++; return index; };
  const quoted = (index) => {
    const quote = content[index]; if (quote !== "'" && quote !== '"') return undefined;
    let value = ""; for (let cursor = index + 1; cursor < length; cursor++) { const char = content[cursor]; if (char === "\\") { if (++cursor >= length) throw new Error("production_module_lexical_parse_failed"); value += content[cursor]; continue; } if (char === quote) return { value, end: cursor + 1 }; value += char; }
    throw new Error(`production_module_lexical_parse_failed_unterminated_quote:${index}`);
  };
  const template = (index) => {
    for (let cursor = index + 1; cursor < length; cursor++) { if (content[cursor] === "\\") { if (++cursor >= length) throw new Error("production_module_lexical_parse_failed"); continue; } if (content[cursor] === "`") return { end: cursor + 1 }; }
    throw new Error(`production_module_lexical_parse_failed_unterminated_template:${index}`);
  };
  const expression = (open) => {
    let depth = 1; let cursor = open + 1;
    for (; cursor < length; cursor++) { const char = content[cursor]; if (char === "'" || char === String.fromCharCode(34)) { cursor = quoted(cursor).end - 1; continue; } if (char === String.fromCharCode(96)) { cursor = template(cursor).end - 1; continue; } if (char === "(") depth++; else if (char === ")" && --depth === 0) return { value: content.slice(open + 1, cursor).trim(), end: cursor + 1 }; }
    throw new Error(`production_module_lexical_parse_failed_unterminated_expression:${open}`);
  };
  for (let index = 0; index < length;) {
    const char = content[index];
    if (char === "'" || char === String.fromCharCode(34) || char === String.fromCharCode(96)) { index = char === String.fromCharCode(96) ? template(index).end : quoted(index).end; continue; }
    if (char === "/" && content[index + 1] === "/") { const end = content.indexOf("\n", index + 2); index = end < 0 ? length : end + 1; continue; }
    if (char === "/" && content[index + 1] === "*") { const end = content.indexOf("*/", index + 2); if (end < 0) throw new Error("production_module_lexical_parse_failed"); index = end + 2; continue; }
    // Emitted modules contain regular expressions. Skip a complete regex token
    // conservatively so quoted characters inside its pattern are not code.
    if (char === "/" && /[=(:,!&|?{[]/.test(content[index - 1] ?? "")) { let cursor = index + 1; let bracket = false; for (; cursor < length; cursor++) { if (content[cursor] === "\\") { cursor++; continue; } if (content[cursor] === "[") bracket = true; else if (content[cursor] === "]") bracket = false; else if (content[cursor] === "/" && !bracket) { index = cursor + 1; while (/[a-z]/i.test(content[index] ?? "")) index++; break; } } if (cursor >= length) throw new Error("production_module_lexical_parse_failed"); continue; }
    const keyword = wordAt(index, "import") ? "import" : wordAt(index, "export") ? "export" : wordAt(index, "require") ? "require" : undefined;
    if (!keyword) { index++; continue; }
    let cursor = skipSpace(index + keyword.length);
    if ((keyword === "import" || keyword === "require") && content[cursor] === "(") { const call = expression(cursor); dynamicCalls.push({ kind: keyword, expression: call.value }); index = call.end; continue; }
    if (keyword === "require") throw new Error("production_dynamic_module_ingress_forbidden:require");
    const declarationEnd = content.indexOf(";", cursor); const end = declarationEnd < 0 ? length : declarationEnd;
    const segment = content.slice(cursor, end); const from = /\bfrom\s*(['"])([^'"\\]+)\1/.exec(segment); const direct = quoted(cursor);
    if (keyword === "import" && direct) staticSpecifiers.push(direct.value);
    else if (from) staticSpecifiers.push(from[2]);
    index = end + 1;
  }
  return { staticSpecifiers, dynamicCalls };
}

async function regular(path, label) {
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isFile()) throw new Error(`${label}_must_be_regular_file:${path}`);
  return state;
}
async function directory(path, label) {
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isDirectory()) throw new Error(`${label}_must_be_regular_directory:${path}`);
  return state;
}
async function safeAncestors(root, target, label) {
  if (!inside(root, target)) throw new Error(`${label}_escapes_root:${target}`);
  let cursor = root;
  for (const item of relative(root, target).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, item);
    const state = await lstat(cursor);
    // Node lstat() detects symbolic links only. It cannot establish the
    // Windows arbitrary-reparse exclusion required by design/42.
    if (state.isSymbolicLink()) throw new Error(`${label}_contains_symbolic_link:${cursor}`);
    if (cursor !== target && !state.isDirectory()) throw new Error(`${label}_ancestor_not_directory:${cursor}`);
  }
}
function validateResource(resource) {
  if (resource === null || typeof resource !== "object" || typeof resource.source !== "string" || typeof resource.destination !== "string") throw new Error("resource_not_allowlisted");
  // Validate the declared source before resolving or touching it. Production has
  // one intentionally reviewed resource; test/fixture/legacy names never enter I/O.
  if (TEST_ARTIFACT.test(slash(resource.source)) || /(?:test|fixture|legacy)/i.test(resource.source)) throw new Error("production_resource_source_forbidden");
  const allowed = new Map([
    ["resources/windows-named-mutex-broker.ps1", "windows-named-mutex-broker.ps1"],
    ["resources/windows-current-user-control-pipe.ps1", "windows-current-user-control-pipe.ps1"],
  ]);
  if (allowed.get(resource.source) !== resource.destination) throw new Error("resource_not_allowlisted");
}
function validateBrowserArtifactDescriptor(value) {
  if (!exactKeys(value, ["kind", "destination", "browserContract", "profileId", "manifest"])
    || value.kind !== BROWSER_ARTIFACT.kind
    || value.destination !== BROWSER_ARTIFACT.destination
    || value.browserContract !== BROWSER_ARTIFACT.browserContract
    || value.profileId !== BROWSER_ARTIFACT.profileId
    || value.manifest !== BROWSER_ARTIFACT.manifest) throw new Error("invalid_browser_artifact_descriptor");
  return Object.freeze({ ...BROWSER_ARTIFACT });
}
function validateWindowsReparseInspector(value) {
  if (!exactKeys(value, ["kind", "destination", "helper", "manifest", "probeEvidence"])
    || Object.keys(WINDOWS_REPARSE_INSPECTOR).some((key) => value[key] !== WINDOWS_REPARSE_INSPECTOR[key]))
    throw new Error("invalid_windows_reparse_inspector_descriptor");
  return Object.freeze({ ...WINDOWS_REPARSE_INSPECTOR });
}
function validateWindowsStaleLockReclaimer(value) {
  if (!exactKeys(value, ["kind", "destination", "helper", "manifest"])
    || Object.keys(WINDOWS_STALE_LOCK_RECLAIMER).some((key) => value[key] !== WINDOWS_STALE_LOCK_RECLAIMER[key]))
    throw new Error("invalid_windows_stale_lock_reclaimer_descriptor");
  return Object.freeze({ ...WINDOWS_STALE_LOCK_RECLAIMER });
}
function canonicalWindowsReparseManifest(sha256) {
  return `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"GameBuddy.WindowsReparseInspector.exe","sha256":"${sha256}"}\n`;
}
function canonicalWindowsStaleLockReclaimerManifest(sha256) {
  return `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"GameBuddy.WindowsStaleLockReclaimer.exe","sha256":"${sha256}"}\n`;
}
/** Verifies construction provenance only. Current live probe evidence is owned
 * exclusively by the release gate process and cannot be supplied to this API. */
export async function verifyWindowsReparseInspectorPair({ root, descriptor = WINDOWS_REPARSE_INSPECTOR }) {
  const pairRoot = resolve(root, descriptor.destination.replaceAll("/", sep));
  const helper = resolve(pairRoot, descriptor.helper);
  const manifest = resolve(pairRoot, descriptor.manifest);
  try {
    await safeAncestors(root, pairRoot, "windows_reparse_inspector"); await directory(pairRoot, "windows_reparse_inspector");
    for (const [path, label] of [[helper, "windows_reparse_inspector_helper"], [manifest, "windows_reparse_inspector_manifest"]]) {
      await safeAncestors(pairRoot, path, label); await regular(path, label);
    }
    const helperSha256 = digest(await readFile(helper));
    if (await readFile(manifest, "utf8") !== canonicalWindowsReparseManifest(helperSha256)) throw new Error("manifest");
    return Object.freeze({ helperSha256, pairRoot, helper, manifest });
  } catch { throw new Error("windows_reparse_inspector_pair_invalid"); }
}

/** Verifies one fixed helper/manifest pair for the handle-bound stale-lock
 * reclaimer. The pair has no optional audit file: every file in the artifact
 * destination is a required construction-provenance fact. */
export async function verifyWindowsStaleLockReclaimerPair({ root, descriptor = WINDOWS_STALE_LOCK_RECLAIMER }) {
  const pairRoot = resolve(root, descriptor.destination.replaceAll("/", sep));
  const helper = resolve(pairRoot, descriptor.helper);
  const manifest = resolve(pairRoot, descriptor.manifest);
  try {
    await safeAncestors(root, pairRoot, "windows_stale_lock_reclaimer"); await directory(pairRoot, "windows_stale_lock_reclaimer");
    for (const [path, label] of [[helper, "windows_stale_lock_reclaimer_helper"], [manifest, "windows_stale_lock_reclaimer_manifest"]]) {
      await safeAncestors(pairRoot, path, label); await regular(path, label);
    }
    const helperSha256 = digest(await readFile(helper));
    if (await readFile(manifest, "utf8") !== canonicalWindowsStaleLockReclaimerManifest(helperSha256)) throw new Error("manifest");
    return Object.freeze({ helperSha256, pairRoot, helper, manifest });
  } catch { throw new Error("windows_stale_lock_reclaimer_pair_invalid"); }
}
function validateExternalClosure(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || value.kind !== "declared_external_runtime_closure"
    || !Array.isArray(value.packages) || value.packages.length === 0
    || !value.packages.every(declaredExternalPackage)
    || new Set(value.packages).size !== value.packages.length) throw new Error("invalid_declared_external_runtime_closure");
  const packages = [...value.packages].sort();
  if (value.dynamicExternalImports !== undefined && (!Array.isArray(value.dynamicExternalImports) || !value.dynamicExternalImports.every((rule) => declaredDynamicExternalImport(rule, packages)))) throw new Error("invalid_declared_external_runtime_closure");
  const dynamicExternalImports = (value.dynamicExternalImports ?? []).map((rule) => ({ package: rule.package, module: rule.module, expression: rule.expression, occurrence: rule.occurrence }));
  // Identical rules count call sites, so a module may publish and clear through
  // the same bridge. Different packages for one emitted module/expression are
  // ambiguous, however: the dynamic source cannot prove which package was used.
  const packageByTarget = new Map();
  const identities = new Set();
  for (const rule of dynamicExternalImports) {
    const target = dynamicExternalImportTargetKey(rule);
    const previous = packageByTarget.get(target);
    if (previous !== undefined && previous !== rule.package) throw new Error("invalid_declared_external_runtime_closure");
    packageByTarget.set(target, rule.package);
    const identity = dynamicExternalImportKey(rule);
    if (identities.has(identity)) throw new Error("invalid_declared_external_runtime_closure");
    identities.add(identity);
  }
  dynamicExternalImports.sort((left, right) => dynamicExternalImportKey(left).localeCompare(dynamicExternalImportKey(right)));
  return { kind: "declared_external_runtime_closure", packages, dynamicExternalImports };
}
export async function readArtifactConfig(hostRoot) {
  const config = JSON.parse(await readFile(resolve(hostRoot, "production-artifact.config.json"), "utf8"));
  const allowedKeys = ["schema", "entryRoots", "verificationRoots", "resources", "browserArtifact", "windowsReparseInspector", "windowsStaleLockReclaimer", "externalRuntimeClosure"];
  if (config === null || typeof config !== "object" || Array.isArray(config)
    || config.schema !== "gamebuddy-host-production-artifact-config/v2"
    || Object.keys(config).some((key) => !allowedKeys.includes(key))
    || !Object.hasOwn(config, "entryRoots") || !Object.hasOwn(config, "verificationRoots")
    || !Object.hasOwn(config, "resources") || !Object.hasOwn(config, "externalRuntimeClosure")
    || !Array.isArray(config.entryRoots) || config.entryRoots.length === 0
    || !config.entryRoots.every((entry) => configuredEntry(config.entryRoots, entry))
    || new Set(config.entryRoots).size !== config.entryRoots.length
    || !Array.isArray(config.resources)
    || !Array.isArray(config.verificationRoots)
    || !config.verificationRoots.every(configuredVerificationRoot)
    || JSON.stringify(config.verificationRoots) !== JSON.stringify(REQUIRED_VERIFICATION_ROOTS)
    || config.verificationRoots.some((root) => config.entryRoots.includes(root)))
    throw new Error("invalid_production_artifact_config");
  config.resources.forEach(validateResource);
  if (config.browserArtifact !== undefined) config.browserArtifact = validateBrowserArtifactDescriptor(config.browserArtifact);
  if (config.windowsReparseInspector !== undefined) config.windowsReparseInspector = validateWindowsReparseInspector(config.windowsReparseInspector);
  if (config.windowsStaleLockReclaimer !== undefined) config.windowsStaleLockReclaimer = validateWindowsStaleLockReclaimer(config.windowsStaleLockReclaimer);
  config.externalRuntimeClosure = validateExternalClosure(config.externalRuntimeClosure);
  return config;
}
async function files(root, prefix = "") {
  const entries = await readdir(resolve(root, prefix), { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const item = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = resolve(root, item); const state = await lstat(absolute);
    // This is link defense in depth, not Windows arbitrary-reparse protection;
    // design/42 remains an explicit release blocker.
    if (state.isSymbolicLink()) throw new Error(`artifact_contains_symbolic_link:${item}`);
    if (state.isDirectory()) result.push(...await files(root, item));
    else if (state.isFile()) result.push(item);
    else throw new Error(`artifact_contains_nonregular_entry:${item}`);
  }
  return result.sort();
}

/** Reject broad TypeScript emit: every JavaScript file must be statically
 * reachable from a configured production root. Resources enter only through
 * the explicit resource allowlist recorded in `origins`. */
export async function reachableProductionModules({ artifactRoot, artifactFiles, entryRoots }) {
  const artifactFileSet = new Set(artifactFiles);
  const reachable = new Set();
  const visit = async (module) => {
    if (reachable.has(module)) return;
    reachable.add(module);
    const ingress = lexicalModuleIngress(await readFile(resolve(artifactRoot, module), "utf8"));
    for (const specifier of ingress.staticSpecifiers) {
      if (specifier.startsWith(".")) await visit(artifactRelativeModule(artifactRoot, module, specifier, artifactFileSet));
    }
  };
  for (const entry of entryRoots) {
    if (!artifactFileSet.has(entry)) throw new Error(`production_entry_missing:${entry}`);
    await visit(entry);
  }
  return reachable;
}
async function verifyEntrypointClosure({ artifactRoot, artifactFiles, entryRoots, origins }) {
  const reachable = await reachableProductionModules({ artifactRoot, artifactFiles, entryRoots });
  for (const item of artifactFiles) {
    if (item === "production-inventory.json") continue;
    if (origins.has(slash(item))) continue;
    if (extname(item) === ".js") {
      if (!reachable.has(item)) throw new Error(`production_module_unreachable_from_entry_roots:${item}`);
    } else throw new Error(`production_file_not_allowlisted_resource:${item}`);
  }
}
function browserArtifactOrigin(descriptor) {
  return Object.freeze({
    kind: BROWSER_ARTIFACT.kind,
    browserContract: descriptor.browserContract,
    profileId: descriptor.profileId,
    manifest: descriptor.manifest,
    destination: descriptor.destination,
  });
}
export async function createBrowserArtifactSnapshot({ artifactRoot, descriptor }) {
  const root = resolve(artifactRoot, descriptor.destination.replaceAll("/", sep));
  await safeAncestors(artifactRoot, root, "production_browser_artifact");
  await directory(root, "production_browser_artifact");
  const manifestPath = resolve(root, descriptor.manifest);
  await safeAncestors(root, manifestPath, "production_browser_artifact_manifest");
  await regular(manifestPath, "production_browser_artifact_manifest");
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch { throw new Error("invalid_browser_artifact_manifest"); }
  if (!exactKeys(manifest, ["schemaVersion", "browserContract", "profileId", "entryHtml", "assets"])
    || manifest.schemaVersion !== 1 || manifest.browserContract !== descriptor.browserContract
    || manifest.profileId !== descriptor.profileId || manifest.entryHtml !== "index.html"
    || !Array.isArray(manifest.assets) || manifest.assets.length === 0) throw new Error("invalid_browser_artifact_manifest");
  const origin = browserArtifactOrigin(descriptor);
  const expected = new Set(["index.html", descriptor.manifest]);
  for (const asset of manifest.assets) {
    if (!exactKeys(asset, ["path", "sha256", "bytes", "mime"])
      || typeof asset.path !== "string" || !BROWSER_ARTIFACT_ASSET.test(asset.path)
      || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0
      || asset.mime !== BROWSER_ARTIFACT_MIMES.get(asset.path.slice(asset.path.lastIndexOf(".") + 1))
      || expected.has(asset.path)) throw new Error("invalid_browser_artifact_manifest");
    expected.add(asset.path);
    const assetPath = resolve(root, asset.path.replaceAll("/", sep));
    await safeAncestors(root, assetPath, "production_browser_artifact_asset");
    await regular(assetPath, "production_browser_artifact_asset");
    const content = await readFile(assetPath);
    if (content.length !== asset.bytes || digest(content) !== asset.sha256) throw new Error(`production_browser_artifact_asset_mismatch:${asset.path}`);
  }
  const actual = await files(root);
  if (actual.length !== expected.size || actual.some((path) => !expected.has(slash(path)))) throw new Error("production_browser_artifact_tree_mismatch");
  const origins = new Map();
  const entries = [];
  for (const path of actual) {
    const relativePath = slash(path);
    const artifactPath = `${descriptor.destination}/${relativePath}`;
    const state = await regular(resolve(root, path), "production_browser_artifact_snapshot");
    entries.push({ path: artifactPath, mode: (state.mode & 0o777).toString(8).padStart(3, "0"), sha256: digest(await readFile(resolve(root, path))) });
    origins.set(artifactPath, origin);
  }
  const snapshot = Object.freeze({
    schema: "gamebuddy-verified-tavern-browser-artifact-snapshot/v1",
    descriptor: Object.freeze({ ...descriptor }),
    entries: Object.freeze(entries),
    digest: digest(JSON.stringify({ descriptor, entries })),
  });
  return Object.freeze({ origins, snapshot });
}
async function verifyBrowserArtifactSnapshot({ artifactRoot, descriptor, snapshot }) {
  if (snapshot === undefined) return createBrowserArtifactSnapshot({ artifactRoot, descriptor });
  if (snapshot === null || typeof snapshot !== "object" || snapshot.schema !== "gamebuddy-verified-tavern-browser-artifact-snapshot/v1"
    || JSON.stringify(snapshot.descriptor) !== JSON.stringify(descriptor)
    || !Array.isArray(snapshot.entries) || typeof snapshot.digest !== "string"
    || snapshot.digest !== digest(JSON.stringify({ descriptor: snapshot.descriptor, entries: snapshot.entries }))) {
    throw new Error("invalid_browser_artifact_snapshot");
  }
  const current = await createBrowserArtifactSnapshot({ artifactRoot, descriptor });
  if (current.snapshot.digest !== snapshot.digest || JSON.stringify(current.snapshot.entries) !== JSON.stringify(snapshot.entries))
    throw new Error("production_browser_artifact_snapshot_mismatch");
  return current;
}
function rejectBrowserArtifactOutsideFixedSubtree(artifactFiles, descriptor) {
  for (const item of artifactFiles) {
    const path = slash(item);
    if (path.startsWith("browser/") && !path.startsWith(`${descriptor.destination}/`))
      throw new Error(`production_browser_artifact_outside_fixed_subtree:${path}`);
  }
}
function windowsReparseInspectorOrigin(descriptor, helperSha256) {
  return Object.freeze({ kind: descriptor.kind, destination: descriptor.destination, helper: descriptor.helper, manifest: descriptor.manifest, helperSha256 });
}
function windowsStaleLockReclaimerOrigin(descriptor, helperSha256) {
  return Object.freeze({ kind: descriptor.kind, destination: descriptor.destination, helper: descriptor.helper, manifest: descriptor.manifest, helperSha256 });
}
function windowsReparseAuditOrigin(descriptor) {
  return Object.freeze({ kind: "passive_windows_reparse_live_gate_audit", destination: descriptor.destination, audit: descriptor.probeEvidence });
}
async function verifiedWindowsReparseInspectorOrigins({ stagingRoot, descriptor }) {
  const verified = await verifyWindowsReparseInspectorPair({ root: stagingRoot, descriptor });
  const origin = windowsReparseInspectorOrigin(descriptor, verified.helperSha256);
  const origins = new Map([...[descriptor.helper, descriptor.manifest].map((name) => [`${descriptor.destination}/${name}`, origin])]);
  const audit = resolve(verified.pairRoot, descriptor.probeEvidence);
  try {
    await safeAncestors(verified.pairRoot, audit, "windows_reparse_inspector_audit"); await regular(audit, "windows_reparse_inspector_audit");
    origins.set(`${descriptor.destination}/${descriptor.probeEvidence}`, windowsReparseAuditOrigin(descriptor));
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  return origins;
}

/** The fixed repository publication of the locked build script is the only
 * source the artifact pipeline copies the reclaimer pair from. There is no
 * runtime or pipeline fallback: a missing or tampered source pair fails the
 * publication closed. */
async function ensureWindowsStaleLockReclaimerPair({ hostRoot, stagingRoot, descriptor }) {
  const buildPairRoot = resolve(hostRoot, "native", "windows-stale-lock-reclaimer", ".dist", "win-x64");
  const source = await verifyWindowsStaleLockReclaimerPair({
    root: resolve(buildPairRoot, ".."),
    descriptor: { ...descriptor, destination: "win-x64" },
  });
  const destinationRoot = resolve(stagingRoot, descriptor.destination.replaceAll("/", sep));
  for (const name of [descriptor.helper, descriptor.manifest]) {
    const destination = resolve(destinationRoot, name);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(source.pairRoot, name), destination);
    await safeAncestors(stagingRoot, destination, "windows_stale_lock_reclaimer_destination");
    await regular(destination, "windows_stale_lock_reclaimer_destination");
  }
  return await verifyWindowsStaleLockReclaimerPair({ root: stagingRoot, descriptor });
}

async function verifiedWindowsStaleLockReclaimerOrigins({ stagingRoot, descriptor }) {
  const verified = await verifyWindowsStaleLockReclaimerPair({ root: stagingRoot, descriptor });
  const origin = windowsStaleLockReclaimerOrigin(descriptor, verified.helperSha256);
  return new Map([...[descriptor.helper, descriptor.manifest].map((name) => [`${descriptor.destination}/${name}`, origin])]);
}
function rejectUnverifiedBrowserArtifactFiles(artifactFiles, origins) {
  for (const item of artifactFiles) {
    const path = slash(item);
    if (path.startsWith("browser/") && origins.get(path)?.kind !== BROWSER_ARTIFACT.kind)
      throw new Error(`production_browser_artifact_outside_fixed_subtree:${path}`);
  }
}
export async function createInventory({ artifactRoot, origins = new Map(), externalRuntimeClosure, hostRoot, entryRoots, browserArtifactSnapshot, browserArtifactDescriptor }) {
  const artifactFiles = await files(artifactRoot);
  if (browserArtifactDescriptor !== undefined) {
    rejectBrowserArtifactOutsideFixedSubtree(artifactFiles, browserArtifactDescriptor);
    await verifyBrowserArtifactSnapshot({ artifactRoot, descriptor: browserArtifactDescriptor, snapshot: browserArtifactSnapshot });
  }
  rejectUnverifiedBrowserArtifactFiles(artifactFiles, origins);
  for (const item of artifactFiles) {
    const emittedModule = slash(item);
    if (forbiddenLegacyContinuityModule(emittedModule))
      throw new Error(`production_legacy_continuity_module_forbidden:${emittedModule}`);
  }
  if (entryRoots !== undefined) await verifyEntrypointClosure({ artifactRoot, artifactFiles, entryRoots, origins });
  const entries = [];
  for (const item of artifactFiles) {
    if (item === "production-inventory.json") continue;
    // `files` has rejected traversal and symbolic links; normalize only its
    // canonical relative path before exact membership checking. Windows
    // arbitrary-reparse enforcement remains blocked by design/42.
    const emittedModule = slash(item);
    if (forbiddenLegacyContinuityModule(emittedModule))
      throw new Error(`production_legacy_continuity_module_forbidden:${emittedModule}`);
    if (TEST_ARTIFACT.test(emittedModule)) throw new Error(`production_test_artifact_forbidden:${emittedModule}`);
    const absolute = resolve(artifactRoot, item); const state = await regular(absolute, "artifact");
    entries.push({ path: slash(item), type: "file", mode: (state.mode & 0o777).toString(8).padStart(3, "0"), sha256: digest(await readFile(absolute)), origin: origins.get(slash(item)) ?? { kind: "typescript_emit" } });
  }
  const closure = await verifyExternalRuntimeClosure({ artifactRoot, hostRoot, externalRuntimeClosure, origins });
  const canonical = JSON.stringify({ entries, externalRuntimeClosure: closure });
  return { schema: "gamebuddy-host-production-inventory/v4", entries, externalRuntimeClosure: closure, digest: digest(canonical) };
}
export async function verifyArtifact({ artifactRoot, hostRoot, config, expectedInventory, origins = new Map(), browserArtifactSnapshot }) {
  const verifiedOrigins = new Map(origins);
  if (config.browserArtifact !== undefined)
    rejectBrowserArtifactOutsideFixedSubtree(await files(artifactRoot), config.browserArtifact);
  let verifiedBrowserArtifactSnapshot;
  if (config.browserArtifact !== undefined) {
    const verifiedBrowser = await verifyBrowserArtifactSnapshot({ artifactRoot, descriptor: config.browserArtifact, snapshot: browserArtifactSnapshot });
    verifiedBrowserArtifactSnapshot = verifiedBrowser.snapshot;
    for (const [path, origin] of verifiedBrowser.origins) {
      const supplied = verifiedOrigins.get(path);
      if (supplied !== undefined && JSON.stringify(supplied) !== JSON.stringify(origin)) throw new Error(`production_browser_artifact_origin_mismatch:${path}`);
      verifiedOrigins.set(path, origin);
    }
  }
  const inventory = await createInventory({ artifactRoot, hostRoot, origins: verifiedOrigins, entryRoots: allVerificationRoots(config), externalRuntimeClosure: config.externalRuntimeClosure, browserArtifactSnapshot: verifiedBrowserArtifactSnapshot, browserArtifactDescriptor: config.browserArtifact });
  for (const entry of config.entryRoots) if (!inventory.entries.some((item) => item.path === entry)) throw new Error(`production_entry_missing:${entry}`);
  if (JSON.stringify(inventory) !== JSON.stringify(expectedInventory ?? inventory)) throw new Error("production_inventory_mismatch_or_orphan");
  return inventory;
}

/** Parse every emitted production module's static import/export-from/require closure.
 * Dynamic module ingress is deliberately rejected; the only reviewed dynamic
 * vendor access resolves the declared @cortexkit package through import.meta. */
const ESM_RESOLUTION_PROBE_TIMEOUT_MS = 5_000;
const ESM_RESOLUTION_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
const esmResolutionProbePath = (scriptPath = fileURLToPath(import.meta.url)) => resolve(dirname(scriptPath), "production-artifact-esm-resolution-probe.mjs");
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactOwnKeys = (value, keys) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};
export function parseEsmResolutionProbeResult(output, specifiers) {
  const result = JSON.parse(output);
  if (!plainObject(result) || !exactOwnKeys(result, ["schema", "resolved"])
    || result.schema !== "gamebuddy-production-esm-resolution/v1"
    || !Array.isArray(result.resolved) || result.resolved.length !== specifiers.length
    || !result.resolved.every((entry, index) => Array.isArray(entry) && entry.length === 2
      && typeof entry[0] === "string" && entry[0] === specifiers[index] && typeof entry[1] === "string")) {
    throw new Error("invalid_esm_probe_result");
  }
  return result.resolved;
}
function esmResolutionProbeEnvironment(inherited = process.env) {
  const path = inherited.PATH ?? inherited.Path;
  if (typeof path !== "string" || path.length === 0) throw new Error("esm_probe_path_missing");
  const environment = { PATH: path, LANG: "C", LC_ALL: "C" };
  // Windows' cryptographic RNG needs its canonical case-sensitive names in
  // the restricted child environment. Preserve only these OS bootstrap paths;
  // user Pi/agent settings, credentials, and runtime configuration remain
  // deliberately absent from the resolution probe.
  for (const key of ["SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "WINDIR"])
    if (typeof inherited[key] === "string" && inherited[key].length > 0) environment[key] = inherited[key];
  return environment;
}
async function runEsmResolutionProbe(hostRoot, specifiers) {
  const probePath = esmResolutionProbePath();
  await regular(probePath, "production_runtime_esm_probe");
  const stdout = []; const stderr = []; let stdoutBytes = 0; let stderrBytes = 0;
  return new Promise((resolveProbe, rejectProbe) => {
    let child; let exit; let failure;
    const fail = (error) => { failure ??= error; if (child?.pid !== undefined) child.kill(); };
    try {
      child = spawn(process.execPath, ["--experimental-import-meta-resolve", probePath, hostRoot, ...specifiers], {
        cwd: dirname(probePath), env: esmResolutionProbeEnvironment(), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) { rejectProbe(error); return; }
    const deadline = setTimeout(() => fail(new Error("esm_probe_timeout")), ESM_RESOLUTION_PROBE_TIMEOUT_MS);
    const capture = (target, chunk) => {
      const bytes = Buffer.byteLength(chunk);
      if (target === stdout) stdoutBytes += bytes; else stderrBytes += bytes;
      if (stdoutBytes > ESM_RESOLUTION_PROBE_MAX_OUTPUT_BYTES || stderrBytes > ESM_RESOLUTION_PROBE_MAX_OUTPUT_BYTES) fail(new Error("esm_probe_output_too_large"));
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk) => capture(stdout, chunk)); child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => { failure ??= error; });
    child.once("exit", (code, signal) => { exit = { code, signal }; });
    child.once("close", () => {
      clearTimeout(deadline);
      if (failure || exit === undefined || exit.code !== 0 || exit.signal !== null || stderrBytes !== 0) { rejectProbe(failure ?? new Error("esm_probe_failed")); return; }
      try { resolveProbe(parseEsmResolutionProbeResult(Buffer.concat(stdout).toString("utf8"), specifiers)); }
      catch (error) { rejectProbe(error); }
    });
  });
}

export async function verifyExternalRuntimeClosure({ artifactRoot, hostRoot, externalRuntimeClosure, origins = new Map() }) {
  const declared = validateExternalClosure(externalRuntimeClosure);
  const used = new Set();
  const staticExternalSpecifiers = new Set();
  const artifactFiles = await files(artifactRoot);
  const artifactFileSet = new Set(artifactFiles);
  for (const rule of declared.dynamicExternalImports) {
    if (!artifactFileSet.has(rule.module)) throw new Error(`production_dynamic_external_module_missing:${rule.module}`);
  }
  for (const item of artifactFiles) {
    if (origins.get(slash(item))?.kind === BROWSER_ARTIFACT.kind) continue;
    if (extname(item) !== ".js") continue;
    const content = await readFile(resolve(artifactRoot, item), "utf8");
    let ingress;
    try { ingress = lexicalModuleIngress(content); } catch (error) { throw new Error(`production_module_lexical_parse_failed:${item}:${error.message}`); }
    if (ingress.processBuiltinModuleIngresses.length > 0) throw new Error(`production_process_get_builtin_module_ingress_forbidden:${item}`);
    const permittedDynamic = declared.dynamicExternalImports.filter((rule) => rule.module === item);
    const consumedDynamic = new Set();
    const occurrences = new Map();
    if (permittedDynamic.length === 0 && ingress.dynamicCalls.length > 0) throw new Error(`production_dynamic_module_ingress_forbidden:${item}`);
    if (ingress.dynamicCalls.length !== permittedDynamic.length) throw new Error(`production_dynamic_module_ingress_rule_bijection_failed:${item}`);
    for (const call of ingress.dynamicCalls) {
      const target = `${item}:${call.expression}`;
      const occurrence = occurrences.get(target) ?? 0;
      occurrences.set(target, occurrence + 1);
      const ruleIndex = permittedDynamic.findIndex((rule, index) => !consumedDynamic.has(index)
        && call.kind === "import" && rule.module === item && rule.expression === call.expression && rule.occurrence === occurrence);
      if (ruleIndex < 0) throw new Error(`production_dynamic_module_ingress_forbidden:${item}`);
      consumedDynamic.add(ruleIndex);
      used.add(permittedDynamic[ruleIndex].package);
    }
    if (consumedDynamic.size !== permittedDynamic.length) throw new Error(`production_dynamic_module_ingress_rule_bijection_failed:${item}`);
    for (const specifier of ingress.staticSpecifiers) {
      if (moduleLoaderIngress(specifier)) throw new Error(`production_module_loader_ingress_forbidden:${item}:${specifier}`);
      if (nodeBuiltin(specifier)) continue;
      if (specifier.startsWith(".")) {
        artifactRelativeModule(artifactRoot, item, specifier, artifactFileSet);
        continue;
      }
      if (specifier.startsWith("/") || specifier.startsWith("file:")) throw new Error(`production_absolute_module_ingress_forbidden:${item}:${specifier}`);
      const name = packageName(specifier);
      if (!declared.packages.includes(name)) throw new Error(`production_external_package_unlisted:${name}:${item}`);
      used.add(name);
      staticExternalSpecifiers.add(specifier);
    }
  }
  // The fixed repository-owned probe uses Node's explicit experimental
  // parent-URL form to apply the Host-root ESM `import` export condition,
  // without executing or creating a mutable Host-root module.
  const runtimeHostRoot = hostRoot ?? artifactRoot;
  const runtimePackageJsonPath = resolve(runtimeHostRoot, "package.json");
  const runtimeNodeModules = resolve(runtimeHostRoot, "node_modules");
  let runtimePackageJson;
  try {
    await directory(runtimeHostRoot, "production_runtime_host_root");
    await safeAncestors(runtimeHostRoot, runtimePackageJsonPath, "production_runtime_package_manifest");
    await regular(runtimePackageJsonPath, "production_runtime_package_manifest");
    await directory(runtimeNodeModules, "production_runtime_node_modules");
    runtimePackageJson = JSON.parse(await readFile(runtimePackageJsonPath, "utf8"));
    if (runtimePackageJson === null || typeof runtimePackageJson !== "object" || Array.isArray(runtimePackageJson)) throw new Error("invalid_runtime_package_manifest");
  } catch { throw new Error("production_runtime_package_manifest_unresolvable"); }
  for (const name of declared.packages) {
    if (!used.has(name)) throw new Error(`production_external_package_unused:${name}`);
    if (runtimePackageJson.dependencies?.[name] === undefined) throw new Error(`production_external_package_unresolvable:${name}`);
  }
  // Check every Host-visible package path before asking Node to inspect package
  // manifests during ESM resolution. A scoped namespace is an ancestor, not a
  // package link, so it must never be a symbolic link. This does not claim
  // arbitrary Windows-reparse protection (design/42 remains open).
  try {
    await safeAncestors(runtimeHostRoot, runtimeNodeModules, "production_runtime_node_modules");
    for (const name of declared.packages) {
      const packageLink = resolve(runtimeNodeModules, ...name.split("/"));
      await safeAncestors(runtimeNodeModules, dirname(packageLink), "production_external_package_ancestors");
      const linkState = await lstat(packageLink);
      if (!linkState.isDirectory() && !linkState.isSymbolicLink()) throw new Error("invalid_external_package_link");
      if (linkState.isDirectory()) await safeAncestors(runtimeNodeModules, packageLink, "production_external_package_root");
    }
  } catch { for (const name of declared.packages) throw new Error(`production_external_package_unresolvable:${name}`); }
  const probeSpecifiers = [...new Set([...staticExternalSpecifiers, ...declared.packages])].sort();
  let resolved;
  try { resolved = await runEsmResolutionProbe(runtimeHostRoot, probeSpecifiers); }
  catch { for (const name of declared.packages) throw new Error(`production_external_package_unresolvable:${name}`); }
  for (const [specifier, resolvedUrl] of resolved) {
    const name = packageName(specifier);
    try {
      const url = new URL(resolvedUrl);
      if (url.protocol !== "file:" || url.search || url.hash) throw new Error("invalid_resolved_url");
      const packageLink = resolve(runtimeNodeModules, ...name.split("/"));
      const entryPath = fileURLToPath(url);
      await safeAncestors(runtimeHostRoot, runtimeNodeModules, "production_runtime_node_modules");
      await safeAncestors(runtimeNodeModules, dirname(packageLink), "production_external_package_ancestors");
      const linkState = await lstat(packageLink);
      if (!linkState.isDirectory() && !linkState.isSymbolicLink()) throw new Error("invalid_external_package_link");
      const packageRoot = linkState.isSymbolicLink() ? await realpath(packageLink) : packageLink;
      if (linkState.isSymbolicLink()) {
        // pnpm exposes a dependency via one direct Host-visible leaf link.
        // Support its immutable store and explicitly declared workspaces only;
        // arbitrary node_modules links remain rejected.
        const workspaceRoot = resolve(runtimeHostRoot, "..");
        const pnpmStore = resolve(workspaceRoot, "node_modules", ".pnpm");
        const dependencyRange = runtimePackageJson.dependencies?.[name];
        const insidePnpmStore = inside(pnpmStore, packageRoot);
        const declaredWorkspacePackage = dependencyRange === "workspace:*" && inside(workspaceRoot, packageRoot);
        if (!insidePnpmStore && !declaredWorkspacePackage) throw new Error("invalid_external_package_link");
      }
      await directory(packageRoot, "production_external_package_root");
      const packageJsonPath = resolve(packageRoot, "package.json");
      await safeAncestors(packageRoot, packageJsonPath, "production_external_package_manifest");
      await regular(packageJsonPath, "production_external_package_manifest");
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
      if (packageJson === null || typeof packageJson !== "object" || Array.isArray(packageJson) || packageJson.name !== name) throw new Error("invalid_external_package_manifest");
      if (!inside(packageRoot, entryPath)) throw new Error("resolved_entry_escapes_package");
      await safeAncestors(packageRoot, entryPath, "production_external_package_entry");
      await regular(entryPath, "production_external_package_entry");
    } catch { throw new Error(`production_external_package_unresolvable:${name}`); }
  }
  return Object.freeze({ kind: declared.kind, packages: declared.packages, dynamicExternalImports: declared.dynamicExternalImports, verifiedPackages: [...used].sort() });
}
export async function copyApprovedResources({ hostRoot, stagingRoot, config }) {
  const origins = new Map();
  for (const resource of config.resources) {
    validateResource(resource); // before any source lstat/read/copy
    const source = resolve(hostRoot, resource.source); const destination = resolve(stagingRoot, resource.destination);
    await safeAncestors(hostRoot, source, "resource_source"); await regular(source, "resource_source");
    await mkdir(dirname(destination), { recursive: true }); await safeAncestors(stagingRoot, dirname(destination), "resource_destination");
    await copyFile(source, destination); await safeAncestors(stagingRoot, destination, "resource_destination"); await regular(destination, "resource_destination");
    if (digest(await readFile(source)) !== digest(await readFile(destination))) throw new Error(`resource_hash_mismatch:${resource.destination}`);
    origins.set(slash(resource.destination), { kind: "allowlisted_resource", source: slash(resource.source), destination: slash(resource.destination), config: "production-artifact.config.json" });
  }
  return origins;
}
async function ensureOutputRoot(outputRoot) {
  await mkdir(outputRoot, { recursive: true });
  const state = await lstat(outputRoot);
  if (state.isSymbolicLink() || !state.isDirectory()) throw new Error("production_output_root_invalid");
}
async function acquirePublisherLock(outputRoot) {
  const path = resolve(outputRoot, PUBLISHER_LOCK); const deadline = Date.now() + PUBLISHER_LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ schema: "gamebuddy-host-production-publisher-lock/v1", pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
      return async () => { await handle.close(); await unlink(path); };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // There is deliberately no stale-owner reclamation: without an exact OS
      // owner proof, reclaim could overlap a publisher that still owns current.
      if (Date.now() >= deadline) throw new Error("production_publisher_lock_timeout_manual_remediation_required");
      await new Promise((resolve) => setTimeout(resolve, PUBLISHER_LOCK_RETRY_MS));
    }
  }
}
async function currentGeneration(outputRoot) {
  const pointerPath = resolve(outputRoot, POINTER); await safeAncestors(outputRoot, pointerPath, "production_pointer"); await regular(pointerPath, "production_pointer");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  if (typeof pointer.generation !== "string" || !/^[a-z0-9-]+$/i.test(pointer.generation)) throw new Error("invalid_production_current_pointer");
  return pointer;
}
async function generationRoot(outputRoot, generation) {
  const root = resolve(outputRoot, GENERATIONS, generation); await safeAncestors(outputRoot, root, "production_generation");
  const state = await lstat(root); if (state.isSymbolicLink() || !state.isDirectory()) throw new Error("invalid_production_generation"); return root;
}
async function assertOutputRootLayout(outputRoot) {
  const entries = await readdir(outputRoot);
  if (entries.some((entry) => entry !== GENERATIONS && entry !== POINTER && entry !== PUBLISHER_LOCK)) throw new Error("production_output_root_contains_direct_artifact");
}
export async function publishProductionArtifact({ hostRoot, emittedRoot, outputRoot }) {
  const config = await readArtifactConfig(hostRoot); const generation = `g-${Date.now().toString(36)}-${process.pid}-${randomUUID().replaceAll("-", "")}`;
  await ensureOutputRoot(outputRoot);
  const releaseLock = await acquirePublisherLock(outputRoot);
  const stagingRoot = resolve(outputRoot, GENERATIONS, `.staging-${generation}`); const finalRoot = resolve(outputRoot, GENERATIONS, generation); const pointerStaging = resolve(outputRoot, `.current-${generation}.json`);
  try {
    await access(emittedRoot); await assertOutputRootLayout(outputRoot); await mkdir(resolve(outputRoot, GENERATIONS), { recursive: true });
    await rm(stagingRoot, { recursive: true, force: true }); await mkdir(stagingRoot);
    for (const item of await files(emittedRoot)) {
      if (TEST_ARTIFACT.test(item)) throw new Error(`production_test_artifact_forbidden:${item}`);
      const source = resolve(emittedRoot, item); const destination = resolve(stagingRoot, item); await regular(source, "emitted_source"); await mkdir(dirname(destination), { recursive: true }); await copyFile(source, destination);
    }
    const origins = await copyApprovedResources({ hostRoot, stagingRoot, config });
    if (process.platform === "win32" && config.windowsReparseInspector !== undefined) {
      for (const [path, origin] of await verifiedWindowsReparseInspectorOrigins({ stagingRoot, descriptor: config.windowsReparseInspector })) origins.set(path, origin);
    }
    if (process.platform === "win32" && config.windowsStaleLockReclaimer !== undefined) {
      // Copy the exact fixed build pair into the artifact first, then verify it
      // in place; every later recheck verifies only the published copy.
      await ensureWindowsStaleLockReclaimerPair({ hostRoot, stagingRoot, descriptor: config.windowsStaleLockReclaimer });
      for (const [path, origin] of await verifiedWindowsStaleLockReclaimerOrigins({ stagingRoot, descriptor: config.windowsStaleLockReclaimer })) origins.set(path, origin);
    }
    // Freeze the browser descriptor's checked bytes before inventory creation;
    // a final exact-snapshot verification below closes the remaining
    // pre-publish mutation window as far as this pathname-based architecture permits.
    const browserArtifactSnapshot = config.browserArtifact === undefined ? undefined
      : (await createBrowserArtifactSnapshot({ artifactRoot: stagingRoot, descriptor: config.browserArtifact })).snapshot;
    const inventory = await verifyArtifact({ artifactRoot: stagingRoot, hostRoot, config, origins, browserArtifactSnapshot });
    await writeFile(resolve(stagingRoot, "production-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
    await verifyArtifact({ artifactRoot: stagingRoot, hostRoot, config, expectedInventory: inventory, origins, browserArtifactSnapshot });
    await rename(stagingRoot, finalRoot); // immutable generation becomes visible before current changes
    await writeFile(pointerStaging, `${JSON.stringify({ schema: "gamebuddy-host-production-current/v1", generation, inventoryDigest: inventory.digest })}\n`);
    await rename(pointerStaging, resolve(outputRoot, POINTER));
    return { ...inventory, generation };
  } catch (error) { await rm(stagingRoot, { recursive: true, force: true }); await rm(pointerStaging, { force: true }); throw error; }
  finally { await releaseLock(); }
}
export async function assertCompleteProductionArtifact({ hostRoot, outputRoot }) {
  await assertOutputRootLayout(outputRoot);
  const config = await readArtifactConfig(hostRoot); const pointer = await currentGeneration(outputRoot); const artifactRoot = await generationRoot(outputRoot, pointer.generation);
  const manifest = JSON.parse(await readFile(resolve(artifactRoot, "production-inventory.json"), "utf8"));
  const origins = new Map(config.resources.map((resource) => [slash(resource.destination), { kind: "allowlisted_resource", source: slash(resource.source), destination: slash(resource.destination), config: "production-artifact.config.json" }]));
  if (process.platform === "win32" && config.windowsReparseInspector !== undefined) {
    for (const [path, origin] of await verifiedWindowsReparseInspectorOrigins({ stagingRoot: artifactRoot, descriptor: config.windowsReparseInspector })) origins.set(path, origin);
  }
  if (process.platform === "win32" && config.windowsStaleLockReclaimer !== undefined) {
    for (const [path, origin] of await verifiedWindowsStaleLockReclaimerOrigins({ stagingRoot: artifactRoot, descriptor: config.windowsStaleLockReclaimer })) origins.set(path, origin);
  }
  const inventory = await verifyArtifact({ artifactRoot, hostRoot, config, expectedInventory: manifest, origins });
  if (pointer.inventoryDigest !== inventory.digest) throw new Error("production_current_pointer_inventory_mismatch");
  return { ...inventory, generation: pointer.generation, artifactRoot };
}
export async function resolveProductionEntry({ hostRoot, outputRoot, entry }) {
  const config = await readArtifactConfig(hostRoot); if (!configuredEntry(config.entryRoots, entry)) throw new Error("production_entry_not_configured");
  const verified = await assertCompleteProductionArtifact({ hostRoot, outputRoot }); const entryPath = resolve(verified.artifactRoot, entry);
  await safeAncestors(verified.artifactRoot, entryPath, "production_entry"); await regular(entryPath, "production_entry");
  return { ...verified, entryPath };
}
/** Resolves a regular emitted module from one already-verified immutable
 * generation. Runners must use this instead of importing the mutable `dist/`
 * root or reconstructing paths from `current.json`. */
export async function resolveProductionModule({ selected, module }) {
  if (typeof module !== "string" || !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.js$/.test(module))
    throw new Error("production_module_not_configured");
  const modulePath = resolve(selected.artifactRoot, module.replaceAll("/", sep));
  if (!inside(selected.artifactRoot, modulePath) || modulePath === selected.artifactRoot)
    throw new Error("production_module_escapes_generation");
  const manifest = JSON.parse(await readFile(resolve(selected.artifactRoot, "production-inventory.json"), "utf8"));
  const inventoryEntry = Array.isArray(manifest.entries)
    ? manifest.entries.find((entry) => entry?.path === module)
    : undefined;
  if (inventoryEntry?.type !== "file" || typeof inventoryEntry.sha256 !== "string")
    throw new Error("production_module_missing_from_inventory");
  await safeAncestors(selected.artifactRoot, modulePath, "production_module");
  await regular(modulePath, "production_module");
  if (digest(await readFile(modulePath)) !== inventoryEntry.sha256)
    throw new Error("production_module_integrity_mismatch");
  if (TEST_ARTIFACT.test(module)) throw new Error("production_module_test_artifact_forbidden");
  return { ...selected, module, modulePath };
}
export async function recheckProductionEntry({ hostRoot, selected }) {
  const config = await readArtifactConfig(hostRoot);
  const origins = new Map(config.resources.map((resource) => [slash(resource.destination), { kind: "allowlisted_resource", source: slash(resource.source), destination: slash(resource.destination), config: "production-artifact.config.json" }]));
  if (process.platform === "win32" && config.windowsReparseInspector !== undefined) {
    for (const [path, origin] of await verifiedWindowsReparseInspectorOrigins({ stagingRoot: selected.artifactRoot, descriptor: config.windowsReparseInspector })) origins.set(path, origin);
  }
  if (process.platform === "win32" && config.windowsStaleLockReclaimer !== undefined) {
    for (const [path, origin] of await verifiedWindowsStaleLockReclaimerOrigins({ stagingRoot: selected.artifactRoot, descriptor: config.windowsStaleLockReclaimer })) origins.set(path, origin);
  }
  const manifest = JSON.parse(await readFile(resolve(selected.artifactRoot, "production-inventory.json"), "utf8"));
  const inventory = await verifyArtifact({ artifactRoot: selected.artifactRoot, hostRoot, config, expectedInventory: manifest, origins });
  if (inventory.digest !== selected.digest) throw new Error("production_selected_generation_integrity_mismatch");
  await safeAncestors(selected.artifactRoot, selected.entryPath, "production_entry"); await regular(selected.entryPath, "production_entry");
  return selected;
}
