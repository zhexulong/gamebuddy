import { createKnownSemanticGameProductionAuthorityFromDeploymentManifest } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import type { ProductionGamePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import { loadHostDeploymentManifest } from "../deployment-manifest.js";

type WorkerRequest =
  | Readonly<{ type: "attempt"; manifestPath: string }>
  | Readonly<{ type: "terminalize" }>
  | Readonly<{ type: "close" }>;
type WorkerReply =
  | Readonly<{ type: "ready" }>
  | Readonly<{ type: "prepared" }>
  | Readonly<{ type: "rejected"; code: string }>
  | Readonly<{ type: "terminalized" }>
  | Readonly<{ type: "closed" }>
  | Readonly<{ type: "fatal"; code: string }>;

let game: Awaited<ReturnType<typeof createKnownSemanticGameProductionAuthorityFromDeploymentManifest>> | undefined;
let permit: ProductionGamePermit | undefined;
let live: Awaited<ReturnType<NonNullable<typeof game>["commitEnter"]>> | undefined;
let handling = false;

function reply(value: WorkerReply): void {
  process.send?.(value);
}
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function attempt(manifestPath: string): Promise<void> {
  if (game !== undefined || handling) throw new Error("semantic_known_game_worker_replayed");
  handling = true;
  try {
    const manifest = await loadHostDeploymentManifest(manifestPath);
    game = await createKnownSemanticGameProductionAuthorityFromDeploymentManifest(manifest);
    const facts = Object.freeze({
      world: Object.freeze({ integrationId: "stardew", saveId: "save_01", worldId: "world_01" }),
      bindingDigest: "b".repeat(64),
      owner: Object.freeze({
        ownerToken: `owner_${process.pid}`,
        runtimeInstanceId: `runtime_${process.pid}`,
        ownerPid: process.pid,
        ownerProcessStartIdentity: "test_process_creation",
      }),
    });
    permit = await game.prepareEnter(facts);
    reply(Object.freeze({ type: "prepared" }));
  } catch (error) {
    try {
      await game?.close();
    } catch {
      /* no leased state is retained on rejected admission */
    }
    game = undefined;
    reply(Object.freeze({ type: "rejected", code: errorCode(error) }));
  } finally {
    handling = false;
  }
}

async function terminalize(): Promise<void> {
  if (!game || !permit || handling) throw new Error("semantic_known_game_worker_not_prepared");
  handling = true;
  try {
    live = await game.commitEnter(
      permit,
      Object.freeze({
        kind: "runtime_bootstrapped",
        operationId: permit.operationId,
        requestId: permit.requestId,
        gameSessionId: permit.gameSessionId,
        bindingDigest: permit.bindingDigest,
        world: permit.world,
        owner: permit.owner,
        fenceToken: permit.fenceToken,
        occurredAtMs: Date.now(),
      }),
    );
    const closing = await game.prepareClose(live);
    const closed = await game.commitClose(
      live,
      closing,
      Object.freeze({
        kind: "runtime_torn_down",
        operationId: closing.operationId,
        requestId: closing.requestId,
        gameSessionId: closing.gameSessionId,
        bindingDigest: closing.bindingDigest,
        world: closing.world,
        owner: closing.owner,
        fenceToken: closing.fenceToken,
        occurredAtMs: Date.now(),
      }),
    );
    if (closed.status !== "terminal" || closed.gameState !== "ended" || closed.leaseState !== null)
      throw new Error("semantic_known_game_worker_close_unsettled");
    permit = undefined;
    live = undefined;
    reply(Object.freeze({ type: "terminalized" }));
  } finally {
    handling = false;
  }
}

async function close(): Promise<void> {
  if (handling) throw new Error("semantic_known_game_worker_busy");
  handling = true;
  try {
    await game?.close();
    game = undefined;
    reply(Object.freeze({ type: "closed" }));
    process.disconnect?.();
  } finally {
    handling = false;
  }
}

process.on("message", (message: WorkerRequest) => {
  void (async () => {
    try {
      if (!message || typeof message !== "object") throw new Error("semantic_known_game_worker_message_invalid");
      if (message.type === "attempt") await attempt(message.manifestPath);
      else if (message.type === "terminalize") await terminalize();
      else if (message.type === "close") await close();
      else throw new Error("semantic_known_game_worker_message_invalid");
    } catch (error) {
      reply(Object.freeze({ type: "fatal", code: errorCode(error) }));
    }
  })();
});

reply(Object.freeze({ type: "ready" }));
