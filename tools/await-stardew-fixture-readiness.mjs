import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const sessionDirectory = option("--session-directory");
const hostConfigPath = option("--host-config");
const timeoutMs = Number(option("--timeout-ms"));
const notBeforeUnixMs = Number(option("--not-before-unix-ms"));
if (
  !isAbsolute(sessionDirectory) ||
  !isAbsolute(hostConfigPath) ||
  !Number.isInteger(timeoutMs) ||
  timeoutMs < 1 ||
  timeoutMs > 300_000 ||
  !Number.isSafeInteger(notBeforeUnixMs) ||
  notBeforeUnixMs < 0
) {
  throw new Error("fixture_readiness_invalid_options");
}

const hostConfig = JSON.parse((await readFile(hostConfigPath, "utf8")).replace(/^\uFEFF/, ""));
const automation = hostConfig.HostAutomation;
const provisioning = hostConfig.HostFarmhandProvisioning;
if (!automation?.Enable || typeof automation.FixtureScenario !== "string" || automation.FixtureScenario.length === 0) {
  console.log(JSON.stringify({ state: "not_required" }));
  process.exit(0);
}
if (!provisioning?.SessionToken || typeof automation.SaveName !== "string" || automation.SaveName.length === 0) {
  throw new Error("invalid_fixture_readiness_host_config");
}

const readinessPath = resolve(sessionDirectory, "stardew-fixture-readiness.json");
if (basename(readinessPath) !== "stardew-fixture-readiness.json") throw new Error("invalid_fixture_readiness_path");
const deadline = Date.now() + timeoutMs;
let lastError = "fixture_readiness_missing";
while (Date.now() < deadline) {
  try {
    const value = JSON.parse(await readFile(readinessPath, "utf8"));
    validateReadiness(
      value,
      automation.FixtureScenario,
      automation.SaveName,
      provisioning.SessionToken,
      notBeforeUnixMs,
    );
    if (value.state === "fixture_blocked") throw new Error(`fixture_preflight_blocked_${value.reasonCode}`);
    console.log(JSON.stringify(value));
    process.exit(0);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    // A previous Host run may have left a valid, signed readiness document in
    // the fixed session directory. It is not valid for this launch, but it is
    // also not a terminal fixture failure: wait for this Host launch to atomically
    // replace it. Authentication, structural validity, clock skew, and an
    // explicit native initializer block are fail-fast.
    if (/^fixture_preflight_blocked_|^fixture_readiness_(authentication_failed|invalid|clock_invalid)$/.test(lastError))
      throw error;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}
throw new Error(lastError === "fixture_readiness_missing" ? "fixture_readiness_timeout" : lastError);

function validateReadiness(value, scenario, saveName, sessionToken, notBeforeUnixMs) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    value.integrationId !== "stardew" ||
    value.fixtureScenario !== scenario ||
    value.saveName !== saveName ||
    (value.state !== "fixture_ready" && value.state !== "fixture_blocked") ||
    !isReasonCode(value.reasonCode) ||
    !Number.isSafeInteger(value.publishedAtUnixMs) ||
    !isOpaque(value.sessionNonce) ||
    typeof value.signature !== "string"
  ) {
    throw new Error("fixture_readiness_invalid");
  }
  if (!verifySignature(value, sessionToken)) throw new Error("fixture_readiness_authentication_failed");
  if (value.publishedAtUnixMs < notBeforeUnixMs) throw new Error("fixture_readiness_stale");
  if (value.publishedAtUnixMs > Date.now() + 30_000) throw new Error("fixture_readiness_clock_invalid");
}

function verifySignature(value, token) {
  const { signature, ...unsigned } = value;
  const expected = createHmac("sha256", token).update(JSON.stringify(unsigned), "utf8").digest("base64url");
  const actual = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function isReasonCode(value) {
  return typeof value === "string" && /^[a-z0-9_:-]{1,128}$/.test(value);
}

function isOpaque(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
