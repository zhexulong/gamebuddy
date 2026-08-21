import { randomUUID } from "node:crypto";

export type MessageTreeRole = "user" | "assistant" | "system" | "player" | "companion" | string;

export type MessageTreeNode = Readonly<{
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
  role: MessageTreeRole;
  content: string;
  message?: Readonly<{
    role: MessageTreeRole;
    content: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}>;

export type ActiveSwipeSelection =
  | Readonly<Record<string, number>>
  | ReadonlyMap<string | null, number>
  | readonly number[]
  | null
  | undefined;

export type SwipeGroup = Readonly<{
  parentId: string | null;
  nodes: readonly MessageTreeNode[];
}>;

export type SwipeInfo = Readonly<{
  nodeId: string;
  parentId: string | null;
  currentIndex: number;
  totalSwipes: number;
  label: string;
  siblingIds: readonly string[];
  hasPrevious: boolean;
  hasNext: boolean;
}>;

/**
 * Creates a new immutable message tree node conforming to Pi SessionManager structure.
 */
export function createChildBranchNode(
  parentId: string | null,
  role: MessageTreeRole,
  content: string,
  options?: Readonly<{
    id?: string;
    timestamp?: string;
    type?: string;
    metadata?: Readonly<Record<string, unknown>>;
  }>,
): MessageTreeNode {
  const id = options?.id ?? randomUUID();
  const timestamp = options?.timestamp ?? new Date().toISOString();
  const type = options?.type ?? "message";
  const node: MessageTreeNode = Object.freeze({
    id,
    parentId,
    timestamp,
    type,
    role,
    content,
    message: Object.freeze({
      role,
      content,
    }),
    ...(options?.metadata ?? {}),
  });
  return node;
}

/**
 * Groups sibling entries by parentId to generate swipe variants for each branch point.
 * Preserves entry order for each parent group.
 */
export function groupSwipesByParent(
  entries: readonly MessageTreeNode[],
): Map<string | null, MessageTreeNode[]> {
  const map = new Map<string | null, MessageTreeNode[]>();
  for (const entry of entries) {
    const parentId = entry.parentId ?? null;
    let list = map.get(parentId);
    if (!list) {
      list = [];
      map.set(parentId, list);
    }
    list.push(entry);
  }
  return map;
}

/**
 * Formats the standard SillyTavern / Pi swipe navigation label: "◀ 1/3 ▶".
 */
export function formatSwipeLabel(currentIndex: number, totalSwipes: number): string {
  const safeTotal = Math.max(1, totalSwipes);
  const safeCurrent = Math.max(0, Math.min(currentIndex, safeTotal - 1));
  return `◀ ${safeCurrent + 1}/${safeTotal} ▶`;
}

/**
 * Retrieves swipe navigation metadata for a specific message node among its siblings.
 */
export function getSwipeInfo(
  entries: readonly MessageTreeNode[],
  nodeId: string,
): SwipeInfo | null {
  const target = entries.find((e) => e.id === nodeId);
  if (!target) return null;

  const parentId = target.parentId ?? null;
  const swipesMap = groupSwipesByParent(entries);
  const siblings = swipesMap.get(parentId) ?? [target];
  const siblingIds = Object.freeze(siblings.map((s) => s.id));
  const currentIndex = Math.max(0, siblings.findIndex((s) => s.id === nodeId));
  const totalSwipes = siblings.length;

  return Object.freeze({
    nodeId,
    parentId,
    currentIndex,
    totalSwipes,
    label: formatSwipeLabel(currentIndex, totalSwipes),
    siblingIds,
    hasPrevious: currentIndex > 0,
    hasNext: currentIndex < totalSwipes - 1,
  });
}

/**
 * Resolves the chosen swipe index for a given parentId/depth from activeSwipeIndices.
 */
function resolveSwipeIndex(
  activeSwipeIndices: ActiveSwipeSelection,
  parentId: string | null,
  depth: number,
  totalOptions: number,
): number {
  if (totalOptions <= 1) return 0;
  const maxIdx = totalOptions - 1;

  if (activeSwipeIndices !== null && activeSwipeIndices !== undefined) {
    if (activeSwipeIndices instanceof Map) {
      if (activeSwipeIndices.has(parentId)) {
        const val = activeSwipeIndices.get(parentId);
        if (typeof val === "number" && Number.isFinite(val)) {
          return Math.max(0, Math.min(Math.floor(val), maxIdx));
        }
      }
      if (parentId === null && activeSwipeIndices.has("root")) {
        const val = activeSwipeIndices.get("root");
        if (typeof val === "number" && Number.isFinite(val)) {
          return Math.max(0, Math.min(Math.floor(val), maxIdx));
        }
      }
    } else if (Array.isArray(activeSwipeIndices)) {
      const val = activeSwipeIndices[depth];
      if (typeof val === "number" && Number.isFinite(val)) {
        return Math.max(0, Math.min(Math.floor(val), maxIdx));
      }
    } else if (typeof activeSwipeIndices === "object") {
      const record = activeSwipeIndices as Record<string, number>;
      const key = parentId === null ? (record["root"] !== undefined ? "root" : "null") : parentId;
      if (record[key] !== undefined) {
        const val = record[key];
        if (typeof val === "number" && Number.isFinite(val)) {
          return Math.max(0, Math.min(Math.floor(val), maxIdx));
        }
      }
    }
  }

  // Default: for root variants, choose index 0; for child swipes, choose latest variant (maxIdx)
  return parentId === null ? 0 : maxIdx;
}

/**
 * Projects the active message sequence from root to leaf along the selected swipe paths.
 * Guarantees DAG acyclicity, path monotonicity, and bounded termination.
 */
export function projectActiveBranch(
  entries: readonly MessageTreeNode[],
  activeSwipeIndices?: ActiveSwipeSelection,
): readonly MessageTreeNode[] {
  if (entries.length === 0) return Object.freeze([]);

  const swipesByParent = groupSwipesByParent(entries);
  const rootNodes = swipesByParent.get(null) ?? [];
  if (rootNodes.length === 0) {
    // If no explicit root (parentId === null), look for orphan root nodes
    const allIds = new Set(entries.map((e) => e.id));
    const fallbackRoots = entries.filter((e) => e.parentId !== null && !allIds.has(e.parentId!));
    if (fallbackRoots.length === 0) return Object.freeze([]);
    rootNodes.push(...fallbackRoots);
  }

  const rootIndex = resolveSwipeIndex(activeSwipeIndices, null, 0, rootNodes.length);
  let current: MessageTreeNode = rootNodes[rootIndex]!;
  const projected: MessageTreeNode[] = [current];
  const visited = new Set<string>([current.id]);

  let depth = 1;
  while (true) {
    const children = swipesByParent.get(current.id) ?? [];
    if (children.length === 0) break;

    const childIndex = resolveSwipeIndex(activeSwipeIndices, current.id, depth, children.length);
    const nextNode = children[childIndex]!;

    // Acyclicity protection
    if (visited.has(nextNode.id)) break;

    visited.add(nextNode.id);
    projected.push(nextNode);
    current = nextNode;
    depth++;
  }

  return Object.freeze(projected);
}

/**
 * Reconstructs the exact ancestor path from root to a specific target node.
 */
export function getBranchToNode(
  entries: readonly MessageTreeNode[],
  targetNodeId: string,
): readonly MessageTreeNode[] {
  const byId = new Map<string, MessageTreeNode>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }

  const path: MessageTreeNode[] = [];
  const visited = new Set<string>();
  let current: MessageTreeNode | undefined = byId.get(targetNodeId);

  while (current !== undefined) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    path.push(current);
    if (current.parentId === null) break;
    current = byId.get(current.parentId);
  }

  return Object.freeze(path.reverse());
}

