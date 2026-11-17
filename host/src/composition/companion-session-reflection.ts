/**
 * The companion's reflection: one per Host session, recorded at the exit and RUN on the next launch.
 *
 * Owner ruling E for this product: reflection is not a cron task. Magic Context's own scheduler was measured on
 * this runtime - its first tick waits a two-minute quiet window and the periodic tick is fifteen minutes, both
 * `unref`'d - so a play session that lasts minutes never reaches a tick at all, however a task is scheduled. The
 * Host therefore asks for exactly one reflection per session end, which is also the moment the material it
 * reflects on is complete.
 *
 * It is not run there. Measured on this runtime, one reflection is a spawned `pi` model call - 8 748 ms against a
 * reachable provider, 4 306 ms against one that rejected the key - so running it inside the exit spends provider
 * time and wall clock on a call nobody is waiting for, on the one path where the player is trying to leave
 * (Windows reads that as "this app is preventing shutdown"). The exit therefore records a bounded local marker
 * (one file write) and the reflection runs beside the next launch's shell, where its output can still be read; a
 * reflection that fails is retried by the marker's own attempt count and, past that, abandoned with its own name.
 *
 * What any of it writes is an ordinary memory row (`sourceType: "dreamer"`); it does not touch compartments,
 * chapters, m0, or the player's own text.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { resolveRuntimePaths } from "../runtime-identity.js";

/**
 * The shape this module relies on from the vendored package's `./dreamer` entry.
 *
 * Stated here rather than imported for the same reason the import below spells the specifier at the call site: the
 * package publishes that subpath at runtime but emits no declarations for it (`src/magic-context-dreamer-subpath.d.ts`
 * says why), and its declaration build cannot be widened to include the entry without dragging in optional Pi peers
 * that exist only at runtime. Stating the consumed surface keeps this module typed without a second source of truth
 * for the parts it does not use.
 */
interface DreamerSubpath {
  openRuntimeDatabase: () => {
    prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
  } | null;
  loadPiConfig: () => Readonly<{ config: unknown }>;
  dreamerRunConfig: (config: unknown, fallback: unknown) => unknown;
  registerPiDreamerProject: (options: Readonly<Record<string, unknown>>) => void;
  runPiDreamForProject: (projectIdentity: string, task: string, registrationOwner: object) => Promise<unknown>;
  unregisterPiDreamerProject: (options: Readonly<{ projectIdentity: string; registrationOwner: object }>) => void;
}

/** The bounded outcome one session-end reflection reports. */
export type CompanionSessionReflectionOutcome = "completed" | "not_applicable" | "failed";

export type CompanionSessionReflectionInput = Readonly<{
  /** The runtime root the conversation ran in; its store is under `data/cortexkit/magic-context`. */
  runtimeCwd: string;
  /** How long the whole attempt may take. The reclamation gives it its own step budget too. */
  timeoutMs?: number;
}>;

/**
 * How long one reflection attempt may take when a launch runs a deferred one.
 *
 * It bounds the promise this launch is waiting on, not the spawned model call: the vendored dreamer spawns its own
 * `pi` child and abandons nothing when this expires, so the launch records the failure and the next launch retries.
 */
export const DEFAULT_REFLECTION_TIMEOUT_MS = 60_000;

/**
 * Runs one reflection against an existing runtime root.
 *
 * The store is resolved by the vendored package when its module loads, from the ambient data layout, so the
 * environment is pointed at this runtime root *before* the import - a root passed only as an argument would read
 * whichever store the process happens to default to (measured: another root's rows). The identity to reflect on
 * comes from that store's own meta row rather than from a caller: deriving one from a directory lands on a
 * different partition whenever the run's identity came from a git root, and the task would then reflect on
 * nothing.
 *
 * Never throws: every failure is one bounded outcome, because this runs on the exit path and a failure here must
 * not become a second failure of the exit it describes.
 */
export async function reflectCompanionSessionOnce(
  input: CompanionSessionReflectionInput,
): Promise<CompanionSessionReflectionOutcome> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_REFLECTION_TIMEOUT_MS;
  // Absolute, always: the vendored package refuses a relative storage directory, and a caller that hands one in
  // would otherwise fail in a way that looks like "the reflection never works".
  const dataRoot = join(resolve(input.runtimeCwd), "data");
  const previous = {
    storage: process.env.MAGIC_CONTEXT_STORAGE_DIR,
    xdgData: process.env.XDG_DATA_HOME,
    xdgConfig: process.env.XDG_CONFIG_HOME,
  };
  // Point the store and the config at this runtime root, in the same shape the runtime itself uses while it is
  // mounted, so the reflection reads and writes the store that belongs to this conversation.
  process.env.MAGIC_CONTEXT_STORAGE_DIR = join(dataRoot, "cortexkit", "magic-context");
  process.env.XDG_DATA_HOME = dataRoot;
  process.env.XDG_CONFIG_HOME = join(resolve(input.runtimeCwd), "config");

  try {
    return await withTimeout(timeoutMs, () => runOnce(dataRoot));
  } catch (error) {
    // One bounded outcome, never a throw: this runs on the exit path. The reason is printed for the operator
    // because a reflection that never works and never says why is the failure mode this whole path was written
    // to avoid; the exit report still carries only the step's bounded code.
    process.stderr.write(
      `[reflection] session-end reflection failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}\n`,
    );
    return "failed";
  } finally {
    restore("MAGIC_CONTEXT_STORAGE_DIR", previous.storage);
    restore("XDG_DATA_HOME", previous.xdgData);
    restore("XDG_CONFIG_HOME", previous.xdgConfig);
  }
}

