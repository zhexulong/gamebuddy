/**
 * What became of each node a submitted program carried, in the Mod's own vocabulary.
 *
 * Measured 2026-11-08 on one completed run: its bundle held 154 node outcomes and every one of them was
 * `{ nodeId, state }`. Thirty-one were `recovery_required` and nine `failed`, and not one said why, which action it
 * was, or where - so "31 nodes needed recovery" was a number nobody could research. The same run's settlement digest
 * (`host/src/program-settlement-digest.ts`) carried `actionId`, `state`, `reasonCode`, `hint` and `tile` for the same
 * nodes: one fact, two spellings, and the bundle's copy was the poorer one.
 *
 * THE PROJECTION IS NOT WRITTEN HERE. It is `planBatchAnswer` from the Host (`host/src/program-status-wait.ts`), the
 * reader the digest answers with and the one `stardew_action_program_status` answers with, so the reason rule
 * (`rejectionCode ?? failureCode`), the tile rule (two integer arguments), the `hint` and the state for a node the
 * journal does not list all live in one place and cannot drift from the tool's own answer. What this adds is
 * `nodeId`: a bundle row is keyed by identity, while the digest's `index` is a position.
 *
 * The population is the nodes THIS RUN SUBMITTED, not the nodes the journal happened to list. A node the Mod never
 * recorded then reads `unknown` - a fact - instead of vanishing from the list, which is how a program that lost a node
 * to a dead bridge read exactly like a program that had one.
 */

import { planBatchAnswer } from "../../../host/dist-test/program-status-wait.js";

/**
 * One row per submitted node: `nodeId`, `actionId`, `state`, and `reasonCode`/`hint`/`tile` only when they exist.
 *
 * `journalNodes` is a status snapshot's `nodes` (or the durable journal's own node rows, already named in the wire's
 * vocabulary): the same rows the digest reads. A row that carries no reason therefore has NO `reasonCode` key - absent,
 * never null and never a placeholder - so a reader can tell "the Mod did not say" from "the Mod said this".
 *
 * `evidence` AND `postconditionVerification` ARE COPIED, and they are the reason this file's own doc exists twice: a
 * `for_each` node settles sixty tiles as ONE node, so its `{nodeId, actionId, state}` is a row that says `succeeded` and
 * nothing about which tiles it succeeded on. `round63`'s own bundle kept `{"nodeId":"n02","actionId":"for_each",
 * "state":"succeeded"}` for `plan_239_2793c52c60b8cadf` while the Mod's journal held the pass's verdict line and its
 * sixty-row table, and `program-node-outcomes.test.mjs` pins the copy so a future projection that stops copying them fails
 * by name instead of quietly shrinking the bundle back to two facts.
 */
export function programNodeOutcomes(compiledNodes, journalNodes) {
  const compiled = (Array.isArray(compiledNodes) ? compiledNodes : []).map((node) =>
    Object.freeze({
      nodeId: typeof node?.nodeId === "string" ? node.nodeId : null,
      actionId: typeof node?.actionId === "string" ? node.actionId : null,
      arguments: node?.arguments ?? {},
    }),
  );
  const answer = planBatchAnswer(compiled, { nodes: Array.isArray(journalNodes) ? journalNodes : [] });
  const byIndex = new Map(answer.nodes.map((node) => [node.index, node]));
  const rows = [];
  for (let index = 0; index < compiled.length; index += 1) {
    // The row's OWN `index`, not the position this loop happens to be at: the join to the submitted node is the index
    // the reader declared, so a reader that ever answered in another order cannot attribute a reason to a neighbour.
    const row = byIndex.get(index);
    if (row === undefined) continue;
    rows.push(
      Object.freeze({
        nodeId: compiled[index].nodeId,
        actionId: row.actionId,
        state: row.state,
        ...(row.reasonCode === undefined ? {} : { reasonCode: row.reasonCode }),
        ...(row.hint === undefined ? {} : { hint: row.hint }),
        ...(row.tile === undefined ? {} : { tile: row.tile }),
        // The batch's own proof, under the Mod's own names, uncut and unsummarised: `evidence` is the row table and
        // `postconditionVerification` is the `for_each_pass:decided=…` line beside it.
        ...(row.evidence === undefined ? {} : { evidence: row.evidence }),
        ...(row.postconditionVerification === undefined
          ? {}
          : { postconditionVerification: row.postconditionVerification }),
      }),
    );
  }
  return Object.freeze(rows);
}
