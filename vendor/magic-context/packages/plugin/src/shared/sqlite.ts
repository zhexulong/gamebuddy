/**
 * SQLite chokepoint — runtime-detected backend selection.
 *
 * The same shipped plugin artifact must run under two different runtimes:
 *   - Bun (current OpenCode releases) → uses `bun:sqlite` (built-in, fast)
 *   - Node / Electron (Pi plugin, OpenCode Desktop) → uses `node:sqlite`
 *     (`DatabaseSync`, built into Node 22.5+ / Electron 41+, stable-enough and
 *     flag-free since Node 22.13/23.4).
 *
 * Bun has no `node:sqlite`, and Node/Electron have no `bun:sqlite`. Static
 * imports of either would crash at parse time in the wrong runtime, so we use
 * dynamic imports gated by runtime detection.
 *
 * Why `node:sqlite` instead of `better-sqlite3`: better-sqlite3 is a native
 * module requiring per-ABI prebuilds, and Electron's ABI never matches the npm
 * Node prebuild — which forced a runtime download of an Electron-matched
 * `.node` binary (a supply-chain + maintenance liability). `node:sqlite` is
 * built into the runtime, so there is NOTHING to download or rebuild. Both Pi
 * (plain Node 24) and OpenCode Desktop (Electron 41 → Node 24.14.1) ship it.
 *
 * API surface we use (common across both backends, modulo the shims below):
 *   - new Database(path, { readonly?: boolean })   ← we map readonly→readOnly
 *   - db.prepare(sql).run/get/all
 *   - db.exec(multistatement)
 *   - db.transaction(fn) → wrapped function        ← shimmed for node:sqlite
 *   - db.close()
 *
 * The three backend differences we bridge for node:sqlite:
 *   1. node:sqlite has no `db.transaction(fn)` helper — we add a savepoint-aware
 *      shim (below) that matches better-sqlite3/bun semantics.
 *   2. node:sqlite's constructor option is `readOnly` (camel-case), not
 *      better-sqlite3/bun's `readonly` — we translate it so call sites are
 *      unchanged.
 *   3. node:sqlite reads a lone array bind arg (`.run([a,b])`) as NAMED params
 *      and throws `Unknown named parameter '0'`; bun binds it positionally. We
 *      normalize it in the `prepare()` override (below) so the bind surface is
 *      identical (issue #151 / Pi /ctx-dream).
 * Everything else (named params with bare keys, ATTACH under defensive mode,
 * `run()` → {changes,lastInsertRowid}) is identical and was verified directly.
 */

// Type import only — runtime is loaded dynamically below. @types/better-sqlite3
// has the richest definitions and is a structural superset of the API surface
// we use, so calls typed against BetterSqlite3 work under bun:sqlite and
// node:sqlite at runtime (both expose prepare/run/get/all/exec/close).
import type BetterSqlite3 from "better-sqlite3";

// Detect Bun via process.versions.bun. Both globalThis.Bun and
// process.versions.bun are set by the Bun runtime, but process.versions
// is a lower-level surface less likely to be sandboxed by host runtimes
// (e.g. Electron in OpenCode desktop apps that re-expose a Bun-flavored
// environment). Real Node and Electron never set this field.
const isBun = typeof process !== "undefined" && typeof process.versions?.bun === "string";

// IMPORTANT: bundler-evading dynamic imports.
//
// We can't write `await import("node:sqlite")` directly because esbuild/bun
// would try to resolve both modules at build time, and one of them won't exist
// in the build runtime (bun:sqlite is missing in Node, node:sqlite is missing
// in Bun). Earlier versions used `new Function("p", "return import(p)")(...)`
// to defeat static analysis, but that breaks Pi's vm-based extension loader: a
// Function constructed at runtime has no module record, so `import()` inside it
// has no referrer module and Node throws "A dynamic import callback was not
// specified".
//
// The /* @vite-ignore */ + variable indirection pattern hides the specifier
// from static analyzers while keeping a real referrer module for the
// dynamic import — Pi's loader, esbuild, and bun build all accept it.
const bunSpec = "bun:" + "sqlite";
const nodeSpec = "node:" + "sqlite";

const sqliteModule = isBun
    ? await import(/* @vite-ignore */ bunSpec)
    : await import(/* @vite-ignore */ nodeSpec);

