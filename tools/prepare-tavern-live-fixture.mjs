import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  loadSelectedHostProductionModule,
  selectHostProductionArtifact,
} from "./lib/host-production-module.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ID = /^[A-Za-z0-9._-]{1,128}$/u;

const FIXTURE_ARTIFACTS = Object.freeze([
  Object.freeze({
    id: "live_persona_v1",
    location: "persona",
    artifact: Object.freeze({
      schemaVersion: 1,
      revision: 1,
      personaId: "live_persona_v1",
      name: "Live Operator",
      description: "An original SFW live-run fixture persona.",
    }),
  }),
  Object.freeze({
    id: "live_scenario_v1",
    location: "scenario",
    artifact: Object.freeze({
      schemaVersion: 1,
      revision: 1,
      scenarioId: "live_scenario_v1",
      text: "An original SFW conversation in a quiet tavern.",
      provenance: "authored",
      owner: "chat_override",
    }),
  }),
  Object.freeze({
    id: "live_examples_v1",
    location: "examples",
    artifact: Object.freeze({
      schemaVersion: 1,
      revision: 1,
      examplesId: "live_examples_v1",
      blocks: Object.freeze(["Operator greets the Companion, who offers a welcome."]),
    }),
  }),
  Object.freeze({
    id: "live_greetings_v1",
    location: "greeting",
    artifact: Object.freeze({
      schemaVersion: 1,
      revision: 1,
      greetingSetId: "live_greetings_v1",
      variants: Object.freeze([
        Object.freeze({ variantId: "first", text: "Welcome to the tavern." }),
        Object.freeze({ variantId: "alternate", text: "Good evening. How may I help?" }),
      ]),
    }),
  }),
]);

async function main(argv) {
  const { runtimeRoot, identity } = parseArguments(argv);
  assertExternalRuntimeRoot(runtimeRoot);
  const selected = await selectHostProductionArtifact();
  const { resolveRuntimePaths } = await loadSelectedHostProductionModule(selected, "runtime.js");
  const { TavernArtifactStore } = await loadSelectedHostProductionModule(selected, "tavern/artifact-store.js");
  const { resolveTavernPaths, tavernRevisionPath } = await loadSelectedHostProductionModule(selected, "tavern/tavern-paths.js");
  const { validateTavernArtifact } = await loadSelectedHostProductionModule(selected, "tavern/types.js");
  const runtimePaths = resolveRuntimePaths(identity, runtimeRoot);
  const tavernPaths = resolveTavernPaths(runtimePaths, identity);
  const store = new TavernArtifactStore(runtimePaths.root);
  const written = [];
  for (const fixture of FIXTURE_ARTIFACTS) {
    const path = artifactPath(tavernPaths, fixture, tavernRevisionPath);
    const envelope = await store.write(path, fixture.artifact, validateTavernArtifact);
    written.push(Object.freeze({ id: fixture.id, revision: envelope.revision, canonicalHash: envelope.canonicalHash }));
  }
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, fixture: "tavern_live_tvl03_v1", artifactCount: written.length, artifacts: written })}\n`,
  );
}

function parseArguments(argv) {
  if (argv.length !== 4)
    throw new Error("usage: prepare-tavern-live-fixture --runtime-root <absolute-path> --identity <json>");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag !== "--runtime-root" && flag !== "--identity") || values.has(flag) || value === undefined)
      throw new Error("invalid_tavern_live_fixture_arguments");
    values.set(flag, value);
  }
  const root = values.get("--runtime-root");
  const identityText = values.get("--identity");
  if (root === undefined || identityText === undefined || !isAbsoluteRoot(root))
    throw new Error("invalid_tavern_live_fixture_runtime_root");
  let identity;
  try {
    identity = JSON.parse(identityText);
  } catch {
    throw new Error("invalid_tavern_live_fixture_identity");
  }
  if (!isIdentity(identity)) throw new Error("invalid_tavern_live_fixture_identity");
  return Object.freeze({ runtimeRoot: resolve(root), identity: Object.freeze({ ...identity }) });
}

function artifactPath(paths, fixture, revisionPath) {
  switch (fixture.location) {
    case "persona":
      return revisionPath(join(paths.playerRoot, "personas", fixture.id), 1);
    case "scenario":
      return revisionPath(join(paths.companionRoot, "scenarios", fixture.id), 1);
    case "examples":
      return revisionPath(join(paths.companionRoot, "dialogue-examples", fixture.id), 1);
    case "greeting":
      return revisionPath(join(paths.companionRoot, "greetings", fixture.id), 1);
    default:
      throw new Error("invalid_tavern_live_fixture_artifact");
  }
}

function assertExternalRuntimeRoot(runtimeRoot) {
  const rel = relative(repositoryRoot, runtimeRoot);
  if (
    runtimeRoot === repositoryRoot ||
    (rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsoluteRoot(rel))
  )
    throw new Error("tavern_live_fixture_runtime_root_inside_repository");
}

function isIdentity(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    Object.keys(value).every((key) => key === "playerId" || key === "companionId" || key === "continuityId") &&
    ID.test(value.playerId) &&
    ID.test(value.companionId) &&
    ID.test(value.continuityId)
  );
}
function isAbsoluteRoot(value) {
  return typeof value === "string" && isAbsolute(value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "tavern_live_fixture_failed"}\n`);
    process.exitCode = 1;
  });
}

export { FIXTURE_ARTIFACTS, main };
