/**
 * The falsifiers: every rule `tools/check-fact-authority.mjs` refuses by is driven RED on a tree built for it, and the
 * real tree is read whole.
 *
 * Each case is a synthetic repository that differs from a GOOD one by exactly one defect, so the finding the gate prints
 * is the defect rather than a consequence of a broken fixture. The last case reads this repository, because a gate that
 * is green only over synthetic trees has not measured the population it exists for.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("./check-fact-authority.mjs", import.meta.url));

/** The wire, with the unions the gate derives its population from. `bodyTrace` is a SUBSET of `semanticEvent.kind`. */
const goodWire = () =>
  JSON.stringify({
    $defs: {
      semanticEvent: {
        properties: { kind: { enum: ["snapshot_changed", "player_input", "route_progress", "body_idle"] } },
      },
      bodyTrace: { properties: { category: { enum: ["route_progress", "body_idle"] } } },
      executionState: { enum: ["accepted", "running", "meaningful_progress", "succeeded"] },
    },
  });

/** The Mod's own answer to "did this execution end?" - read, never restated. */
const goodStates = () => `public static bool IsTerminal(this ExecutionState state) =>
        state is not (ExecutionState.Accepted or ExecutionState.Running or ExecutionState.MeaningfulProgress);
`;

/** A body controller that only reports a TERMINAL ending: the movement itself is body state and says nothing. */
const goodBodyController = () => `    private void Tick()
    {
        this.transition(ExecutionState.Succeeded, "target_reached", $"tile={FormatTile(currentTile)}");
    }
`;

/** The execution manager with no body-trace arm at all: the receipt is the one statement. */
const goodExecutionManager = () => `internal sealed partial class ExecutionManager
{
}
`;

/** The Host's fact pump: two in-flight tables that name no kind this fixture's Mod can emit. */
const goodEventPump = () => `export const EXECUTION_STALL_SEMANTIC_KIND = "execution_stalled";

export const IN_FLIGHT_RECEIPT_PROGRESS_STATES: Readonly<Record<string, string>> = Object.freeze({
  discarded: "no fixture kind is listed here",
});

export const IN_FLIGHT_SEMANTIC_PROGRESS_KINDS: Readonly<Record<string, string>> = Object.freeze({
  nothing_emitted: "no fixture kind is listed here",
});

export const PROGRESS_STATES: ReadonlySet<string> = new Set(["accepted", "running"]);
`;

/** The turn-delivery account, with a reason-keyed non-arrival account beside EACH counted population. */
const goodCompanionLoop = () => `process.stderr.write(
  \`NATIVE_COMPANION_TURN_DELIVERY \${JSON.stringify({
    textParts: assistantTextParts,
    presented: presentedTextParts,
    suppressed,
    bubbles: presentedTextPieces,
    suppressedBubbles,
  })}\\n\`,
);
`;

/** A settlement: one answer per program, bounded rows, a COUNTED remainder, and the shape a tool result has. */
const goodSettlement = () => `export const PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND = "program_settled";
export const MAX_SETTLED_DIGEST_NODES = 12;

export function settledProgramAnswer(answer: ReturnType<typeof planBatchAnswer>) {
  const nodes = answer.nodes.slice(0, MAX_SETTLED_DIGEST_NODES);
  return Object.freeze({
    ok: counts.failed === 0,
    reason: firstRefusal,
    nodes,
    omitted: answer.nodes.length - nodes.length,
  });
}

export function report(input: SettledDigestInput) {
  if (settled.has(input.programId)) return undefined;
  return settledProgramAnswer(input.answer);
}
`;

/** The whole fixture, so a case only names the file it breaks. */
function goodTree() {
  return {
    "protocol/bridge-v1.schema.json": goodWire(),
    "integrations/stardew/StardewBodyController.cs": goodBodyController(),
    "integrations/stardew/farmhandexecutioncontroller.cs": goodExecutionManager(),
    "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs": goodStates(),
    "host/src/event-pump.ts": goodEventPump(),
    "host/src/companion-loop.ts": goodCompanionLoop(),
    "host/src/program-settlement-digest.ts": goodSettlement(),
  };
}

