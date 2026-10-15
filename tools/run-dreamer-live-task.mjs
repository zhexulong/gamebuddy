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
import { createGameBuddyPlayerMemoryCrudFacade, getDeclaredProjectIdentity } from "@cortexkit/pi-magic-context/memory";
import {
  registerPiDreamerProject,
  runPiDreamForProject,
  unregisterPiDreamerProject,
} from "@cortexkit/pi-magic-context/dreamer";

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
const dbPath = join(contextDir, "data", "cortexkit", "magic-context", "context.db");
if (!existsSync(dbPath)) blocked("no_magic_context_store", dbPath);

const facade = createGameBuddyPlayerMemoryCrudFacade({ continuityId, runtimeCwd: root, profileId, profileRevision });
const list = async () => {
  const read = await facade.listMemories({ continuityId, profileId, profileRevision });
  return read;
};

const before = await list();
process.stderr.write(`[dreamer-task] memories before: ${before.length}\n`);
process.stderr.write(`[dreamer-task] declared project identity: ${String(getDeclaredProjectIdentity())}\n`);

const projectIdentity = getDeclaredProjectIdentity();
if (typeof projectIdentity !== "string" || projectIdentity.length === 0) {
  blocked(
    "no_declared_identity",
    "the runtime declares no project identity; run the host first (identity is boot-time)",
  );
}

// The registration is the same shape the extension uses for its own timer, minus the schedule: one owner token,
// this project identity, this root's config. `gitCommitIndexing` is off because a companion's memory does not
// come from commits, and the embedding provider is off because this runtime ships without one.
const registrationOwner = {};
registerPiDreamerProject({
  projectDir: contextDir,
  projectIdentity,
  registrationOwner,
  harness: "pi",
  embeddingConfig: { provider: "off" },
  memoryEnabled: true,
  gitCommitIndexing: { enabled: false, since_days: 30, max_commits: 200 },
  config: {
    disable: false,
    tasks: { [task]: { schedule: "" } },
    memory: { enabled: true, domain: "ongoing-interaction" },
  },
});

let result;
try {
  result = await runPiDreamForProject(projectIdentity, task, registrationOwner);
} finally {
  unregisterPiDreamerProject(projectIdentity, registrationOwner);
}

const after = await list();
const added = after.filter((row) => !before.some((prior) => prior.handle === row.handle));
const report = {
  schema: "gamebuddy_dreamer_live_task/v1",
  root,
  contextDir,
  task,
  declaredIdentity: projectIdentity,
  run: result ?? null,
  memories: { before: before.length, after: after.length, added: added.length },
  addedRows: added.map((row) => ({ handle: row.handle, origin: row.origin ?? null, title: row.title ?? null })),
};
if (reportPath !== undefined) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ verdict: added.length > 0 ? "wrote" : "wrote_nothing", task, added: added.length })}\n`,
);
