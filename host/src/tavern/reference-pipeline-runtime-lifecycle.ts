export type ReferencePipelineDrain = Readonly<{
  close(): Promise<void>;
}>;

/**
 * Closes the reference-pipeline runtime in authority order. A failed listener
 * or service drain intentionally stops here: the mounted lease remains live
 * so its exact owner can perform a controlled retry rather than discarding
 * the only authority that can finish admitted work.
 */
export async function closeReferencePipelineRuntime(
  options: Readonly<{
    server?: ReferencePipelineDrain;
    pipelineService?: ReferencePipelineDrain;
    lease?: ReferencePipelineDrain;
    facade: ReferencePipelineDrain;
  }>,
): Promise<void> {
  if (options.server !== undefined) await options.server.close();
  else if (options.pipelineService !== undefined) await options.pipelineService.close();
  if (options.lease !== undefined) await options.lease.close();
  await options.facade.close();
}
