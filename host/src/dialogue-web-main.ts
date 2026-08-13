import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startDialogueWebServer, type DialogueMemoryFacade } from "./dialogue-web.js";
import { resolveMagicContextExtensionEntry, resolveRuntimePaths } from "./runtime.js";
import { createProductionGameContinuity } from "./production-game-continuity.js";
import { validateIdentityProfile, type IdentityProfile } from "./identity-profile.js";
import { readWorldBook, worldBookMetadata, type WorldBookBinding } from "./worldbook.js";

const configPath = process.argv[2] ?? process.env.GAMEBUDDY_DIALOGUE_CONFIG;
if (configPath === undefined) throw new Error("dialogue_config_path_required");
const resolvedConfigPath = resolve(configPath);
const configDirectory = dirname(resolvedConfigPath);
const config = JSON.parse(await readFile(resolvedConfigPath, "utf8")) as unknown;
if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error("invalid_dialogue_config");
const value = config as Record<string, unknown>;
const opaque = (key: string): string => {
  const candidate = value[key];
  if (typeof candidate !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(candidate))
    throw new Error("invalid_dialogue_config");
  return candidate;
};
const initialProfile =
  value.profile === undefined ? undefined : (validateIdentityProfile(value.profile) as IdentityProfile);
const surfaceSessionId =
  value.surfaceSessionId === undefined
    ? undefined
    : typeof value.surfaceSessionId === "string"
      ? value.surfaceSessionId
      : (() => {
          throw new Error("invalid_dialogue_config");
        })();
const worldBook =
  value.worldBookPath === undefined ? undefined : await loadWorldBook(value.worldBookPath, configDirectory);
const runtimeRoot =
  value.runtimeRoot === undefined
    ? undefined
    : typeof value.runtimeRoot === "string"
      ? value.runtimeRoot
      : (() => {
          throw new Error("invalid_dialogue_config");
        })();
const tavernNarrativeGateNonceSha256 =
  value.tavernNarrativeGateNonceSha256 === undefined
    ? undefined
    : typeof value.tavernNarrativeGateNonceSha256 === "string" && /^[a-f0-9]{64}$/.test(value.tavernNarrativeGateNonceSha256)
      ? value.tavernNarrativeGateNonceSha256
      : (() => {
          throw new Error("invalid_dialogue_config");
        })();
// Dialogue has no browser-supplied game scope. When a deployment provides
// game identity, keep it in the Host-owned config used to compose continuity.
const identity = {
  playerId: opaque("playerId"),
  companionId: opaque("companionId"),
  continuityId: opaque("continuityId"),
  ...(value.saveId === undefined ? {} : { saveId: opaque("saveId") }),
  ...(value.worldId === undefined ? {} : { worldId: opaque("worldId") }),
};
const continuity = createProductionGameContinuity(identity, runtimeRoot);
// Load the exact built vendor extension that the Companion runtime loads. The
// pnpm file dependency is deliberately not used here: it can retain a stale
// package copy while the Host itself loads the source-owned vendor artifact.
const magicContextEntry = resolveMagicContextExtensionEntry();
const magicContextBridge = (await import(pathToFileURL(magicContextEntry).href)) as {
  createGameBuddyMemoryFacade(args: Readonly<{ continuityId: string; runtimeCwd: string }>): DialogueMemoryFacade;
};
const reportTavernNarrativeGateRuntime =
  tavernNarrativeGateNonceSha256 === undefined || typeof process.send !== "function"
    ? undefined
    : (runtime: Readonly<{ piSessionId: string }>) => {
        process.send?.({ schema: "gamebuddy-tavern-narrative-gate-runtime/v1", piSessionId: runtime.piSessionId });
      };
const server = await startDialogueWebServer({
  identity,
  runtimeRoot,
  continuity,
  initialProfile,
  worldBook,
  surfaceSessionId,
  // This bridge is Magic Context-owned. Host only injects an already-bound
  // facade; it never opens storage or builds a memory prompt.
  magicContextMemoryFacade: magicContextBridge.createGameBuddyMemoryFacade({
    continuityId: identity.continuityId,
    runtimeCwd: resolveRuntimePaths(identity, runtimeRoot, surfaceSessionId).runtimeCwd,
  }),
  tavernNarrativeGateNonceSha256,
  onTavernNarrativeGateRuntime: reportTavernNarrativeGateRuntime,
});

async function loadWorldBook(path: unknown, baseDirectory: string): Promise<WorldBookBinding> {
  if (typeof path !== "string" || path.length === 0) throw new Error("invalid_dialogue_config");
  const book = await readWorldBook(resolve(baseDirectory, path));
  return Object.freeze({ book, metadata: worldBookMetadata(book) });
}
process.stdout.write(`GameBuddy Dialogue is ready at ${server.url}\n`);
await new Promise<void>((resolveStop) => {
  process.once("SIGINT", resolveStop);
  process.once("SIGTERM", resolveStop);
});
await server.close();
