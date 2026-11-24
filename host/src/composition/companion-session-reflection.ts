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
import { type RuntimeMagicContextRoot, withRuntimeMagicContextRoot } from "../runtime-core.internal.js";

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
  loadPiConfig: (options: Readonly<{ cwd: string }>) => Readonly<{ config: unknown }>;
  dreamerRunConfig: (config: unknown, fallback: unknown) => unknown;
  registerPiDreamerProject: (options: Readonly<Record<string, unknown>>) => void;
  runPiDreamForProject: (projectIdentity: string, task: string, registrationOwner: object) => Promise<unknown>;
  /** Stops the spawned provider call of one registration; the dreamer's own abort for its subagent child. */
  abortInFlightDreamers: (registrationOwner: object) => void;
  unregisterPiDreamerProject: (options: Readonly<{ projectIdentity: string; registrationOwner: object }>) => void;
}

/**
 * What one attempt will really do once the store is resolved: the spawned provider call, and how to stop it.
 *
 * `run` is the only step of a reflection that takes a provider's wall clock, and it is NOT the Magic Context
 * scope's own work - the scope's work is resolving the store, which must stay pinned, and the provider call
 * happens inside it only because the dreamer's `pi` child is itself a store client whose root is decided by
 * the environment it inherits at spawn.
 */
export type CompanionReflectionRun = Readonly<{
  run: () => Promise<void>;
  abort: () => void;
  close: () => void;
}>;

/** One plan: either a bounded outcome already, or the attempt this reflection will really perform. */
export type CompanionReflectionPlan =
  | Readonly<{ kind: "terminal"; outcome: CompanionSessionReflectionOutcome }>
  | Readonly<{ kind: "run"; attempt: CompanionReflectionRun }>;

/**
 * The narrow seam for the one step a focused test cannot script: the spawned provider call.
 *
 * Production always plans against the vendored dreamer (`planAgainstRuntimeStore`); the seam exists only
 * because a live reflection is a model call, and it carries no store, root or model capability of its own.
 */
export type CompanionSessionReflectionDeps = Readonly<{
  plan?: (root: RuntimeMagicContextRoot) => Promise<CompanionReflectionPlan>;
}>;

/** The bounded outcome one session-end reflection reports. */
export type CompanionSessionReflectionOutcome = "completed" | "not_applicable" | "failed" | "preempted";

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
 * whichever store the process happens to default to (measured: another root's rows). That window is taken from
 * the one owner of those globals (`withRuntimeMagicContextRoot`), never written here: the runtime's own mount
 * pins the same globals, and a reflection that wrote them beside the mount was a second, unserialised writer of
 * one process-wide value. The identity to reflect on comes from that store's own meta row rather than from a
 * caller: deriving one from a directory lands on a different partition whenever the run's identity came from a
 * git root, and the task would then reflect on nothing.
 *
 * The attempt is PREEMPTABLE. A reflection is spawned provider call held inside that window, so a runtime mount
 * that arrives while it runs announces itself through `scope.preempt`, the dreamer's own abort stops the call,
 * and the attempt reports `preempted` - a bounded outcome the caller keeps for the next launch rather than a
 * failure it pays for. Nothing here waits for a model on a foreground path.
 *
 * Never throws: every failure is one bounded outcome, because this runs on the exit path and a failure here must
 * not become a second failure of the exit it describes.
 */
export async function reflectCompanionSessionOnce(
  input: CompanionSessionReflectionInput,
  deps: CompanionSessionReflectionDeps = {},
): Promise<CompanionSessionReflectionOutcome> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_REFLECTION_TIMEOUT_MS;
  const plan = deps.plan ?? planAgainstRuntimeStore;
  let attempt: CompanionReflectionRun | undefined;
  let preempted = false;
  try {
    return await withRuntimeMagicContextRoot(
      input.runtimeCwd,
      async (root) => {
        const planned = await plan(root);
        if (planned.kind === "terminal") return planned.outcome;
        attempt = planned.attempt;
        // A mount that arrived while the store was being resolved already asked this attempt to yield, and the
        // provider call must then never start: the mount is waiting on the globals it will take back here.
        if (preempted) return "preempted";
        try {
          await withTimeout(timeoutMs, () => planned.attempt.run());
          return "completed";
        } catch (error) {
          if (!preempted) throw error;
          return "preempted";
        } finally {
          planned.attempt.close();
        }
      },
      {
        preempt: () => {
          preempted = true;
          attempt?.abort();
        },
      },
    );
  } catch (error) {
    // One bounded outcome, never a throw: this runs on the exit path. The reason is printed for the operator
    // because a reflection that never works and never says why is the failure mode this whole path was written
    // to avoid; the exit report still carries only the step's bounded code.
    process.stderr.write(
      `[reflection] session-end reflection failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}\n`,
    );
    return "failed";
  }
}

