export type PortfolioFrameWriter = Readonly<{
  write(frame: Uint8Array, callback: (error?: Error | null) => void): boolean;
}>;

/**
 * Waits only for local Node transport completion. This is not a Mod receipt
 * and does not imply that the Mod accepted or executed the frame.
 */
export function writePortfolioFrame(
  writer: PortfolioFrameWriter,
  frame: Uint8Array,
  timeoutMs?: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => settle(new Error("portfolio_pipe_write_timeout")), timeoutMs);
    const settle = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (error != null) reject(error);
      else resolve();
    };
    try {
      // `false` is Node backpressure only. The callback is this boundary's
      // completion contract, so deliberately do not wait for `drain`.
      writer.write(frame, settle);
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
