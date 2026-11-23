#!/usr/bin/env node
/**
 * The falsifier of `gates/product/check-fail-closed-forward-path.mjs`.
 *
 * red-proof: inject  make the `step_missing` branch unreachable (`if (false && member.step === null)`) ->
 *                   `a code with no family is a missing member, printed as a difference` fails and the
gate reports
 *                   it (`8 pass / 1 fail`); restoring the file leaves `git diff` empty
 * red-proof: history  the tree before the zombie-turn fix (`69b7a244^`) - the pre-change gate reported
 *                   `"status":"passed"` over 13 `self_heals` codes, certifying "the Host is working, and
 *                   it ends its own work" for a turn a crashed Host left `running` with nothing to settle
 *                   it; this gate reports `self_heals_without_evidence` naming `tavern/turn_busy` and the
 *                   missing durable reread, exit 1. Reproduced with `git archive 69b7a244^`, the same
 *                   `node gates/product/check-fail-closed-forward-path.mjs` invocation, and a junction for each
 *                   `node_modules` the archived tree needs; the injected copy below asserts the same shape.
 *
 * Each case turns one of the gate's findings red on a real violation, by pointing one source at a
 * throwaway copy of the product's own file with exactly one defect injected. The gate's readers run
 * unchanged (`checkForwardPathOf`), so what is proved is the gate's behaviour on the product's shape,
 * not a second implementation of the same rules agreeing with itself.
 *
 * The type half is proved with the compiler the web workspace builds with: the brief's first red case
 * is "a family that loses its step does not compile", and only `tsc` can answer that.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";
import {
  checkForwardPath,
  checkForwardPathOf,
  INTERVENTION_ONLY_DEBT,
  SOURCES,
  selfHealsEvidence,
  turnStates,
} from "./check-fail-closed-forward-path.mjs";

const ROOT = repositoryRoot(import.meta.url);
const WEB_ROOT = join(ROOT, "dialogue-web");
const typescript = createRequire(join(WEB_ROOT, "package.json"))("typescript");

const scratch = mkdtempSync(join(tmpdir(), "forward-path-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A copy of one product file with one injected edit, in a directory this run owns. */
function mutated(source, name, [from, to]) {
  return mutatedMany(source, name, [[from, to]]);
}

/** The same, with several injected edits applied in order (one shape made of two lines). */
function mutatedMany(source, name, edits) {
  let text = readFileSync(source, "utf8");
  for (const [from, to] of edits) {
    assert.ok(
      text.includes(from),
      `${source} no longer contains ${JSON.stringify(from)}, so this injection cannot be made`,
    );
    text = text.replace(from, to);
  }
  const target = join(scratch, name);
  writeFileSync(target, text, "utf8");
  return target;
}

/** A module declaring nothing but the empty populations, for the "examined nothing" case. */
function emptyModule(name, declarations) {
  const target = join(scratch, name);
  writeFileSync(target, `${declarations}\n`, "utf8");
  return target;
}

