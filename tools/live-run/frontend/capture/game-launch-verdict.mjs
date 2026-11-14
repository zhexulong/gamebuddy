/**
 * The one classification of what a game-launch run measured, and the one spelling of "this driver
 * measured nothing".
 *
 * Two facts live here because two files need the same answer. The driver (`w-game-launch.cjs`)
 * decides whether the product's own Game-surface chain got far enough to be a measurement at all,
 * and `phases/capture.mjs` counts that verdict in the run's totals. A second hand-written copy of
 * "which refusal is a missing prerequisite and which is a product fault" would let the driver print
 * `not_measured` while the totals counted a pass - the shape this kit keeps paying for
 * (`reconciliation-verdict.mjs` is the same lesson for the reconciling drivers).
 *
 * The rule, in order:
 *
 * 1. A refusal whose bounded cause names the Guardian family is `guardian_pipe_unreachable`. The
 *    only server of that session in production is the native Desktop supervisor
 *    (`desktop/GameBuddy.Desktop/DesktopHostBootstrapBroker.cs:47`), so on a machine that runs the
 *    gate launcher instead, the Host's arm/launch frames have nowhere to go.
 * 2. A launch refused with the generic `game_unavailable` while NO endpoint can arm is the same
 *    prerequisite, named the same way. "No endpoint can arm" is either "none bound" or "the only one
 *    bound is this run's own gate peer" - the gate answers `hello` and destroys the socket on any
 *    later frame (`tools/desktop-composition-launch.mjs:542-545`), so it is a reachable endpoint
 *    that cannot serve a role. With any other endpoint bound the driver cannot tell the two
 *    apart, so it takes the conservative direction and calls the refusal a product fault.
 * 3. `game_prerequisites_missing` is the Host's own word for "this machine is not staged", which is
 *    likewise not a measurement of the product's launch path.
 * 4. A refusal before the launch request - registration or activation - is an earlier prerequisite
 *    of the same chain, named by its own step.
 * 5. Everything else is the product refusing a launch it was asked to perform: a failure, with the
 *    product's own code carried in the name.
 */

/** A driver that measured nothing says so, because a driver that stayed silent and one that measured must not look alike. */
export const NOT_MEASURED_PREFIX = "NOT-MEASURED:";

/**
 * The prefix of the one line the game-launch driver contributes to the report's observation
 * sections (`phases/report.mjs`), so the run's report names the headline path beside the others.
 */
export const GAME_LAUNCH_PREFIX = "GAME-LAUNCH";

/** `NOT-MEASURED: <reason>: <detail>` - the reason is a stable code, the detail is what was read. */
export function notMeasuredLine(reason, detail) {
  return `${NOT_MEASURED_PREFIX} ${reason}: ${detail}`;
}

/** `{ reason, detail }` when the driver declared itself unmeasured; `null` when it measured. */
export function readNotMeasured(text) {
  if (typeof text !== "string") return null;
  for (const line of text.split("\n")) {
    if (!line.startsWith(NOT_MEASURED_PREFIX)) continue;
    const rest = line.slice(NOT_MEASURED_PREFIX.length).trim();
    const colon = rest.indexOf(":");
    if (colon < 0) return { reason: rest, detail: "" };
    return { reason: rest.slice(0, colon).trim(), detail: rest.slice(colon + 1).trim() };
  }
  return null;
}

/**
 * Every coordinator cause that names the Guardian session rather than the game. `stardew_*` only:
 * the Host projects the bounded cause (`host/src/composed-reference-game-browser.ts:361-369`), so a
 * raw transport message never reaches this test.
 */
const GUARDIAN_CAUSE_PATTERN =
  /^(stardew_(bootstrap_)?guardian_[a-z0-9_]+|stardew_(player_host|ai_client)_launch_runtime_unavailable)$/u;

/** The step whose refusal this is. Named so a refusal says which link of the chain said no. */
export const LAUNCH_STEPS = Object.freeze({
  installation: "installation",
  activation: "activation",
  launch: "launch",
});

/** The verdict vocabulary. `not_measured` is never a pass and never a failure. */
export const VERDICTS = Object.freeze({
  measured: "measured",
  notMeasured: "not_measured",
  failed: "failed",
});

const notMeasured = (reason, detail) => Object.freeze({ verdict: VERDICTS.notMeasured, reason, detail });
const failed = (code, detail) => Object.freeze({ verdict: VERDICTS.failed, reason: code, detail });

/**
 * Whether a bound Guardian endpoint could serve a role on this machine.
 *
 * `onlyRunOwnGatePeer` is the driver's own reading of its run: the launch driver recorded in
 * `<stage>/state/launch-driver.pid` is alive and exactly one endpoint is bound, so the endpoint is
 * that gate's hello-only peer. It is stated as the basis rather than assumed, and any second
 * endpoint makes it false so a real supervisor is never mistaken for the gate.
 */
