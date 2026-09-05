import type { ProductionChatRuntimePermit, ProductionPrincipal } from "./continuity-semantic-production-store.js";

export type ProductionChatRuntimeDeadlineCancellationInput = Readonly<{
  principal: ProductionPrincipal;
  permit: ProductionChatRuntimePermit;
}>;

const productionChatRuntimeDeadlineCancellations = new WeakSet<object>();

/** Host composition-only authority; never re-export from the production store surface. */
function productionChatRuntimeDeadlineCancellation(
  principal: ProductionPrincipal,
  permit: ProductionChatRuntimePermit,
): ProductionChatRuntimeDeadlineCancellationInput {
  const cancellation = Object.freeze({ principal: Object.freeze({ ...principal }), permit });
  productionChatRuntimeDeadlineCancellations.add(cancellation);
  return cancellation;
}

export function isProductionChatRuntimeDeadlineCancellation(value: object): boolean {
  return productionChatRuntimeDeadlineCancellations.has(value);
}
