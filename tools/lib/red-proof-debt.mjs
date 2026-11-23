/**
 * The debt a gate declares when it has no falsifier of its own: the reason, and the condition that ends it.
 *
 * `gates/meta/audit-gate-red-proofs.mjs` reads two ledgers - the markers, and the proofs measured as prose at one
 * commit - and neither can say what a gate that owes a proof is waiting for or what would pay it. The tree already
 * answers that shape for the gates that read this repository's own source: `tools/source-reading-baseline.json`
 * records the gates that have not stated, in their own comment lines, the invariant no compiler can express and when
 * that reading expires. These are the same two lines for a red proof, so the tree carries one declared-debt shape
 * rather than two:
 *
 *   // red-proof-debt: why this gate has no falsifier of its own, in a sentence a reviewer can act on
 *   // red-proof-expiry: when the case that would write the violation arrives, or a date this must be reviewed by
 *
 * Comments rather than a value because the declaration is prose a reviewer checks; only lines that ARE `//` comments
 * count, so the same words inside a string or a doc example declare nothing - the same boundary a `red-proof:` marker
 * has, and the same one `parseSourceReadingDeclaration` draws.
 */

/** The comment markers a gate declares the debt and its expiry under. */
export const RED_PROOF_DEBT_MARKER = "red-proof-debt";
export const RED_PROOF_EXPIRY_MARKER = "red-proof-expiry";

/**
 * How long a reason has to be before it says anything, and what an expiry may be.
 *
 * A one-word reason (`// red-proof-debt: none`) is a marker, not a claim, so the floor is the one
 * `tools/lib/source-reading-declarations.mjs` puts on a recorded reason. An expiry is a date this debt must be
 * reviewed by, or a `when …` clause naming the event that retires it - and a date already passed is a review nobody
 * did, which is why it is red rather than recorded.
 */
const DECLARATION_FLOOR = 40;
const STATED_EXPIRY = /\bwhen\b|\d{4}-\d{2}-\d{2}/u;
const DATED_EXPIRY = /\d{4}-\d{2}-\d{2}/u;

/** The first `// <marker>: …` line across a gate's owned files, or `null` when none carries one. */
const field = (sources, marker) => {
  const pattern = new RegExp(`^[ \\t]*//[ \\t]*${marker}:[ \\t]*(\\S.*)$`, "mu");
  for (const source of sources) {
    const match = pattern.exec(source);
    if (match !== null) return match[1].trim();
  }
  return null;
};

/** The declaration a gate's own files carry. Both halves `null` when it carries none. */
export function parseRedProofDebtDeclaration(sources) {
  return { reason: field(sources, RED_PROOF_DEBT_MARKER), expiry: field(sources, RED_PROOF_EXPIRY_MARKER) };
}

/** Whether a gate has said anything at all: a half of the pair is a declaration that owes the other half. */
export const statesRedProofDebt = (declaration) => declaration.reason !== null || declaration.expiry !== null;

/** Why one gate's declaration is not one a reviewer can act on, in the order a reader would ask. */
function declarationProblems({ gate, declaration, today }) {
  const problems = [];
  if (declaration.reason === null || declaration.reason.length < DECLARATION_FLOOR)
    problems.push({
      code: "red_proof_debt_reason_missing",
      detail: `states no \`// ${RED_PROOF_DEBT_MARKER}: …\` line (${DECLARATION_FLOOR}+ characters) saying why this gate has no falsifier of its own`,
    });
  if (declaration.expiry === null || !STATED_EXPIRY.test(declaration.expiry))
    problems.push({
      code: "red_proof_debt_reason_missing",
      detail: `states no \`// ${RED_PROOF_EXPIRY_MARKER}: …\` line carrying a date or a \`when …\` clause that ends the debt`,
    });
  else {
    const date = DATED_EXPIRY.exec(declaration.expiry);
    if (date !== null && new Date(`${date[0]}T00:00:00Z`) < today)
      problems.push({
        code: "red_proof_debt_expired",
        detail: `the declared expiry \`${declaration.expiry}\` is before today, so the condition it names was never met`,
      });
  }
  return problems.map((problem) => ({ ...problem, detail: `${gate}: ${problem.detail}` }));
}