export function guardianCanArm({ endpoints, onlyRunOwnGatePeer }) {
  if (!Array.isArray(endpoints)) return false;
  if (endpoints.length === 0) return false;
  return onlyRunOwnGatePeer !== true;
}

/**
 * Classify a refusal of one link in the product's own Game-surface chain.
 *
 * `step` is one of `LAUNCH_STEPS`; `code` and `cause` are the product's own problem code and its
 * bounded cause (`{ code }` / `{ code, cause }` from `host/src/composed-reference-game-browser.ts:322`),
 * and `guardian` is `{ endpoints, onlyRunOwnGatePeer }` read from the OS pipe namespace.
 */
export function classifyLaunchRefusal({
  step,
  code,
  cause = null,
  guardian = { endpoints: [], onlyRunOwnGatePeer: false },
}) {
  const causeText = typeof cause === "string" ? cause : "";
  const codeText = typeof code === "string" && code.length > 0 ? code : "no_code";
  const named = causeText.length > 0 ? `${codeText}/${causeText}` : codeText;
  if (GUARDIAN_CAUSE_PATTERN.test(causeText) || GUARDIAN_CAUSE_PATTERN.test(codeText))
    return notMeasured(
      "guardian_pipe_unreachable",
      `the ${step} request was refused with ${named}; the guardian session that arm/launch ride on has no server on this machine (${describeGuardian(guardian)})`,
    );
  if (step === LAUNCH_STEPS.launch && codeText === "game_unavailable" && !guardianCanArm(guardian))
    return notMeasured(
      "guardian_pipe_unreachable",
      `the launch request was refused with ${named} while no endpoint that can arm is bound (${describeGuardian(guardian)})`,
    );
  if (codeText === "game_prerequisites_missing")
    return notMeasured(
      "game_prerequisites_missing",
      `the launch request was refused with ${named}: the Host holds no staged installation`,
    );
  if (step === LAUNCH_STEPS.installation)
    return notMeasured(
      "installation_registration_refused",
      `the Host refused the installation registration with ${named}`,
    );
  if (step === LAUNCH_STEPS.activation)
    return notMeasured("lifecycle_activation_refused", `the Host refused the lifecycle activation with ${named}`);
  return failed(`game_launch_unavailable:${named}`, `the product refused a launch it was asked to perform: ${named}`);
}

/**
 * The launch request that got NO answer: no problem body, and the page's own route then refused the
 * connection because the Host was gone.
 *
 * This is the same missing prerequisite reached through the transport instead of through a bounded refusal.
 * The Host treats the loss of its guardian session as controller EOF and leaves deliberately - "the one
 * bounded thing this process can still do about it is leave" (`host/src/bootstrap/wire/
 * desktop-runtime-bootstrap.internal.ts:188-196`) - and the gate launcher destroys that socket on the first
 * frame after `hello` (`tools/desktop-composition-launch.mjs:542-545`). With an endpoint that CAN arm
 * bound, the same silence is the Host's own failure and is named as one.
 */
export function classifySilentLaunch({ guardian, detail }) {
  const observed = typeof detail === "string" ? detail : "the launch request produced no answer";
  if (!guardianCanArm(guardian))
    return notMeasured(
      "guardian_pipe_unreachable",
      `${observed}; no endpoint that can arm is bound (${describeGuardian(guardian)})`,
    );
  return failed("game_never_reached_ready:host_silent_on_launch", `${observed}; ${describeGuardian(guardian)}`);
}

/** What the pipe namespace held, in one clause, so a reading is never printed without its population. */
export function describeGuardian(guardian) {
  const examined = typeof guardian?.examined === "number" ? guardian.examined : 0;
  const endpoints = Array.isArray(guardian?.endpoints) ? guardian.endpoints : [];
  const bound = endpoints.length === 0 ? "none bound" : `bound: ${endpoints.join(", ")}`;
  const owning = guardian?.onlyRunOwnGatePeer === true ? "; the only one is this run's own hello-only gate peer" : "";
  return `${String(examined)} named pipe(s) examined, ${bound}${owning}`;
}

/**
 * What a game browser state says about readiness: `ready` is one exact pair, `failed` is a pair that
 * cannot become ready without another attempt, `pending` is everything else.
 *
 * `instance.status: "stopped"` is in `failed` rather than `pending`: a stopped instance with no
 * attachment is the shape a launch that died on the way up leaves behind, and waiting the whole
 * budget for it would turn a named failure into a timeout.
 */
export function readinessOf({ instanceStatus, attachmentStatus }) {
  if (instanceStatus === "running" && attachmentStatus === "attached") return "ready";
  if (instanceStatus === "crashed" || instanceStatus === "stopped" || attachmentStatus === "failed") return "failed";
  return "pending";
}

/** The two states the surface published, in the order a reader needs them. */
export function describeGameState({ instanceStatus, attachmentStatus }) {
  return `instance=${instanceStatus ?? "unobserved"}/attachment=${attachmentStatus ?? "unobserved"}`;
}
