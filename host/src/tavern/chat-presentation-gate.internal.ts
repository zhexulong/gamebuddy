/**
 * Retired with the companion_text pseudo-tool. Native assistant content now
 * reaches the Chat P5 commit port directly from the P4-owned observer in
 * `p4-provider-start-execution.ts`; Game continues through its source-lineage
 * Farmhand presentation port. This module intentionally exports no runtime
 * seam so a future tool-based presentation path cannot be mounted by accident.
 */
export {};