/**
 * Finds all leaf nodes in the tree (nodes that are not parents to any other nodes).
 */
export function findLeaves(entries: readonly MessageTreeNode[]): readonly MessageTreeNode[] {
  const parentIds = new Set<string>();
  for (const entry of entries) {
    if (entry.parentId !== null) {
      parentIds.add(entry.parentId);
    }
  }
  return Object.freeze(entries.filter((entry) => !parentIds.has(entry.id)));
}

/**
 * Validates message tree integrity: uniqueness of IDs and acyclicity of parent chains.
 */
export function validateMessageTree(entries: readonly MessageTreeNode[]): Readonly<{
  valid: boolean;
  errors: readonly string[];
}> {
  const errors: string[] = [];
  const seenIds = new Set<string>();
  const byId = new Map<string, MessageTreeNode>();

  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      errors.push(`duplicate_node_id:${entry.id}`);
    }
    seenIds.add(entry.id);
    byId.set(entry.id, entry);
  }

  for (const entry of entries) {
    const visited = new Set<string>([entry.id]);
    let curr: MessageTreeNode | undefined = entry;
    while (curr && curr.parentId !== null) {
      if (visited.has(curr.parentId)) {
        errors.push(`cycle_detected:${entry.id}->${curr.parentId}`);
        break;
      }
      visited.add(curr.parentId);
      curr = byId.get(curr.parentId);
    }
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
  });
}