async function runOnce(dataRoot: string): Promise<CompanionSessionReflectionOutcome> {
  // The specifier is spelled here, as a literal, because the production artifact's external-closure gate declares a
  // dynamic import by its emitted argument text and accepts only a canonical JSON string literal or the frozen
  // magicContext bridge expression. A specifier bound to a constant is emitted as an identifier, so it can never be
  // declared and the artifact could not be published at all. Same package, same subpath, same runtime resolution.
  const dreamer = (await import("@cortexkit/pi-magic-context/dreamer")) as unknown as DreamerSubpath;
  const db = dreamer.openRuntimeDatabase();
  if (db === null) return "not_applicable";

  // The store's own meta row is the authority on the identity its sessions ran under.
  const meta = db
    .prepare(
      "SELECT cached_m0_project_identity AS identity FROM session_meta WHERE cached_m0_project_identity IS NOT NULL AND cached_m0_project_identity <> '' ORDER BY last_response_time DESC LIMIT 1",
    )
    .get() as { identity?: string } | undefined;
  const projectIdentity = meta?.identity;
  if (typeof projectIdentity !== "string" || projectIdentity.length === 0) return "not_applicable";

  // Nothing to reflect on yet: the compartment stream is what a reflection reads, and the historian's first fold
  // is what creates it.
  const compartments = db.prepare("SELECT COUNT(*) AS n FROM compartments").get() as { n?: number } | undefined;
  if ((compartments?.n ?? 0) === 0) return "not_applicable";

  const loaded = dreamer.loadPiConfig();
  const registrationOwner = {};
  dreamer.registerPiDreamerProject({
    db,
    projectDir: dataRoot,
    projectIdentity,
    registrationOwner,
    harness: "pi",
    embeddingConfig: { provider: "off" },
    memoryEnabled: true,
    // The domain decides the category menu and which categories are accepted; without it the taxonomy falls back
    // to the coding one and a reflection on a companion's history is rejected or misfiled.
    memoryDomain: "ongoing-interaction",
    gitCommitIndexing: { enabled: false, since_days: 30, max_commits: 200 },
    config: dreamer.dreamerRunConfig(loaded.config, loaded.config),
  });
  try {
    await dreamer.runPiDreamForProject(projectIdentity, "reflect", registrationOwner);
    return "completed";
  } finally {
    try {
      dreamer.unregisterPiDreamerProject({ projectIdentity, registrationOwner });
    } catch {
      // An unregistration that fails must not replace the outcome the attempt reported.
    }
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withTimeout<T>(timeoutMs: number, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("companion_reflection_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The marker one exit leaves behind, and the launch that reads it.
 *
 * The marker is the whole of the exit's reflection cost: a bounded JSON file under the runtime root that the
 * conversation ran in, named by a schema so a marker written by another build is ignored rather than guessed at.
 * `attempts` is the marker's own retry budget - a launch that fails increments it, and the attempt that reaches the
 * ceiling removes the marker and reports `abandoned`, which is a named outcome rather than a silent endless retry.
 */
export const COMPANION_REFLECTION_PENDING_SCHEMA = "gamebuddy-companion-reflection-pending/v1";
export const COMPANION_REFLECTION_PENDING_FILE = "companion-reflection-pending.json";
export const COMPANION_REFLECTION_MAX_ATTEMPTS = 3;

/** What one launch did with the reflection an earlier exit recorded. */
export type PendingCompanionReflectionOutcome = "none" | "completed" | "not_applicable" | "failed" | "abandoned";

type PendingCompanionReflection = Readonly<{
  schema: typeof COMPANION_REFLECTION_PENDING_SCHEMA;
  recordedAtMs: number;
  attempts: number;
}>;

/** Where one runtime root keeps the reflection it still owes. */
export function companionReflectionPendingPath(runtimeCwd: string): string {
  return join(resolve(runtimeCwd), COMPANION_REFLECTION_PENDING_FILE);
}

/**
 * Records that this runtime root owes one reflection.
 *
 * The runtime root is created here if it is absent - the marker sits beside the root the runtime itself uses, and
 * the exit may reach this step before any launch has written there. A medium that refuses the write fails this step
 * with its own bounded code instead of pretending the reflection was recorded.
 */
export async function recordPendingCompanionReflection(runtimeCwd: string): Promise<void> {
  const path = companionReflectionPendingPath(runtimeCwd);
  const marker: PendingCompanionReflection = Object.freeze({
    schema: COMPANION_REFLECTION_PENDING_SCHEMA,
    recordedAtMs: Date.now(),
    attempts: 0,
  });
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(marker)}\n`, "utf8");
  } catch {
    throw new Error("companion_reflection_marker_unwritable");
  }
}

/**
 * Runs the reflection an earlier exit recorded, once, beside this launch's shell.
 *
 * `none` is the ordinary answer - most launches inherit no marker - and it never touches the dreamer at all, so a
 * launch that owes nothing pays nothing. A completed (or not-applicable) reflection is owed no longer and its
 * marker is removed; a failed one keeps the marker with its attempt count for the next launch, until the ceiling
 * removes it as `abandoned`. Nothing here throws: it runs unawaited beside a live shell.
 */
export async function runPendingCompanionReflection(
  input: CompanionSessionReflectionInput,
): Promise<PendingCompanionReflectionOutcome> {
  const path = companionReflectionPendingPath(input.runtimeCwd);
  const pending = await readPendingCompanionReflection(path);
  if (pending === undefined) return "none";
  const outcome = await reflectCompanionSessionOnce(input);
  if (outcome !== "failed") {
    await removePendingCompanionReflection(path);
    return outcome;
  }
  const attempts = pending.attempts + 1;
  if (attempts >= COMPANION_REFLECTION_MAX_ATTEMPTS) {
    await removePendingCompanionReflection(path);
    return "abandoned";
  }
  try {
    await writeFile(path, `${JSON.stringify({ ...pending, attempts } satisfies PendingCompanionReflection)}\n`, "utf8");
  } catch {
    // The marker could not be advanced; the next launch reads the attempts it can see, so this is the same
    // bounded answer as a marker that could never be written.
  }
  return "failed";
}

/**
 * A malformed or foreign marker is removed rather than trusted: it carries no usable attempt count, and the
 * alternative - reflecting on a guess - is worse than reflecting once more than necessary.
 */
async function readPendingCompanionReflection(path: string): Promise<PendingCompanionReflection | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as Partial<PendingCompanionReflection>;
    if (
      parsed.schema !== COMPANION_REFLECTION_PENDING_SCHEMA ||
      typeof parsed.recordedAtMs !== "number" ||
      typeof parsed.attempts !== "number" ||
      !Number.isInteger(parsed.attempts) ||
      parsed.attempts < 0
    ) {
      await removePendingCompanionReflection(path);
      return undefined;
    }
    return Object.freeze({
      schema: COMPANION_REFLECTION_PENDING_SCHEMA,
      recordedAtMs: parsed.recordedAtMs,
      attempts: parsed.attempts,
    });
  } catch {
    await removePendingCompanionReflection(path);
    return undefined;
  }
}

async function removePendingCompanionReflection(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // A marker that cannot be removed is answered by the next launch's own attempt count.
  }
}

/**
 * The exit reclamation's `reflect_session` step.
 *
 * It resolves the runtime root the surface actually ran in - the same derivation the presentation admission owner
 * uses - and records the one reflection that root owes. That is a single file write: no store is opened, no model
 * is called, and a failing medium is named as this step's bounded failure rather than a silently lost reflection.
 */
export function createCompanionSessionReflectionChild(
  manifest: HostDeploymentManifest,
  chatSurfaceSessionId: string,
): Readonly<{ step: "reflect_session"; close: () => Promise<void> }> {
  return Object.freeze({
    step: "reflect_session" as const,
    close: async (): Promise<void> => {
      const runtimePaths = resolveRuntimePaths(manifest.principal, manifest.runtimeRoot, chatSurfaceSessionId);
      await recordPendingCompanionReflection(runtimePaths.runtimeCwd);
    },
  });
}

/** The runtime root of one Chat surface session: what an exit records into and the next launch reads. */
export function companionReflectionRuntimeCwd(manifest: HostDeploymentManifest, chatSurfaceSessionId: string): string {
  return resolveRuntimePaths(manifest.principal, manifest.runtimeRoot, chatSurfaceSessionId).runtimeCwd;
}

/**
 * Runs the reflection an earlier exit recorded, beside this launch's shell.
 *
 * Synchronous and unawaited by contract: a launch neither waits on a model call nor fails because of one. A runtime
 * root this launch cannot derive is the ordinary `none` case - there is nothing to run - and every failure the
 * reflection itself can report is `runPendingCompanionReflection`'s own bounded outcome.
 */
export function runPendingCompanionReflectionBesideShell(
  manifest: HostDeploymentManifest,
  chatSurfaceSessionId: string,
): void {
  void (async () => {
    let runtimeCwd: string;
    try {
      runtimeCwd = companionReflectionRuntimeCwd(manifest, chatSurfaceSessionId);
    } catch {
      return;
    }
    await runPendingCompanionReflection({ runtimeCwd });
  })();
}
