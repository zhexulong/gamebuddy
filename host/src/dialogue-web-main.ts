import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startDialogueWebServer } from "./dialogue-web.js";
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
  if (typeof candidate !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(candidate)) throw new Error("invalid_dialogue_config");
  return candidate;
};
const initialProfile = value.profile === undefined ? undefined : validateIdentityProfile(value.profile) as IdentityProfile;
const surfaceSessionId = value.surfaceSessionId === undefined ? undefined : typeof value.surfaceSessionId === "string" ? value.surfaceSessionId : (() => { throw new Error("invalid_dialogue_config"); })();
const worldBook = value.worldBookPath === undefined ? undefined : await loadWorldBook(value.worldBookPath, configDirectory);
const server = await startDialogueWebServer({
  identity: { playerId: opaque("playerId"), companionId: opaque("companionId"), continuityId: opaque("continuityId") },
  runtimeRoot: value.runtimeRoot === undefined ? undefined : typeof value.runtimeRoot === "string" ? value.runtimeRoot : (() => { throw new Error("invalid_dialogue_config"); })(),
  initialProfile,
  worldBook,
  surfaceSessionId,
});

async function loadWorldBook(path: unknown, baseDirectory: string): Promise<WorldBookBinding> {
  if (typeof path !== "string" || path.length === 0) throw new Error("invalid_dialogue_config");
  const book = await readWorldBook(resolve(baseDirectory, path));
  return Object.freeze({ book, metadata: worldBookMetadata(book) });
}
process.stdout.write(`GameBuddy Dialogue is ready at ${server.url}\n`);
await new Promise<void>((resolveStop) => { process.once("SIGINT", resolveStop); process.once("SIGTERM", resolveStop); });
await server.close();
