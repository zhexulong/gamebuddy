import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_SURFACE_MAX_JSON_BYTES } from "./action-surface.mjs";
import { checkActionProjection } from "./action-projection-check.mjs";
import { readFixedPackageUtf8File } from "./package-safe-reader.mjs";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ACTION_SURFACE_ARTIFACT_RELATIVE_PATH = "contracts/generated/action-surface.v1.json";
const ACTION_SURFACE_CHECK_SCHEMA = "gamebuddy-stardew-action-surface-check/v1";
const ACTION_SURFACE_CHECK_MAX_REPORT_BYTES = 4096;

function fail(code) {
  throw new Error(`stardew_action_surface_check_${code}`);
}

async function readGeneratedActionSurface() {
  return readFixedPackageUtf8File({
    packageDirectory: PACKAGE_DIRECTORY,
    relativePath: ACTION_SURFACE_ARTIFACT_RELATIVE_PATH,
    maxBytes: ACTION_SURFACE_MAX_JSON_BYTES,
    errorPrefix: "stardew_action_surface_check",
  });
}

function boundedReport(projection) {
  const report = Object.freeze({
    schema: ACTION_SURFACE_CHECK_SCHEMA,
    catalogRevision: projection.catalogRevision,
    status: "valid",
    artifact: ACTION_SURFACE_ARTIFACT_RELATIVE_PATH,
     actions: projection.actions.length,
     executable: projection.executable.length,
    readOnly: projection.readOnly.length,
  });
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > ACTION_SURFACE_CHECK_MAX_REPORT_BYTES) {
    fail("report_bounds");
  }
  return report;
}

/**
 * Validate the package-owned generated artifact as a static consumer input.
 * This never discovers, exports, publishes, or supplies a runtime capability.
 */
export async function runActionSurfaceCheck() {
  const text = await readGeneratedActionSurface();
  const projection = checkActionProjection(text);
  return boundedReport(projection);
}

export {
  ACTION_SURFACE_ARTIFACT_RELATIVE_PATH,
  ACTION_SURFACE_CHECK_MAX_REPORT_BYTES,
  ACTION_SURFACE_CHECK_SCHEMA,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runActionSurfaceCheck().then(
    (report) => process.stdout.write(`${JSON.stringify(report)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
