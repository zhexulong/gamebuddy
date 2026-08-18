import {
  createFreshSemanticProductionAuthorityFromDeploymentManifest,
  createInitialChatResumeSemanticProductionAuthorityFromDeploymentManifest,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import { loadHostDeploymentManifest } from "../deployment-manifest.js";
import { createManifestDerivedInitialChatExactContentPort } from "../tavern/initial-chat-exact-content-port.js";

type Mode = "crash-after-register" | "resume";
type Reply = Readonly<{ type: "registered" | "selected" | "fatal"; code?: string }>;

async function reply(value: Reply): Promise<void> {
  if (!process.send || !process.connected) throw new Error("semantic_initial_worker_ipc_unavailable");
  await new Promise<void>((resolve, reject) => {
    process.send?.(value, undefined, undefined, (error: Error | null) => (error ? reject(error) : resolve()));
  });
}
function code(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function run(mode: Mode, manifestPath: string): Promise<void> {
  const manifest = await loadHostDeploymentManifest(manifestPath);
  if (mode === "crash-after-register") {
    const authority = await createFreshSemanticProductionAuthorityFromDeploymentManifest(manifest);
    await authority.startInitialChat();
    const registered = await authority.registerInitialChat();
    if (registered.phase !== "chat_registered") throw new Error("semantic_initial_worker_registration_missing");
    // The crash fixture may exit only after its registration IPC message has
    // reached the parent. `process.send()` is asynchronous; scheduling exit
    // immediately can otherwise truncate the message and make the real
    // cross-process recovery proof nondeterministic.
    await reply(Object.freeze({ type: "registered" }));
    // Deliberately do not call close(): this process is the crash fixture.
    // A process exit abandons every in-memory broker/resource; the successor
    // must reopen durable state through known-open only.
    process.exit(0);
    return;
  }
  const authority = await createInitialChatResumeSemanticProductionAuthorityFromDeploymentManifest(manifest);
  try {
    const selected = await authority.resumeInitialChatWithContent(
      createManifestDerivedInitialChatExactContentPort(manifest),
    );
    if (selected?.phase !== "selected") throw new Error("semantic_initial_worker_resume_unselected");
    await reply(Object.freeze({ type: "selected" }));
  } finally {
    await authority.close();
  }
}

const [mode, manifestPath] = process.argv.slice(2) as [Mode | undefined, string | undefined];
if (!manifestPath || (mode !== "crash-after-register" && mode !== "resume")) {
  void reply(Object.freeze({ type: "fatal", code: "semantic_initial_worker_arguments_invalid" })).catch(() => {
    process.exitCode = 1;
  });
} else {
  void run(mode, manifestPath).catch(async (error) => {
    try {
      await reply(Object.freeze({ type: "fatal", code: code(error) }));
    } catch {
      process.exitCode = 1;
    }
  });
}
