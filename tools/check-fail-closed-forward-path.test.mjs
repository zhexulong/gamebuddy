#!/usr/bin/env node
/**
 * The falsifier of `tools/check-fail-closed-forward-path.mjs`.
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
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkForwardPath, checkForwardPathOf, SOURCES } from "./check-fail-closed-forward-path.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = join(ROOT, "dialogue-web");
const typescript = createRequire(join(WEB_ROOT, "package.json"))("typescript");

const scratch = mkdtempSync(join(tmpdir(), "forward-path-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A copy of one product file with one injected edit, in a directory this run owns. */
function mutated(source, name, [from, to]) {
  const text = readFileSync(source, "utf8");
  assert.ok(
    text.includes(from),
    `${source} no longer contains ${JSON.stringify(from)}, so this injection cannot be made`,
  );
  const target = join(scratch, name);
  writeFileSync(target, text.replace(from, to), "utf8");
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
    const problemView = mutated(SOURCES.problemView, "control-id.ts", ['id: "message-delete"', 'id: "message-del"']);
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
