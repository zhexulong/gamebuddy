/**
 * The companion's reflection, run once when a Host session ends.
 *
 * Owner ruling E for this product: reflection is not a cron task. Magic Context's own scheduler was measured on
 * this runtime - its first tick waits a two-minute quiet window and the periodic tick is fifteen minutes, both
 * `unref`'d - so a play session that lasts minutes never reaches a tick at all, however a task is scheduled. The
 * Host therefore asks for exactly one reflection at the moment a session ends, which is also the moment the
 * material it reflects on is complete.
 *
 * It runs inside the exit reclamation, before the shared semantic authority is released, and it is written to
 * fail closed: a reflection that cannot run leaves nothing behind and never delays or fails the exit it belongs
 * to. What it writes is an ordinary memory row (`sourceType: "dreamer"`); it does not touch compartments,
 * chapters, m0, or the player's own text.
 */
import { join } from "node:path";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { resolveRuntimePaths } from "../runtime-identity.js";

/**
 * The shape this module relies on from the vendored package's `./dreamer` entry.
 *
 * Stated here rather than imported, and imported through a non-literal specifier for the same reason: the package
 * publishes that subpath at runtime but emits no declarations for it, and its declaration build cannot be widened
 * to include the entry without dragging in optional Pi peers that exist only at runtime. Stating the consumed
 * surface keeps this module typed without a second source of truth for the parts it does not use.
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

const DREAMER_ENTRY = "@cortexkit/pi-magic-context/dreamer";

/** The bounded outcome one session-end reflection reports. */
export type CompanionSessionReflectionOutcome = "completed" | "not_applicable" | "failed";

export type CompanionSessionReflectionInput = Readonly<{
  /** The runtime root the conversation ran in; its store is under `data/cortexkit/magic-context`. */
  runtimeCwd: string;
  /** How long the whole attempt may take. The reclamation gives it its own step budget too. */
  timeoutMs?: number;
}>;

/** Far below the reclamation's own 300s drain budget: this is a courtesy, not a teardown. */
const DEFAULT_REFLECTION_TIMEOUT_MS = 60_000;

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
  const dataRoot = join(input.runtimeCwd, "data");
  const previous = {
    storage: process.env.MAGIC_CONTEXT_STORAGE_DIR,
    xdgData: process.env.XDG_DATA_HOME,
    xdgConfig: process.env.XDG_CONFIG_HOME,
  };
  // Point the store and the config at this runtime root, in the same shape the runtime itself uses while it is
  // mounted, so the reflection reads and writes the store that belongs to this conversation.
  process.env.MAGIC_CONTEXT_STORAGE_DIR = join(dataRoot, "cortexkit", "magic-context");
  process.env.XDG_DATA_HOME = dataRoot;
  process.env.XDG_CONFIG_HOME = join(input.runtimeCwd, "config");

  try {
    return await withTimeout(timeoutMs, () => runOnce(dataRoot));
  } catch {
    // One bounded outcome, never a throw: this runs on the exit path.
    return "failed";
  } finally {
    restore("MAGIC_CONTEXT_STORAGE_DIR", previous.storage);
    restore("XDG_DATA_HOME", previous.xdgData);
    restore("XDG_CONFIG_HOME", previous.xdgConfig);
  }
}

async function runOnce(dataRoot: string): Promise<CompanionSessionReflectionOutcome> {
  const dreamer = (await import(DREAMER_ENTRY)) as unknown as DreamerSubpath;
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
 * The exit reclamation's `reflect_session` step.
 *
 * It resolves the runtime root the surface actually ran in - the same derivation the presentation admission
 * owner uses - and asks for one reflection there. A reflection that fails is named as a bounded failure of this
 * step, so the exit report says so; having nothing to reflect on (no store, no folded history yet) is not a
 * failure of the exit, so it completes without comment.
 */
export function createCompanionSessionReflectionChild(
  manifest: HostDeploymentManifest,
  chatSurfaceSessionId: string,
): Readonly<{ step: "reflect_session"; close: () => Promise<void> }> {
  return Object.freeze({
    step: "reflect_session" as const,
    close: async (): Promise<void> => {
      const runtimePaths = resolveRuntimePaths(manifest.principal, manifest.runtimeRoot, chatSurfaceSessionId);
      const outcome = await reflectCompanionSessionOnce({ runtimeCwd: runtimePaths.runtimeCwd });
      if (outcome === "failed") throw new Error("companion_reflection_failed");
    },
  });
}
