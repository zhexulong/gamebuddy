import { randomBytes, randomUUID, createHash } from "node:crypto";

const PIPE_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const BINDING = /^[a-f0-9]{64}$/;

// D0 is a bounded composition check, never a live launcher mode.
export const D0_BOOTSTRAP_DEADLINE_MS = 1_500;

/**
 * Produces the short-lived control credentials for one Game child only. The
 * returned environment is a copy, so neither secret is published to the
 * launcher process, artifact metadata, or its standard streams.
 */
export function createProductionChildEnvironment(entry, environment = process.env, material = undefined, d0ChallengeSha256 = undefined, liveSourceAttestationLaunchBindingSha256 = undefined) {
  const childEnvironment = { ...environment };
  // Production artifacts own their Pi cwd, agent directory, and session
  // storage. Never allow a launcher (including a developer Pi process) to
  // select a session, agent directory, or Magic Context behavior by inheritance.
  for (const key of Object.keys(childEnvironment)) {
    const normalized = key.toUpperCase();
    if (normalized === "PI" || normalized.startsWith("PI_") || normalized.startsWith("MAGIC_CONTEXT_"))
      delete childEnvironment[key];
  }
  delete childEnvironment.GAMEBUDDY_CONTROL_PIPE;
  delete childEnvironment.GAMEBUDDY_CONTROL_TOKEN;
  // The D0 parent-only test selector is not a child capability or signal.
  delete childEnvironment.GAMEBUDDY_D0_BOOTSTRAP_TEST;
  delete childEnvironment.GAMEBUDDY_D0_BOOTSTRAP_CHALLENGE_SHA256;
  delete childEnvironment.GAMEBUDDY_D0_TEST_PARENT_DELIVERY_NEVER_SETTLES;
  delete childEnvironment.GAMEBUDDY_LIVE_SOURCE_ATTESTATION_LAUNCH_BINDING_SHA256;
  if (entry !== "main.js" && entry !== "farmhand-companion-preview.js") return childEnvironment;

  if (entry === "farmhand-companion-preview.js") {
    if (liveSourceAttestationLaunchBindingSha256 === undefined) return childEnvironment;
    if (!BINDING.test(liveSourceAttestationLaunchBindingSha256)) throw new Error("live_source_attestation_binding_invalid");
    childEnvironment.GAMEBUDDY_LIVE_SOURCE_ATTESTATION_LAUNCH_BINDING_SHA256 = liveSourceAttestationLaunchBindingSha256;
    return childEnvironment;
  }

  const launchMaterial = material ?? mintProductionControlLaunch();
  if (!PIPE_NAME.test(launchMaterial.pipeName) || !TOKEN.test(launchMaterial.launchToken)) throw new Error("generated_product_control_launch_invalid");
  childEnvironment.GAMEBUDDY_CONTROL_PIPE = launchMaterial.pipeName;
  childEnvironment.GAMEBUDDY_CONTROL_TOKEN = launchMaterial.launchToken;
  if (d0ChallengeSha256 !== undefined) {
    if (!BINDING.test(d0ChallengeSha256)) throw new Error("deterministic_bootstrap_challenge_invalid");
    childEnvironment.GAMEBUDDY_D0_BOOTSTRAP_CHALLENGE_SHA256 = d0ChallengeSha256;
  }
  if (liveSourceAttestationLaunchBindingSha256 !== undefined) {
    if (!BINDING.test(liveSourceAttestationLaunchBindingSha256)) throw new Error("live_source_attestation_binding_invalid");
    childEnvironment.GAMEBUDDY_LIVE_SOURCE_ATTESTATION_LAUNCH_BINDING_SHA256 = liveSourceAttestationLaunchBindingSha256;
  }
  return childEnvironment;
}

/** Test-only D0 composition material. Production never enables the handoff seam. */
export function mintProductionControlLaunch() {
  const pipeName = `gamebuddy_${randomUUID().replaceAll("-", "")}`;
  const launchToken = randomBytes(32).toString("base64url");
  if (!PIPE_NAME.test(pipeName) || !TOKEN.test(launchToken)) throw new Error("generated_product_control_launch_invalid");
  return Object.freeze({ pipeName, launchToken, launchBinding: digest(`${pipeName}:${launchToken}`) });
}

/** Sends exactly one D0 capability handoff to the immediate IPC parent. */
export function sendBootstrapControlHandoff(send, material) {
  if (typeof send !== "function" || !material || !PIPE_NAME.test(material.pipeName) || !TOKEN.test(material.launchToken) || !BINDING.test(material.launchBinding)) throw new Error("deterministic_bootstrap_handoff_invalid");
  let sent = false;
  return () => {
    if (sent) throw new Error("deterministic_bootstrap_handoff_duplicate");
    sent = true;
    send(Object.freeze({ schema: "gamebuddy-production-control-capability/v1", protocolVersion: 1, pipeName: material.pipeName, launchToken: material.launchToken, launchBinding: material.launchBinding }));
  };
}
export function sha256(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function digest(value) { return sha256(value); }