// Different export shapes between the two backends:
//   - bun:sqlite  → named export `Database` (has its own .transaction, accepts
//     `{ readonly }`) — usable as-is.
//   - node:sqlite → named export `DatabaseSync` (no .transaction, option is
//     `readOnly`) — wrapped below.
const DatabaseImpl: typeof BetterSqlite3 = isBun
    ? (sqliteModule.Database as typeof BetterSqlite3)
    : buildNodeSqliteDatabaseClass(sqliteModule.DatabaseSync);

/**
 * Wrap node:sqlite's `DatabaseSync` so it presents the better-sqlite3/bun
 * surface the rest of the codebase calls:
 *   - translate the `{ readonly }` constructor option → node:sqlite's `readOnly`
 *   - add a `transaction(fn)` helper that matches better-sqlite3 semantics,
 *     using `db.isTransaction` to pick BEGIN (top-level) vs SAVEPOINT (nested),
 *     so it composes correctly with manual `BEGIN IMMEDIATE` blocks too.
 */
// biome-ignore lint/suspicious/noExplicitAny: node:sqlite has no shipped types here; the public export is cast to the better-sqlite3 shape.
function buildNodeSqliteDatabaseClass(DatabaseSync: any): typeof BetterSqlite3 {
    // Single constant savepoint name is correct for arbitrary nesting depth:
    // SQLite savepoints with the same name stack LIFO — RELEASE / ROLLBACK TO
    // always target the most recent. node:sqlite is synchronous + single-process
    // per connection, so there is no concurrent-savepoint hazard.
    const SAVEPOINT = "mc_tx_sp";

    class NodeSqliteDatabase extends DatabaseSync {
        constructor(filename?: string | Buffer, options?: BetterSqlite3.Options) {
            const translated: Record<string, unknown> = { ...options };
            if (options && "readonly" in options) {
                translated.readOnly = (options as { readonly?: boolean }).readonly;
                delete translated.readonly;
            }
            super(typeof filename === "string" ? filename : ":memory:", translated);
        }

        // Normalize a single ARRAY bind arg to spread positional, matching
        // bun:sqlite. bun's `.run([a,b])` binds positionally; node:sqlite instead
        // reads a lone array as NAMED params with keys "0","1" and throws
        // `Unknown named parameter '0'`. That divergence let an array-form bind
        // (e.g. `.run([x, y])`) silently work on OpenCode/Bun yet break Pi and
        // OpenCode Desktop (both node:sqlite) — issue #151 (/ctx-dream). Wrapping
        // every prepared statement here keeps the two backends' bind surface
        // truly identical so this whole class is impossible regardless of how a
        // call site writes its bind. Named-object binds (`.run({k:v})`), no-arg
        // calls, and already-spread positional args are passed through unchanged;
        // the normalization only triggers on the exact 1-array shape. Overhead
        // measured at ~12ns/call against real node:sqlite (negligible).
        // biome-ignore lint/suspicious/noExplicitAny: node:sqlite StatementSync has no shipped types here.
        prepare(sql: string): any {
            const stmt = super.prepare(sql);
            for (const method of ["run", "get", "all"] as const) {
                const original = stmt[method].bind(stmt);
                stmt[method] = (...args: unknown[]): unknown =>
                    args.length === 1 && Array.isArray(args[0])
                        ? original(...args[0])
                        : original(...args);
            }
            return stmt;
        }

        // biome-ignore lint/suspicious/noExplicitAny: mirrors better-sqlite3's generic transaction(fn) signature.
        transaction<F extends (...args: any[]) => any>(fn: F): F {
            // biome-ignore lint/suspicious/noExplicitAny: faithful pass-through of this/args to fn.
            const self = this as any;
            const execute = (
                mode: "" | "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE",
                receiver: unknown,
                args: unknown[],
            ) => {
                const nested = self.isTransaction === true;
                self.exec(nested ? `SAVEPOINT ${SAVEPOINT}` : `BEGIN${mode ? ` ${mode}` : ""}`);
                try {
                    const result = fn.apply(receiver, args);
                    self.exec(nested ? `RELEASE ${SAVEPOINT}` : "COMMIT");
                    return result;
                } catch (error) {
                    if (nested) {
                        // ROLLBACK TO unwinds the savepoint's changes but leaves
                        // it on the stack; RELEASE then pops it (better-sqlite3
                        // does both).
                        self.exec(`ROLLBACK TO ${SAVEPOINT}`);
                        self.exec(`RELEASE ${SAVEPOINT}`);
                    } else {
                        self.exec("ROLLBACK");
                    }
                    throw error;
                }
            };
            const wrapped = function (this: unknown, ...args: unknown[]): unknown {
                return execute("", this, args);
            };
            wrapped.default = function (this: unknown, ...args: unknown[]): unknown {
                return execute("", this, args);
            };
            wrapped.deferred = function (this: unknown, ...args: unknown[]): unknown {
                return execute("DEFERRED", this, args);
            };
            wrapped.immediate = function (this: unknown, ...args: unknown[]): unknown {
                return execute("IMMEDIATE", this, args);
            };
            wrapped.exclusive = function (this: unknown, ...args: unknown[]): unknown {
                return execute("EXCLUSIVE", this, args);
            };
            return wrapped as unknown as F;
        }
    }

    return NodeSqliteDatabase as unknown as typeof BetterSqlite3;
}

