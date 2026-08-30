import { readFile } from "node:fs/promises";
import { validateDeterministicPortfolio } from "./portfolio.mjs";
import {
  ACTION_REGISTRY,
  createActionRegistry,
  resolveActionRegistration,
  validateVerifierResult,
} from "./action-registry.mjs";

const RESULT_SCHEMA = "gamebuddy-action-scenario-result/v1";
const ACTION_BEARING_COMMANDS = new Set(["check", "preflight", "run-live"]);


function fail(code) {
  throw new Error(`stardew_action_project_${code}`);
}

function report(invocation, status, fields = {}) {
  return Object.freeze({
    schema: RESULT_SCHEMA,
    gameId: "stardew",
    status,
    ...(invocation.actionId === undefined ? {} : { actionId: invocation.actionId }),
    ...fields,
    ...(invocation.briefFile !== undefined ? { briefFile: invocation.briefFile } : {}),
    ...(invocation.runId !== undefined ? { runId: invocation.runId } : {}),
  });
}

function safeReason(value, fallback) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(value) ? value : fallback;
}

function preflightReport(invocation, result) {
  if (result?.gameId !== "stardew" || result?.actionId !== invocation.actionId) fail("preflight_identity_mismatch");
  const reasons = Array.isArray(result?.reasons) ? result.reasons.filter((reason) => typeof reason === "string" && reason.length > 0) : [];
  const ready = result?.state === "READY" && result?.ready === true;
  return report(invocation, "preflight", {
    outcome: ready ? "ready" : "blocked",
    ...(ready ? {} : { reasonCode: safeReason(reasons[0], "preflight_blocked") }),
  });
}

function statusReport(invocation, result) {
  if (result?.gameId !== "stardew" || result?.actionId !== invocation.actionId) fail("status_identity_mismatch");
  const observation = result?.observation;
  const available = observation?.availability === "available";
  return report(invocation, "status", {
    outcome: available ? "available" : "unavailable",
    ...(available ? {} : { reasonCode: safeReason(observation?.reason, "status_unavailable") }),
  });
}

async function liveReport(invocation, result, registration, dependencies, verifiedLiveReports) {
  if (result?.gameId !== "stardew" || result?.actionId !== invocation.actionId || result?.runId !== invocation.runId) fail("live_identity_mismatch");
  if (result?.state !== "PASSED" && result?.state !== "BLOCKED" && result?.state !== "INCOMPLETE") fail("live_result_invalid");
  const outcome = result?.state === "PASSED" ? "passed" : result?.state === "BLOCKED" ? "blocked" : "incomplete";
  if (outcome === "passed") {
    const receiptVerification = await invokeHandler(registration, "verifyReceiptEvidencePostcondition", { actionId: invocation.actionId, invocation, result, dependencies });
    validateVerifierResult("receipt", { actionId: invocation.actionId, invocation, result: receiptVerification });
    const cleanupVerification = await invokeHandler(registration, "verifyCleanup", { actionId: invocation.actionId, invocation, result, dependencies });
    validateVerifierResult("cleanup", { actionId: invocation.actionId, invocation, result: cleanupVerification });
  }
  const reasons = Array.isArray(result?.reasons) ? result.reasons : [];
  const reason = result?.reasonCode ?? reasons.find((candidate) => typeof candidate === "string");
  const neutralReport = report(invocation, "live", {
    outcome,
    ...(outcome === "passed" ? {} : { reasonCode: safeReason(reason, `live_${outcome}`) }),
  });
  if (outcome === "passed") verifiedLiveReports.add(neutralReport);
  return neutralReport;
}

async function invokeHandler(registration, name, input) {
  const handler = registration[name];
  if (typeof handler !== "function") fail(`action_registration_${name}_missing`);
  return await handler(input);
}

async function readPackagePortfolio(manifest) {
  if (typeof manifest.portfolioFile !== "string") return undefined;
  try {
    const portfolio = JSON.parse(await readFile(manifest.portfolioFile, "utf8"));
    return validateDeterministicPortfolio(portfolio);
  } catch {
    return undefined;
  }
}

async function hasPackagePortfolio(manifest) {
  return (await readPackagePortfolio(manifest)) !== undefined;
}

async function assertPortfolioAction(manifest, actionId, registry) {
  const entries = await readPackagePortfolio(manifest);
  if (entries === undefined) fail("portfolio_missing");
  if (!entries.some((entry) => entry.kind === "action-check" && entry.actionId === actionId)) fail("action_not_available");
  resolveActionRegistration(actionId, registry);
}

