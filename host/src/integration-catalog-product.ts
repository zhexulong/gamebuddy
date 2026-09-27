import { createIntegrationCatalog } from "./integration-catalog.js";
import { createStardewGameIntegrationProvider } from "./games/stardew/provider.js";

/**
 * Current product registry. Add only independently audited, receipt-backed adapters.
 *
 * It registers **no directly selectable integration launchers**. Stardew is reachable
 * only through the audited game provider below, which the composition root binds to
 * `StardewProductionLifecycleCoordinator`. There is deliberately no operator-config
 * `pipeName`/`bridgeToken` attach route: the private Farmhand connection is produced by
 * the coordinator's own generation-bound materializer, never selected from operator
 * config. `STARDEW_INTEGRATION_LAUNCHER` still exists for Preview and for that private
 * materializer, but it is not registered here, so it cannot be reached from product
 * entry.
 */
export const PRODUCT_INTEGRATION_CATALOG = createIntegrationCatalog([], [createStardewGameIntegrationProvider()]);
