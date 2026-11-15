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
 * 1. A refusal whose bounded cause names the Guardian family is `guardian_pipe_unreachable`. In
 *    production the only server of that session is the native Desktop supervisor
 *    (`desktop/GameBuddy.Desktop/DesktopHostBootstrapBroker.cs:47`); a harness run's server is the
 *    gate launcher's own peer, which arms a role only when the generation publishes a resident
 *    Guardian (`tools/lib/guardian-role-broker.mjs`).
 * 2. A launch refused with the generic `game_unavailable` while NO endpoint can arm is the same
 *    prerequisite, named the same way. "No endpoint can arm" is either "none bound", "the only one
 *    bound is this run's own gate peer and that peer serves `hello` only", or "the caller did not say
 *    which". With any other endpoint bound the driver cannot tell them apart, so it takes the
 *    conservative direction and calls the refusal a product fault.
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
 * A driver whose chain stopped at a gap the PRODUCT cannot cross says so, in its own word.
 *
 * The launch chain's own target - `instance=running` with `attachment=attached` - cannot be reached by
 * any launch this product performs today, for two reasons that are each a missing state rather than a
 * slow one (`PRODUCT_GAPS`). A driver that reported `failed` on that target would fail on every run of
 * every machine, and an instrument that fails on an impossible target teaches its readers to ignore it.
 * `failed` therefore keeps its meaning - the product refused something it was asked to do - and the
 * unreachable step gets this third verdict instead, printed only when the run PROVED the gap it names.
 */
export const BLOCKED_BY_PRODUCT_PREFIX = "BLOCKED-BY-PRODUCT:";

/**
 * The two gaps, by the name the verdict carries. Each is one named missing state, not a symptom:
 *
 *   `instance_status_never_running` - a GameBuddy-launched Player Host is projected as
 *     `launching` for its whole life: the coordinator overrides the slot in
 *     `launching_player_host` and `awaiting_player_host_attestation`
 *     (`stardew-role-lifecycle-projection.internal.ts:41-45`) and has no later state to move to,
 *     while the only `authenticated` slot the facade can mint is `ownership: "player_external"`
 *     (`stardew-role-lifecycle-facade.ts:29-41,89-111`). `running` is the projection of
 *     `authenticated` (`game-browser/game-browser-state-provider.ts:164-180`), so no launch this
 *     product performs can publish it.
 *
 *   `attach_needs_native_save` - the first attachment binds a farmhand that must be written into
 *     the save: the Mod answers `awaiting_save`/`binding_persist_pending`
 *     (`integrations/stardew/HostFarmhandProvisioner.cs:612-637`), stages the binding on the
 *     engine's own `Saving` event (:180-186) and issues the manifest on `Saved` (:217-222). The only
 *     thing that drives that cycle is `HostAutomation.Enable` (:1394-1420 in `ModEntry.cs`, the
 *     `SaveGameMenu` trigger), which is a fixture switch the Host never writes into the Mod's config.
 */
export const PRODUCT_GAPS = Object.freeze({
  instanceStatusNeverRunning: "instance_status_never_running",
  attachNeedsNativeSave: "attach_needs_native_save",
});

/**
 * The prefix of the one line the game-launch driver contributes to the report's observation
 * sections (`phases/report.mjs`), so the run's report names the headline path beside the others.
 */
export const GAME_LAUNCH_PREFIX = "GAME-LAUNCH";

/** `NOT-MEASURED: <reason>: <detail>` - the reason is a stable code, the detail is what was read. */
export function notMeasuredLine(reason, detail) {
  return `${NOT_MEASURED_PREFIX} ${reason}: ${detail}`;
}

/** `BLOCKED-BY-PRODUCT: <gap>: <the readings that proved it>` - same shape, third verdict. */
export function blockedByProductLine(gap, detail) {
  return `${BLOCKED_BY_PRODUCT_PREFIX} ${gap}: ${detail}`;
}

