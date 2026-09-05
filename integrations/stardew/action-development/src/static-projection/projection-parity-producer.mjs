import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_SURFACE_MAX_JSON_BYTES, parseActionSurface } from "../action-surface.mjs";
import { readFixedPackageUtf8File } from "../package-safe-reader.mjs";
import {
  STATIC_PROJECTION_FIXED_PROTOCOL_CONTROL_IDS,
  STATIC_PROJECTION_SCHEMA,
} from "./action-descriptor-snapshot.mjs";
import {
  PROJECTION_PARITY_ABSENT_ROUTE_TOKENS,
  PROJECTION_PARITY_ADMITTED_LIFECYCLES,
  PROJECTION_PARITY_FIXED_PROTOCOL_CONTROLS,
  PROJECTION_PARITY_GUARD_ORDER,
  PROJECTION_PARITY_SCHEMA,
  validateActionProjectionParity,
} from "./action-projection-parity.mjs";

const ERROR_PREFIX = "stardew_projection_parity_producer";
const PACKAGE_DIRECTORY = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const STATIC_DESCRIPTOR_SCHEMA = "gamebuddy-stardew-static-action-descriptor/v1";
const IDENTIFIER = /^[a-z][a-z0-9_]{1,127}$/;
const SCHEMA_ID = /^[a-z0-9][a-z0-9._-]*\/v[1-9][0-9]*$/;
const JSON_NAME = /^[a-z0-9][a-z0-9._-]*\.json$/;

export const PROJECTION_PARITY_SNAPSHOT_RELATIVE_PATH = "contracts/projection/action-projection-parity.v1.json";

function fail(code) {
  throw new Error(`${ERROR_PREFIX}_${code}`);
}

async function listJsonNames(relativeDirectory) {
  let entries;
  try {
    entries = await readdir(path.join(PACKAGE_DIRECTORY, relativeDirectory), { withFileTypes: true });
  } catch {
    fail("producers_unreadable");
  }
  return entries
    .filter((entry) => entry.isFile() && JSON_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function readPackageJson(relativePath, maxBytes, code) {
  const text = await readFixedPackageUtf8File({
    packageDirectory: PACKAGE_DIRECTORY,
    relativePath,
    maxBytes,
    errorPrefix: ERROR_PREFIX,
  });
  try {
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

/**
 * Deterministically recompute the projection-parity snapshot from package-owned
 * producer documents only. No root Host, Mod, or tool path is ever read; the
 * generated surface artifact stays the sole registration producer.
 */
export async function produceProjectionParitySnapshot() {
  const artifact = parseActionSurface(await readFixedPackageUtf8File({
    packageDirectory: PACKAGE_DIRECTORY,
    relativePath: "contracts/generated/action-surface.v1.json",
    maxBytes: ACTION_SURFACE_MAX_JSON_BYTES,
    errorPrefix: ERROR_PREFIX,
  }));
  const actions = artifact.actions;
  const executableActionIds = actions
    .filter((action) => action.lifecycle === "published" && action.kind === "execution")
    .map((action) => action.actionId);
  const readOnlyActionIds = actions
    .filter((action) => action.kind === "read_only")
    .map((action) => action.actionId);
  const experimentalActionIds = actions
    .filter((action) => action.lifecycle === "experimental")
    .map((action) => action.actionId);

  const descriptorSchemas = new Set();
  const descriptorActionIds = [];
  for (const name of await listJsonNames("descriptors")) {
    const descriptor = await readPackageJson(`descriptors/${name}`, 64 * 1024, "descriptor_unreadable");
    if (descriptor?.schema !== STATIC_DESCRIPTOR_SCHEMA) fail("descriptor_schema_unexpected");
    if (typeof descriptor.actionId !== "string" || !IDENTIFIER.test(descriptor.actionId)) {
      fail("descriptor_action_id_invalid");
    }
    descriptorSchemas.add(descriptor.schema);
    descriptorActionIds.push(descriptor.actionId);
  }

  const briefSchemas = new Set();
  for (const name of await listJsonNames("briefs")) {
    const brief = await readPackageJson(`briefs/${name}`, 16 * 1024, "brief_unreadable");
    if (typeof brief?.schema !== "string" || !SCHEMA_ID.test(brief.schema)) fail("brief_schema_unexpected");
    briefSchemas.add(brief.schema);
  }

  const inventory = await readPackageJson("tool-inventory.json", 256 * 1024, "inventory_unreadable");
  if (typeof inventory?.schema !== "string" || !SCHEMA_ID.test(inventory.schema)) {
    fail("inventory_schema_unexpected");
  }

  const schemaDocIds = new Set();
  for (const name of await listJsonNames("contracts")) {
    if (!name.endsWith(".schema.json")) continue;
    const schemaDoc = await readPackageJson(`contracts/${name}`, 64 * 1024, "schema_doc_unreadable");
    if (typeof schemaDoc?.$id !== "string" || !SCHEMA_ID.test(schemaDoc.$id)) fail("schema_doc_id_unexpected");
    schemaDocIds.add(schemaDoc.$id);
  }

  const fixtureOwnedFiles = (await listJsonNames("tests/fixtures")).map((name) => `tests/fixtures/${name}`);

  const schemas = [...new Set([
    artifact.schema,
    STATIC_PROJECTION_SCHEMA,
    ...descriptorSchemas,
    ...briefSchemas,
    inventory.schema,
    ...schemaDocIds,
  ])].sort();

  const fixedControls = [...PROJECTION_PARITY_FIXED_PROTOCOL_CONTROLS];
  if (
    fixedControls.length !== STATIC_PROJECTION_FIXED_PROTOCOL_CONTROL_IDS.length
    || STATIC_PROJECTION_FIXED_PROTOCOL_CONTROL_IDS.some((id, index) => id !== fixedControls[index])
  ) {
    fail("fixed_control_drift");
  }

  const executableSet = new Set(executableActionIds);
  for (const actionId of descriptorActionIds) {
    if (!executableSet.has(actionId)) fail("descriptor_not_executable");
  }
  const localFixtureOwnedActionIds = descriptorActionIds.filter((actionId) => executableSet.has(actionId));
  const nativeActionIds = executableActionIds.filter((actionId) => !localFixtureOwnedActionIds.includes(actionId));

  const snapshot = {
    schema: PROJECTION_PARITY_SCHEMA,
    developmentOnly: true,
     surface: {
       schema: artifact.schema,
       catalogRevision: artifact.catalogRevision,
       actions,
     },
    lifecycle: {
      admittedLifecycles: [...PROJECTION_PARITY_ADMITTED_LIFECYCLES],
      executableActionIds,
      readOnlyActionIds,
      experimentalActionIds,
    },
    protocol: {
      schemas,
      fixedControls,
    },
    ownership: {
      localFixtureOwnedActionIds,
      nativeActionIds,
    },
    fixtureOwnedFiles,
    guardOrder: [...PROJECTION_PARITY_GUARD_ORDER],
    absentRoutes: [...PROJECTION_PARITY_ABSENT_ROUTE_TOKENS],
  };

  // The producer can never emit a snapshot the strict checker rejects.
  validateActionProjectionParity(snapshot);
  return snapshot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.join(PACKAGE_DIRECTORY, PROJECTION_PARITY_SNAPSHOT_RELATIVE_PATH);
  produceProjectionParitySnapshot().then(
    async (snapshot) => {
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      process.stdout.write(`produced ${PROJECTION_PARITY_SNAPSHOT_RELATIVE_PATH}\n`);
    },
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}