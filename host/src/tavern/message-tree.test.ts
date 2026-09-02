import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  createChildBranchNode,
  findLeaves,
  formatSwipeLabel,
  getBranchToNode,
  getSwipeInfo,
  groupSwipesByParent,
  type MessageTreeNode,
  projectActiveBranch,
  validateMessageTree,
} from "./message-tree.js";

test("createChildBranchNode creates frozen, well-formed message tree nodes", () => {
  const root = createChildBranchNode(null, "system", "You are Abigail.");
  assert.equal(root.parentId, null);
  assert.equal(root.role, "system");
  assert.equal(root.content, "You are Abigail.");
  assert.equal(root.type, "message");
  assert.equal(root.message?.role, "system");
  assert.equal(root.message?.content, "You are Abigail.");
  assert.ok(root.id.length > 0);
  assert.ok(Object.isFrozen(root));

  const child = createChildBranchNode(root.id, "player", "Hello!", {
    id: "custom-id-1",
    timestamp: "2026-08-20T12:00:00.000Z",
    metadata: { author: "farmer" },
  });
  assert.equal(child.id, "custom-id-1");
  assert.equal(child.parentId, root.id);
  assert.equal(child.role, "player");
  assert.equal(child.content, "Hello!");
  assert.equal(child.timestamp, "2026-08-20T12:00:00.000Z");
  assert.equal(child.author, "farmer");
});

test("groupSwipesByParent groups sibling nodes under matching parentId", () => {
  const root1 = createChildBranchNode(null, "companion", "Greeting variant 1", { id: "root-1" });
  const root2 = createChildBranchNode(null, "companion", "Greeting variant 2", { id: "root-2" });
  const child1a = createChildBranchNode("root-1", "companion", "Response 1A", { id: "c-1a" });
  const child1b = createChildBranchNode("root-1", "companion", "Response 1B", { id: "c-1b" });
  const child1c = createChildBranchNode("root-1", "companion", "Response 1C", { id: "c-1c" });

  const entries = [root1, root2, child1a, child1b, child1c];
  const grouped = groupSwipesByParent(entries);

  assert.equal(grouped.size, 2);
  assert.deepEqual(grouped.get(null)?.map((n) => n.id), ["root-1", "root-2"]);
  assert.deepEqual(grouped.get("root-1")?.map((n) => n.id), ["c-1a", "c-1b", "c-1c"]);
  assert.equal(grouped.get("unknown"), undefined);
});

test("formatSwipeLabel and getSwipeInfo format ◀ 1/3 ▶ navigation correctly", () => {
  assert.equal(formatSwipeLabel(0, 3), "◀ 1/3 ▶");
  assert.equal(formatSwipeLabel(1, 3), "◀ 2/3 ▶");
  assert.equal(formatSwipeLabel(2, 3), "◀ 3/3 ▶");
  assert.equal(formatSwipeLabel(0, 1), "◀ 1/1 ▶");

  const parent = createChildBranchNode(null, "player", "Hi", { id: "p1" });
  const resp1 = createChildBranchNode("p1", "companion", "R1", { id: "r1" });
  const resp2 = createChildBranchNode("p1", "companion", "R2", { id: "r2" });
  const resp3 = createChildBranchNode("p1", "companion", "R3", { id: "r3" });
  const entries = [parent, resp1, resp2, resp3];

  const info1 = getSwipeInfo(entries, "r1");
  assert.ok(info1);
  assert.equal(info1.currentIndex, 0);
  assert.equal(info1.totalSwipes, 3);
  assert.equal(info1.label, "◀ 1/3 ▶");
  assert.equal(info1.hasPrevious, false);
  assert.equal(info1.hasNext, true);
  assert.deepEqual(info1.siblingIds, ["r1", "r2", "r3"]);

  const info2 = getSwipeInfo(entries, "r2");
  assert.ok(info2);
  assert.equal(info2.currentIndex, 1);
  assert.equal(info2.label, "◀ 2/3 ▶");
  assert.equal(info2.hasPrevious, true);
  assert.equal(info2.hasNext, true);

  const info3 = getSwipeInfo(entries, "r3");
  assert.ok(info3);
  assert.equal(info3.currentIndex, 2);
  assert.equal(info3.label, "◀ 3/3 ▶");
  assert.equal(info3.hasPrevious, true);
  assert.equal(info3.hasNext, false);

  assert.equal(getSwipeInfo(entries, "non-existent"), null);
});

