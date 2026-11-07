/**
 * Guard: a published Host generation must be able to import itself.
 *
 * WHY (measured 2026-11-07)
 *
 * The generation this checkout publishes does not hold
 * `composition/companion-session-reflection.js` while every suite reads `host/dist-test`, which does. So the
 * published artifact could not serve a production entry and no test said so. The measurements, in order, are
 * what makes the shape of this gate rather than a story:
 *
 *   * `node host/scripts/check-production-artifact.mjs` exits 1 with
 *     `production_dynamic_external_module_missing:composition/companion-session-reflection.js`
 *     (production-artifact.mjs:1202, reached from `verifyExternalRuntimeClosure` through
 *     `assertCompleteProductionArtifact`) - that is the exact refusal the live gate records at
 *     `tools/live-run/game/stardew-world-survival-live.mjs:861`;
 *   * `host/dist/current.json` points at `g-mv94khq7-26648-835362d81e8e486db0ca40e9444d3465`, whose
 *     `composition/` holds three emitted modules and whose inventory records a seven-rule
 *     `externalRuntimeClosure`, while `host/production-artifact.config.json` declares eight;
 *   * the generation's own files are dated 2026-10-15 13:55, and `host/src/composition/companion-session-reflection.ts`
 *     first appears in commit 498697dd on 2026-10-16 - so the artifact predates the module and the config
 *     clause that declares it.
 *
 * The assembler was not the omission. `retainEntrypointClosure` graph-walks the FULL `tsc` emit from
 * `[...entryRoots, ...verificationRoots, bundledRuntime.bootstrapPath]` and copies only what it reaches, and
 * `verifyEntrypointClosure` rejects any emitted `.js` the walk does not reach, so an emitted module cannot be
 * dropped and cannot name a sibling the walk failed to copy. What no gate read was the artifact that is
 * actually on disk: emission is graph-driven but publication is a separate act, and between them an artifact
 * can sit a day behind its source while every suite reads `dist-test`. `check-production-artifact.mjs` exists
 * for exactly that reading, and no `check:` script and no workflow names it.
 *
 * THE POPULATION is the generation's own record of its Host module graph, never a glob and never a list:
 * `production-inventory.json` entries whose `origin.kind` is `typescript_emit`. The bundled runtime, the
 * declared external runtime closure, the browser artifact and the native helpers each carry a different
 * `origin.kind`, so the exclusion is derived from the record that admitted them rather than from a path
 * prefix this file would have to keep in step.
 *
 * THE OTHER HALF is the declaration side, and it is why an internal check alone would have been blind here.
 * The stale generation above is internally perfect: 174 emitted modules, 404 relative imports, no violation -
 * and it is still unusable, because what it lacks is what the CURRENT source declares. No specifier inside an
 * artifact points at a module the artifact does not have; the import that names it lives in a source file that
 * was emitted after the artifact was frozen. So the gate also reads `host/production-artifact.config.json`
 * through the publisher's own validator and requires the generation to hold every entry root, every
 * verification root, the runtime bootstrap entry, and every module a `dynamicExternalImports` rule names. A
 * four-reading gate that only read the artifact would report this defect as a pass, which is exactly the
 * failure class it exists for: a check's boundary is what it reads.
 *
 * THE QUESTION, per module: every relative module specifier it names must be a file the generation holds. A
 * specifier is read three ways, because a generation can name a sibling three ways:
 *
 *   * `import ... from "./x.js"` / `export ... from "./x.js"` - `lexicalModuleIngress`, the publisher's OWN
 *     parser (host/scripts/production-artifact.mjs), so the gate and the assembler cannot disagree about what
 *     an import is. A single authority, not a second copy of it.
 *   * `import("./x.js")` / `require("./x.js")` with a string-literal argument - the same parser's
 *     `dynamicCalls`. A literal relative target is checked like a static one: the publisher declares dynamic
 *     ingress module by module, so a declared module it cannot load is the same defect.
 *   * `join(import.meta.dirname, ..., "x.js")` / `resolve(dirname(fileURLToPath(import.meta.url)), ...,
 *     "x.js")` - a path composed at runtime. Correlated here because no import grammar carries it, so the
 *     only reading that sees it is the one that looks at path calls whose last segment is a `.js` literal.
 *
 * A SPREAD IS READ IN BOTH DIRECTIONS. `demanded - held` is `import_target_missing` (a module names a sibling
 * the generation does not ship: the shipped defect). `population - held` is `generation_file_missing` (the
 * inventory records an emitted module the generation has lost). Each names the module, and for the first the
 * importer that demanded it, because "which import broke" and "which file vanished" are different repairs.
 *
 * WHAT IS NAMED INSTEAD OF SKIPPED. Three kinds of specifier cannot be judged from the text, and each is
 * printed by name in `unassessed` rather than dropped: a computed dynamic argument (`import(someVariable)`), a
 * path composed from an anchor this file does not recognise, and a bare specifier inside a dynamic call (the
 * declared external runtime closure owns package resolution, and `verifyExternalRuntimeClosure` already binds
 * those rules one by one). `unassessed` is printed with its count on every run, so a generation that hides its
 * imports behind a variable is visible on the first line of output rather than after the next live run.
 *
 * Usage:
 *   node tools/check-release-generation-self-contained.mjs [--root <host/dist>] [--generation <id>] [--quiet]
 *
 * Output is one JSON object on stdout: `{gate,generation,population,declarations,imports,unassessed,violations,status}`.
 * `status` is `passed`, `failed`, `blocked`, or `not_measured`. `blocked` is an empty population, because a
 * gate that examined no module has measured nothing and must not report success. `not_measured` is a checkout
 * with no published generation at all - CI is that checkout, `host/dist` being gitignored - and it exits 0 with
 * its reason printed, because "there is no artifact here" is a prerequisite fact rather than a verdict. Exit is
 * 0 for passed or not_measured, 1 for failed or blocked, 2 for an error in the gate itself. `--root` exists so
 * a falsifier can point the gate at a copy of a generation; the default is this repository's own `host/dist`.
 *
 * red-proof: inject  deleting an emitted module from a copy of the generation -> `import_target_missing`
 *                    naming both the importer and the target it demanded
 *                    (tools/check-release-generation-self-contained.test.mjs)
 * red-proof: history the generation at 2026-11-07 (g-mv94khq7-...) declares nothing wrong inside itself and
 *                    still fails: `declared_dynamic_module_missing:composition/companion-session-reflection.js`
 *                    (tools/check-release-generation-self-contained.test.mjs)
 * red-proof: inject  a generation whose inventory records no emitted module -> `status:"blocked"`, exit 1
 *                    (tools/check-release-generation-self-contained.test.mjs)
 * red-proof: fixture a generation module whose dynamic argument is a variable -> `unassessed` names it and
 *                    the run says so, rather than passing in silence
 *                    (tools/check-release-generation-self-contained.test.mjs)
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  lexicalModuleIngress,
  readArtifactConfig,
  readArtifactConfigFromText,
} from "../host/scripts/production-artifact.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_ROOT = join(REPOSITORY_ROOT, "host");
const DEFAULT_OUTPUT_ROOT = join(HOST_ROOT, "dist");

/** The generation id is a directory name; anything else is a pointer this gate refuses to follow. */
const GENERATION_ID = /^[A-Za-z0-9._-]+$/u;
/** The one `origin.kind` that means "this file is part of the Host module graph". */
const HOST_MODULE_ORIGIN = "typescript_emit";

