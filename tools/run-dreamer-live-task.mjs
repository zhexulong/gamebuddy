/**
 * Trigger one dreamer task on demand, and report what it wrote.
 *
 * Magic Context runs its dream tasks from a cron schedule inside the extension. This harness reaches the same
 * machinery through the package's `./dreamer` subpath, so a single task can be run against a runtime root that
 * already exists - which is what the `reflect` outcome plan needs before its schedule is wired:
 *
 *   node tools/run-dreamer-live-task.mjs --root <runtimeCwd> --continuity <id> [--task reflect] [--report <path>]
 *
 * The observation is deliberately the player-visible surface (`/memory`'s read projection, the same one the
 * management panel uses) rather than raw SQL: a row that the player cannot see is not an outcome.
 *
 * Exit codes: 0 ran and reported, 3 blocked (nothing to run against / no credential), 2 failed.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The package lives under the host's node_modules, and a tool in `tools/` cannot resolve a bare specifier for
// it. Its exports map is import-only, so the CJS resolver refuses it; loading the very files that map names, by
// absolute URL, is what makes this harness runnable from the repository root.
// Magic Context opens its store from the ambient data layout, and the vendor's own override for pointing it
// elsewhere is MAGIC_CONTEXT_TEST_DATA_DIR. It has to be set BEFORE the package is imported, because the store
// resolves when its module loads - which is why passing --root alone kept reading the machine's default store.
const argvForRoot = process.argv.slice(2);
const rootFlagAt = argvForRoot.indexOf("--root");
const rootForStore = rootFlagAt < 0 ? process.cwd() : argvForRoot[rootFlagAt + 1];
const contextsForStore = join(resolve(rootForStore), "contexts");
if (existsSync(contextsForStore)) {
  const keys = readdirSync(contextsForStore);
  if (keys.length === 1) process.env.MAGIC_CONTEXT_TEST_DATA_DIR = join(contextsForStore, keys[0], "data");
}

const hostDir = resolve(new URL("../host", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/u, ""));
const packageDir = join(hostDir, "node_modules", "@cortexkit", "pi-magic-context");
const memory = await import(pathToFileURL(join(packageDir, "dist", "memory", "index.js")).href);
const dreamer = await import(pathToFileURL(join(packageDir, "dist", "dreamer", "index.js")).href);
const plugin = { openRuntimeDatabase: dreamer.openRuntimeDatabase };

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(name);
  return at < 0 ? fallback : argv[at + 1];
};

const root = resolve(flag("--root", process.cwd()));
const continuityId = flag("--continuity", undefined);
const task = flag("--task", "reflect");
const reportPath = flag("--report", undefined);
const profileId = flag("--profile", "chat");
const profileRevision = Number.parseInt(flag("--profile-revision", "1"), 10);

const blocked = (reason, detail) => {
  process.stdout.write(`${JSON.stringify({ verdict: "blocked", reason, detail })}\n`);
  process.exit(3);
};

if (continuityId === undefined) blocked("continuity_required", "pass --continuity <id>");
if (process.env.CPA_OAI_API_KEY === undefined) blocked("credential_absent", "CPA_OAI_API_KEY");

const contextsRoot = join(root, "contexts");
if (!existsSync(contextsRoot)) blocked("no_runtime_root", `no contexts/ under ${root}`);
const contextKeys = readdirSync(contextsRoot);
if (contextKeys.length !== 1) blocked("ambiguous_runtime_root", `${contextKeys.length} contexts under ${root}`);
const contextDir = join(contextsRoot, contextKeys[0]);
const dataRoot = join(contextDir, "data");
const dbPath = join(dataRoot, "cortexkit", "magic-context", "context.db");
if (!existsSync(dbPath)) blocked("no_magic_context_store", dbPath);

// The identity the rows actually live under wins. Deriving one from the directory would land on a different
// partition whenever the run's project identity came from a git root, and the task would reflect on nothing.
// Magic Context resolves its store from the ambient XDG layout, so pointing it at this runtime root is how the
// task reads the database that belongs to this run rather than the machine's.
process.env.XDG_DATA_HOME = dataRoot;
const db = plugin.openRuntimeDatabase();
if (db === null) blocked("store_unavailable", `openDatabase() returned null for ${dataRoot}`);

const storedIdentities = db
  .prepare("SELECT project_path, COUNT(*) AS n FROM memories GROUP BY project_path ORDER BY n DESC")
  .all();
const explicitIdentity = flag("--project-identity", undefined);
const projectIdentity =
  explicitIdentity ?? (storedIdentities.length === 1 ? storedIdentities[0].project_path : undefined);
if (projectIdentity === undefined) {
  blocked(
    "identity_ambiguous",
    `stored memories span ${storedIdentities.length} partitions; pass --project-identity <value>`,
  );
}
process.stderr.write(
  `[dreamer-task] partitions in this store: ${storedIdentities.map((row) => `${row.n} under ${row.project_path}`).join("; ") || "(none)"}\n`,
);

const facade = memory.createGameBuddyPlayerMemoryCrudFacade({
  continuityId,
  runtimeCwd: root,
  profileId,
  profileRevision,
});
const list = () => facade.listMemories({ continuityId, profileId, profileRevision });

// The plan reads metric 4 from "the written rows of the candidate arm, read from Magic Context's own
// database". The player-visible facade is the other half of the picture (what the panel would show), and for a
// root whose rows live under an identity scheme the facade does not resolve, it reports nothing at all - which
// is why the database itself is the primary observation here.
const storeRows = () =>
  db
    .prepare("SELECT id, project_path, category, content FROM memories WHERE project_path = ? ORDER BY id")
    .all(projectIdentity);

const rowsBefore = storeRows();
const before = await list();
process.stderr.write(`[dreamer-task] memories before: ${before.length}\n`);
process.stderr.write(`[dreamer-task] project identity: ${String(projectIdentity)}\n`);

// The registration is the same shape the extension uses for its own timer, minus the schedule: one owner token,
// this project identity, and the config the timer would have resolved. `gitCommitIndexing` is off because a
// companion's memory does not come from commits; the embedding provider is off because this runtime ships
// without one.
const loaded = dreamer.loadPiConfig();
const dreamerConfig = dreamer.dreamerRunConfig(loaded.config, loaded.config);
// The domain decides which fact categories a task may write. This runtime's project config says
// `ongoing-interaction`; the loaded config may not have picked that up, and with the coding default every
// reflected category is rejected - which looks exactly like "the task ran and wrote nothing".
if (dreamerConfig?.memory !== undefined) dreamerConfig.memory.domain = "ongoing-interaction";
process.stderr.write(`[dreamer-task] memory domain for this run: ${String(dreamerConfig?.memory?.domain)}\n`);
const registrationOwner = {};
dreamer.registerPiDreamerProject({
  db,
  projectDir: contextDir,
  projectIdentity,
  registrationOwner,
  harness: "pi",
  embeddingConfig: { provider: "off" },
  memoryEnabled: true,
  gitCommitIndexing: { enabled: false, since_days: 30, max_commits: 200 },
  config: dreamerConfig,
});

let result;
let failure;
try {
  result = await dreamer.runPiDreamForProject(projectIdentity, task, registrationOwner);
} catch (error) {
  failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
} finally {
  dreamer.unregisterPiDreamerProject({ projectIdentity, registrationOwner });
  // The store stays open: the delta is read after the run, and closing here made that read throw.
}

const rowsAfter = storeRows();
const after = await list();
const added = after.filter((row) => !before.some((prior) => prior.handle === row.handle));
const report = {
  schema: "gamebuddy_dreamer_live_task/v1",
  root,
  contextDir,
  task,
  projectIdentity,
  failure: failure ?? null,
  run: result ?? null,
  memories: { before: before.length, after: after.length, added: added.length },
  databaseDelta: {
    before: rowsBefore.length,
    after: rowsAfter.length,
    added: rowsAfter.length - rowsBefore.length,
    addedRows: rowsAfter
      .slice(rowsBefore.length)
      .map((row) => ({ id: row.id, category: row.category ?? null, content: row.content ?? null })),
  },
  addedRows: added.map((row) => ({
    handle: row.handle,
    origin: row.origin ?? null,
    title: row.title ?? null,
    content: row.content ?? null,
  })),
  // Outcome metric 4 of reflect-outcome-plan.md: no written row may assert an inferred trait, mood, preference
  // or relationship interpretation as something the player said. The plan puts that check on the rows, so the
  // rows travel with the report and this flags the phrasing that would break it.
  metricInferenceAttribution: rowsAfter
    .slice(rowsBefore.length)
    .map((row) => ({ handle: String(row.id), content: String(row.content ?? "") }))
    .filter((row) =>
      /\b(you (said|told|mentioned|shared|explained)|player (said|stated|reported))\b/iu.test(row.content),
    )
    .map((row) => row.handle),
};
if (reportPath !== undefined) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ verdict: failure !== undefined ? "failed" : added.length > 0 ? "wrote" : "wrote_nothing", task, added: added.length, failure: failure ?? null })}\n`,
);
process.exit(failure !== undefined ? 2 : 0);