test("projectActiveBranch projects linear and branched conversation trees", () => {
  // Linear chain:
  // Root -> User1 -> Bot1 -> User2 -> Bot2
  const root = createChildBranchNode(null, "system", "Sys", { id: "root" });
  const u1 = createChildBranchNode("root", "player", "U1", { id: "u1" });
  const b1 = createChildBranchNode("u1", "companion", "B1", { id: "b1" });
  const u2 = createChildBranchNode("b1", "player", "U2", { id: "u2" });
  const b2 = createChildBranchNode("u2", "companion", "B2", { id: "b2" });

  const linear = [root, u1, b1, u2, b2];
  const activeLinear = projectActiveBranch(linear);
  assert.deepEqual(activeLinear.map((n) => n.id), ["root", "u1", "b1", "u2", "b2"]);

  // Fork / Swipe at b1:
  // b1_v1 ("b1a"), b1_v2 ("b1b"), b1_v3 ("b1c")
  const b1a = createChildBranchNode("u1", "companion", "B1 Var A", { id: "b1a" });
  const b1b = createChildBranchNode("u1", "companion", "B1 Var B", { id: "b1b" });
  const b1c = createChildBranchNode("u1", "companion", "B1 Var C", { id: "b1c" });
  const b1b_u2 = createChildBranchNode("b1b", "player", "U2 following Var B", { id: "u2-b" });
  const b1b_b2 = createChildBranchNode("u2-b", "companion", "B2 following Var B", { id: "b2-b" });

  const branched = [root, u1, b1a, b1b, b1c, u2, b2, b1b_u2, b1b_b2];

  // Default selection selects latest swipe at u1 (b1c)
  const defaultBranch = projectActiveBranch(branched);
  assert.deepEqual(defaultBranch.map((n) => n.id), ["root", "u1", "b1c"]);

  // Explicit swipe selection via Record: select b1b (index 1 under u1)
  const swipeVarB = projectActiveBranch(branched, { u1: 1 });
  assert.deepEqual(swipeVarB.map((n) => n.id), ["root", "u1", "b1b", "u2-b", "b2-b"]);

  // Explicit swipe selection via Map: select b1a (index 0 under u1)
  const swipeVarA = projectActiveBranch(branched, new Map([["u1", 0]]));
  assert.deepEqual(swipeVarA.map((n) => n.id), ["root", "u1", "b1a"]);
});

test("getBranchToNode and findLeaves navigate and identify leaves in tree", () => {
  const root = createChildBranchNode(null, "system", "Sys", { id: "r" });
  const a = createChildBranchNode("r", "player", "A", { id: "a" });
  const b1 = createChildBranchNode("a", "companion", "B1", { id: "b1" });
  const b2 = createChildBranchNode("a", "companion", "B2", { id: "b2" });
  const c = createChildBranchNode("b1", "player", "C", { id: "c" });

  const entries = [root, a, b1, b2, c];

  const branchToC = getBranchToNode(entries, "c");
  assert.deepEqual(branchToC.map((n) => n.id), ["r", "a", "b1", "c"]);

  const branchToB2 = getBranchToNode(entries, "b2");
  assert.deepEqual(branchToB2.map((n) => n.id), ["r", "a", "b2"]);

  const leaves = findLeaves(entries);
  assert.deepEqual(leaves.map((n) => n.id).sort(), ["b2", "c"].sort());
});

test("validateMessageTree detects duplicate IDs and cycles", () => {
  const root = createChildBranchNode(null, "system", "Sys", { id: "n1" });
  const child = createChildBranchNode("n1", "player", "Hi", { id: "n2" });
  assert.equal(validateMessageTree([root, child]).valid, true);

  // Duplicate ID
  const dup = createChildBranchNode("n1", "companion", "Hello", { id: "n2" });
  const dupValidation = validateMessageTree([root, child, dup]);
  assert.equal(dupValidation.valid, false);
  assert.ok(dupValidation.errors.some((e) => e.startsWith("duplicate_node_id")));

  // Cycle: n1 -> n2 -> n3 -> n1
  const c1 = createChildBranchNode("n3", "system", "C1", { id: "n1" });
  const c2 = createChildBranchNode("n1", "player", "C2", { id: "n2" });
  const c3 = createChildBranchNode("n2", "companion", "C3", { id: "n3" });
  const cycleValidation = validateMessageTree([c1, c2, c3]);
  assert.equal(cycleValidation.valid, false);
  assert.ok(cycleValidation.errors.some((e) => e.startsWith("cycle_detected")));
});

// =========================================================================
// Property-Based Tests (PBT via fast-check)
// =========================================================================

