#!/usr/bin/env node
/**
 * Concurrency hygiene: four process-wide facts a Host can break without a compiler saying anything.
 *
 * WHY (measured 2026-11-26 at `29f9bd86`). Every one of these is a fact about the PROCESS, not about a type, so no
 * signature can hold it and no test that drives one module in isolation can notice it. The readings this gate prints on
 * every run, from `host/src`:
 *
 *   process-global mutation   16 production writes - 14 `process.env` writes (9 assignments, 5 deletes) in ONE file and
 *                             2 `process.chdir` calls that move the process's working directory and put it back - plus 16
 *                             `process.on`/`once`/`off` operations. No test-file site counts against a production
 *                             property, but the test share is printed beside it: a test that leaks an environment
 *                             variable corrupts every later test in the same worker.
 *   module-scope registries   3790 module-scope declarations, 235 of them collection initialisers - 96 strong
 *                             (`Map`/`Set`), 84 weak (`WeakMap`/`WeakSet`), 55 array literals - and 100 of them
 *                             mutated: 6 strong and 79 weak in production modules, the rest in tests.
 *   SQLite connections        9 production `new DatabaseSync(` sites in 3 files, 36 more in test files. There is no
 *                             single open-database factory: three functions may open a WRITABLE connection, and two
 *                             sites are read-only inspection handles.
 *   lock helpers              28 functions take the critical section as a `work` callback - 22 await the body, and 6 are
 *                             synchronous. "The signature forbids an await" is therefore not the invariant: it is the
 *                             opposite, and a synchronous family carries a runtime rejection instead.
 *
 * CHECK 1 - PROCESS-GLOBAL MUTATION. Population: every write to `process.env`, `process.cwd` or `process.chdir`, and
 * every `process.on` / `once` / `off` / `removeListener` in the scope, split production and test. The production
 * property is the SAVE/RESTORE PAIR a scoped write has to be: a slot written in a module must also be written (or
 * deleted) from inside a `catch` clause or a `finally` block of that same module, which is the only shape that restores
 * the previous value on a throw. The working directory is a slot on the same terms - `process.chdir(previousCwd)` in the
 * `finally` is what makes an outward `process.chdir(root)` a scoped move rather than a process-wide one, and a
 * `process.cwd` write has no restore that can be observed at all. A `process.on` registration must be paired with a
 * removal of the same event in the same module; `process.once` is excluded by the language's own guarantee that it removes itself after one
 * delivery, and its count is printed rather than assumed. Both directions are measured: a site without its pair is
 * `process_env_write_without_restore` / `process_listener_never_removed`, and a declared row whose site is gone is
 * `stale_process_global_exemption`, so `PROCESS_GLOBAL_EXEMPTIONS` (empty today) can shrink but never rot.
 *
 * CHECK 2 - MODULE-SCOPE MUTABLE REGISTRIES. Population: EVERY module-scope declaration, so a reader that stopped
 * recognising the tree is visible: `declared at module scope N · collection initialisers C · strong S · weak W · arrays
 * A · mutated M`. The property differs by kind and the three kinds are never pooled:
 *
 *   - a STRONG `Map`/`Set` at module scope, mutated at runtime, is shared mutable state whose lifetime the module cannot
 *     end. It needs a DRAIN - a `delete`/`clear` on the same name - or a row in `MODULE_REGISTRY_DECLARATIONS` with an
 *     owner and an expiry. Four schema-approval memo caches are that one row; a fifth must argue its own bound.
 *   - a WEAK `WeakMap`/`WeakSet` is not the same fact and is not exempted by a rule: it EARNS its pass from the
 *     argument that an entry is reachable only through its own key object, so a mutation cannot outlive what it is keyed
 *     on. That argument is written once, here, so nobody has to take 79 sites on faith; the count is printed.
 *   - a plain ARRAY at module scope must be unmutated, full stop: it has no key to bound it and no drain obligation to
 *     state, so a mutation of one is `module_array_mutated`.
 *
 * CHECK 3 - SQLITE CONNECTION DISCIPLINE. Population: every `new DatabaseSync(` site, classified from its OWN arguments
 * and never from a list here - `":memory:"` is a private schema probe, `{ readOnly: true }` is an inspection handle that
 * cannot write durable state, anything else is a writable store connection. A writable one must be opened inside one of
 * `WRITABLE_CONTAINERS` (the two store factories and the migration write path), and that container must put
 * `busy_timeout` in force in an `exec` before its first `prepare(` - the ordering the store argues for at its own line,
 * measured here as `busy_timeout@899 firstPrepare@929` and `busy_timeout@2319 firstPrepare@2380`, with the migration
 * path's statements living in helpers it calls by name so there is no `prepare(` of its own to order against. The pragma
 * is a requirement on the CONTAINER, not an exemption: a container that loses it is
 * `sqlite_writable_open_without_busy_timeout`, and a connection opened anywhere else is
 * `sqlite_connection_outside_a_factory`.
 *
 * CHECK 4 - AWAIT INSIDE A LOCK. Not a scan for `await` in a callback, which is a false-positive machine. The population
 * is every function taking the critical section as a parameter named `work` with a function type - the repository's one
 * spelling for it - classified by its OWN signature: `work: () => Promise<T>` AWAITS the body, `work: () => T` does not.
 * The property is the pairing. A synchronous-family helper must reject a thenable body, because the alternative is a
 * lock released before the work settles; the production coordinator throws
 * `async_partition_mutex_section_rejected` for exactly that, and the rejection is followed one hop through a
 * synchronous helper that passes `work` on. A synchronous helper without it is
 * `sync_lock_body_without_thenable_rejection`; a call site handing an `async` function to such a helper is
 * `lock_body_escapes_the_critical_section`. Every call site passing an `async` function is printed with its file and
 * line whichever family it lands in, so the population is visible rather than judged on trust.
 *
 * The tail protocol is asserted as the durable fact it is: `withPathLock` claims its in-process place with `tails.set`,
 * releases it through exactly ONE `releaseLocal()` call, and deletes the tail only when the tail it holds is still its
 * own (`tails.get(target) === tail`). A second release, or a delete that does not check identity, strands every later
 * acquirer behind a promise nobody settles. `TAIL_MAP` and `TAIL_RELEASE` name that protocol; a rename reds here on
 * purpose, with this paragraph as the reason - the reading is positional and must not pretend to follow a rename.
 *
 * ZERO IS BLOCKED, each with its own reason: no file under the scope, no process-global site, no module-scope
 * declaration, no strong collection, no connection, no `work`-taking helper, no `withPathLock`. Four of these five
 * populations are small enough that a lost reader would look exactly like a clean tree.
 *
 * Usage:
 *   node gates/arch/check-concurrency-hygiene.mjs              # the verdict; exit 0 passed, 1 failed, 2 blocked
 *   node gates/arch/check-concurrency-hygiene.mjs --json       # the same reading, machine-readable
 *   node gates/arch/check-concurrency-hygiene.mjs --root <dir> # the gate's own fixture
 *
 * red-proof: inject  a `process.env.INJECTED = "1"` at module scope in a copy of `host/src/runtime-core.internal.ts` ->
 *   `process_env_write_without_restore` naming the file, the line and the slot, exit 1
 *   (gates/arch/check-concurrency-hygiene.test.mjs)
 * red-proof: inject  a module-scope `const injected = new Map()` mutated with `.set(...)` in a copied module ->
 *   `module_registry_without_drain` naming the file and the name, exit 1 (the same suite)
 * red-proof: inject  a `new DatabaseSync(path)` outside every declared container in a copied module ->
 *   `sqlite_connection_outside_a_factory` naming the file, the line and the function that opened it (the same suite)
 * red-proof: inject  an `async () => {}` handed to a synchronous-family lock helper ->
 *   `lock_body_escapes_the_critical_section` naming the helper and the call site (the same suite)
 */

