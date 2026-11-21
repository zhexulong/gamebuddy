/*
 * The peer a conformance case puts on the other end of the installed launcher.
 *
 * WHY THIS IS A PROGRAM AND NOT A TEST DOUBLE. The launcher is driven as a real process: this
 * file is installed into the generation's own bootstrap entry path and started by the launcher's
 * `CreateProcess`, exactly as the bundled Host is, with the launcher's declared environment and
 * its three inherited handles. Everything it observes is therefore what a real Host child
 * observes, and everything it does is a frame on a real pipe. No product code is imported,
 * stubbed or patched.
 *
 * IT IS A GENERIC INTERPRETER, NOT A CASE. The behaviour it performs, the numbers it declares,
 * the names of the facts it writes and where its transcript goes all arrive in one scenario
 * document; this file holds no vocabulary of its own, so a case cannot drift from its reader.
 *
 * THE ONE SUBSTITUTION. The runner installs this file with `SCENARIO_PATH_PLACEHOLDER` replaced
 * by the JSON literal of the absolute scenario path - the child has no argument or environment
 * variable of its own to be told where to look, because the launcher's command line is the image
 * plus this script and its environment block is the product's declared one.
 *
 * CommonJS on purpose: the product's bootstrap entry is a `.js` file in a directory with no
 * package.json, which node loads as CommonJS. The runner writes it there byte for byte apart
 * from that one substitution.
 */
"use strict";

const fs = require("node:fs");
const net = require("node:net");

const SCENARIO_PATH = "__CONFORMANCE_SCENARIO_PATH__";

const started = Date.now();
let transcriptPath = null;
let facts = null;

function record(field) {
  if (transcriptPath === null) return;
  try {
    fs.appendFileSync(transcriptPath, `${JSON.stringify({ t: Date.now() - started, ...field })}\n`);
  } catch {
    // A transcript that cannot be written is the harness's own failure, and the runner reports it
    // as an absent reading. It is never allowed to change what the peer does on the wire.
  }
}

/** One LF-terminated frame, or null when the stream ended or the bound expired first. */
function readFrame(stream, boundMs) {
  return new Promise((resolve) => {
    let buffered = "";
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData);
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), boundMs);
    const onData = (chunk) => {
      buffered += chunk.toString("utf8");
      const index = buffered.indexOf("\n");
      if (index >= 0) settle(buffered.slice(0, index));
    };
    stream.setEncoding("utf8");
    stream.on("data", onData);
    stream.on("end", () => settle(null));
    stream.on("close", () => settle(null));
    stream.resume();
  });
}

