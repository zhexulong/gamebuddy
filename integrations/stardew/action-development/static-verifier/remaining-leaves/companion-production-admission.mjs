export const PRODUCTION_ADMISSION_PROFILES = Object.freeze({
  preview_run_a_v1: Object.freeze(["SIM-01", "SIM-02"]),
  preview_run_b_v1: Object.freeze(["SIM-03"]),
});

const FORBIDDEN_FLAGS = new Set([
  "--fixture-adapter", "--adapter", "--entry", "--main", "--model", "--gameplay-model",
  "--tool", "--topology", "--control-pipe", "--pipe", "--control-token", "--token",
  "--scenario", "--scenarios", "--launch", "--command", "--args", "--live-evidence-artifact",
]);
const REQUIRED_VALUE_FLAGS = Object.freeze([
  "--profile", "--operator-config", "--runtime-root", "--fixture-transaction-manifest", "--output",
]);
const REASON_CODES = new Set([
  "companion_live_source_attestation_unavailable",
  "companion_live_receipt_evidence_unavailable",
  "admission_supervisor_probe_unavailable",
  "admission_supervisor_probe_malformed",
  "fixture_transaction_manifest_unavailable",
  "fixture_transaction_manifest_invalid_or_unowned",
  "admission_preflight_unavailable",
]);
const WINDOWS_PATH = /^[A-Za-z]:\\(?!.*(?:^|\\)\.\.?\\)(?!.*[<>:"|?*\u0000-\u001f]).+$/;

export class ProductionAdmissionError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new ProductionAdmissionError(code); };

export function parseProductionAdmissionInvocation(argv, { platform = process.platform } = {}) {
  if (platform !== "win32") fail("admission_platform_unsupported");
  if (!Array.isArray(argv)) fail("admission_cli_invalid");
  const values = new Map();
  let preflight = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (FORBIDDEN_FLAGS.has(flag)) fail("admission_cli_forbidden_override");
    if (flag === "--preflight-only") { if (preflight) fail("admission_cli_duplicate_flag"); preflight = true; continue; }
    if (!REQUIRED_VALUE_FLAGS.includes(flag)) fail("admission_cli_unknown_flag");
    if (values.has(flag)) fail("admission_cli_duplicate_flag");
    const value = argv[++index];
    if (typeof value !== "string" || value.startsWith("--")) fail("admission_cli_value_missing");
    values.set(flag, value);
  }
  if (!preflight || REQUIRED_VALUE_FLAGS.some((flag) => !values.has(flag))) fail("admission_cli_required_flag_missing");
  const profile = values.get("--profile");
  if (!Object.hasOwn(PRODUCTION_ADMISSION_PROFILES, profile)) fail("admission_profile_invalid");
  for (const flag of REQUIRED_VALUE_FLAGS.slice(1)) if (!WINDOWS_PATH.test(values.get(flag))) fail("admission_path_not_absolute");
  return Object.freeze({ profile, scenarioIds: PRODUCTION_ADMISSION_PROFILES[profile], preflightOnly: true });
}

export function blockedAdmissionRecord(profile, reasonCode) {
  if (!REASON_CODES.has(reasonCode)) fail("admission_reason_code_invalid");
  const known = Object.hasOwn(PRODUCTION_ADMISSION_PROFILES, profile);
  return Object.freeze({
    schema: "gamebuddy_stardew_companion_admission_record/v1",
    state: "blocked",
    evidenceClass: "production_admission_preflight",
    profile: known ? profile : "redacted",
    scenarioIds: known ? PRODUCTION_ADMISSION_PROFILES[profile] : Object.freeze([]),
    phase: "A",
    reasonCodes: Object.freeze([reasonCode]),
  });
}

export async function runProductionAdmissionPreflight(invocation, { read, supervisorProbe }) {
  try {
    const manifest = JSON.parse(await read());
    if (manifest?.schema !== "gamebuddy-stardew-companion-fixture-transaction/v1" || manifest.state !== "owned" || manifest.profile !== invocation.profile || manifest.topology !== "native_ai_farmhand_multiplayer") {
      return blockedAdmissionRecord(invocation.profile, "fixture_transaction_manifest_invalid_or_unowned");
    }
    let probe;
    try { probe = await supervisorProbe(); } catch { return blockedAdmissionRecord(invocation.profile, "admission_supervisor_probe_unavailable"); }
    if (probe?.schema !== "gamebuddy-stardew-companion-admission-probe/v1" || probe.state !== "blocked" || probe.reasonCode !== "companion_live_source_attestation_unavailable") {
      return blockedAdmissionRecord(invocation.profile, "admission_supervisor_probe_malformed");
    }
    return blockedAdmissionRecord(invocation.profile, probe.reasonCode);
  } catch {
    return blockedAdmissionRecord(invocation?.profile, "fixture_transaction_manifest_unavailable");
  }
}