/**
 * The debt judgment: for every gate that owes a falsifier, is the debt declared, recorded, or neither?
 *
 * `owed` is the population - the gates whose proof is prose, or that have no falsifier suite to be prose in. `recorded`
 * is the ledger's rows. The buckets are the three answers and they partition the population: `declared` (the gate
 * states its own reason and expiry), `recorded` (a ledger row says so, and nobody has stated the condition yet), and
 * `undeclared` (nobody has said anything, which is the finding - the whole failure this convention prevents).
 *
 * The ratchet turns both ways. A ledger row whose gate declares the pair is paid and must go, and a pair on a gate that
 * no longer owes a falsifier outlived what it described; both are `row_stale`, and both are facts the ledger alone
 * cannot state.
 */
export function judgeRedProofDebt({ owed = [], declaring = [], baseline = new Set(), today = new Date() } = {}) {
  const owedGates = new Set(owed.map((member) => member.gate));
  const declared = [];
  const recorded = [];
  const undeclared = [];
  const reasonMissing = [];
  const expired = [];
  for (const member of owed) {
    const declaration = member.declaration ?? { reason: null, expiry: null };
    const problems = declarationProblems({ gate: member.gate, declaration, today });
    if (problems.length === 0) {
      declared.push(member.gate);
      continue;
    }
    const passed = problems.filter((problem) => problem.code === "red_proof_debt_expired");
    const unanswered = problems.filter((problem) => problem.code !== "red_proof_debt_expired");
    if (passed.length > 0) expired.push({ gate: member.gate, detail: passed.map((p) => p.detail).join("; ") });
    if (unanswered.length === 0) continue;
    if (statesRedProofDebt(declaration))
      reasonMissing.push({ gate: member.gate, detail: unanswered.map((p) => p.detail).join("; ") });
    else if (baseline.has(member.gate)) recorded.push(member.gate);
    else
      undeclared.push({
        gate: member.gate,
        detail:
          `${member.gate}: owes a falsifier no file performs, and states no \`// ${RED_PROOF_DEBT_MARKER}:\`/` +
          `\`// ${RED_PROOF_EXPIRY_MARKER}:\` pair and no row in tools/gate-red-proof-execution-baseline.json`,
      });
  }
  const declaredGates = new Set(declared);
  // The buckets partition the population, so their sum is `owed` and a reader who adds the line up gets it: `unanswered`
  // is every gate that stated something a reviewer cannot act on, whether the reason is missing or the expiry passed.
  const unanswered = new Set([...reasonMissing.map((entry) => entry.gate), ...expired.map((entry) => entry.gate)]);
  const rowStale = [
    ...declaring
      .filter((member) => !owedGates.has(member.gate))
      .map((member) => ({
        gate: member.gate,
        detail: `${member.gate}: declares a \`// ${RED_PROOF_DEBT_MARKER}:\` debt and owes no falsifier any more, so the pair outlived what it described`,
      })),
    ...[...baseline]
      .filter((gate) => declaredGates.has(gate))
      .map((gate) => ({
        gate,
        detail: `${gate}: declares the debt and its expiry in its own file, so the recorded row is paid - delete it`,
      })),
  ].sort((left, right) => left.gate.localeCompare(right.gate));
  return {
    census: {
      owed: owed.length,
      declared: declared.length,
      recorded: recorded.length,
      undeclared: undeclared.length,
      unanswered: [...unanswered].filter((gate) => !declaredGates.has(gate)).length,
      expired: expired.length,
    },
    declared: declared.sort(),
    recorded: recorded.sort(),
    undeclared,
    reasonMissing,
    expired,
    rowStale,
  };
}

/** The census line, in the words the convention is written in. The four buckets sum to the population. */
export function describeRedProofDebtCensus(census) {
  return (
    `gates that owe a falsifier ${census.owed} · declared ${census.declared} · ` +
    `recorded without a declaration ${census.recorded} · unanswered ${census.unanswered} · ` +
    `expired ${census.expired} · declared by nobody ${census.undeclared}`
  );
}