async function projectStatusReport(manifest, invocation) {
  if (!await hasPackagePortfolio(manifest)) {
    return report(invocation, "blocked", { outcome: "portfolio_missing", reasonCode: "portfolio_missing" });
  }
  const evidenceRoot = typeof manifest.evidenceRoot === "string" && manifest.evidenceRoot.length > 0 && manifest.evidenceRoot.length <= 512
    ? manifest.evidenceRoot
    : undefined;
  return report(invocation, "observed", {
    outcome: "portfolio_observed",
    reasonCode: "none",
    claimScope: "project",
    ...(evidenceRoot === undefined ? {} : { evidenceRoot }),
  });
}

function verifyReport(verifiedLiveReports, { manifest, invocation, report: candidate } = {}) {
  if (!manifest || manifest.gameId !== "stardew" || !invocation || invocation.command !== "run-live") fail("report_verification_input_invalid");
  if (!candidate || candidate.gameId !== "stardew" || candidate.status !== "live" || candidate.outcome !== "passed"
    || candidate.actionId !== invocation.actionId || candidate.runId !== invocation.runId) fail("report_verification_identity_mismatch");
  if (!verifiedLiveReports.delete(candidate)) fail("report_verification_unattested");
  return Object.freeze({
    schema: "gamebuddy-action-project-report-verification/v1",
    gameId: "stardew",
    actionId: invocation.actionId,
    runId: invocation.runId,
    verified: true,
  });
}

async function runActionProjectWithRegistry({ manifest, invocation, dependencies }, registry, verifiedLiveReports, { allowDependencies = false } = {}) {
  if (!allowDependencies && dependencies !== undefined) fail("dependency_override_forbidden");
  if (!manifest || manifest.gameId !== "stardew" || !invocation || typeof invocation.command !== "string") fail("invalid_invocation");
  if (!["check", "preflight", "run-live", "status"].includes(invocation.command)) fail("command_not_available");
  if (ACTION_BEARING_COMMANDS.has(invocation.command)) {
    if (typeof invocation.actionId !== "string") fail("action_not_available");
    resolveActionRegistration(invocation.actionId, registry);
  }
  if (invocation.command === "status") {
    if (invocation.actionId === undefined) return projectStatusReport(manifest, invocation);
    const registration = resolveActionRegistration(invocation.actionId, registry);
    await assertPortfolioAction(manifest, invocation.actionId, registry);
    return statusReport(invocation, await invokeHandler(registration, "status", { manifest, invocation, dependencies }));
  }
  if (invocation.command === "preflight") {
    const registration = resolveActionRegistration(invocation.actionId, registry);
    const result = await invokeHandler(registration, "preflight", { invocation, dependencies });
    return preflightReport(invocation, result);
  }
  if (invocation.command === "run-live") {
    if (typeof invocation.profileFile !== "string") fail("profile_missing");
    if (typeof invocation.runId !== "string" || invocation.runId.length === 0) fail("run_id_missing");
    const registration = resolveActionRegistration(invocation.actionId, registry);
    const result = registration.runLive === undefined
      ? Object.freeze({
        gameId: "stardew",
        actionId: invocation.actionId,
        status: "live",
        state: "BLOCKED",
        runId: invocation.runId,
        reasons: Object.freeze([registration.blockedPolicy?.reasonCode ?? "run_live_blocked"]),
      })
      : await invokeHandler(registration, "runLive", { manifest, invocation, dependencies });
    return await liveReport(invocation, result, registration, dependencies, verifiedLiveReports);
  }

  const registration = resolveActionRegistration(invocation.actionId, registry);
  const result = await invokeHandler(registration, "check", { manifest, invocation, dependencies, actionId: invocation.actionId });
  const contractVerification = await invokeHandler(registration, "verifyContract", { actionId: invocation.actionId, result, dependencies });
  validateVerifierResult("contract", { actionId: invocation.actionId, result: contractVerification });
  return report(invocation, "checked");
}

function createAdapterInstance(registry, { allowDependencies }) {
  const verifiedLiveReports = new WeakSet();
  return Object.freeze({
    runActionProject(input = {}) {
      return runActionProjectWithRegistry(input, registry, verifiedLiveReports, { allowDependencies });
    },
    verifyActionProjectReport(input) {
      return verifyReport(verifiedLiveReports, input);
    },
  });
}

export function createProjectAdapter(registrations = ACTION_REGISTRY) {
  const registry = registrations === ACTION_REGISTRY ? ACTION_REGISTRY : createActionRegistry(registrations);
  return createAdapterInstance(registry, { allowDependencies: false });
}

export function createTestProjectAdapter(registrations = ACTION_REGISTRY) {
  const registry = registrations === ACTION_REGISTRY ? ACTION_REGISTRY : createActionRegistry(registrations);
  return createAdapterInstance(registry, { allowDependencies: true });
}