/** Connect a client pipe, waiting out the window where the launcher's one instance is busy. */
async function connectPipe(name, boundMs) {
  const deadline = Date.now() + boundMs;
  let lastError = null;
  while (Date.now() < deadline) {
    const socket = await new Promise((resolve) => {
      const attempt = net.connect(name);
      // One attempt is bounded on its own: a pipe whose server is between sessions can leave a
      // connect pending for far longer than a peer is willing to wait, and the retry is what makes
      // the next attempt land in the window where the launcher is serving again.
      const timer = setTimeout(() => {
        lastError = new Error("connect_timeout");
        attempt.destroy();
        resolve(null);
      }, 1_000);
      attempt.once("connect", () => {
        clearTimeout(timer);
        resolve(attempt);
      });
      attempt.once("error", (error) => {
        clearTimeout(timer);
        lastError = error;
        attempt.destroy();
        resolve(null);
      });
    });
    if (socket !== null) return socket;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error("pipe_unreachable");
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function exchange(socket, frame, boundMs) {
  socket.write(`${JSON.stringify(frame)}\n`);
  const raw = await readFrame(socket, boundMs);
  return raw === null ? null : parse(raw);
}

async function main() {
  // 1. The one bootstrap frame the launcher writes on the child's standard input. It carries the
  //    bootstrap id every private pipe is named from, and the four correlation values the
  //    authenticated session is bound to.
  const frameText = await readFrame(process.stdin, 30_000);
  if (frameText === null) {
    record({ fact: "host_failed", error: "bootstrap_frame_absent" });
    process.exitCode = 1;
    return;
  }
  const frame = parse(frameText);
  const scenario = JSON.parse(fs.readFileSync(SCENARIO_PATH, "utf8"));
  transcriptPath = scenario.transcript;
  facts = scenario.facts;
  record({ fact: facts.hostStarted, pid: process.pid, behaviour: scenario.behaviour });
  record({ fact: facts.bootstrapFrame, schema: frame.schema, bootstrapId: frame.bootstrapId });

  const correlation = {
    bootstrapId: frame.bootstrapId,
    generation: frame.generation,
    inventoryDigest: frame.inventoryDigest,
    runtimeAdmissionSha256: frame.runtimeAdmissionSha256,
  };
  const brokerName = `\\\\.\\pipe\\${scenario.pipes.guardianPipePrefix}${frame.bootstrapId}`;
  const handoffName = `\\\\.\\pipe\\${scenario.pipes.presentationPipePrefix}${frame.bootstrapId}`;

  // Every session authenticates with the same seven-key hello, bound to this launch's own values.
  const authenticate = async (socket) => {
    const hello = { ...scenario.helloFrame, ...correlation };
    const reply = await exchange(socket, hello, scenario.bounds.helloMs);
    const accepted = reply !== null && reply.status === "accepted" && reply.bootstrapId === correlation.bootstrapId;
    record({ fact: accepted ? facts.helloAccepted : facts.helloRefused, status: reply === null ? null : reply.status ?? null });
    return accepted;
  };

  const publishReadiness = async () => {
    // The one presentation entry this launch is allowed: an entry the product must refuse, so that
    // no case in this suite ever opens the player's browser.
    try {
      const handoff = await connectPipe(handoffName, scenario.bounds.connectMs);
      handoff.write(`${JSON.stringify(scenario.refusedPresentationFrame)}\n`);
      record({ fact: facts.handoffRefused, launchUrl: scenario.refusedPresentationFrame.launchUrl });
      handoff.end();
    } catch (error) {
      record({ fact: facts.handoffRefused, launchUrl: null, error: String(error && error.message) });
    }
    process.stdout.write(`${JSON.stringify({ ...scenario.acknowledgmentFrame, ...correlation })}\n`);
    record({ fact: facts.acknowledgmentWritten });
  };

  const reauthenticateOnFreshConnection = async () => {
    record({ fact: facts.reconnectAttempted });
    try {
      const second = await connectPipe(brokerName, scenario.bounds.connectMs);
      record({ fact: facts.reconnected });
      const accepted = await authenticate(second);
      second.end();
      return accepted;
    } catch (error) {
      record({ fact: facts.helloRefused, status: null, error: String(error && error.message) });
      return false;
    }
  };

  switch (scenario.behaviour) {
    case "oversized-hello": {
      // A real Host frame longer than the launcher's cap, with no terminating LF anywhere in it.
      // This peer truncates nothing: it writes the whole frame and lets the launcher answer.
      const socket = await connectPipe(brokerName, scenario.bounds.connectMs);
      socket.write(`{"schema":"${scenario.schemas.guardianSession}","padding":"${"x".repeat(scenario.oversizedBytes - 64)}`);
      record({ fact: facts.oversizedHelloWritten, bytes: scenario.oversizedBytes, terminated: false });
      await new Promise((resolve) => setTimeout(resolve, scenario.bounds.settleMs));
      socket.destroy();
      // The same child now speaks the hello a healthy Host speaks. A launch that ended on one
      // oversized frame cannot answer it, and that is the reading this case is for.
      await reauthenticateOnFreshConnection();
      break;
    }
    case "eof-then-reauthenticate":
    case "malformed-then-reauthenticate": {
      const first = await connectPipe(brokerName, scenario.bounds.connectMs);
      if (!(await authenticate(first))) {
        first.destroy();
        break;
      }
      // Readiness first, exactly as a Host that has finished composing publishes it: what this
      // case is about is the END of an attempt, not a Host that never became ready.
      await publishReadiness();
      if (scenario.behaviour === "malformed-then-reauthenticate") {
        // A frame that parses as JSON and is not the command vocabulary: a peer that broke the
        // contract, which must not be read as the owner closing control.
        first.write(`${scenario.malformedFrame}\n`);
        record({ fact: facts.commandWritten, bytes: scenario.malformedFrame.length });
        await new Promise((resolve) => setTimeout(resolve, scenario.bounds.settleMs));
      }
      first.end();
      record({ fact: facts.controlClosed });
      await new Promise((resolve) => setTimeout(resolve, scenario.bounds.settleMs));
      await reauthenticateOnFreshConnection();
      break;
    }
    case "hang": {
      const socket = await connectPipe(brokerName, scenario.bounds.connectMs);
      if (!(await authenticate(socket))) {
        socket.destroy();
        break;
      }
      process.stdout.write(`${JSON.stringify({ ...scenario.acknowledgmentFrame, ...correlation })}\n`);
      record({ fact: facts.acknowledgmentWritten });
      process.stdin.on("end", () => record({ fact: facts.controlEndOfStream }));
      process.stdin.on("close", () => record({ fact: facts.controlEndOfStream }));
      process.stdin.resume();
      await new Promise((resolve) => setTimeout(resolve, scenario.hangMs));
      record({ fact: facts.hostExiting, reason: "hang_elapsed" });
      process.exit(0);
    }
    default: {
      const socket = await connectPipe(brokerName, scenario.bounds.connectMs);
      if (!(await authenticate(socket))) {
        socket.destroy();
        break;
      }
      await publishReadiness();
      if (scenario.behaviour === "environment") {
        const carried = {};
        for (const name of scenario.envNames) {
          if (Object.prototype.hasOwnProperty.call(process.env, name)) carried[name] = process.env[name];
        }
        record({ fact: facts.environment, carried, names: Object.keys(process.env) });
      }
      // Readiness published, then the session's own end: the peer closes control and leaves, which
      // is how a Host that has finished its work ends an attempt.
      socket.end();
      record({ fact: facts.controlClosed });
      await new Promise((resolve) => setTimeout(resolve, scenario.bounds.settleMs));
      break;
    }
  }

  record({ fact: facts.hostExiting, reason: "scenario_complete" });
  process.exit(0);
}

main().catch((error) => {
  record({ fact: "host_failed", error: String((error && error.message) || error) });
  process.exit(1);
});
