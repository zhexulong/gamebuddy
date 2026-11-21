/**
 * The conformance cases: what a Host peer is, what the launcher must do with it, and what the
 * launcher must refuse.
 *
 * EACH CASE IS A CONTRACT, NOT A SCENARIO RECORDING. It names the behaviour the launcher owes a
 * peer of that shape, reads it out of process facts only - the child's exit status, the one
 * bounded code on its standard error, frames on its named pipes, and the records it writes - and
 * carries a CONTROL whose expectation is the opposite, so a reading that cannot go red is visible
 * in the same run rather than trusted. Case 3 has no control because the initiator it needs does
 * not exist yet; it reports that as blocked instead of passing.
 *
 * A DEFECT IS NAMED, NOT FIXED. Where the launcher does not meet a contract today the case fails
 * and names the defect; nothing here patches the product.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import { join } from "node:path";

import {
  acknowledgmentFrame,
  BEHAVIOURS,
  FACTS,
  FRAME_CAP_BYTES,
  GUARDIAN_ATTEMPT_RECORD,
  GUARDIAN_LAUNCH_UNAVAILABLE,
  GUARDIAN_PIPE_PREFIX,
  GUARDIAN_SESSION_SCHEMA,
  PRESENTATION_PIPE_PREFIX,
  PRIMARY_INTENT_PIPE_PREFIX,
  PRIMARY_INTENTS,
  primaryIntentFrame,
  refusedPresentationFrame,
  helloFrame,
} from "./wire.mjs";
import {
  factsNamed,
  isRunning,
  killExactProcess,
  launchDesktop,
  processIdentity,
  readAttemptRecord,
  startStandinProcess,
  teardownRecords,
  writeAttemptRecord,
} from "./world.mjs";

/** The name no launcher may hand a child: this suite's own canary, set in the launcher's block. */
export const CANARY_NAME = "GAMEBUDDY_CONFORMANCE_CANARY";
/** A name the launcher DOES declare, carrying the same secret: the control that the canary is absent by policy. */
export const CARRIED_NAME = "HTTPS_PROXY";

