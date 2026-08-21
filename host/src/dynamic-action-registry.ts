// host/src/dynamic-action-registry.ts
import { createDomainActionPipeline, type DomainActionNode } from "./action-ast.js";
import {
  interpretPreflight,
  type PreflightResult,
  type PreflightSnapshot,
} from "./action-preflight-interpreter.js";
import {
  type PullbackSpec,
  verifyPullbackEqualizer,
} from "./pullback-receipt.js";
import type { ExecutionReceipt } from "./protocol.js";

export interface DeclarativeDomainActionSpec {
  readonly actionId: string;
  readonly family: string;
  readonly description: string;
  readonly pipeline: readonly DomainActionNode[];
  readonly preflightInvariants: {
    readonly requiredTools?: readonly string[];
    readonly minimumStamina?: number;
    readonly requiredLocation?: string;
  };
  readonly pullbackEqualizer: PullbackSpec;
}

export interface DynamicActionExecutionFeedback {
  readonly status: "verified" | "diagnostic_feedback" | "execution_error";
  readonly reasonCode: string;
  readonly delta?: {
    readonly targetProperty: string;
    readonly expectedValue: unknown;
    readonly actualValue: unknown;
  };
}

export interface DynamicActionRegistry {
  register(spec: DeclarativeDomainActionSpec): { readonly success: boolean; readonly reason?: string };
  unregister(actionId: string): boolean;
  hasAction(actionId: string): boolean;
  getActionSpec(actionId: string): DeclarativeDomainActionSpec | undefined;
  preflight(actionId: string, snapshot: PreflightSnapshot): PreflightResult;
  evaluateReceipt(actionId: string, receipt: ExecutionReceipt): DynamicActionExecutionFeedback;
  listActions(): readonly DeclarativeDomainActionSpec[];
}

export function createDynamicActionRegistry(): DynamicActionRegistry {
  const actions = new Map<string, DeclarativeDomainActionSpec>();

  return {
    register: (spec: DeclarativeDomainActionSpec) => {
      if (!spec.actionId || typeof spec.actionId !== "string") {
        return { success: false, reason: "invalid_action_id" };
      }
      if (!Array.isArray(spec.pipeline) || spec.pipeline.length === 0) {
        return { success: false, reason: "empty_pipeline" };
      }
      actions.set(spec.actionId, Object.freeze({ ...spec }));
      return { success: true };
    },

    unregister: (actionId: string) => {
      return actions.delete(actionId);
    },

    hasAction: (actionId: string) => actions.has(actionId),

    getActionSpec: (actionId: string) => actions.get(actionId),

    preflight: (actionId: string, snapshot: PreflightSnapshot): PreflightResult => {
      const spec = actions.get(actionId);
      if (!spec) {
        return {
          isValid: false,
          estimatedStaminaCost: 0,
          simulatedFinalStamina: snapshot.playerStamina,
          missingTools: ["action_not_found"],
          missingHandles: [],
        };
      }

      const plan = createDomainActionPipeline(spec.pipeline);
      const baseResult = interpretPreflight(plan, snapshot);

      const missingTools = [...baseResult.missingTools];
      const missingHandles = [...baseResult.missingHandles];

      if (spec.preflightInvariants.requiredTools) {
        for (const tool of spec.preflightInvariants.requiredTools) {
          const hasTool = snapshot.inventorySlots.some((s) => s.label === tool);
          if (!hasTool && !missingTools.includes(tool)) {
            missingTools.push(tool);
          }
        }
      }

      if (spec.preflightInvariants.requiredLocation) {
        if (snapshot.currentLocation !== spec.preflightInvariants.requiredLocation) {
          missingHandles.push(`location_mismatch:${spec.preflightInvariants.requiredLocation}`);
        }
      }

      const minStamina = spec.preflightInvariants.minimumStamina ?? 0;
      const effectiveCost = Math.max(baseResult.estimatedStaminaCost, minStamina);
      const isValid =
        missingTools.length === 0 &&
        missingHandles.length === 0 &&
        snapshot.playerStamina >= effectiveCost;

      return {
        isValid,
        estimatedStaminaCost: effectiveCost,
        simulatedFinalStamina: Math.max(0, snapshot.playerStamina - effectiveCost),
        missingTools: Object.freeze(missingTools),
        missingHandles: Object.freeze(missingHandles),
      };
    },

    evaluateReceipt: (actionId: string, receipt: ExecutionReceipt): DynamicActionExecutionFeedback => {
      const spec = actions.get(actionId);
      if (!spec) {
        return { status: "execution_error", reasonCode: "action_not_found" };
      }

      const isMatch = verifyPullbackEqualizer(receipt);
      if (isMatch && receipt.state === "succeeded") {
        return { status: "verified", reasonCode: receipt.reasonCode };
      }

      if (receipt.state === "expired" || receipt.state === "rejected") {
        return { status: "execution_error", reasonCode: receipt.reasonCode };
      }

      const evidence = (receipt.evidence ?? {}) as Record<string, unknown>;
      if (evidence.expectedValue !== undefined || evidence.actualValue !== undefined) {
        return {
          status: "diagnostic_feedback",
          reasonCode: receipt.reasonCode,
          delta: {
            targetProperty: spec.pullbackEqualizer.targetProperty,
            expectedValue: evidence.expectedValue ?? spec.pullbackEqualizer.expectedValue,
            actualValue: evidence.actualValue,
          },
        };
      }

      return { status: "execution_error", reasonCode: receipt.reasonCode };
    },

    listActions: () => Array.from(actions.values()),
  };
}
