/**
 * The conformance cases: what a Host peer is, what the launcher must do with it, and what the
 * launcher must refuse.
 *
 * EACH CASE IS A CONTRACT, NOT A SCENARIO RECORDING. It names the behaviour the launcher owes a
 * peer of that shape, reads it out of process facts only - the child's exit status, the one
 * bounded code on its standard error, frames on its named pipes, and the records it writes - and
 * carries a CONTROL whose expectation is the opposite, so a reading that cannot go red is visible
 * in the same run rather than trusted.
 *
 * A CASE THAT CANNOT OBSERVE ITS SUBJECT FAILS. Each case takes its own presence reading first -
 * a peer that started, a marker on disk in the shape the product reads, a channel that answers -
 * and a missing subject is a named failure (`desktop_conformance_unobservable`), never a pass over
 * an empty reading. Two cases start more than one launcher because their probes are each other's
 * control, and one number is what a reading costs: a control that shares its subject's launch
 * cannot show that the subject, and not the launch, decided the answer.
 *
 * A CASE WHOSE SUBJECT THE PRODUCT DOES NOT OFFER IS SKIPPED, AND NAMED. One case needs a quit a
 * process can ask for, and the product has none: it is skipped with the measurement that shows why
 * rather than failing on a stage the product never reaches.
 *
 * A DEFECT IS NAMED, NOT FIXED. Where the launcher does not meet a contract today the case fails
 * and names the defect; nothing here patches the product.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  acknowledgmentFrame,
  BEHAVIOURS,
  FACTS,
  FRAME_CAP_BYTES,
  GUARDIAN_ATTEMPT_RECORD,
  GUARDIAN_PIPE_PREFIX,
  GUARDIAN_SESSION_SCHEMA,
  PRESENTATION_PIPE_PREFIX,
  PRIMARY_INTENTS,
  refusedPresentationFrame,
  helloFrame,
} from "./wire.mjs";
import {
  bootstrapIdIn,
  deliverEveryPrimaryIntent,
  factsNamed,
  guardianPipeName,
  isRunning,
  killExactProcess,
  launchDesktop,
  pipeReachable,
  processIdentity,
  readAttemptRecord,
  startStandinProcess,
  teardownRecords,
  transcriptFacts,
  writeAttemptRecord,
} from "./world.mjs";

/** The one bound every launcher start is read under: past it a launch is a hang, and a hang is a failure. */
const LAUNCH_BOUND_MS = 20_000;

/** The name no launcher may hand a child: this suite's own canary, set in the launcher's block. */
const CANARY_NAME = "GAMEBUDDY_CONFORMANCE_CANARY";
/** A name the launcher DOES declare, carrying the same secret: the control that the canary is absent by policy. */
const CARRIED_NAME = "HTTPS_PROXY";

const BOUNDED_CODE = /^[a-z][a-z0-9_]*(?::[a-z0-9_]+)?$/u;
/** One scenario, with the wire it speaks and the bounds the harness reads it under. */
function scenarioBase(world, caseId, overrides = {}) {
  return {
    behaviour: BEHAVIOURS.standard,
    transcript: join(world.scratch, `${caseId}.ndjson`),
    facts: FACTS,
    pipes: { guardianPipePrefix: GUARDIAN_PIPE_PREFIX, presentationPipePrefix: PRESENTATION_PIPE_PREFIX },
    schemas: { guardianSession: GUARDIAN_SESSION_SCHEMA },
    helloFrame: helloFrame({}),
    acknowledgmentFrame: acknowledgmentFrame({ drainDeadlineMs: 3_000, stepHangDeadlineMs: 1_000 }),
    refusedPresentationFrame: refusedPresentationFrame({}),
    malformedFrame: JSON.stringify({ schema: GUARDIAN_SESSION_SCHEMA }),
    bounds: { connectMs: 6_000, helloMs: 6_000, settleMs: 700 },
    envNames: [
      CANARY_NAME,
      CARRIED_NAME,
      "GAMEBUDDY_HOST_SURFACE",
      "GAMEBUDDY_EMBEDDED_RUNTIME",
      "GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST",
    ],
    environment: {},
    oversizedBytes: FRAME_CAP_BYTES + 10_009,
    hangMs: 120_000,
    launchBoundMs: LAUNCH_BOUND_MS,
    stopAfterBoundedCodeMs: 0,
    onBoundedCode: null,
    ...overrides,
  };
}

