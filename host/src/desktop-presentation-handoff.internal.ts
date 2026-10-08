import { connect } from "node:net";

/**
 * The Desktop-owned one-shot presentation handoff.
 *
 * The installed product's shell is a native process that owns exactly one
 * private parent-child channel for this fact: a named pipe it creates before it
 * starts this child and derives from the same one-shot bootstrap id the child
 * already received in its bootstrap frame. This module is the Host half of that
 * channel and nothing else. It is deliberately not `process.send`: Node's IPC
 * channel exists only when Node itself created the child, and the production
 * Desktop launcher must not reimplement Node's private channel bootstrap to own
 * one. The developer/QA composition gate's IPC readiness fact is published
 * separately, next to this one, by the bootstrap wire.
 *
 * The frame carries the composed surface's launch URL, which is a live one-shot
 * bootstrap credential (the URL's fragment names the bootstrap token). It must
 * therefore never reach stdout, stderr, an argument list, an environment block,
 * a file, a log line, or any error message - the private pipe is its only
 * destination, and a launch with no launcher reading it simply publishes
 * nothing.
 *
 * Publication is best-effort in the same sense the IPC readiness fact is: the
 * composition this frame announces is already running, and a handoff that
 * cannot be delivered must never change it.
 */
const HANDOFF_SCHEMA = "gamebuddy-desktop-presentation-handoff/v1";
const HANDOFF_PIPE_PREFIX = "\\\\.\\pipe\\GameBuddy.DesktopPresentationHandoff.";
const MAX_HANDOFF_FRAME_BYTES = 2_048;
const MAX_LAUNCH_URL_LENGTH = 1_024;
const bootstrapIdPattern = /^[a-f0-9]{64}$/;
// The launch URL is the Host-owned loopback entry of the composed surface: an
// ephemeral literal-loopback origin plus the immutable shell's fragment marker
// and the one-shot bootstrap token. Anything else - another host, another
// scheme, a whitespace or control character, a backslash the shell could read
// as a path - is refused rather than published, because the token's whole
// contract is that it stays on loopback and inside one URL.
const launchUrlPattern = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/[^\s\u0000-\u001f"\\]+$/;

/** The exact private pipe name one admitted Desktop launch owns. */
export function desktopPresentationHandoffPipeName(bootstrapId: string): string {
  if (!bootstrapIdPattern.test(bootstrapId)) {
    throw new Error("desktop_presentation_handoff_bootstrap_invalid");
  }
  return `${HANDOFF_PIPE_PREFIX}${bootstrapId}`;
}

/**
 * The one frame this channel may carry, or undefined when the URL is not the
 * literal-loopback entry this channel is allowed to carry. Key order is part of
 * the frame for the same reason it is on every other private wire here: it
 * keeps exactly one shape acceptable.
 */
export function composeDesktopPresentationHandoffFrame(
  bootstrapId: string,
  launchUrl: string,
): Buffer | undefined {
  if (!bootstrapIdPattern.test(bootstrapId)) return undefined;
  if (!isLoopbackLaunchUrl(launchUrl)) return undefined;
  const frame = Buffer.from(
    `${JSON.stringify({
      schema: HANDOFF_SCHEMA,
      protocolVersion: 1,
      bootstrapId,
      launchUrl,
    })}\n`,
    "utf8",
  );
  if (frame.length === 0 || frame.length > MAX_HANDOFF_FRAME_BYTES) return undefined;
  return frame;
}

/**
 * One publisher per bootstrap: the returned callback is the composition's
 * `publishLaunchUrl` seam. It publishes at most once per call and never throws,
 * so a launcher that is not there - a developer gate, a fixture composition -
 * cannot observe or break the running product.
 */
export function createDesktopPresentationHandoffPublisher(
  bootstrapId: string,
): (launchUrl: string) => void {
  const pipeName = desktopPresentationHandoffPipeName(bootstrapId);
  return (launchUrl: string): void => {
    const frame = composeDesktopPresentationHandoffFrame(bootstrapId, launchUrl);
    if (frame === undefined) return;
    publishBestEffort(pipeName, frame);
  };
}

function publishBestEffort(pipeName: string, frame: Buffer): void {
  let socket;
  try {
    socket = connect(pipeName);
  } catch {
    return;
  }
  socket.on("error", () => {
    // The launcher's pipe is absent, refused, or already closed. The published
    // fact is optional to the running composition and is never retried.
    socket.destroy();
  });
  socket.on("connect", () => socket.end(frame));
}

function isLoopbackLaunchUrl(launchUrl: string): boolean {
  if (launchUrl.length === 0 || launchUrl.length > MAX_LAUNCH_URL_LENGTH) return false;
  if (!launchUrlPattern.test(launchUrl)) return false;
  let parsed;
  try {
    parsed = new URL(launchUrl);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.port !== "";
}