const typescript = createRequire(join(REPOSITORY_ROOT, "host", "package.json"))("typescript");

/** A `join`/`resolve` first argument that names the directory the composing module lives in. */
const DIRECTORY_ANCHOR = /^(?:import\.meta\.dirname|__dirname|dirname\(fileURLToPath\(import\.meta\.url\)\))$/u;

/** The generation's own record of its Host module graph, or the reason this checkout has none to read. */
function notMeasured(generation, reason) {
  return {
    gate: "release-generation-self-contained",
    generation: typeof generation === "string" ? generation : null,
    population: 0,
    declarations: 0,
    imports: 0,
    unassessed: [],
    violations: [],
    reason,
    status: "not_measured",
  };
}

const decodeLiteral = (expression) => {
  try {
    const value = JSON.parse(expression);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
};

const isRelative = (specifier) => specifier.startsWith("./") || specifier.startsWith("../");

/**
 * Every `.js` path one emitted module composes out of its own directory.
 *
 * `join(import.meta.dirname, "composition", "x.js")` and
 * `resolve(dirname(fileURLToPath(import.meta.url)), "x.js")` are the two spellings the Host uses; the anchor
 * is matched exactly, so a path built on anything else is reported as unassessed rather than guessed at. The
 * last segment must be a `.js` literal, which is what makes this a module path and not a data path.
 */
function readComposedPaths(content) {
  const source = typescript.createSourceFile(
    "generation-module.js",
    content,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.JS,
  );
  const composed = [];
  const visit = (node) => {
    if (typescript.isCallExpression(node) && node.arguments.length >= 2) {
      const callee = node.expression;
      const name = typescript.isIdentifier(callee)
        ? callee.text
        : typescript.isPropertyAccessExpression(callee) && typescript.isIdentifier(callee.name)
          ? callee.name.text
          : undefined;
      const last = node.arguments[node.arguments.length - 1];
      if ((name === "join" || name === "resolve") && typescript.isStringLiteral(last) && last.text.endsWith(".js")) {
        const segments = node.arguments.slice(1, -1);
        const anchor = node.arguments[0].getText(source).replaceAll(/\s+/gu, "");
        if (DIRECTORY_ANCHOR.test(anchor) && segments.every((segment) => typescript.isStringLiteral(segment)))
          composed.push({ specifier: [...segments.map((segment) => segment.text), last.text].join("/") });
        else composed.push({ expression: node.getText(source).replaceAll(/\s+/gu, " ").slice(0, 160) });
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return composed;
}

/** The Host module graph as the generation itself records it, and the modules its inventory admits elsewhere. */
function readPopulation(inventory) {
  const entries = Array.isArray(inventory?.entries) ? inventory.entries : [];
  return entries
    .filter((entry) => entry?.type === "file" && entry?.origin?.kind === HOST_MODULE_ORIGIN)
    .map((entry) => entry.path)
    .sort();
}

/**
 * Every module the generation's Host graph demands, every demand it cannot satisfy, and every specifier that
 * could not be judged from the text.
 *
 * `config` is an already-validated `production-artifact.config.json`; the CLI supplies the publisher's own
 * reading of it and a falsifier supplies a smaller one, so the config's validation has one authority.
 */
export async function auditReleaseGenerationSelfContained({
  outputRoot = DEFAULT_OUTPUT_ROOT,
  generation,
  config,
} = {}) {
  const declaredConfig = config ?? (await readArtifactConfig(HOST_ROOT));
  // A checkout with no published generation has not measured this question at all. That is neither a pass nor a
  // failure, and CI is exactly that checkout: `host/dist` is gitignored, so a green "0 violations" there would
  // be a gate agreeing with itself about an artifact it never read.
  const pointerPath = join(outputRoot, "current.json");
  if (!existsSync(pointerPath)) return notMeasured(generation, "generation_not_published");
  const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
  const selected = generation ?? pointer?.generation;
  if (typeof selected !== "string" || !GENERATION_ID.test(selected))
    throw new Error("release_generation_pointer_invalid");
  const artifactRoot = join(outputRoot, "generations", selected);
  if (!existsSync(artifactRoot)) return notMeasured(selected, "generation_directory_absent");
  const inventoryPath = join(artifactRoot, "production-inventory.json");
  if (!existsSync(inventoryPath)) return notMeasured(selected, "generation_inventory_absent");
  const population = readPopulation(JSON.parse(readFileSync(inventoryPath, "utf8")));
  const reading = {
    gate: "release-generation-self-contained",
    generation: selected,
    population: population.length,
    declarations: 0,
    imports: 0,
    unassessed: [],
    violations: [],
  };
  if (population.length === 0) return { ...reading, status: "blocked" };

  const absoluteTarget = (target) => join(artifactRoot, ...target.split("/"));
  // The generation's internal consistency is only half the question. The other half is whether it holds what
  // the CURRENT source declares it must: a generation emitted before a module existed is internally perfect
  // and unable to serve an entry, and no specifier inside the artifact points at the module it lacks.
  const declared = [
    ...declaredConfig.entryRoots.map((path) => ({ path, code: "declared_entry_missing" })),
    ...declaredConfig.verificationRoots.map((path) => ({ path, code: "declared_verification_root_missing" })),
    ...(typeof declaredConfig.bundledRuntime?.bootstrapPath === "string"
      ? [{ path: declaredConfig.bundledRuntime.bootstrapPath, code: "declared_bootstrap_missing" }]
      : []),
    ...(declaredConfig.externalRuntimeClosure?.dynamicExternalImports ?? []).map((rule) => ({
      path: rule.module,
      code: `declared_dynamic_module_missing:${rule.package}:${rule.expression}`,
    })),
  ];
  reading.declarations = declared.length;
  for (const { path, code } of declared) {
    if (existsSync(absoluteTarget(path))) continue;
    // The path leads, so an operator greps the module the generation lacks, not the rule that demanded it.
    const [kind, ...demand] = code.split(":");
    reading.violations.push([kind, path, ...demand].join(":"));
  }
  const demanded = new Map();
  const unassessed = [];
  let imports = 0;
  const demand = (importer, specifier) => {
    const target = posix.normalize(posix.join(posix.dirname(importer), specifier));
    const importers = demanded.get(target) ?? new Set();
    importers.add(`${importer}:${specifier}`);
    demanded.set(target, importers);
  };
  for (const module of population) {
    let content;
    try {
      content = readFileSync(absoluteTarget(module), "utf8");
    } catch {
      continue; // reported below as `generation_file_missing`, with the demand side of the spread
    }
    let ingress;
    try {
      ingress = lexicalModuleIngress(content);
    } catch {
      reading.violations.push(`generation_module_unparseable:${module}`);
      continue;
    }
    for (const specifier of ingress.staticSpecifiers) {
      // A non-relative specifier is the package resolver's question, not this generation's.
      if (!isRelative(specifier)) continue;
      imports += 1;
      demand(module, specifier);
    }
    for (const call of ingress.dynamicCalls) {
      const literal = decodeLiteral(call.expression);
      if (literal === undefined) {
        unassessed.push(`dynamic_specifier_computed:${module}:${call.expression.slice(0, 160)}`);
        continue;
      }
      // A bare literal is one of the declared external runtime closure's rules; verifyExternalRuntimeClosure
      // binds every rule to a package and this gate would be a second, weaker copy of that judgement.
      if (!isRelative(literal)) continue;
      imports += 1;
      demand(module, literal);
    }
    for (const composed of readComposedPaths(content)) {
      if (composed.expression !== undefined) {
        unassessed.push(`composed_path_unresolved:${module}:${composed.expression}`);
        continue;
      }
      imports += 1;
      demand(module, composed.specifier);
    }
  }

  const absent = new Set();
  for (const [target, importers] of demanded) {
    if (target.startsWith("..")) {
      reading.violations.push(`import_target_outside_generation:${[...importers].sort().join(",")}:${target}`);
      continue;
    }
    if (existsSync(absoluteTarget(target))) continue;
    absent.add(target);
    for (const importer of importers) reading.violations.push(`import_target_missing:${importer}:${target}`);
  }
  // The other half of the spread: a module the inventory records as emitted and the generation no longer has.
  // Both are reported for one deletion on purpose: "this import broke" and "the inventory still records a file
  // the generation has lost" are different repairs, and a report showing one of them hides the other.
  for (const module of population) {
    if (existsSync(absoluteTarget(module))) continue;
    reading.violations.push(`generation_file_missing:${module}`);
  }
  reading.imports = imports;
  reading.unassessed = unassessed.sort();
  reading.violations.sort();
  return { ...reading, status: reading.violations.length === 0 ? "passed" : "failed" };
}

async function main(argv) {
  const argumentValue = (name) => {
    const index = argv.indexOf(name);
    const value = index >= 0 ? argv[index + 1] : undefined;
    return typeof value === "string" && !value.startsWith("--") ? value : undefined;
  };
  const root = argumentValue("--root");
  const configPath = argumentValue("--config");
  const reading = await auditReleaseGenerationSelfContained({
    outputRoot: root === undefined ? DEFAULT_OUTPUT_ROOT : resolve(root),
    generation: argumentValue("--generation"),
    config:
      configPath === undefined
        ? undefined
        : await readArtifactConfigFromText(readFileSync(resolve(configPath), "utf8")),
  });
  process.stdout.write(`${JSON.stringify(reading, null, 2)}\n`);
  const quiet = argv.includes("--quiet");
  if (!quiet) {
    process.stderr.write(
      `release_generation_self_contained examined ${reading.population} module(s) of generation ${reading.generation}, ` +
        `${reading.imports} resolved relative import(s), ${reading.declarations} declared module(s) of the current config\n`,
    );
    if (reading.unassessed.length > 0)
      process.stderr.write(
        `release_generation_self_contained unassessed ${reading.unassessed.length}:\n${reading.unassessed.map((entry) => `  ${entry}\n`).join("")}`,
      );
  }
  if (reading.status === "passed") return 0;
  if (reading.status === "not_measured") {
    process.stderr.write(
      `release_generation_self_contained not_measured: ${reading.reason} (no published generation at this root)\n`,
    );
    return 0;
  }
  if (reading.status === "blocked") {
    process.stderr.write(
      `release_generation_self_contained blocked: generation ${reading.generation} records no emitted Host module\n`,
    );
    return 1;
  }
  process.stderr.write(
    `release_generation_self_contained failed: ${reading.violations.length} unsatisfied module reference(s)\n`,
  );
  if (!quiet) for (const violation of reading.violations) process.stderr.write(`  ${violation}\n`);
  return 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `release_generation_self_contained error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