/**
 * The code a launch named: the FIRST whitespace-delimited token of its one line, when that token
 * is a bounded code. A step with something to add appends it after a label (`... host_child_stderr:
 * ...`), so the code is the token the line starts with and never a substring of it.
 */
function namedCode(line) {
  const token = line.split(" ")[0];
  return BOUNDED_CODE.test(token) ? token : null;
}

/** The bounded codes a launch wrote on its one channel, in the order it wrote them. */
function boundedCodes(reading) {
  return reading.stderr.map(namedCode).filter((token) => token !== null);
}

/**
 * A probe that only a naming launch can be asked, printed as the question it was or was not asked:
 * `null` means the launch never named a code, so no instant existed to ask at.
 */
function asked(value, describe) {
  return value === null ? "not asked: the launch named no code and exited by itself" : describe(value);
}

/**
 * How many facts of one name the peer wrote before the first fact of another: the transcript is in
 * the order the peer lived it, so this is how a case tells "before" from "after" without a clock.
 */
function countBefore(reading, name, before) {
  const index = reading.facts.findIndex((entry) => entry.fact === before);
  const upTo = index === -1 ? reading.facts : reading.facts.slice(0, index);
  return upTo.filter((entry) => entry.fact === name).length;
}

/** The reading every case takes first: whether the thing it is about appeared at all. */
function observable(subject, present, detail) {
  return {
    name: `${subject}-observed`,
    ok: present,
    detail: present ? detail : `desktop_conformance_unobservable: ${detail}`,
  };
}

/** The exit status as a reading, or the fact that this harness - not the product - ended the process. */
function exitReading(reading) {
  if (reading.killed) return `no exit of its own: this harness ended it (status ${String(reading.exitCode)})`;
  return reading.exited ? `exit=${String(reading.exitCode)}` : "still running at the read";
}

/** A launch that neither exited nor named a code inside the shared bound is a hang, and a hang fails. */
function settled(reading, scenario, label = "the") {
  return {
    name: `${label}-launch-settled`,
    ok: !reading.timedOut,
    detail: reading.timedOut
      ? `desktop_conformance_launch_hung: neither an exit nor a bounded code within ${scenario.launchBoundMs} ms`
      : `${reading.stoppedAfterBoundedCode ? "named a bounded code" : "exited"} after ${reading.elapsedMs} ms`,
  };
}