describe("check-fail-closed-forward-path", () => {
  test("the real tree answers every member, over a population no reader left empty", () => {
    const verdict = checkForwardPath();
    assert.equal(verdict.status, "passed", JSON.stringify(verdict.findings, null, 2));
    // The population is derived, so a reader that quietly stopped finding things would still read as
    // "passed" over what little it saw: the size is pinned to a floor taken from the declarations.
    assert.ok(verdict.examined >= 100, `examined ${verdict.examined} members`);
    // The phase axis, read as the product declares it: every phase either offers an in-system step or
    // names only an intervention, and the one intervention-only phase is the declared debt. Ten of the
    // nineteen phases were unread for two commits after `9682e223` wrapped `build` in `inFarm` - a
    // reader that stops at the callee's name goes green over phases it never saw.
    assert.ok(verdict.phases.examined > 0, "the phase population is never empty");
    assert.equal(
      verdict.phases.withInSystem + verdict.phases.interventionOnly,
      verdict.phases.examined,
      "every phase either offers an in-system step or names only interventions",
    );
    assert.deepEqual(verdict.phases.exempt, ["launch_failed"], "the quarantine is the one declared debt");
  });

  test("a family that loses its step no longer compiles", () => {
    const family =
      /sentence\(labels\.problemRevisionConflictTitle, labels\.problemRevisionConflictDetail, RETRY_READ\)/u;
    const source = readFileSync(SOURCES.problemView, "utf8");
    assert.ok(family.test(source), "the revisionConflict family no longer reads as this case expects");
    // The copy lives beside the original so its relative imports resolve to the real modules.
    const target = join(WEB_ROOT, "src", ".red-proof-composed-problem-view.ts");
    writeFileSync(
      target,
      source.replace(family, "sentence(labels.problemRevisionConflictTitle, labels.problemRevisionConflictDetail)"),
      "utf8",
    );
    try {
      const options = typescript.parseJsonConfigFileContent(
        typescript.readConfigFile(join(WEB_ROOT, "tsconfig.json"), typescript.sys.readFile).config,
        typescript.sys,
        WEB_ROOT,
      ).options;
      const program = typescript.createProgram([target], { ...options, noEmit: true });
      const diagnostics = typescript
        .getPreEmitDiagnostics(program)
        .filter((diagnostic) => diagnostic.file !== undefined && resolve(diagnostic.file.fileName) === resolve(target))
        .map(
          (diagnostic) =>
            `TS${diagnostic.code} ${typescript.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
        );
      assert.ok(
        diagnostics.some((line) => line.includes("TS2554") && line.includes("Expected 3 arguments")),
        `the step is not required by the type: ${diagnostics.join(" | ") || "(no diagnostics)"}`,
      );
    } finally {
      rmSync(target, { force: true });
    }
  });

  test("a control id that names no marker is named, with the family that claims it", () => {
    // The pair is the anchor, not the bare id: `message-delete` is the step of more than one family
    // (`chat_regenerate_anchor_unavailable` took it first), and an injection that lands in another
    // family proves the reader over a family this case never meant.
    const problemView = mutated(SOURCES.problemView, "control-id.ts", [
      'id: "message-delete",\n    elsewhere: { said_as: "delete the message" },',
      'id: "message-del",\n    elsewhere: { said_as: "delete the message" },',
    ]);
    const finding = checkForwardPathOf({ problemView }).findings.find(
      (entry) => entry.code === "control_id_not_a_control",
    );
    assert.ok(finding, "expected control_id_not_a_control");
    assert.match(finding.detail, /tavern\/chat_swipe_last_variant/u);
    assert.match(finding.detail, /"message-del"/u);
  });

  test("a step said to be elsewhere whose sentence does not say it is named", () => {
    const problemView = mutated(SOURCES.problemView, "said-as.ts", [
      'said_as: "delete the message"',
      'said_as: "remove that reply"',
    ]);
    const finding = checkForwardPathOf({ problemView }).findings.find(
      (entry) => entry.code === "said_as_not_in_sentence",
    );
    assert.ok(finding, "expected said_as_not_in_sentence");
    assert.match(finding.detail, /chat_swipe_last_variant/u);
    assert.match(finding.detail, /problemChatSwipeLastVariantDetail/u);
  });

  test("a step reason outside the closed vocabulary is named", () => {
    const problemView = mutated(SOURCES.problemView, "vocabulary.ts", [
      'const HOST_RETRIES: ProblemStep = { kind: "self_heals", because: "host_retries" };',
      'const HOST_RETRIES: ProblemStep = { kind: "self_heals", because: "the_turn_finishes" };',
    ]);
    const findings = checkForwardPathOf({ problemView }).findings;
    assert.ok(
      findings.some((entry) => entry.code === "step_vocabulary" && entry.detail.includes("the_turn_finishes")),
      JSON.stringify(findings),
    );
  });

  test("a code with no family is a missing member, printed as a difference", () => {
    const tavernApi = mutated(SOURCES.tavernApi, "codes.ts", [
      "export const PROBLEM_CODES = [",
      'export const PROBLEM_CODES = [\n  "not_a_code_this_build_knows",',
    ]);
    const verdict = checkForwardPathOf({ tavernApi });
    assert.ok(
      verdict.findings.some(
        (entry) => entry.code === "step_missing" && entry.detail.includes("tavern/not_a_code_this_build_knows"),
      ),
      JSON.stringify(verdict.findings),
    );
    assert.match(verdict.difference, /- missing: \[tavern\/not_a_code_this_build_knows\]/u);
  });

  test("an empty population is blocked, never passed", () => {
    const verdict = checkForwardPathOf({
      tavernApi: emptyModule(
        "empty-api.ts",
        "export const PROBLEM_CODES = [];\nconst TURN_PROBLEM_CODES = [];\nconst PROVIDER_FAILURES = [];",
      ),
      gameApi: emptyModule("empty-game-api.ts", "export const GAME_PROBLEM_CODES = [];"),
    });
    assert.equal(verdict.status, "blocked", JSON.stringify(verdict.findings));
    assert.ok(verdict.findings.some((entry) => entry.code === "population_empty"));
  });

  test("a `self_heals` step whose reason the Host does not perform is named, with what is missing", () => {
    // The zombie turn, as the shape the gate can read: the turn is no longer reread durably, so nothing
    // settles a turn whose owner died, and "the Host is working, and it ends its own work" is an alibi.
    const turnRecovery = mutated(SOURCES.turnRecovery, "recovery.ts", [
      "  readTurn: () => Promise<ChatTurnLedger | null>,",
      "  readTurn: () => Promise<unknown>,",
    ]);
    const verdict = checkForwardPathOf({ turnRecovery });
    const finding = verdict.findings.find(
      (entry) => entry.code === "self_heals_without_evidence" && entry.detail.includes("tavern/turn_busy"),
    );
    assert.ok(finding, JSON.stringify(verdict.findings, null, 2));
    assert.match(finding.detail, /stillRunning/u, "the family that owns the sentence is named");
    assert.match(finding.detail, /no settlement rereads the turn durably/u, "the missing evidence is named");
    assert.equal(verdict.selfHeals.settlements.length, 0);
  });

  test("a reason this gate cannot read fails closed rather than passing on union membership", () => {
    const problemView = mutated(SOURCES.problemView, "unread-reason.ts", [
      'const HOST_RETRIES: ProblemStep = { kind: "self_heals", because: "host_retries" };',
      'const HOST_RETRIES: ProblemStep = { kind: "self_heals", because: "stream_resumes" };',
    ]);
    const findings = checkForwardPathOf({ problemView }).findings;
    assert.ok(
      findings.some(
        (entry) =>
          entry.code === "self_heals_without_evidence" &&
          entry.detail.includes("stream_resumes") &&
          entry.detail.includes("reads no event-stream resume path"),
      ),
      JSON.stringify(findings),
    );
  });

  test("a holding turn status with no reachable terminal is named", () => {
    const turnLedger = mutated(SOURCES.turnLedger, "ledger.ts", [
      "export type ChatTurnLedger =\n  | AcceptedQueuedTurn",
      'export type StrandedTurn = Readonly<{ turnId: string; status: "awaiting_provider"; }>;\n' +
        "export type ChatTurnLedger =\n  | StrandedTurn\n  | AcceptedQueuedTurn",
    ]);
    const verdict = checkForwardPathOf({ turnLedger });
    const finding = verdict.findings.find((entry) => entry.code === "hold_without_reachable_release");
    assert.ok(finding, JSON.stringify(verdict.findings, null, 2));
    assert.match(finding.detail, /turn_status\/awaiting_provider/u);
    assert.deepEqual(verdict.selfHeals.states.reaches.get("awaiting_provider"), []);
  });

  test("the states come from the union, and the split from the product's own terminal predicate", () => {
    const states = turnStates();
    assert.deepEqual(states.terminal, ["completed", "cancelled", "failed"]);
    assert.ok(states.holding.includes("running"), states.holding.join(","));
    for (const status of states.holding)
      assert.ok(states.reaches.get(status).length > 0, `${status} reaches no terminal`);
    // The `host_retries` codes are each held to their own evidence, so a reader that stopped finding the
    // settlement cannot leave them silently green.
    assert.ok(selfHealsEvidence().evidence.has("host_retries"));
  });

  test("a Game phase whose derivation offers nothing to press is named", () => {
    const lifecycle = mutated(SOURCES.lifecycle, "lifecycle.ts", [
      'return build("launching", {}, ["wait_for_game"]);',
      'return build("launching", {}, []);',
    ]);
    const findings = checkForwardPathOf({ lifecycle }).findings;
    assert.ok(
      findings.some(
        (entry) => entry.code === "phase_without_forward_action" && entry.detail.includes("phase/launching"),
      ),
      JSON.stringify(findings),
    );
  });

  test("a forward action the union does not declare is named", () => {
    const lifecycle = mutated(SOURCES.lifecycle, "lifecycle-union.ts", [
      'return build("launching", {}, ["wait_for_game"]);',
      'return build("launching", {}, ["wait_for_weather"]);',
    ]);
    const findings = checkForwardPathOf({ lifecycle }).findings;
    assert.ok(
      findings.some(
        (entry) =>
          entry.code === "phase_action_not_declared" &&
          entry.detail.includes('phase/launching offers "wait_for_weather"'),
      ),
      JSON.stringify(findings),
    );
  });
});

/**
 * The rule this gate was missing: a step that leaves the software is not a forward path on the
 * surface. A phase whose whole answer is one is a finding, and the one phase that needs the debt is
 * declared with the step it is owed and an expiry the tree decides.
 */
describe("check-fail-closed-forward-path · the phase's in-system step", () => {
  test("a phase whose whole answer leaves the software is named, on the shape a live run measured", () => {
    // `6a822da9^`: a crash and the player's own quit both reached a phase whose only step was the tray
    // quit, and a live run found a player with no button. The copy is HEAD's own file with those two
    // `build(...)` lines put back, so the vocabulary under test is today's and the shape is history's.
    const lifecycle = mutatedMany(SOURCES.lifecycle, "lifecycle-history.ts", [
      [
        'if (attemptEndedWithKnownOutcome(instance)) return build("ended_attempt_ready", {}, ["activate"]);',
        'if (instance.status === "crashed") return build("launch_failed", {}, ["restart_gamebuddy"]);\n' +
          '  if (instance.status === "stopped") return build("game_ended", {}, ["restart_gamebuddy"]);',
      ],
      [
        '  "launch_failed",\n  "ended_attempt_ready",\n  "game_not_read",',
        '  "launch_failed",\n  "game_ended",\n  "game_not_read",',
      ],
    ]);
    const verdict = checkForwardPathOf({ lifecycle });
    const finding = verdict.findings.find((entry) => entry.code === "phase_without_in_system_step");
    assert.ok(finding, JSON.stringify(verdict.findings, null, 2));
    assert.match(finding.detail, /phase\/game_ended/u);
    assert.match(finding.detail, /"restart_gamebuddy"/u, "the step it names is what leaves the software");
    assert.equal(verdict.status, "failed");
    assert.equal(verdict.phases.interventionOnly, 2, "game_ended joins the quarantined launch");
    assert.deepEqual(verdict.phases.exempt, ["launch_failed"], "only the declared debt is excused");
  });

  test("the declared debt expires when its phase gains an in-system step", () => {
    const lifecycle = mutated(SOURCES.lifecycle, "lifecycle-paid.ts", [
      'return build("launch_failed", {}, ["restart_gamebuddy"]);',
      'return build("launch_failed", {}, ["reread_game"]);',
    ]);
    const verdict = checkForwardPathOf({ lifecycle });
    const stale = verdict.findings.find((entry) => entry.code === "stale_intervention_only_exemption");
    assert.ok(stale, JSON.stringify(verdict.findings, null, 2));
    assert.match(stale.detail, /launch_failed/u);
    assert.match(stale.detail, /now names reread_game/u, "the step that paid the debt is named");
  });

  test("the declared debt expires when the Host stops declaring the trap it rests on", () => {
    // The entry's authority is the Host's own record: while `launch_quarantined` is trapped, a launch
    // whose outcome nobody knows has no egress inside the Host, so the phase has nothing to press.
    const trappedTerminals = mutated(SOURCES.trappedTerminals, "trapped-terminals.ts", [
      "    launch_quarantined:",
      "    launch_quarantine_proved:",
    ]);
    const verdict = checkForwardPathOf({ trappedTerminals });
    const stale = verdict.findings.find((entry) => entry.code === "stale_intervention_only_exemption");
    assert.ok(stale, JSON.stringify(verdict.findings, null, 2));
    assert.match(stale.detail, /launch_failed/u);
    assert.match(stale.detail, /STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS/u);
    assert.ok(
      verdict.findings.some(
        (entry) => entry.code === "phase_without_in_system_step" && entry.detail.includes("phase/launch_failed"),
      ),
      "with the trap disproved, the phase is a finding again rather than an excused dead end",
    );
  });

  test("the declared debt states the step it is owed and the Host terminal it rests on", () => {
    assert.ok(INTERVENTION_ONLY_DEBT.length > 0, "the debt is a declaration, not an empty list");
    for (const entry of INTERVENTION_ONLY_DEBT) {
      assert.ok(entry.needs.trim().length > 0, `${entry.phase} names no in-system step a player would need`);
      assert.ok(entry.trapped.trim().length > 0, `${entry.phase} names no Host terminal`);
    }
  });

  test("a step both halves declare is named, because whether a player can press it would be two answers", () => {
    const lifecycle = mutated(SOURCES.lifecycle, "lifecycle-double.ts", [
      'export type InSystemAction =\n  | "terminal"',
      'export type InSystemAction =\n  | "restart_gamebuddy"\n  | "terminal"',
    ]);
    const findings = checkForwardPathOf({ lifecycle }).findings;
    assert.ok(
      findings.some(
        (entry) =>
          entry.code === "phase_action_double_classified" &&
          entry.detail.includes("phase/launch_failed") &&
          entry.detail.includes('"restart_gamebuddy"'),
      ),
      JSON.stringify(findings),
    );
  });

  test("a tree whose in-system vocabulary is empty is blocked, never green", () => {
    const lifecycle = mutated(SOURCES.lifecycle, "lifecycle-no-in-system.ts", [
      "export type InSystemAction =",
      "export type InSystemAction = never;\nexport type UnusedInSystem =",
    ]);
    const verdict = checkForwardPathOf({ lifecycle });
    assert.equal(verdict.status, "blocked", JSON.stringify(verdict.findings));
    assert.ok(verdict.findings.some((entry) => entry.code === "in_system_vocabulary_empty"));
  });

  test("a tree that declares no phase is blocked, never green", () => {
    const verdict = checkForwardPathOf({
      lifecycle: emptyModule("empty-lifecycle.ts", "const GAME_SESSION_PHASES = [];"),
    });
    assert.equal(verdict.status, "blocked", JSON.stringify(verdict.findings));
    assert.ok(verdict.findings.some((entry) => entry.code === "phase_population_empty"));
  });
});
