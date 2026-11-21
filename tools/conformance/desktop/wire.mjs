/**
 * The Desktop's private wire as a PEER sees it: one spelling of every name this suite sends,
 * reads or asserts on.
 *
 * WHY THIS FILE EXISTS. The suite drives the installed launcher as a black box, so the harness
 * has to speak the desktop's own protocol. That makes every string below a fact about the
 * PRODUCT, held here once and read by both ends the suite owns (the runner that drives a case
 * and the mock Host that the launcher starts). Nothing here is read out of the C# sources at
 * run time and nothing here is an assertion about them: it is the wire the launcher publishes
 * on its pipes and on its child's standard streams, spelled as a language-neutral peer must
 * spell it.
 *
 * `FRAME_CAP_BYTES` is the broker's one frame ceiling. It is asserted, not discovered: a Host
 * frame longer than this is refused, and the case that proves it quotes the number the product
 * answers with.
 */

/** Schema of the authenticated Guardian session the launcher serves on its named pipe. */
export const GUARDIAN_SESSION_SCHEMA = "gamebuddy-desktop-guardian-session/v1";

/** Schema of the one-shot acknowledgement the Host writes on its own standard output. */
const HOST_BOOTSTRAP_SCHEMA = "gamebuddy-desktop-host-bootstrap/v1";

/** Schema of the one-shot presentation entry the Host publishes on its own pipe. */
const PRESENTATION_HANDOFF_SCHEMA = "gamebuddy-desktop-presentation-handoff/v1";

/** Schema of the root layout the bootstrap frame carries. */
const ROOT_LAYOUT_SCHEMA = "gamebuddy-windows-root-layout/v1";

/** Schema of the bounded channel a second invocation delivers an intent on. */
const PRIMARY_INTENT_SCHEMA = "gamebuddy-desktop-primary-intent/v1";

/** The broker's one frame ceiling, in bytes, excluding the terminating LF. */
export const FRAME_CAP_BYTES = 16_384;

/** Pipe the launcher creates for the authenticated Host session; suffixed with the bootstrap id. */
export const GUARDIAN_PIPE_PREFIX = "GameBuddy.HostGuardian.";

/** Pipe the launcher creates for the Host's one presentation entry; suffixed with the bootstrap id. */
export const PRESENTATION_PIPE_PREFIX = "GameBuddy.DesktopPresentationHandoff.";

/** Pipe a second invocation addresses; suffixed with the Windows session id. */
export const PRIMARY_INTENT_PIPE_PREFIX = "GameBuddy.Desktop.PrimaryIntent.v1.";

/** The launcher's own record of the Guardian attempt it has armed, as the next launch reads it. */
export const GUARDIAN_ATTEMPT_RECORD = Object.freeze({
  directory: "guardian-attempt",
  file: "guardian-attempt.json",
  schema: "gamebuddy-desktop-guardian-attempt/v1",
  version: 1,
  settledUnverified: "guardian_settle_unverified",
  pidBelongsToAnotherProcess: "guardian_pid_belongs_to_another_process",
});

/** The launcher's own record of a Host child it had to terminate, with the two numbers a quit reports. */
export const HOST_TEARDOWN_RECORD = Object.freeze({
  directory: "host-exit",
  schema: "gamebuddy-desktop-host-teardown/v1",
  timeoutOutcome: "host_teardown_timeout",
});

/** Where the harness leaves the scenario a case's mock Host reads, under the layout's operational root. */
export const SCENARIO_FILE = "scenario.json";

/**
 * The facts a mock Host writes to its transcript, one JSON document per line.
 *
 * The mock Host is handed this whole map in its scenario (`facts`), so the names live here and
 * nowhere else: the child prints `facts.helloAccepted`, the runner asserts on `facts.helloAccepted`.
 */
export const FACTS = Object.freeze({
  hostStarted: "host_started",
  bootstrapFrame: "bootstrap_frame_read",
  helloAccepted: "hello_accepted",
  helloRefused: "hello_refused",
  oversizedHelloWritten: "oversized_hello_written",
  oversizedConnectionClosed: "oversized_connection_closed",
  oversizedConnectionHeld: "oversized_connection_held",
  acknowledgmentWritten: "acknowledgment_written",
  handoffRefused: "handoff_refused",
  commandWritten: "command_written",
  controlClosed: "control_closed",
  reconnectAttempted: "reconnect_attempted",
  reconnected: "reconnected",
  controlEndOfStream: "control_end_of_stream",
  environment: "environment",
  hostExiting: "host_exiting",
});

/**
 * The behaviours a case can ask of its mock Host. Each one is a peer's behaviour, not a product
 * operation: the launcher is judged on how it answers, never on what it is told to do.
 */
export const BEHAVIOURS = Object.freeze({
  standard: "standard",
  oversizedHello: "oversized-hello",
  eofThenReauthenticate: "eof-then-reauthenticate",
  malformedThenReauthenticate: "malformed-then-reauthenticate",
  hang: "hang",
  environment: "environment",
});

/** The bounded code a launch that never got a Host session ends with. */
export const GUARDIAN_LAUNCH_UNAVAILABLE = "guardian_launch_unavailable";

/**
 * The one frame shape a hello may have: seven keys, in this order, and no eighth wherever the
 * product refuses an exact key sequence. The launcher's reader demands the exact set, so the
 * harness writes exactly that set.
 */
export function helloFrame({ bootstrapId, generation, inventoryDigest, runtimeAdmissionSha256 }) {
  return {
    schema: GUARDIAN_SESSION_SCHEMA,
    protocolVersion: 1,
    operation: "hello",
    bootstrapId,
    generation,
    inventoryDigest,
    runtimeAdmissionSha256,
  };
}

/** The acknowledgement the launcher accepts as readiness, with the two numbers a quit is bounded by. */
export function acknowledgmentFrame({
  bootstrapId,
  generation,
  inventoryDigest,
  runtimeAdmissionSha256,
  drainDeadlineMs,
  stepHangDeadlineMs,
}) {
  return {
    schema: HOST_BOOTSTRAP_SCHEMA,
    protocolVersion: 1,
    status: "accepted",
    bootstrapId,
    generation,
    inventoryDigest,
    runtimeAdmissionSha256,
    rootLayoutSchema: ROOT_LAYOUT_SCHEMA,
    drainDeadlineMs,
    stepHangDeadlineMs,
  };
}

/**
 * The presentation entry the harness publishes on purpose: an entry the product must refuse,
 * because a launch whose Host is a harness must never open the player's browser.
 */
export function refusedPresentationFrame({ bootstrapId }) {
  return {
    schema: PRESENTATION_HANDOFF_SCHEMA,
    protocolVersion: 1,
    bootstrapId,
    launchUrl: "https://conformance.invalid/not-a-loopback-entry",
  };
}

/** The bounded frame a second invocation may deliver, and the only two intents it has. */
export const PRIMARY_INTENTS = Object.freeze(["open", "focus"]);

export function primaryIntentFrame(intent) {
  return { schema: PRIMARY_INTENT_SCHEMA, protocolVersion: 1, intent };
}