export const gateDeclaration = {
  id: "check-concurrency-hygiene",
  domain: "arch",
  tier: "l0",
  kind: "totality",
};

// source-invariant: no compiler relates four different process-wide facts to the shapes that make them safe - a scoped
//   environment write to a `finally`, a module-scope `Map` to a drain, a writable connection to the pragma that has to
//   precede it, and a synchronous lock body to the rejection of a thenable. This gate derives each population from the
//   declaration that produces it (the write, the declaration, the constructor's own arguments, the `work` parameter) and
//   prints what it examined, so a lost reader is a blocked run rather than a green one.
// source-expiry: when the Host is built as a process that never shares an environment, a module graph or a SQLite file
//   between concurrent units - a worker or an actor runtime owning each of these four resources per instance - this
//   reading has no subject and must be retired with that change rather than kept as a green line.

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rootFromArgv } from "../../tools/lib/gate-preamble.mjs";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

const REPOSITORY_ROOT = repositoryRoot(import.meta.url);

/** The tree this gate reads: the Host's own sources, tests included, because a leaked variable corrupts a worker. */
export const HOST_SOURCE = "host/src";

/** The helper whose in-process tail protocol check 4 asserts, and the two names that protocol is made of. */
export const PATH_LOCK = "host/src/path-lock.ts";
export const TAIL_MAP = "tails";
export const TAIL_RELEASE = "releaseLocal";
export const PATH_LOCK_HELPER = "withPathLock";

/**
 * Why a weak collection needs no drain row, written once so the gate is not asking 79 sites to be taken on faith.
 *
 * This is an argument, not an exemption: a `WeakMap`/`WeakSet` entry is reachable only through its own key object, so the
 * entry dies with that key and the collection cannot outlive what it is keyed on. A strong collection has no such bound
 * and therefore owes a drain or a row.
 */
export const WEAK_COLLECTION_BOUND =
  "an entry is reachable only through its own key object, so its lifetime is that key's";

/** The TypeScript parser the Host compiles with, so this gate reads the tree the build reads. */
const typescript = createRequire(join(REPOSITORY_ROOT, "host", "package.json"))("typescript");

const TYPESCRIPT_FILE = /\.(?:ts|tsx)$/u;
const TEST_FILE = /\.test\.ts$/u;
const TEST_SUPPORT = /test-support\./u;
const TEST_FIXTURE = /test-fixtures[./]/u;

/** What each verdict exits with: a violation is a failure, and a scan that measured nothing is neither. */
const EXIT_STATUS = Object.freeze({ passed: 0, failed: 1, blocked: 2 });

/** The mutation verbs a collection's runtime use is read by, per kind. */
const MAP_MUTATIONS = Object.freeze(["set", "add", "push", "delete", "clear", "unshift", "splice"]);
const MAP_DRAINS = Object.freeze(["delete", "clear"]);
const ARRAY_MUTATIONS = Object.freeze([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

/** The members that register a process listener, and the ones that remove one. */
const LISTENER_REGISTERING = Object.freeze(["on", "once"]);
const LISTENER_REMOVING = Object.freeze(["off", "removeListener", "removeAllListeners"]);

/**
 * Process-global writes this gate accepts, each naming its owner and the condition that ends the row.
 *
 * Empty today, and that is a reading: every production write in the tree is a save/restore pair or a self-removing
 * `once`. A row here is for a site that genuinely cannot be restored, and it expires by itself - a row naming a site
 * the reading no longer finds is `stale_process_global_exemption`.
 */
export const PROCESS_GLOBAL_EXEMPTIONS = Object.freeze([]);

/**
 * Module-scope registries accepted without a drain, one row per FACT rather than one per name.
 *
 * The four names are one memo family: each caches a signature derived from the same fixed schema, keyed by that schema's
 * own object names, so its size is bounded by the schema the build ships rather than by anything a run adds.
 */
export const MODULE_REGISTRY_DECLARATIONS = Object.freeze([
  Object.freeze({
    file: "host/src/continuity-semantic-store/continuity-semantic-production-store.ts",
    names: Object.freeze(["expectedColumns", "approvedTables", "approvedIndexes", "approvedDdl"]),
    owner: "the continuity semantic store lane (continuity-semantic-store/continuity-semantic-production-store.ts)",
    expiry:
      "expires when the schema-signature helpers take the schema's own object-name list as a parameter instead of " +
      "memoising it, so the cache has a declared population and a size a reader can see",
    reason:
      "the key space is the shipped schema's own table/index/column names, read from `sqlite_master` of this build's " +
      "schema, so the cache cannot grow with a run or with player data",
  }),
]);

/**
 * The functions that may open a WRITABLE store connection, and the pragma each must put in force before its first
 * `prepare(`. A read-only handle and an in-memory probe are classified from their own arguments and need no row.
 */
export const WRITABLE_CONTAINERS = Object.freeze([
  Object.freeze({
    container: "openProductionContinuityStore",
    owner: "the continuity semantic store lane",
    reason: "the production authority's single connection; the store argues the pragma order at its own line",
  }),
  Object.freeze({
    container: "migrateProductionContinuityStoreSchema",
    owner: "the continuity semantic store lane",
    reason:
      "the one WRITE path that rebuilds a stale schema; unreachable from the open path, it runs under the root mutex " +
      "and its statements live in helpers it calls by name",
  }),
  Object.freeze({
    container: "createChatThreadStore",
    owner: "the Chat thread store lane",
    reason: "the tavern store's single lazily opened connection; its pragmas are re-applied on every open",
  }),
]);

/** Every `*.ts`/`*.tsx` under the scope, relative to `root` and sorted so two runs read the tree the same way. */
export function sourceFiles({ root = REPOSITORY_ROOT, directory = HOST_SOURCE } = {}) {
  const files = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
        continue;
      }
      if (entry.isFile() && TYPESCRIPT_FILE.test(entry.name)) files.push(path);
    }
  };
  walk(join(root, directory));
  return files.map((path) => path.slice(root.length + 1).replace(/\\/gu, "/")).sort();
}

