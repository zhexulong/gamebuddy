/**
 * The historian's model, written where Magic Context reads it.
 *
 * Magic Context treats `historian.pi.model` and `historian.pi.thinking_level` as USER-scope trust decisions, and this runtime
 * owns its own user-scope config inside the runtime root. Both files are re-written on a model change so the fold and the
 * conversation cannot disagree about which model is running: the session is repointed by its own reload, and these two files
 * are the only thing the embedded historian ever reads.
 *
 * Existing content is preserved: only the two historian keys are replaced, because the rest of that file is a security
 * surface this module has no business editing (thresholds, feature gates).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type HistorianModelProjection = Readonly<{
  /** The runtime's own working directory; both config files live underneath it. */
  runtimeCwd: string;
  /** `provider/modelId`, the form Magic Context resolves through its registry. */
  model: string;
  thinkingLevel: string;
}>;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonc(path: string): Promise<JsonRecord> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    // A missing or unreadable file is the mount's own problem, not this projection's: the mount writes before any reload can
    // arrive, so an absent file here means there is nothing to correct.
    return {};
  }
}

export async function projectHistorianModel(projection: HistorianModelProjection): Promise<void> {
  const projectFile = join(projection.runtimeCwd, ".cortexkit", "magic-context.jsonc");
  const userFile = join(projection.runtimeCwd, "config", "cortexkit", "magic-context.jsonc");

  // Project scope: the flat `historian` block this Host writes at mount.
  const project = await readJsonc(projectFile);
  const projectHistorian = isRecord(project.historian) ? project.historian : {};
  await mkdir(join(projection.runtimeCwd, ".cortexkit"), { recursive: true });
  await writeFile(
    projectFile,
    JSON.stringify(
      {
        ...project,
        historian: {
          ...projectHistorian,
          model: projection.model,
          thinking_level: projection.thinkingLevel,
        },
      },
      null,
      2,
    ),
  );

  // User scope: where the historian's model selection is actually trusted from.
  const user = await readJsonc(userFile);
  const userHistorian = isRecord(user.historian) ? user.historian : {};
  const userPi = isRecord(userHistorian.pi) ? userHistorian.pi : {};
  await mkdir(join(projection.runtimeCwd, "config", "cortexkit"), { recursive: true });
  await writeFile(
    userFile,
    JSON.stringify(
      {
        ...user,
        historian: {
          ...userHistorian,
          pi: {
            ...userPi,
            model: projection.model,
            thinking_level: projection.thinkingLevel,
          },
        },
      },
      null,
      2,
    ),
  );
}
