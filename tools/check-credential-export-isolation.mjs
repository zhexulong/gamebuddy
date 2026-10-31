#!/usr/bin/env node
/**
 * The credential-export gate: a player's long-lived API keys must never travel inside an artifact.
 *
 * The promise is "credentials never leave the product". Written as prose it is worth nothing, because
 * the product has no diagnostic-bundle or log-export feature today and so has nothing to violate. The
 * exposure is not a feature that exists; it is the one that will be written next. A player who reports
 * a bug zips `%LOCALAPPDATA%\GameBuddy` by hand and posts it, and a future `export logs` control
 * assembles the same tree for them. Two files in that tree are plaintext credentials:
 *
 *   <agentDir>/auth.json                  Pi's own store, keyed by piProviderId
 *   <agentDir>/tavern-connection-keys.json  the Host's per-connection store, keyed by connectionId
 *
 * Both are declared by `host/src/tavern/connection-store.ts` as `connectionAuthPath` /
 * `connectionKeysPath`, and the reason there are two is recorded in that module's header.
 *
 * WHERE THE POPULATION COMES FROM. Not from a list of today's filenames: an exported
 * `function <name>Path(dir: string): string { return join(dir, SOME_CONST); }` in a production
 * `host/src` module, where `<name>` is credential-marked and SOME_CONST resolves to a `.json` leaf.
 * A third credential file declared the way the two above are declared is covered the moment it is
 * written, with nobody editing this file. A third one written some other way is not covered, which is
 * why Arm A also refuses when the population it derived is empty: the day the builders are renamed,
 * this gate must fail rather than pass vacuously.
 *
 * WHAT IT ASSERTS. Any module that assembles an exportable artifact must not read or include a path in
 * that population. An assembler is any shipped module that
 *
 *   - holds a copy/archive/stream primitive (`copyFile`, `cp`/`cpSync`, `copyTree`, `createWriteStream`,
 *     `archiver`, PowerShell `Copy-Item`), or
 *   - is a production host module whose own file name marks an export/interchange/bundle/backup
 *     artifact, or
 *   - names an `*.export` route id from the Tavern browser contract.
 *
 * and it must not (Arm B) name a credential leaf as a quoted string, call a credential path builder, or
 * admit a credential path through a tree filter (Arm C: an array of regex literals in an assembler is
 * that module's include decision, so no pattern in it may match a representative credential path).
 *
 * WHEN YOU ADD AN EXPORT, the repair is not to teach this gate about your new file. Wire the export's
 * file set through a declared include decision — the shape `tools/live-run/core/capture.mjs` uses, where
 * `RUNTIME_ROOT_EVIDENCE` lists exactly what a capture keeps and the agent directory's credential files
 * are simply absent — and then this gate has nothing to say about you. If your export copies a directory
 * wholesale, it is already violating the promise, and this gate will name the file and the path.
 *
 * WHAT IT DOES NOT CLAIM. It cannot see a credential that reaches an artifact through a variable the
 * reader assembles at runtime from non-credential-looking parts, and it does not police a `.ps1` or a
 * `.cs` file's copy calls beyond `Copy-Item`. Those gaps are why the population is derived rather than
 * remembered: the cheap mistake (adding a filename to an include list) is the one it catches.
 *
 * Usage:
 *   node tools/check-credential-export-isolation.mjs              # the verdict
 *   node tools/check-credential-export-isolation.mjs --root <dir> # the gate's own fixture
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A path builder whose name marks a credential, and whose leaf is a durable document. */
const CREDENTIAL_NAME = /AUTH|CREDENTIAL|SECRET|TOKEN|KEY|PASS/iu;

/** Trees that hold shipped code. A fixture root may hold any subset. */
const SOURCE_TREES = Object.freeze(["host/src", "host/scripts", "tools"]);

/** Directories that are never shipped code. */
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "dist-test", "bin", "obj", "coverage"]);

/** A module that copies, archives or streams a file is assembling an artifact. */
const COPY_PRIMITIVES = Object.freeze([
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "copyTree",
  "copyFileInto",
  "createWriteStream",
  "archiver",
  "Copy-Item",
]);