/** A test-support module, a fixture or a suite: everything a production property is not asserted against. */
export function isTestPath(path) {
  return TEST_FILE.test(path) || TEST_SUPPORT.test(path) || TEST_FIXTURE.test(path);
}

/** The line a node starts on, 1-based. */
function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** A node's text on one line, for a report line that has to stay readable. */
function flat(sourceFile, node) {
  return node.getText(sourceFile).replace(/\s+/gu, " ");
}

/** Parse one module of the tree, through `cache` when the caller has one so a run reads each file once. */
function parse(root, file, cache) {
  const key = `${root}\u0000${file}`;
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;
  const sourceFile = typescript.createSourceFile(
    file,
    readFileSync(join(root, file), "utf8"),
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  cache?.set(key, sourceFile);
  return sourceFile;
}

/** The nearest enclosing NAMED function, so a report names the container rather than an unknown arrow. */
function enclosingFunctionName(sourceFile, node) {
  let current = node.parent;
  while (current !== undefined && current !== null) {
    if (typescript.isFunctionDeclaration(current) && current.name !== undefined) return current.name.text;
    if (typescript.isMethodDeclaration(current) && current.name !== undefined) return current.name.getText(sourceFile);
    current = current.parent;
  }
  return null;
}

/** Every function the file declares, with the name a report can use for it. */
function declaredFunctions(sourceFile) {
  const found = [];
  const visit = (node) => {
    if (typescript.isFunctionDeclaration(node) && node.name !== undefined) found.push({ name: node.name.text, node });
    else if (typescript.isMethodDeclaration(node) && node.name !== undefined)
      found.push({ name: node.name.getText(sourceFile), node });
    else if (
      typescript.isVariableDeclaration(node) &&
      typescript.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (typescript.isArrowFunction(node.initializer) || typescript.isFunctionExpression(node.initializer))
    )
      found.push({ name: node.name.text, node: node.initializer });
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** The calls to `names` inside a node's subtree, as the callee name and the call node. */
function callsIn(sourceFile, node, names) {
  const calls = [];
  const visit = (inner) => {
    if (typescript.isCallExpression(inner)) {
      const callee = inner.expression;
      const called = typescript.isIdentifier(callee)
        ? callee.text
        : typescript.isPropertyAccessExpression(callee)
          ? callee.name.getText(sourceFile)
          : null;
      if (called !== null && names.includes(called)) calls.push({ called, node: inner });
    }
    typescript.forEachChild(inner, visit);
  };
  visit(node);
  return calls;
}

/** Whether a node sits inside a `catch` clause or a `finally` block: the only shape that restores on a throw. */
function withinRestoreClause(node) {
  for (let current = node.parent; current !== undefined && current !== null; current = current.parent) {
    if (typescript.isCatchClause(current)) return true;
    if (
      typescript.isBlock(current) &&
      current.parent !== undefined &&
      typescript.isTryStatement(current.parent) &&
      current.parent.finallyBlock === current
    )
      return true;
  }
  return false;
}

/** Whether a node is `process.env`. */
function isWholeEnvironment(node) {
  return (
    node !== undefined &&
    node !== null &&
    typescript.isPropertyAccessExpression(node) &&
    node.name.getText() === "env" &&
    typescript.isIdentifier(node.expression) &&
    node.expression.text === "process"
  );
}

/** Whether an expression names the tail map: a bare `tails` or a member of one that ends in `tails`. */
function namesTheTailMap(node) {
  if (typescript.isIdentifier(node)) return node.text === TAIL_MAP;
  if (typescript.isPropertyAccessExpression(node)) return node.name.getText() === TAIL_MAP;
  return false;
}

/** Whether a subtree deletes or clears the tail map: `tails.delete(…)`. */
function drainsTailMap(sourceFile, node) {
  let found = false;
  const visit = (inner) => {
    if (
      typescript.isCallExpression(inner) &&
      typescript.isPropertyAccessExpression(inner.expression) &&
      ["delete", "clear"].includes(inner.expression.name.getText()) &&
      namesTheTailMap(inner.expression.expression)
    )
      found = true;
    typescript.forEachChild(inner, visit);
  };
  visit(node);
  return found;
}

/**
 * The slot a member access names: `process.env.X` -> `"X"`, `process.env["X"]` -> `"X"`, `process.cwd` -> `cwd`,
 * `process.env` -> `env`. `null` when the expression is not one of those, and `{ slot: null }` for a computed key this
 * reader cannot pair.
 */
function processMember(node) {
  if (node === undefined || node === null) return null;
  if (isWholeEnvironment(node)) return { kind: "env", slot: null, whole: true };
  if (!typescript.isPropertyAccessExpression(node) && !typescript.isElementAccessExpression(node)) return null;
  const owner = node.expression;
  if (
    typescript.isPropertyAccessExpression(owner) &&
    owner.name.getText() === "cwd" &&
    typescript.isIdentifier(owner.expression) &&
    owner.expression.text === "process"
  )
    return { kind: "cwd", slot: "cwd" };
  if (!isWholeEnvironment(owner)) return null;
  if (typescript.isPropertyAccessExpression(node)) return { kind: "env", slot: node.name.getText(), whole: false };
  const argument = node.argumentExpression;
  if (typescript.isStringLiteral(argument) || typescript.isNoSubstitutionTemplateLiteral(argument))
    return { kind: "env", slot: argument.text, whole: false };
  return { kind: "env", slot: null, whole: false };
}

/** The event a listener call names, or `null` when it is computed and therefore unpairable by this reader. */
function listenerEvent(node) {
  const argument = node.arguments[0];
  if (argument === undefined) return null;
  if (typescript.isStringLiteral(argument) || typescript.isNoSubstitutionTemplateLiteral(argument))
    return argument.text;
  if (typescript.isIdentifier(argument)) return argument.text;
  return null;
}

/** The key a declared row and a finding share, so the table and the reading cannot spell an identity two ways. */
function siteKey(site) {
  return `${site.code}:${site.file}:${site.line}:${site.slot ?? site.event ?? "*"}`;
}

/**
 * CHECK 1: every process-global mutation site in the scope, the slots it writes, and whether each is restored.
 *
 * A WRITE is an assignment to `process.env`, `process.cwd` or a member of either, a `delete` of an `process.env`
 * member, a `process.chdir` call, or a whole-environment replacement through `Object.assign(process.env, …)`. Listener
 * calls are sites of their own, because a registration nobody removes is the same leak in another register.
 */
export function readProcessGlobalMutations({ root = REPOSITORY_ROOT, cache } = {}) {
  const sites = [];
  const files = sourceFiles({ root });
  for (const file of files) {
    const sourceFile = parse(root, file, cache);
    const visit = (node) => {
      if (typescript.isBinaryExpression(node) && node.operatorToken.kind === typescript.SyntaxKind.EqualsToken) {
        const member = processMember(node.left);
        if (member?.kind === "env" && member.whole)
          sites.push({ file, line: lineOf(sourceFile, node), code: "env_replace", slot: null, node });
        else if (member?.kind === "env")
          sites.push({ file, line: lineOf(sourceFile, node), code: "env_write", slot: member.slot, node });
        else if (member?.kind === "cwd")
          sites.push({ file, line: lineOf(sourceFile, node), code: "cwd_write", slot: "cwd", node });
      } else if (typescript.isDeleteExpression(node)) {
        const member = processMember(node.expression);
        if (member?.kind === "env" && member.whole)
          sites.push({ file, line: lineOf(sourceFile, node), code: "env_replace", slot: null, node });
        else if (member?.kind === "env")
          sites.push({ file, line: lineOf(sourceFile, node), code: "env_delete", slot: member.slot, node });
      } else if (typescript.isCallExpression(node) && typescript.isPropertyAccessExpression(node.expression)) {
        const member = node.expression.name.getText();
        const owner = node.expression.expression;
        const onProcess = typescript.isIdentifier(owner) && owner.text === "process";
        if (onProcess && member === "chdir")
          sites.push({ file, line: lineOf(sourceFile, node), code: "chdir", slot: "cwd", node });
        else if (onProcess && LISTENER_REGISTERING.includes(member))
          sites.push({
            file,
            line: lineOf(sourceFile, node),
            code: "listener_register",
            event: listenerEvent(node),
            selfRemoving: member === "once",
            node,
          });
        else if (onProcess && LISTENER_REMOVING.includes(member))
          sites.push({
            file,
            line: lineOf(sourceFile, node),
            code: "listener_remove",
            event: listenerEvent(node),
            node,
          });
      }
      if (typescript.isCallExpression(node) && typescript.isPropertyAccessExpression(node.expression)) {
        const member = node.expression.name.getText();
        const owner = node.expression.expression;
        if (
          member === "assign" &&
          typescript.isIdentifier(owner) &&
          owner.text === "Object" &&
          isWholeEnvironment(node.arguments[0])
        )
          sites.push({ file, line: lineOf(sourceFile, node), code: "env_replace", slot: null, node });
      }
      typescript.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  // The restore shape is the same for every slot: a write that lands in a `catch` clause or a `finally` block of the
  // same module. The working directory is a slot too - `process.chdir(previousCwd)` in the `finally` is what makes the
  // outward `process.chdir(root)` a scoped move rather than a process-wide one.
  const restoring = (site) =>
    site.code !== "listener_register" && site.code !== "listener_remove" && withinRestoreClause(site.node);
  const restoredSlots = new Set(sites.filter(restoring).map((site) => `${site.file}\u0000${site.slot ?? "*"}`));

  const findings = [];
  for (const site of sites) {
    if (isTestPath(site.file)) continue;
    if (site.code === "listener_register" || site.code === "listener_remove") continue;
    if (restoredSlots.has(`${site.file}\u0000${site.slot ?? "*"}`)) continue;
    if (PROCESS_GLOBAL_EXEMPTIONS.some((row) => row.id === siteKey(site))) continue;
    if (site.code === "chdir" || site.code === "cwd_write")
      findings.push({
        code: "process_working_directory_mutated",
        at: `${site.file}:${site.line}`,
        detail:
          "moves the working directory of the whole process and no `catch`/`finally` in this module moves it back, so " +
          "every relative path another party reads answers with this directory afterwards",
      });
    else
      findings.push({
        code: "process_env_write_without_restore",
        at: `${site.file}:${site.line}`,
        detail:
          `\`process.env${site.slot === null ? "" : `[${site.slot}]`}\` is written here and no \`catch\`/\`finally\` in ` +
          "this module writes it back, so the surrounding process keeps the value after this scope ends",
      });
  }
  for (const site of sites) {
    if (isTestPath(site.file) || site.code !== "listener_register" || site.selfRemoving || site.event === null)
      continue;
    if (
      sites.some((other) => other.file === site.file && other.code === "listener_remove" && other.event === site.event)
    )
      continue;
    if (PROCESS_GLOBAL_EXEMPTIONS.some((row) => row.id === siteKey(site))) continue;
    findings.push({
      code: "process_listener_never_removed",
      at: `${site.file}:${site.line}`,
      detail: `\`process.on("${site.event}", …)\` has no \`process.off\`/\`removeListener\` for the same event here`,
    });
  }
  for (const row of PROCESS_GLOBAL_EXEMPTIONS) {
    if (sites.some((site) => siteKey(site) === row.id)) continue;
    findings.push({
      code: "stale_process_global_exemption",
      at: row.id,
      detail: `the row names a site this reading no longer finds; delete it (owner: ${row.owner})`,
    });
  }

  const production = sites.filter((site) => !isTestPath(site.file));
  const writes = production.filter((site) => !site.code.startsWith("listener_"));
  const directoryWrites = writes.filter((site) => site.slot === "cwd");
  const envWrites = writes.filter((site) => site.slot !== "cwd");
  const slots = [...new Set(envWrites.map((site) => `${site.file}\u0000${site.slot ?? "*"}`))].sort();
  return {
    files: files.length,
    sites: sites.map(({ node, ...rest }) => rest),
    production: production.length,
    test: sites.length - production.length,
    writes: writes.length,
    envSlots: slots.map((key) => key.split("\u0000")[1]),
    restoredSlots: slots.filter((key) => restoredSlots.has(key)).map((key) => key.split("\u0000")[1]),
    workingDirectory: {
      mutations: directoryWrites.length,
      restored: directoryWrites.filter((site) => restoredSlots.has(`${site.file}\u0000cwd`)).length,
    },
    registrations: production.filter((site) => site.code === "listener_register").length,
    once: production.filter((site) => site.code === "listener_register" && site.selfRemoving).length,
    removals: production.filter((site) => site.code === "listener_remove").length,
    findings,
  };
}

/** Whether a name is called through one of `verbs` anywhere in the file's text. */
function mutationsOf(text, name, verbs) {
  return new RegExp(`\\b${name.replace(/\$/gu, "\\$")}\\.(?:${verbs.join("|")})\\s*\\(`, "u").test(text);
}

/** Whether a row of `MODULE_REGISTRY_DECLARATIONS` declares this module-scope registry. */
function declaresRegistry(entry) {
  return MODULE_REGISTRY_DECLARATIONS.some((row) => row.file === entry.file && row.names.includes(entry.name));
}

/**
 * CHECK 2: every module-scope declaration, the collection initialisers among them, and which of those are mutated.
 *
 * The population is every declaration at module scope rather than the collections alone, so the printed `declared at
 * module scope N` says whether the reader still reads the tree at all.
 */
export function readModuleScopeRegistries({ root = REPOSITORY_ROOT, cache } = {}) {
  const strong = [];
  const weak = [];
  const arrays = [];
  let declared = 0;
  const files = sourceFiles({ root });
  for (const file of files) {
    const sourceFile = parse(root, file, cache);
    const text = sourceFile.text;
    for (const statement of sourceFile.statements) {
      if (!typescript.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        declared += 1;
        const initializer = declaration.initializer;
        if (initializer === undefined || !typescript.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        const entry = { file, name, line: lineOf(sourceFile, declaration), test: isTestPath(file) };
        if (typescript.isNewExpression(initializer) && typescript.isIdentifier(initializer.expression)) {
          const kind = initializer.expression.text;
          if (kind === "Map" || kind === "Set")
            strong.push({
              ...entry,
              kind,
              mutated: mutationsOf(text, name, MAP_MUTATIONS),
              drained: mutationsOf(text, name, MAP_DRAINS),
            });
          else if (kind === "WeakMap" || kind === "WeakSet")
            weak.push({ ...entry, kind, mutated: mutationsOf(text, name, MAP_MUTATIONS) });
        } else if (typescript.isArrayLiteralExpression(initializer))
          arrays.push({ ...entry, kind: "array", mutated: mutationsOf(text, name, ARRAY_MUTATIONS) });
      }
    }
  }

  const findings = [];
  for (const entry of strong) {
    if (entry.test || !entry.mutated || entry.drained || declaresRegistry(entry)) continue;
    findings.push({
      code: "module_registry_without_drain",
      at: `${entry.file}:${entry.line}`,
      detail:
        `\`${entry.name}\` is a module-scope \`${entry.kind}\` that is mutated and never drains (\`.delete\`/\`.clear\`), ` +
        "so nothing bounds it but the lifetime of the process; give it a drain or a row in MODULE_REGISTRY_DECLARATIONS",
    });
  }
  for (const entry of arrays) {
    if (entry.test || !entry.mutated) continue;
    findings.push({
      code: "module_array_mutated",
      at: `${entry.file}:${entry.line}`,
      detail:
        `\`${entry.name}\` is a module-scope array literal mutated at runtime: it has no key to bound it and no drain ` +
        "obligation to state",
    });
  }
  // A declared row is judged only against a population that was measured: on a tree with no strong collection to
  // compare, every row would read stale, which is a fact about the fixture rather than about the row.
  for (const row of strong.length === 0 ? [] : MODULE_REGISTRY_DECLARATIONS) {
    for (const name of row.names) {
      const entry = strong.find((candidate) => candidate.file === row.file && candidate.name === name);
      if (entry !== undefined && entry.mutated) continue;
      findings.push({
        code: "stale_registry_declaration",
        at: `${row.file}:${name}`,
        detail:
          "the row declares this module-scope registry and the reading no longer finds it mutated here; delete the row " +
          `(owner: ${row.owner})`,
      });
    }
  }

  return {
    files: files.length,
    declared,
    strong,
    weak,
    arrays,
    collections: strong.length + weak.length + arrays.length,
    mutated: [...strong, ...weak, ...arrays].filter((entry) => entry.mutated).length,
    mutatedStrong: strong.filter((entry) => entry.mutated).map((entry) => `${entry.file}:${entry.name}`),
    weakBound: WEAK_COLLECTION_BOUND,
    findings,
  };
}

/**
 * Whether a container puts `busy_timeout` in force before its first `prepare(`.
 *
 * A container whose statements all live in helpers it calls by name has no `prepare(` of its own; the ordering question
 * then has nothing to order, and the pragma's presence is the whole reading.
 */
function busyTimeoutBeforeFirstStatement(sourceFile, containerNode) {
  let budget = null;
  let firstPrepare = null;
  const visit = (node) => {
    if (typescript.isCallExpression(node) && typescript.isPropertyAccessExpression(node.expression)) {
      const member = node.expression.name.getText();
      if ((member === "exec" || member === "prepare") && node.arguments.length > 0) {
        const start = node.getStart(sourceFile);
        if (member === "exec" && /busy_timeout/u.test(flat(sourceFile, node)) && budget === null)
          budget = { start, line: lineOf(sourceFile, node) };
        if (member === "prepare" && firstPrepare === null) firstPrepare = { start, line: lineOf(sourceFile, node) };
      }
    }
    typescript.forEachChild(node, visit);
  };
  visit(containerNode);
  return {
    inForce: budget !== null && (firstPrepare === null || budget.start < firstPrepare.start),
    busyTimeoutLine: budget === null ? null : budget.line,
    firstPrepareLine: firstPrepare === null ? null : firstPrepare.line,
  };
}

/**
 * CHECK 3: every `new DatabaseSync(` site, classified from its own arguments, and whether a writable one is opened by a
 * container that puts `busy_timeout` in force before its first `prepare(`.
 */
export function readSqliteConnections({ root = REPOSITORY_ROOT, cache } = {}) {
  const sites = [];
  const files = sourceFiles({ root });
  for (const file of files) {
    const sourceFile = parse(root, file, cache);
    const functions = declaredFunctions(sourceFile);
    const visit = (node) => {
      if (
        typescript.isNewExpression(node) &&
        typescript.isIdentifier(node.expression) &&
        node.expression.text === "DatabaseSync"
      ) {
        const options =
          node.arguments === undefined ? [] : node.arguments.map((argument) => flat(sourceFile, argument));
        const container = enclosingFunctionName(sourceFile, node);
        sites.push({
          file,
          line: lineOf(sourceFile, node),
          test: isTestPath(file),
          argument: options.join(", "),
          kind: options.some((option) => /^":memory:"$/u.test(option))
            ? "in_memory"
            : options.some((option) => /readOnly:\s*true/u.test(option))
              ? "read_only"
              : "writable",
          container,
          containerNode: functions.find((entry) => entry.name === container)?.node ?? null,
          sourceFile,
        });
      }
      typescript.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const findings = [];
  const containers = [];
  for (const site of sites) {
    if (site.test || site.kind !== "writable") continue;
    const declared = WRITABLE_CONTAINERS.find((row) => row.container === site.container);
    if (declared === undefined) {
      findings.push({
        code: "sqlite_connection_outside_a_factory",
        at: `${site.file}:${site.line}`,
        detail:
          `\`new DatabaseSync(${site.argument})\` opens a writable store connection in ` +
          `${site.container === null ? "no named function" : `\`${site.container}\``}, which is not one of ` +
          `${WRITABLE_CONTAINERS.map((row) => row.container).join(", ")}: a store owns one connection and the pragma ` +
          "that makes it safe",
      });
      continue;
    }
    const order =
      site.containerNode === null
        ? { inForce: false, busyTimeoutLine: null, firstPrepareLine: null }
        : busyTimeoutBeforeFirstStatement(site.sourceFile, site.containerNode);
    containers.push({ container: declared.container, file: site.file, line: site.line, ...order });
    if (!order.inForce)
      findings.push({
        code: "sqlite_writable_open_without_busy_timeout",
        at: `${declared.container}:${site.line}`,
        detail:
          `\`${declared.container}\` opens a writable connection without putting \`busy_timeout\` in force before its ` +
          "first `prepare(`; a contending writer then fails instead of waiting (owner: " +
          `${declared.owner})`,
      });
  }
  // The same rule as the registry rows: a container can only be called stale against a tree where connections were found.
  for (const row of sites.length === 0 ? [] : WRITABLE_CONTAINERS) {
    if (sites.some((site) => !site.test && site.kind === "writable" && site.container === row.container)) continue;
    findings.push({
      code: "sqlite_container_declaration_stale",
      at: row.container,
      detail: `the row names a container that opens no writable connection any more; delete it (owner: ${row.owner})`,
    });
  }

  const production = sites.filter((site) => !site.test);
  return {
    files: files.length,
    sites: sites.map(({ containerNode, sourceFile, ...rest }) => rest),
    production: production.length,
    test: sites.filter((site) => site.test).length,
    writable: production.filter((site) => site.kind === "writable").length,
    readOnly: production.filter((site) => site.kind === "read_only").length,
    inMemory: production.filter((site) => site.kind === "in_memory").length,
    containers,
    findings,
  };
}

/**
 * CHECK 4: every helper taking the critical section as a `work` callback, its family, and every call site that hands one
 * an `async` function.
 *
 * A `work: () => Promise<T>` parameter AWAITS the body; a `work: () => T` one does not and must therefore refuse a
 * thenable at runtime. The rejection is followed one hop: a synchronous helper that passes `work` to another
 * synchronous helper inherits that helper's rejection.
 */
export function readLockHelpers({ root = REPOSITORY_ROOT, cache } = {}) {
  const helpers = [];
  const callSites = [];
  const files = sourceFiles({ root });
  for (const file of files) {
    const sourceFile = parse(root, file, cache);
    for (const entry of declaredFunctions(sourceFile)) {
      const parameters = entry.node.parameters ?? [];
      const workIndex = parameters.findIndex(
        (parameter) =>
          typescript.isIdentifier(parameter.name) &&
          parameter.name.text === "work" &&
          parameter.type !== undefined &&
          parameter.type.getText(sourceFile).includes("=>"),
      );
      if (workIndex < 0) continue;
      const typeText = parameters[workIndex].type.getText(sourceFile).replace(/\s+/gu, " ");
      helpers.push({
        file,
        name: entry.name,
        line: lineOf(sourceFile, entry.node),
        test: isTestPath(file),
        workIndex,
        signature: `${entry.name}(${parameters.map((parameter) => flat(sourceFile, parameter)).join(", ")})`,
        type: typeText,
        family: /=>\s*Promise</u.test(typeText) ? "awaits" : "synchronous",
        node: entry.node,
        sourceFile,
        rejectsThenable: callsIn(sourceFile, entry.node, ["isThenable"]).length > 0,
      });
    }
  }

  // Which synchronous helper each one hands `work` to, read after the whole population exists.
  const synchronous = new Set(helpers.filter((helper) => helper.family === "synchronous").map((helper) => helper.name));
  for (const helper of helpers) {
    helper.delegatesTo = callsIn(helper.sourceFile, helper.node, [...synchronous]).map((call) => call.called);
  }
  const rejecting = new Set(helpers.filter((helper) => helper.rejectsThenable).map((helper) => helper.name));
  let grew = true;
  while (grew) {
    grew = false;
    for (const helper of helpers) {
      if (helper.family !== "synchronous" || rejecting.has(helper.name)) continue;
      if (helper.delegatesTo.some((name) => rejecting.has(name))) {
        rejecting.add(helper.name);
        grew = true;
      }
    }
  }

  // A call site may live in ANY module, not only the one that declares the helper, so the census walks the whole scope
  // and resolves a call by the name it uses. Where two helpers in one reading share a name, a site they both answer is
  // held only when every one of them holds it - the conservative direction, and the ambiguity is printed.
  for (const helper of helpers) helper.holdsBody = helper.family === "awaits" || rejecting.has(helper.name);
  const byName = new Map();
  for (const helper of helpers) {
    if (!byName.has(helper.name)) byName.set(helper.name, []);
    byName.get(helper.name).push(helper);
  }
  const seen = new Set();
  for (const file of files) {
    const sourceFile = parse(root, file, cache);
    const visit = (node) => {
      if (typescript.isCallExpression(node)) {
        const callee = node.expression;
        const called = typescript.isIdentifier(callee)
          ? callee.text
          : typescript.isPropertyAccessExpression(callee)
            ? callee.name.getText(sourceFile)
            : null;
        const named = called === null ? undefined : byName.get(called);
        if (named !== undefined) {
          const argument = named
            .map((helper) => node.arguments[helper.workIndex])
            .find((candidate) => candidate !== undefined);
          const passesAsyncFunction =
            argument !== undefined &&
            (typescript.isArrowFunction(argument) || typescript.isFunctionExpression(argument)) &&
            /^async\b/u.test(argument.getText(sourceFile).trimStart());
          const line = lineOf(sourceFile, node);
          const key = `${file}:${line}:${called}`;
          if (passesAsyncFunction && !seen.has(key)) {
            seen.add(key);
            callSites.push({
              file,
              line,
              helper: called,
              held: named.every((helper) => helper.holdsBody),
              test: isTestPath(file),
            });
          }
        }
      }
      typescript.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const findings = [];
  for (const helper of helpers) {
    if (helper.test || helper.family !== "synchronous" || helper.holdsBody) continue;
    findings.push({
      code: "sync_lock_body_without_thenable_rejection",
      at: `${helper.file}:${helper.line}`,
      detail:
        `\`${helper.name}\` takes \`work: ${helper.type}\`, so it cannot await the body and does not refuse a promise one ` +
        "returns: the section is released before the work settles, and nothing reports it",
    });
  }
  for (const site of callSites) {
    if (site.test || site.held) continue;
    findings.push({
      code: "lock_body_escapes_the_critical_section",
      at: `${site.file}:${site.line}`,
      detail: `an \`async\` body is handed to \`${site.helper}\`, which neither awaits it nor rejects it`,
    });
  }

  const tail = readPathLockTail({ root, cache });
  findings.push(...tail.findings);
  return {
    files: files.length,
    helpers: helpers.map(({ node, sourceFile, ...rest }) => rest),
    callSites,
    rejectingSynchronous: helpers
      .filter((helper) => helper.family === "synchronous" && helper.holdsBody)
      .map((helper) => `${helper.file}:${helper.name}`),
    tail,
    findings,
  };
}

/**
 * The tail protocol of `withPathLock`: one release, and a delete that only removes the tail it still holds.
 *
 * `TAIL_MAP` and `TAIL_RELEASE` are the names the protocol is made of. A rename reds here on purpose: the reading is
 * positional, so it must not pretend to follow a protocol it can no longer recognise.
 */
export function readPathLockTail({ root = REPOSITORY_ROOT, cache } = {}) {
  let sourceFile;
  try {
    sourceFile = parse(root, PATH_LOCK, cache);
  } catch {
    return { present: false, findings: [] };
  }
  const helper = declaredFunctions(sourceFile).find((entry) => entry.name === PATH_LOCK_HELPER);
  if (helper === undefined) return { present: false, findings: [] };
  const releases = callsIn(sourceFile, helper.node, [TAIL_RELEASE]).length;
  let identityGuardedDelete = false;
  const visit = (node) => {
    if (
      typescript.isIfStatement(node) &&
      typescript.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === typescript.SyntaxKind.EqualsEqualsEqualsToken &&
      typescript.isCallExpression(node.expression.left) &&
      typescript.isPropertyAccessExpression(node.expression.left.expression) &&
      node.expression.left.expression.name.getText() === "get" &&
      namesTheTailMap(node.expression.left.expression.expression) &&
      drainsTailMap(sourceFile, node.thenStatement)
    )
      identityGuardedDelete = true;
    typescript.forEachChild(node, visit);
  };
  visit(helper.node);

  const findings = [];
  const line = lineOf(sourceFile, helper.node);
  if (releases !== 1)
    findings.push({
      code: "lock_tail_released_more_than_once",
      at: `${PATH_LOCK}:${line}`,
      detail:
        `\`${PATH_LOCK_HELPER}\` calls \`${TAIL_RELEASE}()\` ${releases} time(s); the tail it claimed must be released ` +
        "exactly once, or a second release settles the place the next acquirer is already waiting on",
    });
  if (!identityGuardedDelete)
    findings.push({
      code: "lock_tail_deleted_without_identity_check",
      at: `${PATH_LOCK}:${line}`,
      detail:
        `\`${PATH_LOCK_HELPER}\` must delete \`${TAIL_MAP}\` only when \`${TAIL_MAP}.get(…) === tail\`; deleting an entry ` +
        "it does not hold strands every later acquirer behind a promise nobody settles",
    });
  return {
    present: true,
    helper: PATH_LOCK_HELPER,
    releases,
    identityGuardedDelete,
    findings,
  };
}

/** Why a check could not measure, or `null` when every population was found. */
function blockedReasons({ process: processReading, registries, connections, locks }) {
  const reasons = [];
  if (processReading.files === 0) reasons.push(`concurrency_hygiene_no_host_source: no file under ${HOST_SOURCE}`);
  if (processReading.sites.length === 0)
    reasons.push(
      `process_global_population_empty: ${processReading.files} file(s) carry no write to \`process.env\`, ` +
        "`process.cwd`, `process.chdir` and no `process.on`/`off` call, so this scan lost its reader",
    );
  if (registries.declared === 0) reasons.push("module_scope_population_empty: no module-scope declaration was found");
  if (registries.strong.length === 0)
    reasons.push(
      `module_scope_strong_population_empty: ${registries.declared} module-scope declaration(s) and not one strong ` +
        "`Map`/`Set`, so the kind this check judges cannot be told from a reader that stopped recognising it",
    );
  if (connections.sites.length === 0)
    reasons.push(`sqlite_connection_population_empty: no \`new DatabaseSync(\` site under ${HOST_SOURCE}`);
  if (locks.helpers.length === 0)
    reasons.push("lock_helper_population_empty: no function takes a `work` callback, so no lock body can be paired");
  if (!locks.tail.present)
    reasons.push(`lock_tail_protocol_subject_missing: ${PATH_LOCK} declares no \`${PATH_LOCK_HELPER}\``);
  return reasons;
}

/**
 * The whole reading: four populations, their findings, and one verdict.
 *
 * `examined` is the four populations added up, which is the number the shared judge reads: `0 findings` means nothing
 * without it.
 */
export function checkConcurrencyHygiene({ root = REPOSITORY_ROOT } = {}) {
  const cache = new Map();
  const processReading = readProcessGlobalMutations({ root, cache });
  const registries = readModuleScopeRegistries({ root, cache });
  const connections = readSqliteConnections({ root, cache });
  const locks = readLockHelpers({ root, cache });
  const findings = [...processReading.findings, ...registries.findings, ...connections.findings, ...locks.findings];
  const blocked = blockedReasons({ process: processReading, registries, connections, locks });
  // Blocked before failed, the way every gate in this tree answers a lost population: an exit code cannot tell a
  // measurement that did not happen from one that happened and found a violation, so the missing measurement wins and
  // the findings it did produce are still printed beside the reasons.
  const status = blocked.length > 0 ? "blocked" : findings.length > 0 ? "failed" : "passed";
  const verdict = (codes) => {
    if (findings.some((finding) => codes.includes(finding.code))) return "failed";
    return blocked.some((reason) => codes.includes(reason.split(":")[0])) ? "blocked" : "passed";
  };

  const checks = [
    {
      id: "process_global_writes_are_restored",
      status: verdict([
        "process_env_write_without_restore",
        "process_listener_never_removed",
        "process_working_directory_mutated",
        "stale_process_global_exemption",
      ]),
      detail:
        `${processReading.writes} production write(s) (${processReading.workingDirectory.mutations} of the working ` +
        `directory, ${processReading.workingDirectory.restored} restored), ${processReading.registrations} ` +
        `registration(s) (${processReading.once} self-removing), ${processReading.removals} removal(s), ` +
        `${processReading.restoredSlots.length}/${processReading.envSlots.length} env slot(s) restored`,
    },
    {
      id: "module_registries_are_bounded",
      status: verdict(["module_registry_without_drain", "module_array_mutated", "stale_registry_declaration"]),
      detail:
        `declared at module scope ${registries.declared} · collection initialisers ${registries.collections} · ` +
        `strong ${registries.strong.length} · weak ${registries.weak.length} · arrays ${registries.arrays.length} · ` +
        `mutated ${registries.mutated}`,
    },
    {
      id: "store_connections_are_opened_by_a_factory",
      status: verdict([
        "sqlite_connection_outside_a_factory",
        "sqlite_writable_open_without_busy_timeout",
        "sqlite_container_declaration_stale",
      ]),
      detail:
        `${connections.production} production connection(s): ${connections.writable} writable, ` +
        `${connections.readOnly} read-only, ${connections.inMemory} in memory`,
    },
    {
      id: "lock_bodies_and_signatures_agree",
      status: verdict([
        "sync_lock_body_without_thenable_rejection",
        "lock_body_escapes_the_critical_section",
        "lock_tail_released_more_than_once",
        "lock_tail_deleted_without_identity_check",
      ]),
      detail:
        `${locks.helpers.length} \`work\`-taking helper(s): ` +
        `${locks.helpers.filter((helper) => helper.family === "awaits").length} await the body, ` +
        `${locks.helpers.filter((helper) => helper.family === "synchronous").length} are synchronous ` +
        `(${locks.rejectingSynchronous.length} reject a thenable) · ` +
        `${locks.callSites.length} \`async\` call site(s), ${locks.callSites.filter((site) => site.held).length} held`,
    },
  ];

  return {
    gate: "concurrency-hygiene",
    status,
    examined: processReading.sites.length + registries.declared + connections.sites.length + locks.helpers.length,
    files: processReading.files,
    process: processReading,
    registries,
    connections,
    locks,
    checks,
    findings,
    ...(blocked.length === 0 ? {} : { blocked }),
  };
}

/**
 * The one document this gate reports, so `--json` and the last line of the human run cannot say two things.
 *
 * `examined` is the population the shared judge reads; every bucket the run counted is beside it, so a reader can tell a
 * measured tree from a lost reader without re-deriving anything.
 */
export function reportDocument(result) {
  return {
    gate: result.gate,
    status: result.status,
    examined: result.examined,
    files: result.files,
    process: {
      production: result.process.production,
      test: result.process.test,
      writes: result.process.writes,
      registrations: result.process.registrations,
      removals: result.process.removals,
      envSlots: result.process.envSlots,
      restoredSlots: result.process.restoredSlots,
      workingDirectory: result.process.workingDirectory,
    },
    registries: {
      declared: result.registries.declared,
      collections: result.registries.collections,
      strong: result.registries.strong.length,
      weak: result.registries.weak.length,
      arrays: result.registries.arrays.length,
      mutated: result.registries.mutated,
      mutatedStrong: result.registries.mutatedStrong,
    },
    connections: {
      production: result.connections.production,
      test: result.connections.test,
      writable: result.connections.writable,
      readOnly: result.connections.readOnly,
      inMemory: result.connections.inMemory,
      containers: result.connections.containers,
    },
    locks: {
      helpers: result.locks.helpers.map((helper) => ({
        file: helper.file,
        line: helper.line,
        name: helper.name,
        family: helper.family,
        signature: helper.signature,
        type: helper.type,
      })),
      asyncCallSites: result.locks.callSites,
      rejectingSynchronous: result.locks.rejectingSynchronous,
      tail: result.locks.tail,
    },
    checks: result.checks,
    findings: result.findings,
    ...(result.blocked === undefined ? {} : { blocked: result.blocked }),
  };
}

/** The reading as the lines a reader needs: the four populations first, then the findings, then the report. */
export function renderConcurrencyHygieneReport(result, out = process.stdout) {
  out.write(
    `files examined ${result.files} under ${HOST_SOURCE} · process-global sites ${result.process.sites.length} ` +
      `(production ${result.process.production}, test ${result.process.test}) · module-scope declarations ` +
      `${result.registries.declared} · sqlite connections ${result.connections.sites.length} (production ` +
      `${result.connections.production}) · lock helpers ${result.locks.helpers.length}\n`,
  );
  out.write(
    `  module scope: collections ${result.registries.collections} (strong ${result.registries.strong.length}, weak ` +
      `${result.registries.weak.length}, arrays ${result.registries.arrays.length}) · mutated ${result.registries.mutated}\n`,
  );
  if (result.registries.weak.length > 0)
    out.write(`  weak collections need no drain: ${result.registries.weakBound}\n`);
  for (const helper of result.locks.helpers)
    out.write(
      `  section ${helper.family.padEnd(11)} ${helper.file}:${helper.line} ${helper.signature} -> ${helper.type}` +
        ` · ${result.locks.callSites.filter((site) => site.helper === helper.name && site.held).length} async body(s) held\n`,
    );
  for (const site of result.locks.callSites.filter((candidate) => !candidate.held))
    out.write(`  section call site ${site.helper}: ${site.file}:${site.line} (escapes)\n`);
  for (const check of result.checks) out.write(`  ${check.id}: ${check.status} (${check.detail})\n`);
  for (const finding of result.findings) out.write(`${finding.code}: ${finding.at} - ${finding.detail}\n`);
  for (const reason of result.blocked ?? []) out.write(`blocked: ${reason}\n`);
  out.write(`${JSON.stringify(reportDocument(result))}\n`);
}

function main(argv) {
  const root = rootFromArgv(argv, REPOSITORY_ROOT);
  const result = checkConcurrencyHygiene({ root });
  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(reportDocument(result))}\n`);
  else renderConcurrencyHygieneReport(result, process.stdout);
  return EXIT_STATUS[result.status];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  process.exitCode = main(process.argv.slice(2));
