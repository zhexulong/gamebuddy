import type { ProductionChatRuntimePermit, ProductionPrincipal } from "./continuity-semantic-production-store.js";

export type ProductionChatRuntimeDeadlineCancellationInput = Readonly<{
  principal: ProductionPrincipal;
  permit: ProductionChatRuntimePermit;
}>;

const productionChatRuntimeDeadlineCancellations = new WeakSet<object>();

export function isProductionChatRuntimeDeadlineCancellation(value: object): boolean {
  return productionChatRuntimeDeadlineCancellations.has(value);
}
