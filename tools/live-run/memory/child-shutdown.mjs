/**
 * Ask a composed child to close itself, and wait for it to actually exit.
 *
 * This is the whole reason the memory loop can have a second phase. The product
 * admits a `known` mount as a terminal SUCCESSOR, which requires the predecessor
 * chat-runtime teardown to have COMMITTED, and that commit happens only inside the
 * child's own close path (desktop-runtime-bootstrap finally -> composition.close()).
 *
 * On Windows there is no way to make that path run from outside: `child.kill("SIGTERM")`
 * is TerminateProcess and the handler never executes (probe: exit reported
 * `signal SIGTERM`, handler not invoked), and disposing the guardian peer leaves the
 * child running. So the child now accepts a cooperative request on the IPC channel the
 * gate already opens for readiness, and this asks politely before ever escalating.
 */
export const SHUTDOWN_REQUEST_SCHEMA = "gamebuddy-desktop-shutdown-request/v1";

export async function stopChildGracefully(child, timeoutMs = 30_000) {
  if (child === undefined || child === null || child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", () => resolveExit(true)));
  // The request only reaches a child that was spawned with an IPC channel and has
  // not disconnected. `connected` is the product's own gate: a child without the
  // channel (production Desktop) simply never gets asked, which is correct - it is
  // stopped by its supervisor.
  const canRequest = typeof child.send === "function" && child.connected === true;
  if (canRequest) {
    try {
      child.send(Object.freeze({ schema: SHUTDOWN_REQUEST_SCHEMA, protocolVersion: 1 }));
    } catch {
      // A send failure is not fatal: the escalation below still guarantees exit.
    }
  }
  const closed = await Promise.race([
    exited,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs)),
  ]);
  if (closed === true) return;
  // Escalate. `kill` without a signal is the portable hard stop; SIGTERM is
  // equivalent on Windows and unreliable elsewhere, so it is not used as a fallback.
  child.kill();
  await Promise.race([exited, new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000))]);
}