const BOUNDED_CODE = /^[a-z][a-z0-9_]*(?::[a-z0-9_]+)?$/u;
/** One scenario, with the wire it speaks and the bounds the harness reads it under. */
export function scenarioBase(world, caseId, overrides = {}) {
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
    launchBoundMs: 45_000,
    stopOnBoundedCodeMs: 0,
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

const cases = [
  {
    id: "frame-cap",
    title: "a Host frame over the 16384-byte cap is refused by name, and the launch keeps serving",
    async run({ world }) {
      const scenario = scenarioBase(world, "frame-cap", {
        behaviour: BEHAVIOURS.oversizedHello,
        // The size of the frame that ended a real launch on 2026-11-21.
        oversizedBytes: 26_393,
        // A failed launch shows the player a window and waits for the click, so the harness reads
        // the one bounded code and stops the process itself instead of waiting for an exit.
        stopOnBoundedCodeMs: 3_000,
        launchBoundMs: 20_000,
      });
      const reading = await launchDesktop(world, scenario);
      const codes = boundedCodes(reading);
      const oversized = factsNamed(reading, FACTS.oversizedHelloWritten);
      const accepted = factsNamed(reading, FACTS.helloAccepted);
      const refused = factsNamed(reading, FACTS.helloRefused);
      const acknowledged = factsNamed(reading, FACTS.acknowledgmentWritten);
      return {
        assertions: [
          {
            name: "refused-by-name",
            ok: codes.length === 1 && namedCode(codes[0]).split(":")[0] === GUARDIAN_LAUNCH_UNAVAILABLE,
            detail: `stderr=${JSON.stringify(reading.stderr)} exit=${String(reading.exitCode)}`,
          },
          {
            name: "frame-not-truncated-and-nothing-accepted",
            ok: oversized.length === 1 && accepted.length === 0 && acknowledged.length === 0,
            detail: `oversized=${oversized.length} accepted=${accepted.length} acknowledged=${acknowledged.length}`,
          },
          {
            name: "launch-survives-the-refusal",
            ok: accepted.length > 0,
            detail: `helloAccepted=${accepted.length} reconnectAttempted=${factsNamed(reading, FACTS.reconnectAttempted).length} refused=${JSON.stringify(refused)}`,
          },
        ],
        defects:
          accepted.length === 0
            ? [
                {
                  id: "desktop_frame_cap_ends_the_launch",
                  detail:
                    `one ${scenario.oversizedBytes}-byte frame (cap ${FRAME_CAP_BYTES}) ends the whole launch: it is refused by name and then has no session left to serve, ` +
                    `so a Host whose session frame grew past the cap has no way back - the peer that owns the frame can never re-authenticate`,
                },
              ]
            : [],
        notes: [
          "the same peer reconnects after the oversized frame and speaks the hello a healthy Host speaks; the launcher's answer to that second session is the whole reading",
        ],
      };
    },
  },
  {
    id: "eof-ownership",
    title: "a control EOF ends the attempt, and only a broken frame reads as a broken peer",
    async run({ world }) {
      const clean = await launchDesktop(
        world,
        scenarioBase(world, "eof-clean", { behaviour: BEHAVIOURS.eofThenReauthenticate }),
      );
      const broken = await launchDesktop(
        world,
        scenarioBase(world, "eof-broken", { behaviour: BEHAVIOURS.malformedThenReauthenticate }),
      );
      const cleanAccepted = factsNamed(clean, FACTS.helloAccepted);
      const cleanClosed = factsNamed(clean, FACTS.controlClosed);
      const cleanReconnected = factsNamed(clean, FACTS.reconnected);
      const cleanAcknowledged = factsNamed(clean, FACTS.acknowledgmentWritten);
      const brokenAccepted = factsNamed(broken, FACTS.helloAccepted);
      const brokenCommand = factsNamed(broken, FACTS.commandWritten);
      const brokenRefused = factsNamed(broken, FACTS.helloRefused);
      return {
        assertions: [
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
        launchBoundMs: 22_000,
      });
      const started = Date.now();
      const pending = launchDesktop(world, scenario);
      // The only channel a script has for asking a running launcher for anything. Wait until the
      // Host has published readiness, then deliver every intent that channel has.
      await new Promise((resolveWait) => setTimeout(resolveWait, 6_000));
      const delivered = await deliverEveryPrimaryIntent();
      const reading = await pending;
      const records = teardownRecords(world);
      const elapsed = Date.now() - started;
      return {
        assertions: [
          {
            name: "an-intent-channel-a-script-can-address",
            ok: delivered.pipePresent,
            detail: JSON.stringify(delivered),
          },
          {
            name: "declared-drain-is-reported-not-spent",
            ok: records.some(
              (entry) =>
                entry.record !== null &&
                typeof entry.record.elapsedMs === "number" &&
                typeof entry.record.drainDeadlineMs === "number",
            ),
            detail: `records=${JSON.stringify(records)} elapsedMs=${elapsed} declared={drainDeadlineMs:3000,stepHangDeadlineMs:1000}`,
          },
          {
            name: "a-scheduled-initiator-exists",
            ok: false,
            detail:
              `the channel carries ${JSON.stringify(PRIMARY_INTENTS)} and nothing else; after ${elapsed} ms with a Host that never reclaims, the launcher ` +
              `${reading.killed ? "was still running (the harness stopped it)" : "had exited"} and wrote ${records.length} teardown record(s)`,
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
        blocked: {
          code: "desktop_shutdown_has_no_scriptable_initiator",
          detail: `after ${elapsed} ms the launcher neither quit nor reported a teardown for a Host that declared 3000/1000 ms and never reclaimed`,
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
      await settle();
      const goneIdentity = processIdentity(gone.pid);
      killExactProcess(gone.pid);
      await settle();
      writeAttemptRecord(world, attemptRecordFor(goneIdentity, recordedAt));
      const recovered = await launchDesktop(world, scenarioBase(world, "orphan-dead"));
      const afterRecovery = readAttemptRecord(world);

      // (2) The record whose pid now belongs to another process: alive, not the recorded one.
      const foreign = startStandinProcess();
      await settle();
      const foreignIdentity = processIdentity(foreign.pid);
      writeAttemptRecord(
        world,
        attemptRecordFor({ ...foreignIdentity, startedAtUnixMs: foreignIdentity.startedAtUnixMs - 60_000 }, recordedAt),
      );
      const discriminated = await launchDesktop(world, scenarioBase(world, "orphan-foreign"));
      const foreignAlive = isRunning(foreign.pid);
      const afterForeign = readAttemptRecord(world);
      killExactProcess(foreign.pid);

      // (3) The control: the record names its owner EXACTLY, and the launch is what ends that process.
      const exact = startStandinProcess();
      await settle();
      const exactIdentity = processIdentity(exact.pid);
      writeAttemptRecord(world, attemptRecordFor(exactIdentity, recordedAt));
      const reaped = await launchDesktop(world, scenarioBase(world, "orphan-exact"));
      const exactAlive = isRunning(exact.pid);
      if (exactAlive) killExactProcess(exact.pid);

      return {
        assertions: [
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

const settle = () => new Promise((resolveWait) => setTimeout(resolveWait, 400));

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

/** Deliver every intent the primary-instance channel has, each on its own connection. */
async function deliverEveryPrimaryIntent() {
  const name = `\\\\.\\pipe\\${PRIMARY_INTENT_PIPE_PREFIX}${windowsSessionId()}`;
  const results = [];
  for (const intent of PRIMARY_INTENTS) {
    const delivered = await new Promise((resolveDelivery) => {
      const socket = net.connect(name);
      const timer = setTimeout(() => resolveDelivery(false), 3_000);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.write(`${JSON.stringify(primaryIntentFrame(intent))}\n`);
        socket.end();
        resolveDelivery(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolveDelivery(false);
      });
    });
    results.push({ intent, delivered });
  }
  return { pipePresent: results.some((entry) => entry.delivered), results };
}

/** The launcher names its channel from the Windows session it runs in, which is this one. */
function windowsSessionId() {
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id $PID).SessionId"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return output.trim();
}

export { cases };
