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
 * any launch this product performs today, for reasons that are each a missing state rather than a
 * slow one (`PRODUCT_GAPS`). A driver that reported `failed` on that target would fail on every run of
 * every machine, and an instrument that fails on an impossible target teaches its readers to ignore it.
 * `failed` therefore keeps its meaning - the product refused something it was asked to do - and the
 * unreachable step gets this third verdict instead, printed only when the run PROVED the gap it names.
 */
export const BLOCKED_BY_PRODUCT_PREFIX = "BLOCKED-BY-PRODUCT:";

/**
 * The three gaps, by the name the verdict carries. Each is one named missing state, not a symptom:
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
 *   `cabin_offer_expires_before_any_ui_can_answer` - the cabin choice is offered with a deadline no page
 *     can answer inside: the Mod republishes the advertisement every second with a 3 s expiry
 *     (`integrations/stardew/HostFarmhandProvisioner.cs:152-156,318-358`), and the Host hands the browser
 *     `Math.min(choice.expiresAtMs, joinDeadlineMs(sessionExpiry))` on every read while holding the handle
 *     to that same deadline (`host/src/stardew-production-lifecycle-coordinator.internal.ts:2065,2099`), so
 *     the page gets a window that has to cover a render, a player's look and click, and the round trip. A
 *     run proves this gap only by making the press the panel would make and reading BOTH sides: the
 *     confirmation went out, the game refused it `stardew_cabin_choice_stale`, and every cabin read in that
 *     run carried a window no longer than `CABIN_OFFER_USABLE_WINDOW_MS`.
 *
 *   `farmhand_not_initialized` - the confirmation reaches the Mod, the Mod creates a farmhand for the cabin
 *     through the engine's own `Cabin.CreateFarmhand()` (`HostFarmhandProvisioner.cs:539`), finds the created
 *     farmhand unusable, rolls it back and answers `rejected`/`farmhand_not_initialized`
 *     (`integrations/stardew/HostFarmhandProvisioner.cs:572-580`, and the same reason code at :585-593 for the
 *     id/name guard). No farmhand is left to bind, no binding is written, no manifest is published, and the
 *     Host can only report its handoff `409 stardew_manifest_handoff_uncertain`. Measured 2026-11-15
 *     (`.live-runs/runconfirm`): the press at 1794705319241, the Mod's rejected stamp at 1794705319293 (52 ms
 *     later), the Host's 409 110 ms after that - and the game's own log names which guard fired:
 *     "GameBuddy refused a first binding: id=-339058954489388311, customized=True, name='琥珀',
 *     displayName='琥珀', expected='琥珀'". Three terms of that guard are satisfied by the
 *     values it prints; the only one left standing is `UniqueMultiplayerID <= 0`, on an id the engine's own
 *     creation path produced. That is the game owner's question, not this instrument's, and this gap only
 *     records where the chain really stops.
 */
export const PRODUCT_GAPS = Object.freeze({
  instanceStatusNeverRunning: "instance_status_never_running",
  cabinOfferExpiresBeforeAnyUiCanAnswer: "cabin_offer_expires_before_any_ui_can_answer",
  farmhandNotInitialized: "farmhand_not_initialized",
});

/** The Mod's own reason code for "the farmhand this cabin needed was never usable". */
const FARMHAND_NOT_INITIALIZED_CODE = "farmhand_not_initialized";

/** The Host's own answer when the manifest the attachment needs was never settled. */
const MANIFEST_HANDOFF_UNCERTAIN_CODE = "stardew_manifest_handoff_uncertain";

/**
 * The longest offer window that still leaves no room for a page to answer.
 *
 * A budget, named as one rather than measured from what a player takes: the advertisement is 3 s
 * (`HostFarmhandProvisioner.cs:358`), so a read that hands back five seconds or less is handing back the
 * Mod's own beat and not a window - a render, a look, a click and a round trip inside one beat. A run whose
 * reads hand back minutes is not this gap, however a single press turned out, and `staleOfferReading` says no.
 */
export const CABIN_OFFER_USABLE_WINDOW_MS = 5_000;

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

/** The verdict the game-launch driver gives a game that reads a different language than the run's. */
export const GAME_LOCALE_MISMATCH_CODE = "game_locale_mismatch";

/**
 * The live locale SMAPI echoed on the launched game's own line (`Context: loaded save '<slot>',
 * starting <date>, locale set to <x>`, or the bare `Context: locale set to <x>`), canonised to the
 * product's BCP-47 grammar.
 *
 * SMAPI prints the engine's own localized-asset suffix: EMPTY for English - the game's only empty
 * suffix, which `integrations/stardew/NativeChatPresentationPolicy.cs` states in the Mod - and
 * `zh (zh-CN)` / `zh-CN` for a translated locale. `null` when the line carries no locale at all, so
 * "nobody read it" and "it was English" never look alike.
 */
