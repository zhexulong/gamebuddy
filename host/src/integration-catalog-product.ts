import { createIntegrationCatalog } from "./integration-catalog.js";
import { createStardewGameIntegrationProvider } from "./games/stardew/provider.js";
import { STARDEW_INTEGRATION_LAUNCHER } from "./stardew-integration-launcher.js";

/** Current product registry. Add only independently audited, receipt-backed adapters. */
export const PRODUCT_INTEGRATION_CATALOG = createIntegrationCatalog(
  [STARDEW_INTEGRATION_LAUNCHER],
  [createStardewGameIntegrationProvider()],
);