/** `{ gap, detail }` when the driver reported a product gap; `null` when it reported none. */
export function readBlockedByProduct(text) {
  if (typeof text !== "string") return null;
  for (const line of text.split("\n")) {
    if (!line.startsWith(BLOCKED_BY_PRODUCT_PREFIX)) continue;
    const rest = line.slice(BLOCKED_BY_PRODUCT_PREFIX.length).trim();
    const colon = rest.indexOf(":");
    if (colon < 0) return { gap: rest, detail: "" };
    return { gap: rest.slice(0, colon).trim(), detail: rest.slice(colon + 1).trim() };
  }
  return null;
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

/**
 * The verdict vocabulary. `not_measured` is never a pass and never a failure, and
 * `blocked_by_product` is neither: it is the product's own missing step, proved by this run.
 */
export const VERDICTS = Object.freeze({
  measured: "measured",
  notMeasured: "not_measured",
  blockedByProduct: "blocked_by_product",
  failed: "failed",
});

const notMeasured = (reason, detail) => Object.freeze({ verdict: VERDICTS.notMeasured, reason, detail });
const failed = (code, detail) => Object.freeze({ verdict: VERDICTS.failed, reason: code, detail });

/**
 * Whether a bound Guardian endpoint could serve a role on this machine.
 *
 * `onlyRunOwnGatePeer` is the driver's own reading of its run: the launch driver recorded in
 * `<stage>/state/launch-driver.pid` is alive and exactly one endpoint is bound, so the endpoint is
 * that gate's own peer. Whether such a peer can ARM a role is a separate fact, and it is read from
 * the peer itself (`runGatePeerMode`, the broker's own `mode`): `armable` when the generation
 * published a resident Guardian and the launcher runs it, `hello_only` when it did not. A peer that
 * is armable is a real server, so a launch it could not serve is the product's to answer for; a
 * hello-only peer is the missing prerequisite this classification exists to name. A caller that does
 * not say which is treated as unable to arm, which is the conservative direction for an excuse.
 */
export function guardianCanArm({ endpoints, onlyRunOwnGatePeer, runGatePeerMode = null }) {
  if (!Array.isArray(endpoints)) return false;
  if (endpoints.length === 0) return false;
  if (onlyRunOwnGatePeer === true) return runGatePeerMode === "armable";
  return true;
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
 * desktop-runtime-bootstrap.internal.ts:188-196`). When the bound peer cannot arm a role that loss is
 * the missing prerequisite; when it can, the same silence is the Host's own failure and is named as one.
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
  const owning =
    guardian?.onlyRunOwnGatePeer === true
      ? `; the only one is this run's own gate peer (${describeGatePeerMode(guardian?.runGatePeerMode)})`
      : "";
  return `${String(examined)} named pipe(s) examined, ${bound}${owning}`;
}

/** The gate peer's own account of whether it can arm a role, in the words the report uses. */
function describeGatePeerMode(mode) {
  if (mode === "armable") return "armable: it runs the generation's resident Guardian";
  if (mode === "hello_only") return "hello-only: the generation publishes no resident Guardian";
  return "armability unread: the launch state records no role-broker mode";
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

/**
 * How long an unchanged launch state is read as "waiting for a step" rather than "still moving".
 *
 * Measured 2026-11-15 (`SMAPI-latest.txt`): the launch chain itself - Guardian role, SMAPI, Mod, loaded
 * world, built cabin - took 9 s from the launch request. After that the state stayed exactly
 * `instance=launching/attachment=none` for the remaining 4 min 51 s of a 300 s budget because the
 * product's third step (the cabin handoff, `stardew-production-lifecycle-coordinator.internal.ts:2082-2152`)
 * had not been sent, and no amount of waiting sends it. So a window that long with nothing moving is
 * the finding, not a reason to wait longer: the driver reports the plateau and drives the next step.
 */
export const LAUNCH_PLATEAU_MS = 120_000;

/** One line of the launch wait: what the state says, what the routes said, and the game's own last word. */
export function describeLaunchProgress({ elapsedMs, state, problems = [], game = null }) {
  const refusals = Array.isArray(problems)
    ? problems.map(([route, problem]) => `${String(route)}=${String(problem?.code ?? problem?.status ?? "unreadable")}`)
    : [];
  const seconds = Math.round(Number(elapsedMs) / 1000);
  return [
    `launch progress: elapsed=${String(seconds)}s`,
    state?.ok === true ? describeGameState(state) : `state_unreadable:${String(state?.status)}`,
    `problems=${refusals.length === 0 ? "none" : refusals.join(",")}`,
    `game=${describeGameLog(game)}`,
  ].join(" ");
}

/**
 * The plateau sentence: what the state was, how long it stayed that way, and the launched game's own
 * last line. Repeated every window, because a state that stops moving and one that moves slowly print
 * different lines and only the timeline separates them.
 */
export function describeLaunchPlateau({ elapsedMs, unchangedForMs, state, game = null }) {
  const unchanged = Math.round(Number(unchangedForMs) / 1000);
  const elapsed = Math.round(Number(elapsedMs) / 1000);
  return `PLATEAU: ${describeGameState(state)} unchanged for ${String(unchanged)}s (elapsed=${String(elapsed)}s); the launched game's own last line: ${describeGameLog(game)}`;
}

/** The launched game's last line as `{ line, writtenAtMs }`, or the fact that there was none to read. */
function describeGameLog(game) {
  if (game === null || game === undefined) return "no SMAPI log read";
  const line = typeof game.line === "string" && game.line.length > 0 ? game.line : "no line";
  const writtenAt =
    typeof game.writtenAtMs === "number" && Number.isFinite(game.writtenAtMs)
      ? new Date(game.writtenAtMs).toISOString()
      : "with no mtime";
  return `${JSON.stringify(line)} (SMAPI-latest.txt written ${writtenAt})`;
}

/* ------------------------------------------------------------------ the chain, rung by rung */

/**
 * The chain a launch walks, as the player and the next reader meet it.
 *
 * These are RUNGS, not the driver's own cells: an instrument that prints seventeen of its own phases
 * leaves "where did it stop" as an exercise for the reader. Two of the rungs are alternative
 * spellings of one step, because naming the wrong one would be a lie: `cabin read(auto)` is the
 * panel asking the Host by itself (the admitted launch's own bounded wait), and `cabin read(pressed)`
 * is the same read after this driver pressed the panel's refresh control - the second chance the
 * budget's end leaves a player, and a different fact about the fix under measurement.
 */
export const CHAIN_STEPS = Object.freeze({
  launchAdmitted: "launch admitted",
  guardianArmed: "guardian armed",
  processStarted: "process started",
  saveLoaded: "save loaded",
  cabinBuilt: "cabin built",
  cabinReadAuto: "cabin read(auto)",
  cabinReadPressed: "cabin read(pressed)",
  cabinConfirm: "cabin confirm",
  attach: "attach",
});

export const CHAIN_RUNGS = Object.freeze([
  Object.freeze([CHAIN_STEPS.launchAdmitted]),
  Object.freeze([CHAIN_STEPS.guardianArmed]),
  Object.freeze([CHAIN_STEPS.processStarted]),
  Object.freeze([CHAIN_STEPS.saveLoaded]),
  Object.freeze([CHAIN_STEPS.cabinBuilt]),
  Object.freeze([CHAIN_STEPS.cabinReadAuto, CHAIN_STEPS.cabinReadPressed]),
  Object.freeze([CHAIN_STEPS.cabinConfirm]),
  Object.freeze([CHAIN_STEPS.attach]),
]);

/** The rung names a driver may record, in one flat list, so a typo is a missing rung rather than a new one. */
export const CHAIN_STEP_NAMES = Object.freeze(CHAIN_RUNGS.flat());

/**
 * The chain as lines: one per rung, with the elapsed time and the fact that proved it, and every rung
 * the run never reached printed by name. That last part is the whole point - a reader must not have
 * to infer "and then it stopped" from the absence of a line.
 */
export function describeChain(chain) {
  const reached = Array.isArray(chain) ? chain : [];
  if (reached.length === 0) return ["CHAIN: no rung of the launch chain was reached"];
  const lines = [];
  CHAIN_RUNGS.forEach((names, index) => {
    const entry = reached.find((candidate) => names.includes(candidate.name)) ?? null;
    const position = `${String(index + 1)}/${String(CHAIN_RUNGS.length)}`;
    if (entry === null) {
      lines.push(`CHAIN ${position} ${names[0]} - not reached`);
      return;
    }
    const seconds = Math.round(Number(entry.atMs) / 1000);
    lines.push(`CHAIN ${position} ${entry.name} @${String(Number.isFinite(seconds) ? seconds : 0)}s - ${entry.proof}`);
  });
  return lines;
}

/** `steps=launch admitted>guardian armed>...` - the same chain as one field, for the report's one line. */
export function chainStepsLine(chain) {
  const names = Array.isArray(chain) ? chain.map((entry) => String(entry?.name ?? "")) : [];
  const present = names.filter((name) => name.length > 0);
  return present.length === 0 ? "none" : present.join(">");
}

/**
 * Which gap a chain that could not reach `running`+`attached` actually proved, if any.
 *
 * The ordering is the chain's own: the FURTHEST step reached decides, because the nearer gap is a
 * consequence of the same launch rather than its cause. An attachment that landed while the instance
 * word still read `launching` proves the projection gap and nothing else - the chain did everything it
 * was asked. A confirmation the Mod answered with `awaiting_save` proves the save gap: the Mod's own
 * published word for "this binding is waiting for the engine to save", written at the confirmation and
 * never replaced because no save cycle ever came to persist it.
 *
 * Anything else is `null`: no proof, no verdict, and the caller keeps reporting `failed`.
 */
export function classifyChainStop({ state, attachmentResponse = null, confirmPressedAtMs = null }) {
  const readable = state?.ok === true;
  if (readable && state.attachmentStatus === "attached" && state.instanceStatus !== "running")
    return Object.freeze({
      verdict: VERDICTS.blockedByProduct,
      gap: PRODUCT_GAPS.instanceStatusNeverRunning,
      detail: `the attachment landed (${describeGameState(state)}) and the instance word never left ${String(state.instanceStatus)}: the coordinator projects a GameBuddy-launched Player Host as launching for its whole life (stardew-role-lifecycle-projection.internal.ts:41-45), and the only authenticated slot the facade mints is ownership=player_external (stardew-role-lifecycle-facade.ts:29-41), which this host is not`,
    });
  if (readable && state.attachmentStatus === "attached") return null;
  const awaiting = awaitingSaveReading(attachmentResponse, confirmPressedAtMs);
  if (awaiting !== null)
    return Object.freeze({
      verdict: VERDICTS.blockedByProduct,
      gap: PRODUCT_GAPS.attachNeedsNativeSave,
      detail: awaiting,
    });
  return null;
}

/**
 * The Mod's own word for the confirmation, or `null` when it is absent or not from this run.
 *
 * Freshness is part of the proof: the response file lives in the run root and outlives the game, so a
 * reading taken from yesterday's run would prove nothing about today's. The Mod stamps
 * `updatedAtUnixMs` when it writes the file, and the confirmation press is this run's own clock.
 */
function awaitingSaveReading(response, confirmPressedAtMs) {
  if (response === null || typeof response !== "object") return null;
  if (response.state !== "awaiting_save") return null;
  const stamp = Number(response.updatedAtUnixMs);
  const pressed = Number(confirmPressedAtMs);
  // A response this run did not cause proves nothing about this run: no press, no freshness to check.
  const writtenForThisRun =
    Number.isFinite(stamp) && Number.isFinite(pressed) && pressed > 0 && stamp + 5_000 >= pressed;
  if (!writtenForThisRun) return null;
  const reason =
    typeof response.reasonCode === "string" && response.reasonCode.length > 0 ? response.reasonCode : "no_reason_code";
  return `the confirmation reached the Mod and the Mod answered state=awaiting_save/reason=${reason} (stardew-attachment-response.json, updated ${new Date(stamp).toISOString()}): the first binding is written by the engine's own Saving/Saved cycle (HostFarmhandProvisioner.cs:180-222), and the only trigger for one is HostAutomation.Enable (ModEntry.cs, TryTriggerNativeAutomationSave), which production never writes into the Mod's config`;
}
