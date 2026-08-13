import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

const TEST_ARTIFACT = /(?:^|\/)(?:[^/]*\.(?:test|test-support)(?:\.[^/]+)?|test-fixtures|[^/]*(?:physical-)?fixture-worker[^/]*)(?:\/|$)|legacy-writer-fixture/i;
const POINTER = "current.json";
const GENERATIONS = "generations";
const PUBLISHER_LOCK = ".publisher.lock";
const PUBLISHER_LOCK_WAIT_MS = 5_000;
const PUBLISHER_LOCK_RETRY_MS = 50;
const slash = (path) => path.replaceAll("\\", "/");
const inside = (root, path) => { const value = relative(root, path); return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value)); };
const digest = (content) => createHash("sha256").update(content).digest("hex");
const configuredEntry = (entryRoots, entry) => typeof entry === "string" && entryRoots.includes(entry) && basename(entry) === entry && !entry.includes("/") && !entry.includes("\\") && !entry.includes("..");
const declaredExternalPackage = (value) => typeof value === "string" && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(value);
const packageName = (specifier) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
const nodeBuiltin = (specifier) => specifier.startsWith("node:");
const dynamicExternalImportKey = (rule) => `${rule.package}:${rule.module}:${rule.expression}:${rule.occurrence}`;
const dynamicExternalImportTargetKey = (rule) => `${rule.module}:${rule.expression}`;
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
  const staticSpecifiers = []; const dynamicCalls = [];
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
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { staticSpecifiers, dynamicCalls };
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
async function safeAncestors(root, target, label) {
  if (!inside(root, target)) throw new Error(`${label}_escapes_root:${target}`);
  let cursor = root;
  for (const item of relative(root, target).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, item);
    const state = await lstat(cursor);
    if (state.isSymbolicLink()) throw new Error(`${label}_contains_symlink_or_reparse_point:${cursor}`);
    if (cursor !== target && !state.isDirectory()) throw new Error(`${label}_ancestor_not_directory:${cursor}`);
  }
}
function validateResource(resource) {
  if (resource === null || typeof resource !== "object" || typeof resource.source !== "string" || typeof resource.destination !== "string") throw new Error("resource_not_allowlisted");
  // Validate the declared source before resolving or touching it. Production has
  // one intentionally reviewed resource; test/fixture/legacy names never enter I/O.
  if (TEST_ARTIFACT.test(slash(resource.source)) || /(?:test|fixture|legacy)/i.test(resource.source)) throw new Error("production_resource_source_forbidden");
  if (resource.source !== "resources/windows-named-mutex-broker.ps1" || resource.destination !== "windows-named-mutex-broker.ps1") throw new Error("resource_not_allowlisted");
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
  if (!Array.isArray(config.entryRoots) || config.entryRoots.length === 0 || !config.entryRoots.every((entry) => configuredEntry(config.entryRoots, entry)) || new Set(config.entryRoots).size !== config.entryRoots.length || !Array.isArray(config.resources)) throw new Error("invalid_production_artifact_config");
  config.resources.forEach(validateResource);
  config.externalRuntimeClosure = validateExternalClosure(config.externalRuntimeClosure);
  return config;
}
async function files(root, prefix = "") {
  const entries = await readdir(resolve(root, prefix), { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const item = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = resolve(root, item); const state = await lstat(absolute);
    if (state.isSymbolicLink()) throw new Error(`artifact_contains_symlink_or_reparse_point:${item}`);
    if (state.isDirectory()) result.push(...await files(root, item));
    else if (state.isFile()) result.push(item);
    else throw new Error(`artifact_contains_nonregular_entry:${item}`);
  }
  return result.sort();
}
export async function createInventory({ artifactRoot, origins = new Map(), externalRuntimeClosure, hostRoot }) {
  const entries = [];
  for (const item of await files(artifactRoot)) {
    if (item === "production-inventory.json") continue;
    if (TEST_ARTIFACT.test(item)) throw new Error(`production_test_artifact_forbidden:${item}`);
    const absolute = resolve(artifactRoot, item); const state = await regular(absolute, "artifact");
    entries.push({ path: slash(item), type: "file", mode: (state.mode & 0o777).toString(8).padStart(3, "0"), sha256: digest(await readFile(absolute)), origin: origins.get(slash(item)) ?? { kind: "typescript_emit" } });
  }
  const closure = await verifyExternalRuntimeClosure({ artifactRoot, hostRoot, externalRuntimeClosure });
  const canonical = JSON.stringify({ entries, externalRuntimeClosure: closure });
  return { schema: "gamebuddy-host-production-inventory/v4", entries, externalRuntimeClosure: closure, digest: digest(canonical) };
}
export async function verifyArtifact({ artifactRoot, hostRoot, config, expectedInventory, origins }) {
  const inventory = await createInventory({ artifactRoot, hostRoot, origins, externalRuntimeClosure: config.externalRuntimeClosure });
  for (const entry of config.entryRoots) if (!inventory.entries.some((item) => item.path === entry)) throw new Error(`production_entry_missing:${entry}`);
  if (JSON.stringify(inventory) !== JSON.stringify(expectedInventory ?? inventory)) throw new Error("production_inventory_mismatch_or_orphan");
  return inventory;
}

/** Parse every emitted production module's static import/export-from/require closure.
 * Dynamic module ingress is deliberately rejected; the only reviewed dynamic
 * vendor access resolves the declared @cortexkit package through import.meta. */
export async function verifyExternalRuntimeClosure({ artifactRoot, hostRoot, externalRuntimeClosure }) {
  const declared = validateExternalClosure(externalRuntimeClosure);
  const used = new Set();
  const artifactFiles = await files(artifactRoot);
  const artifactFileSet = new Set(artifactFiles);
  for (const rule of declared.dynamicExternalImports) {
    if (!artifactFileSet.has(rule.module)) throw new Error(`production_dynamic_external_module_missing:${rule.module}`);
  }
  for (const item of artifactFiles) {
    if (extname(item) !== ".js") continue;
    const content = await readFile(resolve(artifactRoot, item), "utf8");
    let ingress;
    try { ingress = lexicalModuleIngress(content); } catch (error) { throw new Error(`production_module_lexical_parse_failed:${item}:${error.message}`); }
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
      if (nodeBuiltin(specifier)) continue;
      if (specifier.startsWith(".")) {
        artifactRelativeModule(artifactRoot, item, specifier, artifactFileSet);
        continue;
      }
      if (specifier.startsWith("/") || specifier.startsWith("file:")) throw new Error(`production_absolute_module_ingress_forbidden:${item}:${specifier}`);
      const name = packageName(specifier);
      if (!declared.packages.includes(name)) throw new Error(`production_external_package_unlisted:${name}:${item}`);
      used.add(name);
    }
  }
  for (const name of declared.packages) {
    if (!used.has(name)) throw new Error(`production_external_package_unused:${name}`);
    try {
      const packageJson = JSON.parse(await readFile(resolve(hostRoot ?? artifactRoot, "package.json"), "utf8"));
      if (packageJson.dependencies?.[name] === undefined) throw new Error("not_runtime_dependency");
      await import.meta.resolve(name);
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
    const inventory = await verifyArtifact({ artifactRoot: stagingRoot, hostRoot, config, origins });
    await writeFile(resolve(stagingRoot, "production-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
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
  const manifest = JSON.parse(await readFile(resolve(selected.artifactRoot, "production-inventory.json"), "utf8"));
  const inventory = await verifyArtifact({ artifactRoot: selected.artifactRoot, hostRoot, config, expectedInventory: manifest, origins });
  if (inventory.digest !== selected.digest) throw new Error("production_selected_generation_integrity_mismatch");
  await safeAncestors(selected.artifactRoot, selected.entryPath, "production_entry"); await regular(selected.entryPath, "production_entry");
  return selected;
}
