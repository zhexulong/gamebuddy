import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTION_SOURCE_SNAPSHOT_RELATIVE_PATH,
  deriveActionSourceProjection,
  loadSources,
  serializeActionSourceProjection,
} from "./action-source-projection-producer.mjs";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LAYOUT_PATH = path.join(PACKAGE_DIRECTORY, "projection-source-layout.json");
const LAYOUT_SCHEMA = "gamebuddy-stardew-action-projection-source-layout/v1";
const MODES = Object.freeze({
  "repository-root": "../../..",
  "standalone-input": "inputs/action-projection-source",
});

function fail(code) {
  throw new Error(`stardew_action_source_projection_check_${code}`);
}

export async function runActionSourceProjectionCheck() {
  let layout;
  try {
    layout = JSON.parse(await readFile(LAYOUT_PATH, "utf8"));
  } catch {
    fail("layout_unreadable");
  }
  if (layout === null || typeof layout !== "object" || Array.isArray(layout)
    || Object.keys(layout).sort().join(",") !== "mode,schema,sourceRoot"
    || layout.schema !== LAYOUT_SCHEMA
    || !Object.hasOwn(MODES, layout.mode)
    || layout.sourceRoot !== MODES[layout.mode]) fail("layout_invalid");

  const sourceRoot = path.resolve(PACKAGE_DIRECTORY, layout.sourceRoot);
  const sources = await loadSources(sourceRoot);
  const produced = Buffer.from(serializeActionSourceProjection(deriveActionSourceProjection(sources)), "utf8");
  const artifactPath = path.join(sourceRoot, ACTION_SOURCE_SNAPSHOT_RELATIVE_PATH);
  let artifact;
  try {
    artifact = await readFile(artifactPath);
  } catch {
    fail("artifact_unreadable");
  }
  if (Buffer.compare(produced, artifact) !== 0) fail("producer_drift");
  return Object.freeze({ status: "valid", mode: layout.mode, bytes: artifact.length });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runActionSourceProjectionCheck().then(
    (report) => process.stdout.write(`${JSON.stringify(report)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