/** A production host module whose own name marks an exportable artifact. */
const EXPORT_NAME = /export|interchange|bundle|archive|backup/iu;

/** The builder shape the population is derived from, and the constant it reads. */
const PATH_BUILDER =
  /export function ([A-Za-z0-9_]+)\(([A-Za-z0-9_]+): string\): string \{\r?\n\s*return join\(\2, ([A-Za-z0-9_]+)\);\r?\n\}/gu;

/** A file write. The module that DECLARES a credential path must also be one that writes it. */
const WRITE_PRIMITIVE = /\b(?:atomicWriteFile|writeManagedFile|writeFileSync|writeFile)\s*\(/u;

/** A string literal that names a file. */
const QUOTED = /["']([^"'\r\n]+)["']/gu;

export function isProductionTs(path) {
  const normalized = path.split(sep).join("/");
  if (!normalized.endsWith(".ts") || normalized.endsWith(".d.ts")) return false;
  if (/\.test\.ts$|\.test-support\.ts$|\.test-fixtures\.ts$|fixture-worker\.ts$/u.test(normalized)) return false;
  return !/(?:^|\/)test-fixtures\//u.test(normalized);
}

/** True for code a player's installation or a harness actually runs. */
export function isShipped(path) {
  const normalized = path.split(sep).join("/");
  if (normalized.endsWith(".ts")) return isProductionTs(normalized);
  if (!/\.(?:mjs|cjs|js|ps1)$/u.test(normalized)) return false;
  if (/\.test\.(?:mjs|cjs|js)$/u.test(normalized)) return false;
  return !(/(?:^|\/)(?:fixtures|test-fixtures)\//u.test(normalized) || /\.mutation\.mjs$/u.test(normalized));
}

/** Every file under `directory`, sorted; a missing directory is an empty one. */
function walk(directory, out = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  out.sort();
  return out;
}

/** Every shipped code file in a repository root, as `{ path, absolute, text }`. */
function shippedSources(root) {
  const files = [];
  for (const tree of SOURCE_TREES) {
    for (const absolute of walk(join(root, tree))) {
      const path = relative(root, absolute).split(sep).join("/");
      if (!isShipped(path)) continue;
      files.push({ path, absolute, text: readFileSync(absolute, "utf8") });
    }
  }
  return files;
}

/**
 * The credential-bearing files, derived from the code that declares them.
 *
 * Each entry names the builder, the module that declares it, and the leaf. A builder whose name is
 * credential-marked but whose leaf is not a `.json` document is reported rather than trusted: the
 * promise is about durable credential documents, and a shape this gate cannot describe is drift.
 */
export function credentialPopulation(root) {
  const credentials = [];
  const drift = [];
  for (const source of shippedSources(root)) {
    if (!(source.path.startsWith("host/src/") && isProductionTs(source.path))) continue;
    PATH_BUILDER.lastIndex = 0;
    for (let match = PATH_BUILDER.exec(source.text); match !== null; match = PATH_BUILDER.exec(source.text)) {
      const builder = match[1];
      if (!CREDENTIAL_NAME.test(builder)) continue;
      const constant = new RegExp(`const ${match[3]} = "([^"]+)";`, "u").exec(source.text);
      if (constant === null) {
        drift.push({ code: "credential_leaf_unresolved", builder, file: source.path });
        continue;
      }
      const leaf = constant[1];
      if (!leaf.endsWith(".json"))
        drift.push({ code: "credential_leaf_not_a_document", builder, file: source.path, leaf });
      if (!WRITE_PRIMITIVE.test(source.text))
        drift.push({ code: "credential_file_never_written", builder, file: source.path, leaf });
      credentials.push({ builder, leaf, file: source.path });
    }
  }
  return { credentials, drift };
}

/** The representative absolute and bare paths one credential leaf can appear as. */
function credentialPaths(leaf, container) {
  if (container === null) return [leaf];
  return [leaf, container.replaceAll("<key>", "k0").replaceAll("<id>", "session"), `${container}/${leaf}`];
}

/**
 * The directory the runtime's own resolver puts an agent directory in, relative to the runtime root,
 * as `<contexts>/<key>/<agent>`. Read from `runtime-identity.ts` rather than restated here: the
 * credential files live beside `models.json` in that directory, and a gate that invented its own copy
 * of the layout would keep matching a path the product no longer uses.
 */
export function credentialContainer(root) {
  let text;
  try {
    text = readFileSync(join(root, "host", "src", "runtime-identity.ts"), "utf8");
  } catch {
    return null;
  }
  const agent = /agentDir: join\([A-Za-z0-9_]+, "([^"]+)"\)/u.exec(text);
  const contexts = /runtimeCwd = join\(resolvedRoot, "([^"]+)", key\)/u.exec(text);
  if (agent === null || contexts === null) return null;
  return `${contexts[1]}/<key>/${agent[1]}`;
}

