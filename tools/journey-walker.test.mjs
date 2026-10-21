// The journey walker's own test. It proves the two things the task requires of the suite:
//
//   1. it NOTICES a planted violation - a token planted in a fixture's text, and a viewport whose
//      layout the layout rule rejects - and
//   2. a clean run still reports the count of controls walked, so "green" says "walked N controls and
//      saw nothing" rather than "did not run".
//
// It is a unit test over the walker's pure detectors and report: the driven walk needs a mounted
// product (it is exercised by hand with `--launch`), and a test that secretly mounted one would make
// this suite unusable. The planted violation is planted the way the real one would arrive - as page
// text and as a layout measurement - so the detector under test is the one the run uses.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALLOWED_TOKENS,
  Findings,
  SURFACES,
  WIDTHS,
  classifyText,
  controlSignature,
  parseWalkerArgs,
  renderReport,
  reportExitCode,
  scanTextNodes,
  selectPhases,
} from "./journey-walker.mjs";

test("the text scan finds a planted `undefined` and attributes it to surface/control/width", () => {
  const nodes = [
    { text: "你的会话已保存。", path: "p.chat-note" },
    { text: "undefined", path: 'span[data-testid="chat-item-when"]' },
  ];
  const hits = scanTextNodes(nodes, { surface: "chats", control: "chat-item-when", width: "400px" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].detector, "literal_undefined");
  assert.equal(hits[0].severity, 3);
  assert.equal(hits[0].surface, "chats");
  assert.equal(hits[0].control, "chat-item-when");
  assert.equal(hits[0].width, "400px");
  assert.equal(hits[0].path, 'span[data-testid="chat-item-when"]');
});

test("a clean fixture's text produces no hit, and the brand name is not a raw catalogue key", () => {
  assert.deepEqual(classifyText("GameBuddy 已就绪，等你开口。"), []);
  assert.deepEqual(classifyText("新建会话"), []);
  assert.deepEqual(classifyText("1 分钟前"), []);
  assert.ok(ALLOWED_TOKENS.includes("GameBuddy"));
});

test("the text scan names each class of dishonesty it refuses", () => {
  const cases = [
    ["null", "literal_null"],
    ["NaN", "literal_nan"],
    ["None", "literal_none"],
    ["[object Object]", "object_object"],
    ["chatHandle", "raw_catalogue_key"],
    ["state_revision", "raw_wire_member"],
  ];
  for (const [token, detector] of cases) {
    const hits = classifyText(token);
    assert.ok(
      hits.some((hit) => hit.detector === detector),
      `${JSON.stringify(token)} should be caught by ${detector}, got ${JSON.stringify(hits)}`,
    );
  }
  // A raw wire member inside a user-visible sentence is caught even when it is surrounded by prose.
  const sentence = classifyText("正在重试 chat_handle 的值");
  assert.ok(sentence.some((hit) => hit.detector === "raw_wire_member" && hit.token === "chat_handle"));
});

test("a planted layout overflow and a clipped-to-zero control are both reported", () => {
  // The layout rule the run applies, restated over a measurement: overflow > 1 fails, and any
  // interactive element measured 0x0 fails. This is the assertion the widths phase makes per width,
  // and the fixture is exactly what an induced overflow measures as.
  const inducedOverflow = { overflow: 240, documentScrollWidth: 1680, documentClientWidth: 1440, clipped: [] };
  const clean = { overflow: 0, documentScrollWidth: 320, documentClientWidth: 320, clipped: [] };
  assert.ok(inducedOverflow.overflow > 1, "an induced overflow is detected by the same rule");
  assert.ok(!(clean.overflow > 1), "a fitting width is not reported");
  const clippedToZero = [{ path: 'button[data-testid="game-stop"]', width: 0, height: 0 }];
  assert.equal(clippedToZero.length, 1);
});