const cases = [
  {
    id: "frame-cap",
    title: "a Host frame over the 16384-byte cap costs the frame, not the session or the launch",
    async run({ world }) {
      // The two halves of "alive" and "serving" are asked of the channels the Desktop publishes at
      // the instant it names a refusal - and only then: a launch that survives names nothing and
      // exits by itself, so there is no such instant and no question to ask at it. The presence of
      // the answers is therefore part of the reading, never a precondition of it.
      const probes = { launcherRunning: null, primaryIntents: null, sessionPipe: null, bootstrapId: null };
      const scenario = scenarioBase(world, "frame-cap", {
        behaviour: BEHAVIOURS.oversizedHello,
        // The size of the frame that ended a real launch on 2026-11-21.
        oversizedBytes: 26_393,
        // A launch that failed shows the player a window and waits for the click, so the harness
        // reads the one bounded code and keeps the process alive only long enough to ask it two
        // questions. A launch that survives names nothing and exits by itself.
        stopAfterBoundedCodeMs: 400,
        async onBoundedCode({ pid }) {
          probes.launcherRunning = isRunning(pid);
          probes.primaryIntents = await deliverEveryPrimaryIntent();
          const bootstrapId = bootstrapIdIn(transcriptFacts(scenario.transcript));
          probes.bootstrapId = bootstrapId;
          probes.sessionPipe = bootstrapId === null ? null : await pipeReachable(guardianPipeName(bootstrapId));
        },
      });
      const reading = await launchDesktop(world, scenario);
      const peerStarted = factsNamed(reading, FACTS.hostStarted);
      const oversized = factsNamed(reading, FACTS.oversizedHelloWritten);
      const closed = factsNamed(reading, FACTS.oversizedConnectionClosed);
      const held = factsNamed(reading, FACTS.oversizedConnectionHeld);
      const accepted = factsNamed(reading, FACTS.helloAccepted);
      const refused = factsNamed(reading, FACTS.helloRefused);
      const acknowledged = factsNamed(reading, FACTS.acknowledgmentWritten);
      const reconnected = factsNamed(reading, FACTS.reconnectAttempted);
      const peerFinished = factsNamed(reading, FACTS.hostExiting);
      // The transcript is in the peer's own order, so "accepted before the peer reconnected" and
      // "accepted after it" are two different readings of the same session vocabulary.
      const acceptedBeforeReconnect = countBefore(reading, FACTS.helloAccepted, FACTS.reconnectAttempted);
      const acknowledgedBeforeReconnect = countBefore(reading, FACTS.acknowledgmentWritten, FACTS.reconnectAttempted);
      // A peer that never reached the end of its own script and is gone was ended by the launcher
      // during the refusal: its connection ended with it, and that is a reading of the same fact as
      // seeing the close. Which of the two it was is printed, never assumed.
      const peerEndedWithoutFinishing = peerFinished.length === 0 && !reading.hostStillAliveAfterRead;
      return {
        assertions: [
          settled(reading, scenario),
          observable("host-peer", peerStarted.length === 1, `host_started=${peerStarted.length}`),
          {
            // The refusal belongs to the FRAME: the launcher ends the connection it arrived on and
            // accepts nothing from it - and it never half-reads the bytes into a parsed frame.
            name: "the-oversized-frame-was-refused-not-truncated",
            ok:
              oversized.length === 1 &&
              acceptedBeforeReconnect === 0 &&
              acknowledgedBeforeReconnect === 0 &&
              (closed.length === 1 || peerEndedWithoutFinishing),
            detail:
              `oversized=${oversized.length} closedByLauncher=${closed.length} heldOpen=${held.length} ` +
              `acceptedBeforeReconnect=${acceptedBeforeReconnect} acknowledgedBeforeReconnect=${acknowledgedBeforeReconnect} ` +
              `peerReachedItsOwnEnd=${peerFinished.length} peerAliveAtRead=${reading.hostStillAliveAfterRead}`,
          },
          {
            // The contract: one oversized frame costs one frame. The same child's next hello gets a
            // session, and the launch that session admits is served readiness.
            name: "a-fresh-hello-gets-a-session",
            ok: reconnected.length === 1 && accepted.length - acceptedBeforeReconnect >= 1,
            detail: `reconnectAttempted=${reconnected.length} acceptedAfterReconnect=${accepted.length - acceptedBeforeReconnect} refused=${JSON.stringify(refused)}`,
          },
          {
            name: "the-launch-admitted-through-it-is-served",
            ok: acknowledgedBeforeReconnect === 0 && acknowledged.length >= 1,
            detail: `acknowledged=${acknowledged.length} peerReachedItsOwnEnd=${peerFinished.length}`,
          },
          {
            name: "the-desktop-is-alive-at-the-refusal",
            // The refusal must not be a process that died: when the launcher names a code, it is
            // still there to be asked. A launch that never named one answers this with `null`,
            // which is the other honest reading rather than a pass.
            ok: probes.launcherRunning === null || probes.launcherRunning === true,
            detail: asked(probes.launcherRunning, (running) => `launcherRunning=${String(running)}`),
          },
        ],
        readings: [
          { name: "what-the-launch-wrote", detail: `${JSON.stringify(reading.stderr)} ${exitReading(reading)}` },
          {
            name: "session-pipe-at-the-refusal",
            detail: asked(
              probes.sessionPipe,
              (reachable) => `reachable=${String(reachable)} bootstrapId=${String(probes.bootstrapId)}`,
            ),
          },
          {
            name: "primary-intent-channel-at-the-refusal",
            detail: asked(probes.primaryIntents, (delivered) => JSON.stringify(delivered)),
          },
        ],
        knownDefect:
          accepted.length > 0 && acknowledged.length > 0
            ? null
            : {
                id: "desktop_frame_cap_ends_the_launch",
                explains: ["a-fresh-hello-gets-a-session", "the-launch-admitted-through-it-is-served"],
                detail:
                  `one ${scenario.oversizedBytes}-byte frame (cap ${FRAME_CAP_BYTES}) is refused and then takes the launch with it: the peer that owns the frame never ` +
                  `gets its next hello served (acceptedAfterReconnect=${accepted.length - acceptedBeforeReconnect}, acknowledged=${acknowledged.length}), ` +
                  `so a Host whose session frame grew past the cap has no way back ` +
                  `(measured at the instant the code appeared: launcherRunning=${String(probes.launcherRunning)} sessionPipe=${String(probes.sessionPipe)} primaryIntentsAbsent=${probes.primaryIntents?.pipePresent === false})`,
              },
        notes: [
          "the peer never destroys the connection the oversized frame arrived on, so a close it sees is the launcher's refusal rather than its own",
          "after that close the same child speaks the hello a healthy Host speaks, publishes the readiness a healthy Host publishes, and leaves: all three are the reading",
        ],
      };
    },
  },
  {
    id: "eof-ownership",
    title: "a control EOF ends the attempt, and only a broken frame reads as a broken peer",
    async run({ world }) {
      const cleanScenario = scenarioBase(world, "eof-clean", { behaviour: BEHAVIOURS.eofThenReauthenticate });
      const clean = await launchDesktop(world, cleanScenario);
      const brokenScenario = scenarioBase(world, "eof-broken", {
        behaviour: BEHAVIOURS.malformedThenReauthenticate,
        // A broken frame ends the broker, so the peer's next connection has nothing to reach and
        // every retry fails at once: the bound is how long the retries are allowed to try.
        bounds: { connectMs: 1_500, helloMs: 6_000, settleMs: 700 },
      });
      const broken = await launchDesktop(world, brokenScenario);
      const cleanAccepted = factsNamed(clean, FACTS.helloAccepted);
      const cleanClosed = factsNamed(clean, FACTS.controlClosed);
      const cleanReconnected = factsNamed(clean, FACTS.reconnected);
      const cleanAcknowledged = factsNamed(clean, FACTS.acknowledgmentWritten);
      const brokenAccepted = factsNamed(broken, FACTS.helloAccepted);
      const brokenCommand = factsNamed(broken, FACTS.commandWritten);
      const brokenRefused = factsNamed(broken, FACTS.helloRefused);
      return {
        assertions: [
          settled(clean, cleanScenario, "clean"),
          settled(broken, brokenScenario, "broken"),
          observable(
            "host-peer",
            factsNamed(clean, FACTS.hostStarted).length === 1 && factsNamed(broken, FACTS.hostStarted).length === 1,
            `clean=${factsNamed(clean, FACTS.hostStarted).length} broken=${factsNamed(broken, FACTS.hostStarted).length}`,
          ),
          {
            name: "clean-control-eof-ends-only-the-attempt",
            ok:
              cleanAcknowledged.length === 1 &&
              cleanAccepted.length === 2 &&
              cleanClosed.length >= 1 &&
              cleanReconnected.length === 1,
            detail: `acknowledged=${cleanAcknowledged.length} accepted=${cleanAccepted.length} closed=${cleanClosed.length} reconnected=${cleanReconnected.length}`,
          },
          {
            name: "clean-control-eof-is-not-a-failure",
            ok: clean.exitCode === 0 && boundedCodes(clean).length === 0,
            detail: `exit=${String(clean.exitCode)} stderr=${JSON.stringify(clean.stderr)}`,
          },
          {
            name: "a-broken-frame-is-not-a-peer-leaving",
            ok: brokenCommand.length === 1 && brokenAccepted.length === 1 && brokenRefused.length >= 1,
            detail: `command=${brokenCommand.length} accepted=${brokenAccepted.length} refused=${brokenRefused.length}`,
          },
        ],
        defects: [],
        notes: [
          "the clean probe is the guard and the broken probe is its control: the same re-authentication is expected to succeed after a peer leaves and to fail after a peer breaks the frame vocabulary",
        ],
      };
    },
  },
  {
    id: "drain-budget",
    title: "a quit waits the Host's declared drain plus its step-hang bound before killing it",
    async run({ world }) {
      const scenario = scenarioBase(world, "drain-budget", {
        behaviour: BEHAVIOURS.hang,
        hangMs: 120_000,
        // Longer than the quit the Host's own numbers would bound (3000 ms drain + 1000 ms
        // step-hang, plus the launcher's margin) and short enough to cost the suite a few seconds:
        // a launcher still running past it did not quit on anything a script could say.
        launchBoundMs: 8_000,
      });
      const started = Date.now();
      const pending = launchDesktop(world, scenario);
      // The only channel a script has for asking a running launcher for anything. Wait until the
      // Host is serving, then deliver every intent that channel has.
      const delivered = await waitForIntentChannel(6_000);
      const reading = await pending;
      const records = teardownRecords(world);
      const elapsed = Date.now() - started;
      return {
        assertions: [observable("intent-channel", delivered.pipePresent, JSON.stringify(delivered))],
        readings: [
          { name: "host-declared", detail: JSON.stringify(scenario.acknowledgmentFrame) },
          { name: "intents-the-channel-accepts", detail: JSON.stringify(PRIMARY_INTENTS) },
          { name: "teardown-records", detail: `${records.length} written · ${JSON.stringify(records)}` },
          {
            name: "the-two-numbers-a-quit-reports",
            detail: "none: no teardown record carries elapsedMs and drainDeadlineMs",
          },
          {
            name: "launcher-at-the-bound",
            detail: `${reading.timedOut ? "still running" : reading.exited ? "exited" : "stopped on a bounded code"} after ${elapsed} ms · killed-by-harness=${reading.killed}`,
          },
        ],
        defects: [
          {
            id: "desktop_shutdown_has_no_scriptable_initiator",
            detail:
              "the product's only quit is the tray's own menu item, which no process, supervisor or test can address; on a machine without an interactive shell nothing can ask a running " +
              "launcher to quit at all, so ADR-0012's declared drain and step-hang numbers are never spent and never observable",
          },
        ],
        skipped: {
          code: "desktop_shutdown_has_no_scriptable_initiator",
          detail:
            `the only channel a process may address answers ${JSON.stringify(PRIMARY_INTENTS)} and nothing else, so with a Host that declared ` +
            `${scenario.acknowledgmentFrame.drainDeadlineMs} ms drain + ${scenario.acknowledgmentFrame.stepHangDeadlineMs} ms step-hang and never reclaimed, ` +
            `after ${elapsed} ms the launcher was still running and had written 0 teardown records`,
        },
        notes: [
          "the Host is told to hang for 120 s, so any quit inside the case's bound would still be a launcher-initiated one",
        ],
      };
    },
  },
  {
    id: "environment-whitelist",
    title: "the Host child carries the declared environment block and nothing credential-shaped beside it",
    async run({ world }) {
      const scenario = scenarioBase(world, "environment-whitelist", {
        behaviour: BEHAVIOURS.environment,
        environment: {
          [CANARY_NAME]: `leak-${randomBytes(8).toString("hex")}`,
          [CARRIED_NAME]: "http://127.0.0.1:9/conformance-control",
        },
      });
      const reading = await launchDesktop(world, scenario);
      const observed = factsNamed(reading, FACTS.environment);
      const carried = observed.length === 1 ? observed[0].carried : {};
      const names = observed.length === 1 ? observed[0].names : [];
      return {
        assertions: [
          settled(reading, scenario),
          observable("child-environment", observed.length === 1, `environment-fact=${observed.length}`),
          {
            name: "ambient-canary-not-carried",
            ok: observed.length === 1 && carried[CANARY_NAME] === undefined,
            detail: `observed=${observed.length} canary=${JSON.stringify(carried[CANARY_NAME] ?? null)} childNames=${names.length}`,
          },
          {
            name: "declared-names-are-carried",
            ok:
              carried[CARRIED_NAME] === scenario.environment[CARRIED_NAME] &&
              carried.GAMEBUDDY_HOST_SURFACE === "composed-reference-game" &&
              carried.GAMEBUDDY_EMBEDDED_RUNTIME === "1",
            detail: JSON.stringify(carried),
          },
          {
            name: "the-reading-is-live",
            // The control: the canary name IS set in the launcher's own environment and is NOT in
            // the child's, so "absent" measures a decision rather than an unread environment.
            ok:
              scenario.environment[CANARY_NAME] !== undefined &&
              carried[CANARY_NAME] === undefined &&
              carried[CARRIED_NAME] === scenario.environment[CARRIED_NAME],
            detail: `launcherCanary=${scenario.environment[CANARY_NAME] !== undefined} childCanary=${carried[CANARY_NAME] === undefined ? "absent" : "present"}`,
          },
        ],
        defects: [],
        notes: [
          `the child's own environment had ${names.length} names; the block it was given is the launcher's, not the harness's`,
        ],
      };
    },
  },
  {
    id: "orphan-recovery",
    title: "a dead attempt's record is reclaimed, and a pid that belongs to another process is left alone",
    async run({ world }) {
      const recordedAt = Date.now();

      // (1) The record a launch that died left behind, naming a process that is gone.
      const gone = startStandinProcess();
      const goneIdentity = processIdentity(gone.pid);
      killExactProcess(gone.pid);
      const goneRecord = attemptRecordFor(goneIdentity, recordedAt);
      writeAttemptRecord(world, goneRecord);
      const readBack = readAttemptRecord(world);
      const deadScenario = scenarioBase(world, "orphan-dead");
      const recovered = await launchDesktop(world, deadScenario);
      const afterRecovery = readAttemptRecord(world);

      // (2) The record whose pid now belongs to another process: alive, not the recorded one.
      const foreign = startStandinProcess();
      const foreignIdentity = processIdentity(foreign.pid);
      writeAttemptRecord(
        world,
        attemptRecordFor({ ...foreignIdentity, startedAtUnixMs: foreignIdentity.startedAtUnixMs - 60_000 }, recordedAt),
      );
      const foreignScenario = scenarioBase(world, "orphan-foreign");
      const discriminated = await launchDesktop(world, foreignScenario);
      const foreignAlive = isRunning(foreign.pid);
      const afterForeign = readAttemptRecord(world);
      killExactProcess(foreign.pid);

      // (3) The control: the record names its owner EXACTLY, and the launch is what ends that process.
      const exact = startStandinProcess();
      const exactIdentity = processIdentity(exact.pid);
      writeAttemptRecord(world, attemptRecordFor(exactIdentity, recordedAt));
      const exactScenario = scenarioBase(world, "orphan-exact");
      const reaped = await launchDesktop(world, exactScenario);
      const exactAlive = isRunning(exact.pid);
      if (exactAlive) killExactProcess(exact.pid);

      return {
        assertions: [
          settled(recovered, deadScenario, "dead-owner"),
          settled(discriminated, foreignScenario, "foreign-owner"),
          settled(reaped, exactScenario, "exact-owner"),
          {
            // The harness wrote a marker the product would have written, and read back the shape it
            // wrote: a marker the product never saw would make every answer below meaningless.
            name: "the-attempt-marker-observed",
            ok:
              readBack !== null &&
              readBack.bootstrapId === goneRecord.bootstrapId &&
              readBack.pid === goneRecord.pid &&
              readBack.startedAtUnixMs === goneRecord.startedAtUnixMs,
            detail: `written=${JSON.stringify(goneRecord)} readBack=${JSON.stringify(readBack)}`,
          },
          {
            name: "a-gone-owner-is-reclaimed-not-bricked",
            ok: recovered.exitCode === 0 && afterRecovery === null,
            detail: `exit=${String(recovered.exitCode)} recordAfter=${JSON.stringify(afterRecovery)} stderr=${JSON.stringify(recovered.stderr)}`,
          },
          {
            name: "a-pid-that-belongs-to-another-process-is-left-alone",
            ok:
              discriminated.exitCode === 0 &&
              foreignAlive &&
              afterForeign !== null &&
              afterForeign.outcome === GUARDIAN_ATTEMPT_RECORD.pidBelongsToAnotherProcess,
            detail: `exit=${String(discriminated.exitCode)} alive=${foreignAlive} record=${JSON.stringify(afterForeign)}`,
          },
          {
            name: "an-exact-owner-is-the-one-the-launch-ends",
            ok: reaped.exitCode === 0 && !exactAlive,
            detail: `exit=${String(reaped.exitCode)} alive=${exactAlive}`,
          },
        ],
        defects: [],
        notes: [
          "the three probes are each other's control: one record shape, three owners (gone, foreign, exact), three different answers",
        ],
      };
    },
  },
];

/** The exact record shape the launcher writes when an attempt arms and its settlement cannot prove the process gone. */
function attemptRecordFor(identity, recordedAt) {
  return {
    schema: GUARDIAN_ATTEMPT_RECORD.schema,
    version: GUARDIAN_ATTEMPT_RECORD.version,
    outcome: GUARDIAN_ATTEMPT_RECORD.settledUnverified,
    bootstrapId: randomBytes(32).toString("hex"),
    attemptId: randomUUID(),
    pid: identity.pid,
    startedAtUnixMs: identity.startedAtUnixMs,
    executablePath: identity.executablePath,
    recordedAtUnixMs: recordedAt,
  };
}

/** Wait until the launcher answers the one channel a script may address, bounded. */
async function waitForIntentChannel(boundMs) {
  const deadline = Date.now() + boundMs;
  let last = await deliverEveryPrimaryIntent();
  while (!last.pipePresent && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    last = await deliverEveryPrimaryIntent();
  }
  return last;
}

export { cases };