test("PBT Property 1: DAG Acyclicity & No Duplicates across random tree structures", () => {
  // Generator for valid trees:
  // Sequentially adds nodes where each new node chooses an existing node as parent (or null for root)
  const treeArbitrary = fc.integer({ min: 1, max: 25 }).chain((numNodes) =>
    fc.array(fc.integer({ min: 0, max: numNodes - 1 }), {
      minLength: numNodes - 1,
      maxLength: numNodes - 1,
    }).map((parentChoices) => {
      const nodes: MessageTreeNode[] = [
        createChildBranchNode(null, "system", "Root system prompt", { id: "node-0" }),
      ];
      for (let i = 1; i < numNodes; i++) {
        const parentIdx = parentChoices[i - 1]! % i;
        const role = i % 2 === 1 ? "player" : "companion";
        nodes.push(createChildBranchNode(nodes[parentIdx]!.id, role, `Message content ${i}`, { id: `node-${i}` }));
      }
      return nodes;
    }),
  );

  const swipeIndicesArbitrary = fc.dictionary(
    fc.string({ minLength: 1, maxLength: 10 }),
    fc.integer({ min: 0, max: 10 }),
  );

  fc.assert(
    fc.property(treeArbitrary, swipeIndicesArbitrary, (tree, swipeIndices) => {
      const projected = projectActiveBranch(tree, swipeIndices);

      // Invariant 1: No duplicate IDs in projected active branch
      const idSet = new Set<string>();
      for (const node of projected) {
        assert.equal(idSet.has(node.id), false, `Duplicate node id in projection: ${node.id}`);
        idSet.add(node.id);
      }

      // Invariant 2: Projected branch length is between 1 and tree.length
      assert.ok(projected.length >= 1);
      assert.ok(projected.length <= tree.length);
    }),
    { numRuns: 100 },
  );
});

test("PBT Property 2: Path Monotonicity and Parent Continuity", () => {
  const treeArbitrary = fc.integer({ min: 1, max: 20 }).chain((numNodes) =>
    fc.array(fc.integer({ min: 0, max: numNodes - 1 }), {
      minLength: numNodes - 1,
      maxLength: numNodes - 1,
    }).map((parentChoices) => {
      const nodes: MessageTreeNode[] = [
        createChildBranchNode(null, "system", "Root", { id: "node-0" }),
      ];
      for (let i = 1; i < numNodes; i++) {
        const parentIdx = parentChoices[i - 1]! % i;
        nodes.push(createChildBranchNode(nodes[parentIdx]!.id, "player", `Text ${i}`, { id: `node-${i}` }));
      }
      return nodes;
    }),
  );

  fc.assert(
    fc.property(treeArbitrary, (tree) => {
      const projected = projectActiveBranch(tree);

      // Invariant: First node must be a root (parentId === null)
      assert.equal(projected[0]?.parentId, null);

      // Invariant: Every subsequent node must strictly reference its predecessor
      for (let i = 1; i < projected.length; i++) {
        const prev = projected[i - 1]!;
        const curr = projected[i]!;
        assert.equal(
          curr.parentId,
          prev.id,
          `Monotonicity violation: node ${curr.id} has parentId ${curr.parentId}, expected ${prev.id}`,
        );
      }
    }),
    { numRuns: 100 },
  );
});

test("PBT replay supports official seed and path", () => {
  const options = { seed: 12_345, path: "0", numRuns: 1 };
  const failingProbe = fc.property(fc.constant(null), () => false);

  assert.throws(() => fc.assert(failingProbe, options));
  assert.throws(() => fc.assert(failingProbe, options));
});

test("PBT Property 3: Deterministic Swipe Selection Monotonicity", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 8 }),
      fc.integer({ min: 0, max: 7 }),
      (siblingCount, selectedSwipeIndex) => {
        const root = createChildBranchNode(null, "system", "Root", { id: "root" });
        const siblings: MessageTreeNode[] = [];
        for (let i = 0; i < siblingCount; i++) {
          siblings.push(createChildBranchNode("root", "companion", `Variant ${i}`, { id: `sib-${i}` }));
        }

        const entries = [root, ...siblings];
        const activeBranch = projectActiveBranch(entries, { root: selectedSwipeIndex });

        const expectedChildIndex = Math.min(selectedSwipeIndex, siblingCount - 1);
        const expectedNode = siblings[expectedChildIndex]!;

        assert.equal(activeBranch.length, 2);
        assert.equal(activeBranch[0]?.id, "root");
        assert.equal(activeBranch[1]?.id, expectedNode.id);
      },
    ),
    { numRuns: 100 },
  );
});

test("PBT Property 4: Graph Robustness under arbitrary noisy topologies", () => {
  // Generate arbitrary node lists with random IDs and arbitrary parentIds (including self-cycles, disconnected nodes)
  const nodeArb = fc.record({
    id: fc.constantFrom("a", "b", "c", "d", "e", "f", "g"),
    parentId: fc.constantFrom(null, "a", "b", "c", "d", "e", "f", "g", "orphan-1"),
    content: fc.string({ minLength: 0, maxLength: 20 }),
    role: fc.constantFrom("player", "companion", "system"),
  }).map((r) => createChildBranchNode(r.parentId, r.role, r.content, { id: r.id }));

  const arbitraryEntries = fc.array(nodeArb, { minLength: 0, maxLength: 15 });

  fc.assert(
    fc.property(arbitraryEntries, (entries) => {
      // Must never throw, hang, or produce an infinite loop
      const branch = projectActiveBranch(entries);
      assert.ok(Array.isArray(branch));
      assert.ok(branch.length <= entries.length);

      // Must have unique IDs in output
      const ids = new Set(branch.map((b) => b.id));
      assert.equal(ids.size, branch.length);
    }),
    { numRuns: 100 },
  );
});
