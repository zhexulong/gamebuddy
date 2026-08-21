// host/src/action-ast.ts

export type DomainActionNode =
  | { readonly type: "equip_tool" | "equip_tool_slot"; readonly slot: number; readonly toolName: string }
  | { readonly type: "till_soil"; readonly targetHandle: string }
  | { readonly type: "water_crop"; readonly targetHandle: string }
  | { readonly type: "plant_seed"; readonly slot: number; readonly targetHandle: string; readonly qualifiedItemId: string }
  | { readonly type: "fertilize_tile"; readonly slot: number; readonly targetHandle: string; readonly qualifiedItemId: string }
  | { readonly type: "harvest_crop"; readonly targetHandle: string; readonly qualifiedItemId?: string }
  | { readonly type: "pickup_forage" | "collect_forage"; readonly targetHandle: string; readonly qualifiedItemId?: string }
  | { readonly type: "use_item"; readonly slot: number; readonly qualifiedItemId: string }
  | { readonly type: "clear_hoedirt"; readonly slot: number; readonly targetHandle: string }
  | { readonly type: "contribute_bundle"; readonly bundleId: string; readonly bundleSlot: number; readonly inventorySlot: number }
  | { readonly type: "skip_event"; readonly eventId?: string };

export interface DomainActionPipeline {
  readonly nodes: readonly DomainActionNode[];
}

export interface SopStepWireDescriptor {
  readonly stepIndex: number;
  readonly actionType: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface SopPipelineWirePayload {
  readonly pipelineId: string;
  readonly steps: readonly SopStepWireDescriptor[];
  readonly expectedPullback?: {
    readonly targetProperty: string;
    readonly targetLocation: { readonly location: string; readonly tile: { readonly x: number; readonly y: number } };
    readonly expectedValue: unknown;
  };
}

export function createDomainActionPipeline(nodes: readonly DomainActionNode[]): DomainActionPipeline {
  return Object.freeze({ nodes: Object.freeze([...nodes]) });
}

export function equipToolAction(slot: number, toolName: string): DomainActionNode {
  return { type: "equip_tool", slot, toolName };
}

export function equipToolSlotAction(slot: number, toolName: string): DomainActionNode {
  return { type: "equip_tool", slot, toolName };
}

export function tillSoilAction(targetHandle: string): DomainActionNode {
  return { type: "till_soil", targetHandle };
}

export function waterCropAction(targetHandle: string): DomainActionNode {
  return { type: "water_crop", targetHandle };
}

export function plantSeedAction(slot: number, targetHandle: string, qualifiedItemId: string): DomainActionNode {
  return { type: "plant_seed", slot, targetHandle, qualifiedItemId };
}

export function fertilizeTileAction(slot: number, targetHandle: string, qualifiedItemId: string): DomainActionNode {
  return { type: "fertilize_tile", slot, targetHandle, qualifiedItemId };
}

export function harvestCropAction(targetHandle: string, qualifiedItemId?: string): DomainActionNode {
  return { type: "harvest_crop", targetHandle, qualifiedItemId };
}

export function pickupForageAction(targetHandle: string, qualifiedItemId?: string): DomainActionNode {
  return { type: "pickup_forage", targetHandle, qualifiedItemId };
}

export function collectForageAction(targetHandle: string, qualifiedItemId?: string): DomainActionNode {
  return { type: "pickup_forage", targetHandle, qualifiedItemId };
}

export function useItemAction(slot: number, qualifiedItemId: string): DomainActionNode {
  return { type: "use_item", slot, qualifiedItemId };
}

export function clearHoeDirtAction(slot: number, targetHandle: string): DomainActionNode {
  return { type: "clear_hoedirt", slot, targetHandle };
}

export function contributeBundleAction(bundleId: string, bundleSlot: number, inventorySlot: number): DomainActionNode {
  return { type: "contribute_bundle", bundleId, bundleSlot, inventorySlot };
}

export function skipEventAction(eventId?: string): DomainActionNode {
  return { type: "skip_event", eventId };
}

export function serializeDomainActionPipeline(pipeline: DomainActionPipeline, pipelineId = "sop_pipeline"): SopPipelineWirePayload {
  const steps: SopStepWireDescriptor[] = pipeline.nodes.map((node, index) => {
    const { type, ...args } = node;
    return {
      stepIndex: index,
      actionType: type,
      args: Object.freeze(args as Record<string, unknown>),
    };
  });

  return Object.freeze({
    pipelineId,
    steps: Object.freeze(steps),
  });
}

export function deserializeDomainActionPipeline(payload: SopPipelineWirePayload): DomainActionPipeline {
  if (!payload || !Array.isArray(payload.steps)) {
    throw new Error("invalid_sop_payload: steps array required");
  }

  payload.steps.forEach((step, idx) => {
    if (step.stepIndex !== idx) {
      throw new Error(`invalid_step_index_sequence: expected ${idx} but got ${step.stepIndex}`);
    }
  });

  const nodes: DomainActionNode[] = payload.steps.map((step) => {
    return {
      type: step.actionType,
      ...step.args,
    } as DomainActionNode;
  });

  return createDomainActionPipeline(nodes);
}