/**
 * Resolves this runtime root's store inside the scope, and hands back the provider call that will run in it.
 *
 * Everything that resolves a path happens here, while the scope holds: the module import, the store open, the
 * two reads that decide whether there is anything to reflect on, the config load and the registration. The
 * attempt it returns names the vendored dreamer's own abort, because stopping the call is the dreamer's job.
 *
 * The config load names its directory: `loadPiConfig` takes a `cwd`, and this runtime's project-tier config lives at
 * `<root>/.cortexkit/magic-context.jsonc`, so passing the root is what makes the same values reach the registration
 * without the process standing anywhere in particular. It is the difference between a reflection that needs the
 * process's working directory (and held it across a spawned provider call) and one that carries its own.
 */
async function planAgainstRuntimeStore(root: RuntimeMagicContextRoot): Promise<CompanionReflectionPlan> {
  // The specifier is spelled here, as a literal, because the production artifact's external-closure gate declares a
  // dynamic import by its emitted argument text and accepts only a canonical JSON string literal or the frozen
  // magicContext bridge expression. A specifier bound to a constant is emitted as an identifier, so it can never be
  // declared and the artifact could not be published at all. Same package, same subpath, same runtime resolution.
  const dreamer = (await import("@cortexkit/pi-magic-context/dreamer")) as unknown as DreamerSubpath;
  const db = dreamer.openRuntimeDatabase();
  if (db === null) return Object.freeze({ kind: "terminal" as const, outcome: "not_applicable" as const });

  // The store's own meta row is the authority on the identity its sessions ran under.
  const meta = db
    .prepare(
      "SELECT cached_m0_project_identity AS identity FROM session_meta WHERE cached_m0_project_identity IS NOT NULL AND cached_m0_project_identity <> '' ORDER BY last_response_time DESC LIMIT 1",
    )
    .get() as { identity?: string } | undefined;
  const projectIdentity = meta?.identity;
  if (typeof projectIdentity !== "string" || projectIdentity.length === 0)
    return Object.freeze({ kind: "terminal" as const, outcome: "not_applicable" as const });

  // Nothing to reflect on yet: the compartment stream is what a reflection reads, and the historian's first fold
  // is what creates it.
  const compartments = db.prepare("SELECT COUNT(*) AS n FROM compartments").get() as { n?: number } | undefined;
  if ((compartments?.n ?? 0) === 0)
    return Object.freeze({ kind: "terminal" as const, outcome: "not_applicable" as const });

  const loaded = dreamer.loadPiConfig({ cwd: root.runtimeCwd });
  const registrationOwner = {};
  dreamer.registerPiDreamerProject({
    db,
    projectDir: root.dataHome,
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
  return Object.freeze({
    kind: "run" as const,
    attempt: Object.freeze({
      run: async (): Promise<void> => {
        await dreamer.runPiDreamForProject(projectIdentity, "reflect", registrationOwner);
      },
      // The dreamer's own abort for this registration: it stops the spawned `pi` child through that run's signal.
      abort: (): void => {
        try {
          dreamer.abortInFlightDreamers(registrationOwner);
        } catch {
          // An abort that cannot be delivered must not become a second failure of this attempt.
        }
      },
      close: (): void => {
        try {
          dreamer.unregisterPiDreamerProject({ projectIdentity, registrationOwner });
        } catch {
          // An unregistration that fails must not replace the outcome the attempt reported.
        }
      },
    }),
  });
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

/**
 * What one launch did with the reflection an earlier exit recorded.
 *
 * `deferred` is the mount's own outcome: the attempt was preempted by a runtime mount that needed the globals, so
 * it neither completed nor failed. The marker stays and no attempt is spent - a reflection that keeps losing to
 * mounts is retried on the next launch rather than abandoned by a budget the player never saw.
 */
export type PendingCompanionReflectionOutcome =
  | "none"
  | "completed"
  | "not_applicable"
  | "failed"
  | "abandoned"
  | "deferred";

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
  deps: CompanionSessionReflectionDeps = {},
): Promise<PendingCompanionReflectionOutcome> {
  const path = companionReflectionPendingPath(input.runtimeCwd);
  const pending = await readPendingCompanionReflection(path);
  if (pending === undefined) return "none";
  const outcome = await reflectCompanionSessionOnce(input, deps);
  // A preempted attempt is owed no longer and owes no attempt: the marker is left exactly as it was.
  if (outcome === "preempted") return "deferred";
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