/** The `*.export` route ids the Tavern browser contract publishes. */
export function exportRouteIds(root) {
  const contract = join(root, "host", "src", "tavern", "browser-contract", "index.ts");
  let text;
  try {
    text = readFileSync(contract, "utf8");
  } catch {
    return [];
  }
  return [...text.matchAll(/routeId: "([^"]+)"/gu)]
    .map((match) => match[1])
    .filter((routeId) => /\.export$/u.test(routeId));
}

/**
 * Scan `text` from `open` (the index of `[`) to its matching `]`, skipping strings, template literals,
 * line comments and regex literals. Returns the body and the index just past the closer.
 */
function bracketBody(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    const previous = text[index - 1];
    if (character === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      if (newline < 0) return { body: text.slice(open + 1), end: text.length };
      index = newline;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      if (close < 0) return { body: text.slice(open + 1), end: text.length };
      index = close + 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      index = skipString(text, index);
      continue;
    }
    // A regex literal can only start where a value is expected. Inside an array that is after `[` or `,`,
    // which keeps a division operator (`a / b`) from being read as one.
    if (character === "/" && /[[,]\s*$/u.test(text.slice(Math.max(0, index - 8), index))) {
      index = skipRegex(text, index);
      continue;
    }
    if (character === "[" || character === "{" || character === "(") depth += 1;
    else if (character === "]" || character === "}" || character === ")") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, index), end: index + 1 };
    }
    if (previous === undefined) continue;
  }
  return { body: text.slice(open + 1), end: text.length };
}

function skipString(text, open) {
  const quote = text[open];
  for (let index = open + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === quote) return index;
    if (text[index] === "\n" && quote !== "`") return index;
  }
  return text.length;
}

function skipRegex(text, open) {
  let index = open + 1;
  let inClass = false;
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") inClass = true;
    else if (character === "]") inClass = false;
    else if (character === "/" && !inClass) break;
    else if (character === "\n") return index;
  }
  return index;
}

/**
 * The same text with every comment replaced by spaces, so element splitting sees code only. A regex
 * literal is skipped whole, which is why `\/` inside a pattern is not read as a comment start.
 */
