import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { type CompanionIntegration } from "./integration-types.js";
import { type ExecutionReceipt, type ExecutionRequest, validateExecutionRequest } from "./protocol.js";

/** A bridge that can execute the one currently verified capability. */
export interface MoveCapableIntegration extends CompanionIntegration {
  /** Host-owned selection prevents the Agent from minting or choosing grants. */
  nextMoveGrant(target: Readonly<{ x: number; y: number }>): string | null;
  execute(request: ExecutionRequest): Promise<ExecutionReceipt>;
  cancel(requestId: string, executionId: string, reasonCode: string): Promise<ExecutionReceipt>;
}
function isMoveCapable(value: CompanionIntegration): value is MoveCapableIntegration {
  return "nextMoveGrant" in value && typeof (value as { nextMoveGrant?: unknown }).nextMoveGrant === "function"
    && "execute" in value && typeof (value as { execute?: unknown }).execute === "function" && "cancel" in value && typeof (value as { cancel?: unknown }).cancel === "function";
}

/** Read-only tools always expose facts exactly as supplied by the Mod. */
export function createStardewObservationTools(integration: CompanionIntegration) {
  const observe = defineTool({
    name: "stardew_observe", label: "Observe Stardew",
    description: "Read the latest authoritative Stardew Farmhand snapshot. This never changes the game.", parameters: Type.Object({}),
    execute: async () => {
      const state = integration.state; const available = state.connected && state.snapshot !== null;
      return { content: [{ type: "text" as const, text: available ? JSON.stringify(state.snapshot) : "No authoritative Stardew snapshot is available." }], details: { available, reasonCode: available ? "available" : state.latestReasonCode ?? "integration_not_ready", snapshotJson: available ? JSON.stringify(state.snapshot) : null } };
    },
  });
  const execution = defineTool({
    name: "stardew_execution_status", label: "Stardew Execution Status",
    description: "Read the latest authoritative Stardew execution receipt; accepted or running is not success.", parameters: Type.Object({}),
    execute: async () => {
      const receipt = integration.state.latestReceipt;
      return { content: [{ type: "text" as const, text: receipt === null ? "No authoritative Stardew execution receipt is available." : JSON.stringify(receipt) }], details: { receiptJson: receipt === null ? null : JSON.stringify(receipt) } };
    },
  });
  return [observe, execution] as const;
}

/**
 * Mount the only currently evidence-backed Game Action. It checks a fresh
 * snapshot and short-lived Mod-issued grant; its returned receipt is verbatim
 * authority, never a Host interpretation of success.
 */
export function createStardewActionTools(integration: CompanionIntegration) {
  // Capability declaration is Mod authority. A transport implementation alone
  // must never cause an unapproved Game Action to appear to the Agent.
  if (!isMoveCapable(integration) || !integration.state.capabilities.includes("move_to_tile")) return [] as const;
  const cancel = defineTool({
    name: "stardew_cancel_active_execution", label: "Cancel Active Stardew Execution",
    description: "Request cancellation of the exact active execution. The authoritative Mod receipt determines whether it stopped.",
    parameters: Type.Object({ requestId: Type.String({ minLength: 1, maxLength: 128 }), executionId: Type.String({ minLength: 1, maxLength: 128 }), reasonCode: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
    execute: async (_toolCallId, params) => {
      if (!integration.state.connected || !integration.state.capabilities.includes("cancel_active_execution")) return receiptResult(null, "capability_not_declared");
      try { return receiptResult(await integration.cancel(params.requestId, params.executionId, params.reasonCode ?? "agent_requested_cancel"), null); }
      catch (error) { return receiptResult(null, error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_cancel_failed"); }
    },
  });
  const move = defineTool({
    name: "stardew_move_to_tile", label: "Move Farmhand to Tile",
    description: "Request the verified move_to_tile capability. Inspect its authoritative receipt before saying the movement succeeded.",
    parameters: Type.Object({ x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
    execute: async (_toolCallId, params) => {
      const snapshot = integration.state.snapshot;
      if (!integration.state.connected || snapshot === null) return receiptResult(null, "integration_not_ready");
      // Capability is a live Mod fact, not a one-time Host mount decision.
      // Reconnects, lifecycle transitions, or version changes therefore fail
      // closed even though Pi keeps the stable tool name in its session.
      if (!integration.state.capabilities.includes("move_to_tile") || !snapshot.capabilities.includes("move_to_tile")) return receiptResult(null, "capability_not_declared");
      const permissionToken = integration.nextMoveGrant({ x: params.x, y: params.y });
      if (permissionToken === null) return receiptResult(null, "no_fresh_permission_grant");
      const request: ExecutionRequest = { requestId: params.requestId ?? randomUUID(), idempotencyKey: params.idempotencyKey ?? randomUUID(), action: "move_to_tile", args: { x: params.x, y: params.y }, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000, permissionToken };
      const invalid = validateExecutionRequest(request, snapshot);
      if (invalid !== null) return receiptResult(null, invalid);
      try { return receiptResult(await integration.execute(request), null); }
      catch (error) { return receiptResult(null, error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_execute_failed"); }
    },
  });
  return integration.state.capabilities.includes("cancel_active_execution") ? [move, cancel] as const : [move] as const;
}
function receiptResult(receipt: ExecutionReceipt | null, reasonCode: string | null) {
  return { content: [{ type: "text" as const, text: receipt === null ? `Game action was not created: ${reasonCode}.` : JSON.stringify(receipt) }], details: { receiptJson: receipt === null ? null : JSON.stringify(receipt), reasonCode } };
}