const gateFile = (name) => (body) => [`${name}`, body];

/** Build a tree, run the gate over it, and remove it - AWAITING nothing, because the gate is a child process. */
function read(files) {
  const root = mkdtempSync(join(tmpdir(), "fact-authority-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body, "utf8");
    }
    const run = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
    const lastLine = run.stdout.trim().split("\n").at(-1) ?? "";
    const report = lastLine.startsWith("{") ? JSON.parse(lastLine) : null;
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, report };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const codes = (report) => report.findings.map((entry) => `${entry.code}:${entry.id}`);
const withDefect = (name, body) => ({ ...goodTree(), [name]: body });

// -------------------------------------------------------------------------------------------------------------
// The good tree: green, and every population counted.
// -------------------------------------------------------------------------------------------------------------
test("a tree where the body says nothing about itself passes, with all five populations non-zero", () => {
  const { status, report, stdout } = read(goodTree());
  assert.equal(status, 0, stdout);
  assert.deepEqual(codes(report), []);
  assert.equal(report.checks.progress_reported_as_a_fact.traces, 0);
  assert.equal(report.checks.settlement_is_one_answer_with_a_bounded_evidence.dribbled, 0);
  assert.equal(report.checks.fact_flushed_then_discarded.suppressed, 0);
  assert.equal(report.checks.delivered_text_never_arrived.unnamed, 0);
  assert.equal(report.checks.progress_kinds_declared_only_in_a_test.testOnly, 0);
  assert.ok(report.population > 0, "the population is counted, so a green reading is a measurement");
  // N = E + T + D, so the four printed numbers describe one population rather than four overlapping ones.
  const one = report.checks.progress_reported_as_a_fact;
  assert.equal(one.events + one.traces + one.declaredOnce, one.examined);
});

// -------------------------------------------------------------------------------------------------------------
// Falsifier 1: a per-tile receipt comes back.
// -------------------------------------------------------------------------------------------------------------
test("FALSIFIER a per-tile receipt emitted again is named, with the line it is emitted on", () => {
  const controller = `    private void Tick()
    {
        if (currentTile != this.lastTile)
        {
            this.lastTile = currentTile;
            this.transition(ExecutionState.MeaningfulProgress, "tile_advanced", $"tile={FormatTile(currentTile)};path=stardew_native");
            return;
        }
        this.transition(ExecutionState.Succeeded, "target_reached", "done");
    }
`;
  const { status, report } = read(withDefect("integrations/stardew/StardewBodyController.cs", controller));
  assert.equal(status, 1);
  assert.ok(codes(report).includes("progress_reported_as_a_fact:tile_advanced"), codes(report).join(", "));
  const finding = report.findings.find((entry) => entry.id === "tile_advanced");
  assert.match(finding.detail, /integrations\/stardew\/StardewBodyController\.cs:6\b/u);
  assert.match(finding.detail, /MeaningfulProgress/u);
  // The one sentence the owner asked the failure to carry.
  assert.match(finding.detail, /non-terminal state/u);
});

test("FALSIFIER a body trace spelled a second time is named at its arm", () => {
  const manager = `internal sealed partial class ExecutionManager
{
    private LocalExecutionReceipt AddTrace(LocalExecutionReceipt receipt)
    {
        string? category = receipt.State switch
        {
            ExecutionState.Running => "route_progress",
            ExecutionState.Succeeded => "execution_settled_succeeded",
            _ => null,
        };
        return receipt;
    }
}
`;
  const { status, report } = read(withDefect("integrations/stardew/farmhandexecutioncontroller.cs", manager));
  assert.equal(status, 1);
  assert.ok(codes(report).includes("progress_reported_as_a_fact:route_progress"), codes(report).join(", "));
  assert.match(
    report.findings.find((entry) => entry.id === "route_progress").detail,
    /farmhandexecutioncontroller\.cs:\d+/u,
  );
});

test("FALSIFIER the same kind produced by the store's idle publication is named there too", () => {
  const manager = `internal sealed partial class ExecutionManager
{
    private ExecutionReceiptStore store = new ExecutionReceiptStore(
        publishBodyIdleTrace: (executionId, requestId) => this.AddPublicTrace("body_idle", executionId, requestId));
}
`;
  const { report } = read(withDefect("integrations/stardew/farmhandexecutioncontroller.cs", manager));
  assert.ok(codes(report).includes("progress_reported_as_a_fact:body_idle"), codes(report).join(", "));
});

// -------------------------------------------------------------------------------------------------------------
// Falsifier 2: a settlement that dribbles, or truncates in silence.
// -------------------------------------------------------------------------------------------------------------
test("FALSIFIER a settlement that shows 12 of 60 rows without counting the rest is red, and the bound counts them", () => {
  const silent = goodSettlement().replace(/,\n {4}omitted: [^\n]*/u, "");
  const { status, report } = read(withDefect("host/src/program-settlement-digest.ts", silent));
  assert.equal(status, 1);
  assert.ok(codes(report).includes("settlement_is_one_answer_with_a_bounded_evidence:program_settled"));
  const detail = report.findings.find((entry) => entry.id === "program_settled").detail;
  // The falsifier the owner named: 60 rows over a bound of 12 must be COUNTED, never silently truncated.
  assert.match(detail, /60 rows/u);
  assert.match(detail, /shows 12/u);
  assert.match(detail, /48 must be COUNTED/u);
  assert.equal(report.checks.settlement_is_one_answer_with_a_bounded_evidence.bounded, 0);
});

test("FALSIFIER an unbounded settlement says it prints all 60 rows", () => {
  const unbounded = goodSettlement()
    .replace("answer.nodes.slice(0, MAX_SETTLED_DIGEST_NODES)", "answer.nodes")
    .replace(/,\n {4}omitted: [^\n]*/u, "");
  const { report } = read(withDefect("host/src/program-settlement-digest.ts", unbounded));
  const detail = report.findings.find((entry) => entry.id === "program_settled").detail;
  assert.match(detail, /prints all 60\b/u);
});

test("FALSIFIER a settlement without the ok/reason shape is red on the shape alone", () => {
  const unshaped = goodSettlement()
    .replace("    ok: counts.failed === 0,\n", "")
    .replace("    reason: firstRefusal,\n", "");
  const { report } = read(withDefect("host/src/program-settlement-digest.ts", unshaped));
  const detail = report.findings.find((entry) => entry.id === "program_settled").detail;
  assert.match(detail, /`ok`\/`reason`/u);
  assert.equal(report.checks.settlement_is_one_answer_with_a_bounded_evidence.oneAnswer, 1);
});

// -------------------------------------------------------------------------------------------------------------
// Falsifier 3: a fact flushed and then discarded by an in-flight suppressor.
// -------------------------------------------------------------------------------------------------------------
test("FALSIFIER an in-flight table that suppresses a Mod fact kind is named at its declaration", () => {
  const pump = goodEventPump().replace(
    "discarded: \"no fixture kind is listed here\",",
    "succeeded: \"the programme's own settlement states it\",",
  );
  const { status, report } = read(withDefect("host/src/event-pump.ts", pump));
  assert.equal(status, 1);
  assert.ok(codes(report).includes("fact_flushed_then_discarded:succeeded"), codes(report).join(", "));
  assert.match(
    report.findings.find((entry) => entry.id === "succeeded").detail,
    /host\/src\/event-pump\.ts:\d+/u,
  );
});

// -------------------------------------------------------------------------------------------------------------
// Falsifier 4: delivered text that never arrived, with nothing beside it.
// -------------------------------------------------------------------------------------------------------------
test("FALSIFIER a counted population with no reason-keyed non-arrival account is named", () => {
  const loop = goodCompanionLoop().replace("    suppressedBubbles,\n", "");
  const { status, report } = read(withDefect("host/src/companion-loop.ts", loop));
  assert.equal(status, 1);
  assert.ok(codes(report).includes("delivered_text_never_arrived:bubbles"), codes(report).join(", "));
  assert.equal(report.checks.delivered_text_never_arrived.named, 1, "the parts still have their account");
});

// -------------------------------------------------------------------------------------------------------------
// Falsifier 5: a production concept that only a test declares.
// -------------------------------------------------------------------------------------------------------------
test("FALSIFIER a progress concept that exists only in a test file is named at its test", () => {
  const files = withDefect(
    "host/src/event-pump.held-progress.test.ts",
    'const PROGRESS_KINDS = ["execution_started", "route_progress", "body_idle"];\n',
  );
  const { status, report } = read(files);
  assert.equal(status, 1);
  assert.ok(codes(report).includes("progress_kinds_declared_only_in_a_test:PROGRESS_KINDS"), codes(report).join(", "));
  assert.match(
    report.findings.find((entry) => entry.id === "PROGRESS_KINDS").detail,
    /event-pump\.held-progress\.test\.ts:1\b/u,
  );
});

test("a concept production declares is not test-only, even when a test also names it", () => {
  const files = withDefect(
    "host/src/event-pump.held-progress.test.ts",
    'const PROGRESS_STATES = new Set(["accepted"]);\n',
  );
  const { status, report } = read(files);
  assert.equal(status, 0, codes(report).join(", "));
  assert.equal(report.checks.progress_kinds_declared_only_in_a_test.testOnly, 0);
});

// -------------------------------------------------------------------------------------------------------------
// Zero population is blocked, never green.
// -------------------------------------------------------------------------------------------------------------
test("FALSIFIER a wire with no event union blocks the gate with exit 2, not a pass", () => {
  const emptyWire = JSON.stringify({ $defs: { semanticEvent: { properties: { kind: { enum: [] } } } } });
  const { status, stdout } = read(withDefect("protocol/bridge-v1.schema.json", emptyWire));
  assert.equal(status, 2, stdout);
  assert.match(stdout, /fact_authority_no_population/u);
});

// -------------------------------------------------------------------------------------------------------------
// This repository: the partition adds up, and every finding answers "where".
// -------------------------------------------------------------------------------------------------------------
test("the real tree: the five populations are measured, the partition adds up, and each finding names a file:line", () => {
  const run = spawnSync(process.execPath, [GATE], { encoding: "utf8" });
  const lastLine = run.stdout.trim().split("\n").at(-1) ?? "";
  assert.ok(lastLine.startsWith("{"), `the gate printed no report: ${run.stdout}${run.stderr}`);
  const report = JSON.parse(lastLine);
  assert.equal(report.gate, "fact-authority");
  assert.ok(report.population > 0, "a gate over an empty population agrees with itself");
  const one = report.checks.progress_reported_as_a_fact;
  assert.equal(one.events + one.traces + one.declaredOnce, one.examined);
  for (const finding of report.findings) assert.match(finding.detail, /[\w./-]+\.(?:cs|ts|mjs):\d+/u);
  // A tree where nothing is wrong exits 0; a tree with findings exits 1. Never 2 over the real repository.
  assert.equal(run.status, report.findings.length === 0 ? 0 : 1);
});

test("the real repository's body-trace union is the wire's own declaration, not a list this gate keeps", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const schema = JSON.parse(readFileSync(join(root, "protocol/bridge-v1.schema.json"), "utf8"));
  const bodyTraceKinds = schema.$defs.bodyTrace.properties.category.enum;
  const eventKinds = schema.$defs.semanticEvent.properties.kind.enum;
  assert.ok(bodyTraceKinds.length > 0);
  for (const kind of bodyTraceKinds)
    assert.ok(eventKinds.includes(kind), `${kind} is a body trace but not an event kind, so the two unions disagree`);
});