function blankComments(text) {
  const characters = [...text];
  const blank = (from, to) => {
    for (let index = from; index < to && index < characters.length; index += 1)
      if (characters[index] !== "\n") characters[index] = " ";
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipString(text, index);
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      const end = newline < 0 ? text.length : newline;
      blank(index, end);
      index = end;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      const end = close < 0 ? text.length : close + 2;
      blank(index, end);
      index = end - 1;
      continue;
    }
    if (character === "/" && /[[,{]\s*$/u.test(text.slice(Math.max(0, index - 8), index))) {
      index = skipRegex(text, index);
    }
  }
  return characters.join("");
}

/** Split an array body on top-level commas. */
function splitElements(body) {
  const text = blankComments(body);
  const elements = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipString(text, index);
      continue;
    }
    if (character === "/" && /[[,{]\s*$/u.test(text.slice(Math.max(0, index - 8), index))) {
      index = skipRegex(text, index);
      continue;
    }
    if (character === "[" || character === "{" || character === "(") depth += 1;
    else if (character === "]" || character === "}" || character === ")") depth -= 1;
    else if (character === "," && depth === 0) {
      elements.push(text.slice(start, index));
      start = index + 1;
    }
  }
  elements.push(text.slice(start));
  return elements.map((element) => element.trim()).filter((element) => element.length > 0);
}

/** Compile one regex-literal element, or `undefined` when the element is not one. */
function compileRegexLiteral(element) {
  if (!element.startsWith("/")) return undefined;
  const lastSlash = element.lastIndexOf("/");
  if (lastSlash <= 0) return undefined;
  try {
    return new RegExp(element.slice(1, lastSlash), element.slice(lastSlash + 1));
  } catch {
    return undefined;
  }
}

/**
 * The arrays of regex literals a module declares: each one is that module's include decision when the
 * module copies a tree. A declaration that mixes regexes with anything else is not a filter and is
 * skipped, so this arm is narrow by construction.
 */
export function patternArrays(text) {
  const arrays = [];
  const DECLARATION = /(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:Object\.freeze\(\s*)?\[/gu;
  for (let match = DECLARATION.exec(text); match !== null; match = DECLARATION.exec(text)) {
    const open = text.indexOf("[", match.index);
    const { body } = bracketBody(text, open);
    const elements = splitElements(body);
    if (elements.length === 0) continue;
    const compiled = [];
    for (const element of elements) {
      const pattern = compileRegexLiteral(element);
      if (pattern === undefined) {
        compiled.length = 0;
        break;
      }
      compiled.push({ literal: element.replace(/\s+/gu, " "), pattern });
    }
    if (compiled.length > 0) arrays.push({ name: match[1], patterns: compiled });
  }
  return arrays;
}

/** True when a module assembles an exportable artifact, and why. */
function assemblerReason(source, routeIds) {
  const reasons = [];
  for (const primitive of COPY_PRIMITIVES)
    if (new RegExp(`\\b${primitive}\\s*\\(`, "u").test(source.text)) reasons.push(primitive);
  if (source.path.startsWith("host/src/") && isProductionTs(source.path)) {
    const own = source.path.slice(source.path.lastIndexOf("/") + 1);
    if (EXPORT_NAME.test(own)) reasons.push("export_named_module");
  }
  for (const routeId of routeIds)
    if (source.text.includes(`"${routeId}"`) || source.text.includes(`'${routeId}'`)) reasons.push(routeId);
  return reasons;
}

/**
 * The verdict over one repository root.
 *
 * `violations` are the violations; `checked` records what the gate actually read, so a green run says
 * how many assemblers it looked at instead of inviting the reader to assume it looked at all of them.
 */
export function evaluate({ root = REPOSITORY_ROOT } = {}) {
  const population = credentialPopulation(root);
  const container = credentialContainer(root);
  const routeIds = exportRouteIds(root);
  const leaves = population.credentials.map((entry) => entry.leaf);
  const violations = [...population.drift];
  if (population.credentials.length === 0)
    violations.push({
      code: "credential_population_empty",
      detail:
        "no exported credential path builder was found in host/src; the two stores are declared by connectionAuthPath/connectionKeysPath in tavern/connection-store.ts. If they moved, fix this gate's PATH_BUILDER derivation - do not delete the gate",
    });
  if (container === null)
    violations.push({
      code: "credential_container_unresolved",
      detail:
        "the runtime's agent directory could not be read from host/src/runtime-identity.ts; the tree-filter arm compares credential paths inside it",
    });

  const assemblers = [];
  let filtersInspected = 0;
  for (const source of shippedSources(root)) {
    const reasons = assemblerReason(source, routeIds);
    if (reasons.length === 0) continue;
    const where = { file: source.path, reasons };
    assemblers.push(where);
    // Comments are blanked before either arm reads the module. A comment that names a credential
    // file is documentation - very often documentation of exactly this rule - and a gate that fired
    // on it would be a gate someone deletes. The blanking keeps offsets, so `filters` are located
    // by position rather than by re-scanning a shifted string.
    const code = blankComments(source.text);

    for (const leaf of leaves) {
      QUOTED.lastIndex = 0;
      for (let match = QUOTED.exec(code); match !== null; match = QUOTED.exec(code)) {
        const literal = match[1];
        if (literal === leaf || literal.endsWith(`/${leaf}`) || literal.endsWith(`\\${leaf}`))
          violations.push({ code: "assembler_names_credential_file", ...where, leaf, literal });
      }
    }

    for (const credential of population.credentials) {
      if (new RegExp(`\\b${credential.builder}\\s*\\(`, "u").test(code))
        violations.push({ code: "assembler_calls_credential_builder", ...where, builder: credential.builder });
    }

    for (const array of patternArrays(code)) {
      filtersInspected += 1;
      for (const entry of array.patterns) {
        const admitted = leaves
          .map((leaf) => ({
            leaf,
            path: credentialPaths(leaf, container).find((path) => entry.pattern.test(path)),
          }))
          .filter((candidate) => candidate.path !== undefined);
        if (admitted.length === 0) continue;
        violations.push({
          code: "assembler_filter_matches_credential_path",
          ...where,
          filter: `${array.name}: ${entry.literal}`,
          leaves: admitted.map((candidate) => candidate.leaf),
          path: admitted[0].path,
        });
      }
    }
  }

  return {
    credentials: population.credentials,
    assemblers,
    violations,
    checked: { credentials: population.credentials.length, assemblers: assemblers.length, filters: filtersInspected },
  };
}

function describe(violation) {
  switch (violation.code) {
    case "credential_population_empty":
      return `credential_population_empty: ${violation.detail}`;
    case "credential_container_unresolved":
      return `credential_container_unresolved: ${violation.detail}`;
    case "credential_leaf_unresolved":
      return `${violation.file}: ${violation.builder}() returns a constant this gate cannot resolve`;
    case "credential_leaf_not_a_document":
      return `${violation.file}: ${violation.builder}() returns "${violation.leaf}", which is not a durable document`;
    case "credential_file_never_written":
      return `${violation.file}: ${violation.builder}() declares "${violation.leaf}" but this module writes no file`;
    case "assembler_names_credential_file":
      return `${violation.file}: assembles an artifact (${violation.reasons.join(",")}) and names ${violation.leaf} as "${violation.literal}"`;
    case "assembler_calls_credential_builder":
      return `${violation.file}: assembles an artifact (${violation.reasons.join(",")}) and calls ${violation.builder}()`;
    case "assembler_filter_matches_credential_path":
      return `${violation.file}: include filter ${violation.filter} admits "${violation.path}", which is ${violation.leaves.join("/")}`;
    default:
      return `${violation.file ?? ""}: ${violation.code}`;
  }
}

function main(argv) {
  const rootAt = argv.indexOf("--root");
  const root = rootAt < 0 ? REPOSITORY_ROOT : resolve(argv[rootAt + 1]);
  const result = evaluate({ root });
  if (result.violations.length === 0) {
    process.stdout.write(
      `credential_export_isolation_ok credentials=${result.checked.credentials} ` +
        `assemblers=${result.checked.assemblers} filters=${result.checked.filters} ` +
        `files=${result.credentials.map((entry) => entry.leaf).join(",")}\n`,
    );
    return 0;
  }
  process.stdout.write(
    `credential_export_isolation_failed violations=${result.violations.length} ` +
      `assemblers=${result.checked.assemblers}\n`,
  );
  for (const violation of result.violations) process.stdout.write(`  ${describe(violation)}\n`);
  process.stdout.write(
    "a credential file is a player's long-lived API key in plaintext; an export may not carry it. " +
      "Wire the export's file set through a declared include decision instead of copying a directory, " +
      "or leave the credential out of the set (see tools/live-run/core/capture.mjs RUNTIME_ROOT_EVIDENCE).\n",
  );
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