export function liveGameLocaleOf(line) {
  if (typeof line !== "string") return null;
  const match = /locale set to ([^.\n]*)/u.exec(line);
  if (match === null) return null;
  const raw = match[1].trim();
  if (raw.length === 0) return "en-US";
  const parenthesised = /\(([^)]+)\)\s*$/u.exec(raw);
  const value = (parenthesised === null ? raw : parenthesised[1]).trim();
  return value.length === 0 ? "en-US" : value;
}

/**
 * `{ code, expected, saw, line }` when the launched game reads another language than the run's own;
 * `null` when the two agree, when the run seeded no expectation, or when nothing was measured.
 *
 * The game applies `startup_preferences.languageCode` asynchronously from the title-menu update, and a
 * native world entry driven before that locks the session into the default locale for its whole life -
 * so the product would be measured in a language it was never configured for. That is a defect, not a
 * detail. Measured 2026-11-16 (`.live-runs/gamewait2` and every launch that day): the game logged
 * `locale set to .` - English - while the run's own preference was zh-CN.
 */
export function gameLocaleMismatch({ expected, saveLoadedLine }) {
  if (typeof expected !== "string" || expected.length === 0) return null;
  const saw = liveGameLocaleOf(saveLoadedLine);
  if (saw === null || saw === expected) return null;
  return {
    code: `${GAME_LOCALE_MISMATCH_CODE}:expected ${expected}, saw '${saw}'`,
    expected,
    saw,
    line: saveLoadedLine,
  };
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
 * The lifecycle shapes the product's own instance facts distinguish, in the words of its derivation
 * (`dialogue-web/src/game-lifecycle-controls.ts:89-99,388-408`):
 *
 *   `unactivated`   `instance.status: "none"` with no generation: activation is the product's next step,
 *                   and the activate control exists for exactly this shape.
 *   `activated`     nothing running and the expected generation >= 1: activation is behind this state,
 *                   and the launch control exists for exactly this shape.
 *   `instantiated`  any other instance word (`launching`, `running`, `stopped`, `crashed`, `detected`):
 *                   a game instance exists, so neither the activate nor the launch control is offered.
 *   `unread`        `instance.status: "unread"`, or a state read that carried no instance word: the Host
 *                   holds no reading of the game, so the product's own step is the reread, not a staging
 *                   control.
 *
 * TWO DRIVERS ASK THIS QUESTION and both used to answer it by hand as `instanceStatus === "none"` -
 * "activated" - which reads an instance that EXISTS as one that was never activated. The product forbids
 * an activation control in `launching`/`running`/`stopped`/`crashed`, so that reading sends the driver
 * hunting a control the state rules out and then names the whole lifecycle as unactivated
 * (`game_lifecycle_not_activated` at `instance=launching/attachment=none`, measured 2026-11-15). One
 * derivation, so the two drivers cannot answer the same state differently.
 */
export const LIFECYCLE_SHAPES = Object.freeze({
  unactivated: "unactivated",
  activated: "activated",
  instantiated: "instantiated",
  unread: "unread",
});

/** Which of `LIFECYCLE_SHAPES` these published facts put the lifecycle in. */
export function lifecycleShapeOf({ instanceStatus, instanceGeneration } = {}) {
  if (instanceStatus === null || instanceStatus === undefined || instanceStatus === "unread")
    return LIFECYCLE_SHAPES.unread;
  if (instanceStatus !== "none") return LIFECYCLE_SHAPES.instantiated;
  return Number.isInteger(instanceGeneration) && instanceGeneration >= 1
    ? LIFECYCLE_SHAPES.activated
    : LIFECYCLE_SHAPES.unactivated;
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
 * What the product publishes when the companion's game actions are stopped, in the words of its own
 * derivation: the panel's phase is `attached_stopped` exactly when the attachment is still held with a
 * live generation AND `connectionStatus === "stopped"` (`dialogue-web/src/game-lifecycle-controls.ts:390-400`).
 *
 * EVERY FIELD HERE HAS A PUBLISHER, AND NO ONE OF THEM IS THIS HARNESS'S OWN WORD:
 *
 *   - `connectionStatus` crosses the browser boundary as `game.connectionStatus`
 *     (`host/src/game-browser-contract/index.ts:367`), projected from the coordinator's attachment reader
 *     (`host/src/game-browser/game-browser-state-provider.ts:198`), which writes `"stopping"` when it
 *     seals the epoch and `"stopped"` once the Host's STOP has settled
 *     (`host/src/stardew-production-lifecycle-coordinator.internal.ts:2623,2641`).
 *   - `attachment.status`/`generation` are the same reader's other two facts: a stop leaves the
 *     attachment held, which is what tells a stopped companion apart from one that was never there.
 *
 * THE INSTANCE WORD IS NOT PART OF THIS SHAPE AND MUST NEVER BE WAITED ON. An ordinary stop is
 * `player_stop_all`: it settles the AI authority and the world keeps running (project rules #3023/#506), so
 * `instance=running` is the expected reading both before and after the press. `instance=stopped|none` is the
 * OTHER ending - the player quitting the game, which the surface offers only "restart GameBuddy" for - and
 * a wait for that shape reports every stop that works as a timeout.
 */
export function attachmentActionsStopped({ attachmentStatus, attachmentGeneration, connectionStatus } = {}) {
  return (
    attachmentStatus === "attached" &&
    Number.isInteger(attachmentGeneration) &&
    attachmentGeneration > 0 &&
    connectionStatus === "stopped"
  );
}

/**
 * A stop in one line: what settled it, the wire's own receipt for the same fact, and the world that is
 * still running afterwards because that is what the product promises.
 *
 * `answer` is the `game/stop` response this run saw (`{status, atMs}`), or `null` while the Host has not
 * answered - the route returns the STOP's settled promise
 * (`host/src/stardew-production-lifecycle-coordinator.internal.ts:2598-2662`), so an answer IS the Host
 * saying it finished.
 */
export function describeStopReading({ settled, state, answer, elapsedMs } = {}) {
  const receipt =
    answer === null || answer === undefined
      ? "answer=none (the Host has answered no game/stop)"
      : `answer=HTTP ${String(answer.status)} at ${new Date(answer.atMs).toISOString()}`;
  const facts = [
    `attachment=${String(state?.attachmentStatus ?? "unobserved")}/${String(state?.attachmentGeneration ?? "unobserved")}`,
    `connection=${String(state?.connectionStatus ?? "unobserved")}`,
    `instance=${String(state?.instanceStatus ?? "unobserved")}`,
  ].join(" ");
  return `stop ${settled === true ? "settled" : "did not settle"} in ${String(Math.round(Number(elapsedMs ?? 0) / 100) / 10)}s: ${receipt}; ${facts} - the instance word is read, never waited on: an ordinary stop leaves the world running`;
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
 *
 * `cabin confirm accepted` is a rung of its own because the confirmation's ACCEPTANCE and its ANSWER
 * are different facts: the answer can be a refusal (a lapsed choice, an uncertain handoff) while the
 * game took the choice, and a reader who only saw "cabin confirm" could not tell the two apart. The
 * proof is the Mod's own stamp for that confirmation, so the rung carries the press-to-stamp latency.
 *
 * `cabin ready` is one rung with two proofs, because the world gives the companion a Cabin in two ways and
 * both are the fact the next rung needs: the Mod BUILT one on a free cabin pad (`BuiltCabin`, a world that
 * had cabins and no empty one), or the world's own starting Cabin was already there and the Mod released the
 * unclaimed native slot inside it (`UnlockedUnclaimedCabin`, which is what a freshly created world answers).
 * Calling the rung "cabin built" reported the second case as a missing rung - measured 2026-11-21, when the
 * fixture started creating its own world per run.
 */
export const CHAIN_STEPS = Object.freeze({
  launchAdmitted: "launch admitted",
  guardianArmed: "guardian armed",
  processStarted: "process started",
  saveLoaded: "save loaded",
  cabinReady: "cabin ready",
  cabinReadAuto: "cabin read(auto)",
  cabinReadPressed: "cabin read(pressed)",
  cabinConfirm: "cabin confirm",
  cabinConfirmAccepted: "cabin confirm accepted",
  attach: "attach",
});

export const CHAIN_RUNGS = Object.freeze([
  Object.freeze([CHAIN_STEPS.launchAdmitted]),
  Object.freeze([CHAIN_STEPS.guardianArmed]),
  Object.freeze([CHAIN_STEPS.processStarted]),
  Object.freeze([CHAIN_STEPS.saveLoaded]),
  Object.freeze([CHAIN_STEPS.cabinReady]),
  Object.freeze([CHAIN_STEPS.cabinReadAuto, CHAIN_STEPS.cabinReadPressed]),
  Object.freeze([CHAIN_STEPS.cabinConfirm]),
  Object.freeze([CHAIN_STEPS.cabinConfirmAccepted]),
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
 * was asked. A confirmation the Mod answered with
 * `rejected`/`farmhand_not_initialized` proves the farmhand gap: the Mod took the choice, could not use
 * what the engine's creation path produced, and rolled it back.
 *
 * A state that stopped moving proves the same instance-word gap from the other side, and that side is the
 * one a driver meets when it arrives after another driver's launch: `unchangedForMs` is how long the
 * tuple stayed put while a launch was in flight (`readinessOf` still `pending`), held to the drivers' own
 * plateau threshold (`plateauMs`, `LAUNCH_PLATEAU_MS` unless the caller declares another). No attachment
 * ever landed, so the attachment branches above say nothing, and the run's proof is the plateau itself -
 * a launch the Host admitted, an instance that exists, and nothing moving.
 *
 * Anything else is `null`: no proof, no verdict, and the caller keeps reporting `failed`.
 */
export function classifyChainStop({
  state,
  attachmentResponse = null,
  confirmPressedAtMs = null,
  cabinConfirm = null,
  unchangedForMs = null,
  plateauMs = LAUNCH_PLATEAU_MS,
}) {
  const readable = state?.ok === true;
  if (readable && state.attachmentStatus === "attached" && state.instanceStatus !== "running")
    return Object.freeze({
      verdict: VERDICTS.blockedByProduct,
      gap: PRODUCT_GAPS.instanceStatusNeverRunning,
      detail: `the attachment landed (${describeGameState(state)}) and the instance word never left ${String(state.instanceStatus)}: the coordinator projects a GameBuddy-launched Player Host as launching for its whole life (stardew-role-lifecycle-projection.internal.ts:41-45), and the only authenticated slot the facade mints is ownership=player_external (stardew-role-lifecycle-facade.ts:29-41), which this host is not`,
    });
  if (readable && state.attachmentStatus === "attached") return null;
  if (
    readable &&
    state.instanceStatus === "launching" &&
    readinessOf(state) === "pending" &&
    Number.isFinite(unchangedForMs) &&
    unchangedForMs >= plateauMs
  )
    return Object.freeze({
      verdict: VERDICTS.blockedByProduct,
      gap: PRODUCT_GAPS.instanceStatusNeverRunning,
      detail: `an instance exists and stayed ${describeGameState(state)} for ${String(Math.round(unchangedForMs / 1000))}s: the launch was admitted and the instance word never left launching, so the game cannot be reached by any driver that waits for running (the coordinator projects a GameBuddy-launched Player Host as launching for its whole life, stardew-role-lifecycle-projection.internal.ts:41-45, and the only authenticated slot the facade mints is ownership=player_external, stardew-role-lifecycle-facade.ts:29-41, which this host is not)`,
    });
  const rolledBack = farmhandNotInitializedReading(cabinConfirm, attachmentResponse, confirmPressedAtMs);
  if (rolledBack !== null)
    return Object.freeze({
      verdict: VERDICTS.blockedByProduct,
      gap: PRODUCT_GAPS.farmhandNotInitialized,
      detail: rolledBack,
    });
  const stale = staleOfferReading(cabinConfirm);
  if (stale !== null)
    return Object.freeze({
      verdict: VERDICTS.blockedByProduct,
      gap: PRODUCT_GAPS.cabinOfferExpiresBeforeAnyUiCanAnswer,
      detail: stale,
    });
  return null;
}

/**
 * The game's own words for a cabin offer that could not be answered in time, or `null` when this run
 * proved nothing of the kind.
 *
 * Three facts, all of them this run's own: a confirmation was SENT (a press the page answered itself is
 * not a press against a window), the game REFUSED it by the name it gives a lapsed choice, and every offer
 * the run read handed the page a window no longer than `CABIN_OFFER_USABLE_WINDOW_MS`. The two windows are
 * quoted side by side because the difference between "the same deadline every time" and "a fresh short one
 * each time" is what a game owner has to act on, and no single reading can tell them apart.
 */
function staleOfferReading(cabinConfirm) {
  if (cabinConfirm === null || typeof cabinConfirm !== "object") return null;
  const requested = Number(cabinConfirm.requested);
  if (!Number.isFinite(requested) || requested <= 0) return null;
  const refusals = (Array.isArray(cabinConfirm.refusals) ? cabinConfirm.refusals : []).filter(
    (entry) => entry?.code === "stardew_cabin_choice_stale",
  );
  if (refusals.length === 0) return null;
  const offers = (Array.isArray(cabinConfirm.offers) ? cabinConfirm.offers : []).filter(
    (entry) => Number.isFinite(entry?.expiresAtMs) && Number.isFinite(entry?.readAtMs),
  );
  if (offers.length < 2) return null;
  if (offers.some((entry) => entry.expiresAtMs - entry.readAtMs > CABIN_OFFER_USABLE_WINDOW_MS)) return null;
  const quoted = offers
    .slice(-2)
    .map(
      (entry) =>
        `expiresAtMs=${String(entry.expiresAtMs)} read at ${new Date(entry.readAtMs).toISOString()} (${String(entry.expiresAtMs - entry.readAtMs)}ms left)`,
    );
  const refused = refusals.at(-1);
  return `the confirmation was sent ${String(requested)} time(s) and the game refused it HTTP ${String(refused.status)} ${String(refused.code)}; two consecutive cabin reads: ${quoted.join(" then ")}. The Mod republishes the advertisement every second with a 3 s expiry (integrations/stardew/HostFarmhandProvisioner.cs:152-156,318-358) and the Host hands the page min(that expiry, the join deadline) on every read while holding the choice handle to the same deadline (host/src/stardew-production-lifecycle-coordinator.internal.ts:2065,2099), so the window a page must render, be clicked in, and answer inside is the Mod's own beat`;
}

/**
 * The Mod's own stamp when it wrote that response for THIS run's confirmation, or `null` when it did not.
 *
 * A response this run did not cause proves nothing about this run: a file with no press behind it, or one
 * stamped further from the press than a round trip takes, is a write from an earlier launch that survived in
 * the run root. The window is the same one the confirmation's own round trip is held to, and the driver uses
 * this function for its chain rung so "stamped for this press" has one spelling.
 */
export function responseStampForPress(response, confirmPressedAtMs) {
  const stamp = Number(response?.updatedAtUnixMs);
  const pressed = Number(confirmPressedAtMs);
  if (!Number.isFinite(stamp) || !Number.isFinite(pressed) || !(pressed > 0)) return null;
  return stamp + 5_000 >= pressed ? stamp : null;
}

/**
 * The Mod's own word for a confirmation it took and rolled back, or `null` when this run proved nothing of the
 * kind.
 *
 * Three facts, all of them this run's own: a confirmation was SENT (a press the page answered itself never
 * reaches the game, so it can prove nothing about the game's answer), the Mod answered THAT press with
 * `state=rejected` and the reason code it gives a farmhand it could not use, and the Host answered the same
 * confirmation with `409` and its own code for a handoff it could not settle. Both halves are required and
 * neither is sufficient: the Mod's file is a write an earlier bootstrap directory could hold, and the Host's
 * `409` names an uncertainty rather than its cause. Whatever one of the two the run holds alone, the
 * classification stays silent and the caller keeps `failed`.
 */
function farmhandNotInitializedReading(cabinConfirm, attachmentResponse, confirmPressedAtMs) {
  const requested = Number(cabinConfirm?.requested);
  if (!Number.isFinite(requested) || requested <= 0) return null;
  if (attachmentResponse === null || typeof attachmentResponse !== "object") return null;
  if (attachmentResponse.state !== "rejected" || attachmentResponse.reasonCode !== FARMHAND_NOT_INITIALIZED_CODE)
    return null;
  const stamp = responseStampForPress(attachmentResponse, confirmPressedAtMs);
  if (stamp === null) return null;
  const refusals = (Array.isArray(cabinConfirm.refusals) ? cabinConfirm.refusals : []).filter(
    (entry) => entry?.code === MANIFEST_HANDOFF_UNCERTAIN_CODE && Number(entry?.status) === 409,
  );
  if (refusals.length === 0) return null;
  const latencyMs = stamp - Number(confirmPressedAtMs);
  return `the confirmation was sent ${String(requested)} time(s) and the Mod answered it state=rejected/reason=${FARMHAND_NOT_INITIALIZED_CODE}, stamped ${new Date(stamp).toISOString()} (${String(latencyMs)}ms after the press, ${String(attachmentResponse.file)}/session/stardew-attachment-response.json), while the Host answered the same confirmation HTTP 409 ${MANIFEST_HANDOFF_UNCERTAIN_CODE}: the Mod creates the cabin's farmhand through the engine's own Cabin.CreateFarmhand(), finds the created farmhand unusable, rolls it back (integrations/stardew/HostFarmhandProvisioner.cs:572-580,585-593) and never writes the binding, so no manifest is published and the Host has nothing to admit`;
}