export const Database: typeof BetterSqlite3 = DatabaseImpl;

/** Instance type alias used by helpers and storage modules. */
export type Database = BetterSqlite3.Database;

/**
 * Statement instance type used for WeakMap caches throughout the codebase.
 *
 * We deliberately use the variadic Statement<unknown[], unknown> shape rather
 * than `ReturnType<Database["prepare"]>` because the latter resolves through
 * a conditional return type in @types/better-sqlite3 that confuses TypeScript
 * about how many arguments .run/.get/.all accept. With this explicit type,
 * cached statements accept any number of bind args (matching bun:sqlite's
 * historical behavior in this codebase).
 */
export type Statement = BetterSqlite3.Statement<unknown[], unknown>;

const privilegeDepth = new WeakMap<Database, number>();
const registeredPrivilegeFunctions = new WeakSet<Database>();
const privilegeUdfAvailable = new WeakSet<Database>();

/** Register the connection-local privilege predicate used by managed-write guards. */
export function registerPrivilegedWriter(db: Database): void {
    if (registeredPrivilegeFunctions.has(db)) return;
    const native = db as unknown as {
        function?: (name: string, implementation: () => number) => void;
        createFunction?: (name: string, implementation: () => number) => void;
    };
    const implementation = (): number => ((privilegeDepth.get(db) ?? 0) > 0 ? 1 : 0);
    if (typeof native.function === "function") {
        native.function("mc_privileged_writer", implementation);
    } else if (typeof native.createFunction === "function") {
        native.createFunction("mc_privileged_writer", implementation);
    } else {
        // Older Bun releases do not expose scalar UDF registration. Migration 55
        // retains the pre-UDF state-table trigger on those runtimes.
        registeredPrivilegeFunctions.add(db);
        return;
    }
    privilegeUdfAvailable.add(db);
    registeredPrivilegeFunctions.add(db);
}

function isInTransaction(db: Database): boolean {
    const candidate = db as unknown as { inTransaction?: unknown; isTransaction?: unknown };
    return candidate.inTransaction === true || candidate.isTransaction === true;
}

/**
 * Run a storage operation while the connection-local privilege predicate is enabled.
 * The depth lives outside SQLite, so a second connection can never observe or inherit it.
 */
export function withPrivilegedWriter<T>(db: Database, operation: () => T): T {
    registerPrivilegedWriter(db);
    const previousDepth = privilegeDepth.get(db) ?? 0;
    const nested = isInTransaction(db);
    const savepoint = "mc_privilege_scope";
    if (nested) {
        db.exec(`SAVEPOINT ${savepoint}`);
    } else {
        db.exec("BEGIN IMMEDIATE");
    }
    privilegeDepth.set(db, previousDepth + 1);
    try {
        if (!privilegeUdfAvailable.has(db)) {
            db.prepare(
                "INSERT INTO context_privilege_state(id, enabled) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET enabled = 1",
            ).run();
        }
        const result = operation();
        if (!privilegeUdfAvailable.has(db) && previousDepth === 0) {
            db.prepare("UPDATE context_privilege_state SET enabled = 0 WHERE id = 1").run();
        }
        if (nested) {
            db.exec(`RELEASE ${savepoint}`);
        } else {
            db.exec("COMMIT");
        }
        if (previousDepth > 0) privilegeDepth.set(db, previousDepth);
        else privilegeDepth.delete(db);
        return result;
    } catch (error) {
        try {
            if (nested) {
                db.exec(`ROLLBACK TO ${savepoint}`);
                db.exec(`RELEASE ${savepoint}`);
            } else {
                db.exec("ROLLBACK");
            }
        } finally {
            if (previousDepth > 0) privilegeDepth.set(db, previousDepth);
            else privilegeDepth.delete(db);
        }
        throw error;
    }
}
