/**
 * Ask a composed child to close itself, and wait for it to actually exit.
 *
 * This is the whole reason the memory loop can have a second phase. The product
 * admits a `known` mount as a terminal SUCCESSOR, which requires the predecessor
 * chat-runtime teardown to have COMMITTED, and that commit happens only inside the
 * child's own close path (desktop-runtime-bootstrap -> composition.close()).
 *
 * The ask IS the product's own quit, not a second channel: the bootstrap's
 * controller channel is the child's standard input, and its EOF is the one trigger
 * the Host accepts (ADR-0012 §9.2). A polite message over the readiness IPC channel
 * used to stand here; it had no producer in the product and was deleted, so this
 * closes the channel the launcher itself closes on a tray quit. `child.kill()` is
 * not a substitute: on Windows it is TerminateProcess, so the child runs no step.
 */
export async function stopChildGracefully(child, timeoutMs = 30_000) {
  if (child === undefined || child === null || child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", () => resolveExit(true)));
  // A launch handle that already closed the channel (its own `dispose`) left nothing
  // to ask with; a child without one was never launched by this product's launcher.
  if (child.stdin !== null && child.stdin !== undefined && !child.stdin.destroyed) child.stdin.end();
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