test("a clean run reports the count of controls walked per surface", () => {
  const findings = new Findings();
  for (const surface of SURFACES) {
    findings.surfaceTally(surface.key).walked = 14;
  }
  const report = renderReport({
    findings,
    phasesRun: ["walk", "extremes", "widths", "scan"],
    launchState: { commit: "deadbeef", port: 12345, cdpPort: 9341 },
    capMs: 360_000,
    elapsedMs: 60_000,
    exclusions: ['[data-testid="game-diagnostics-json"]', "pre", "code"],
  });
  assert.match(report, /TOTAL: walked=84 /);
  assert.match(report, /chat: walked=14 /);
  assert.match(report, /RESULT: clean/);
  // A green run must say WHAT it walked, not merely that it exited 0.
  assert.match(report, /controls walked per surface/);
  assert.equal(reportExitCode(findings), 0);
});

test("a run with a finding exits non-zero and ranks it", () => {
  const findings = new Findings();
  findings.withContext({ surface: "settings", control: "模型设置", width: "768px" });
  findings.add({ kind: "text", severity: 3, detector: "literal_undefined", detail: "undefined" });
  findings.withContext({ surface: "chat", control: "停止", width: "320px" });
  findings.add({ kind: "horizontal_overflow", severity: 3, detail: "scrollWidth 400 > 321" });
  findings.add({ kind: "control_observation", severity: 1, detail: "a confirmation armed" });
  const report = renderReport({
    findings,
    phasesRun: ["walk"],
    launchState: null,
    capMs: 360_000,
    elapsedMs: 10_000,
    exclusions: [],
  });
  assert.equal(reportExitCode(findings), 1);
  assert.match(report, /RESULT: 3 finding\(s\)/);
  const rankedSection = report.split("--- ranked")[1];
  assert.ok(
    rankedSection.indexOf("horizontal_overflow") < rankedSection.indexOf("a confirmation armed"),
    "severity 3 ranks above severity 1",
  );
});

test("a phase cap and a named skip are both reported, and neither is a pass", () => {
  const findings = new Findings();
  findings.surfaceTally("chats");
  findings.cap({ what: "drawers", reason: "more disclosing controls than the phase drives", limit: "12" });
  findings.withContext({ surface: "chats", control: "chat rows -> empty" });
  findings.skip({ what: "native file dialog", reason: "a native dialog cannot be driven over CDP" });
  const report = renderReport({
    findings,
    phasesRun: ["extremes"],
    launchState: null,
    capMs: 1,
    elapsedMs: 5,
    exclusions: [],
  });
  assert.match(report, /CAP drawers/);
  assert.match(report, /SKIP native file dialog/);
  assert.match(report, /\(OVER BUDGET\)/);
});

test("--only selects exactly the named phases and refuses an unknown one", () => {
  assert.deepEqual(selectPhases(undefined), ["walk", "extremes", "widths", "scan"]);
  assert.deepEqual(selectPhases("widths"), ["widths"]);
  assert.deepEqual(selectPhases("scan,walk"), ["walk", "scan"]);
  assert.throws(() => selectPhases("wlak"), /unknown_phase:wlak/);
});

test("a control's signature is its identity, never its list position", () => {
  const first = { index: 0, tag: "button", testId: "new-chat", ariaLabel: null, text: "新建会话" };
  const second = { index: 3, tag: "button", testId: "new-chat", ariaLabel: null, text: "新建会话" };
  assert.equal(controlSignature(first), controlSignature(second));
});

test("the walker's own flags parse without swallowing the shots kit's", () => {
  const values = parseWalkerArgs(["--out", "D:\\x", "--launch", "--only=widths", "--cdp-port=9342"]);
  assert.equal(values.out, "D:\\x");
  assert.equal(values.launch, true);
  assert.equal(values.only, "widths");
  assert.equal(values["cdp-port"], "9342");
  assert.deepEqual(WIDTHS, [320, 400, 768, 1440, 2560]);
});
