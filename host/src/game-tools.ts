import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type CompanionIntegrationClient } from "./integration.js";

/**
 * Product-safe read-only tools. Game actions are deliberately absent until a
 * native Farmhand validates each capability, policy, and evidence contract.
 */
export function createStardewObservationTools(integration: CompanionIntegrationClient) {
  const observe = defineTool({
    name: "stardew_observe",
    label: "Observe Stardew",
    description: "Read the latest authoritative Stardew Farmhand snapshot. This never changes the game.",
    parameters: Type.Object({}),
    execute: async () => {
      const state = integration.state;
      const available = state.connected && state.snapshot !== null;
      const text = available ? JSON.stringify(state.snapshot) : "No authoritative Stardew snapshot is available.";
      return {
        content: [{ type: "text" as const, text }],
        details: {
          available,
          reasonCode: available ? "available" : state.latestReasonCode ?? "integration_not_ready",
          // Keep details structurally uniform for Pi's inferred tool-result type.
          snapshotJson: available ? JSON.stringify(state.snapshot) : null,
        },
      };
    },
  });

  const execution = defineTool({
    name: "stardew_execution_status",
    label: "Stardew Execution Status",
    description: "Read the latest authoritative Stardew execution receipt; an accepted or running receipt is not success.",
    parameters: Type.Object({}),
    execute: async () => {
      const receipt = integration.state.latestReceipt;
      return {
        content: [{ type: "text" as const, text: receipt === null ? "No authoritative Stardew execution receipt is available." : JSON.stringify(receipt) }],
        details: { receiptJson: receipt === null ? null : JSON.stringify(receipt) },
      };
    },
  });

  return [observe, execution] as const;
}
