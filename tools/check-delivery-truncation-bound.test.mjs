/**
 * The falsifiers for `check-delivery-truncation-bound.mjs`: every finding it can produce, turned red on purpose.
 *
 * <p>
 * WHY THIS SUITE EXISTS. `maxChars: 80` shipped through a green tree: the delivery cut 18 turns' tails on `round62` and
 * the only guard was a prompt sentence saying the same number, so the two agreed with each other and neither agreed with
 * the wire. A gate that reads where a bound's number came from is only worth its licence if it fires on the bound that was
 * there - so the first case below is that exact line, and the rest are the shapes a future tree could take: a second
 * budget, a bound hidden behind a local constant (which must PASS, or the gate would forbid any indirection), a wire whose
 * two declarations disagree, and a bubble that lost its clamp.
 * </p>
 *
 * <p>
 * Every case builds a throwaway tree at the REAL repository-relative paths and runs the gate against it with `--root`, so
 * the gate resolves the product's own file names and the suite never edits the working tree.
 * </p>
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BOUND_RULES,
  BUBBLE_CLAMP,
  readDeliveryBounds,
  TRANSPORT_CONSTANT,
  TRANSPORT_DECLARATIONS,
} from "./check-delivery-truncation-bound.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const readReal = (path) => readFileSync(join(REPOSITORY_ROOT, ...path.split("/")), "utf8");

/** Every file the gate reads, at its real path, copied into a throwaway tree. */
const GATE_FILES = Object.freeze([
  "host/src/companion-presentation-transport.ts",
  "host/src/companion-delivery-pacing.ts",
  "host/src/protocol.ts",
  ...TRANSPORT_DECLARATIONS.map((declaration) => declaration.path),
  BUBBLE_CLAMP.path,
]);

const REAL = Object.freeze(Object.fromEntries(GATE_FILES.map((path) => [path, readReal(path)])));
const PACING = "host/src/companion-delivery-pacing.ts";
const TRANSPORT_MODULE = "host/src/companion-presentation-transport.ts";

/** A throwaway tree holding the real files, with `overrides` written over them. */
function withFixtureRoot(overrides, run) {
  const root = mkdtempSync(join(tmpdir(), "delivery-bound-"));
  try {
    for (const path of GATE_FILES) {
      const absolute = join(root, ...path.split("/"));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, overrides[path] ?? REAL[path]);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const codes = (reading) => reading.violations.map((violation) => violation.code);

/** The real tree's own reading: the premise every case below departs from. */
const REAL_READING = readDeliveryBounds(REPOSITORY_ROOT);

test("the tree's own delivery takes its ceiling from the transport, and the gate says so with the populations it read", () => {
  assert.ok(REAL_READING.examined > 0, `blocked: no bound was examined. ${JSON.stringify(REAL_READING.bounds)}`);
  assert.equal(
    REAL_READING.handPicked,
    0,
    `a hand-picked bound is in the tree: ${JSON.stringify(REAL_READING.bounds)}`,
  );
  assert.ok(REAL_READING.transport > 0, "the delivery's one budget must resolve to the transport's declaration");
  assert.deepEqual(REAL_READING.violations, []);
  assert.ok(REAL_READING.wire.agrees, "the three transport declarations must agree before a bound can be judged");
  assert.ok(REAL_READING.clamp.present, "the bubble's own clamp is what makes a delivery cut below the wire pointless");
});

test("the bound this unit deleted is red, and the finding names it as it is written", () => {
  const injected = REAL[PACING].replace(`maxChars: ${TRANSPORT_CONSTANT}`, "maxChars: 80");
  assert.notEqual(injected, REAL[PACING], "the fixture must really restore the 80 this gate exists for");
  withFixtureRoot({ [PACING]: injected }, (root) => {
    const reading = readDeliveryBounds(root);
    assert.ok(
      codes(reading).includes(BOUND_RULES.handPicked.code),
      `maxChars: 80 must be a finding: ${JSON.stringify(reading.violations)}`,
    );
    const finding = reading.violations.find((violation) => violation.code === BOUND_RULES.handPicked.code);
    assert.match(finding.detail, /maxChars: 80/u, "the finding must name the bound as the source writes it");
    assert.equal(reading.handPicked, 1);
  });
});

test("a bound declared through a local constant still resolves, so indirection is not itself a finding", () => {
  // `const SOME_CEILING = MAX_...` is what a layering refactor produces; the gate must follow it rather than refuse it.
  const injected = REAL[PACING]
    .replace(`maxChars: ${TRANSPORT_CONSTANT}`, "maxChars: SOME_CEILING")
    .replace(
      `export const GAME_DELIVERY_PACING`,
      `const SOME_CEILING = ${TRANSPORT_CONSTANT};\n\nexport const GAME_DELIVERY_PACING`,
    );
  assert.notEqual(injected, REAL[PACING], "the fixture must really route the number through a constant");
  withFixtureRoot({ [PACING]: injected }, (root) => {
    const reading = readDeliveryBounds(root);
    assert.deepEqual(
      reading.violations,
      [],
      `a transport-derived constant is not a hand-picked bound: ${JSON.stringify(reading.violations)}`,
    );
    assert.equal(reading.declared, 1, "and it is reported as the INDIRECTION it is, not as the transport itself");
  });
});

test("a number hidden behind a constant that is itself a literal is still hand-picked", () => {
  const injected = REAL[PACING]
    .replace(`maxChars: ${TRANSPORT_CONSTANT}`, "maxChars: SOME_CEILING")
    .replace(`export const GAME_DELIVERY_PACING`, "const SOME_CEILING = 80;\n\nexport const GAME_DELIVERY_PACING");
  assert.notEqual(injected, REAL[PACING], "the fixture must really hide the literal");
  withFixtureRoot({ [PACING]: injected }, (root) => {
    const reading = readDeliveryBounds(root);
    assert.ok(
      codes(reading).includes(BOUND_RULES.handPicked.code),
      `80 behind a local name is still 80: ${JSON.stringify(reading.violations)}`,
    );
  });
});

test("a second length budget is a finding even when both numbers are the transport's", () => {
  const injected = `${REAL[PACING]}\nexport const SECOND_PACING = Object.freeze({ lengthBudget: Object.freeze({ maxChars: ${TRANSPORT_CONSTANT} }) });\n`;
  withFixtureRoot({ [PACING]: injected }, (root) => {
    const reading = readDeliveryBounds(root);
    assert.ok(
      codes(reading).includes(BOUND_RULES.secondBudget.code),
      `two budgets that agree today are a disagreement scheduled for later: ${JSON.stringify(reading.violations)}`,
    );
  });
});

test("a wire whose declarations disagree blocks, because no bound can be judged against two numbers", () => {
  const injected = REAL["integrations/stardew/BridgeSession.cs"].replace(
    /MaximumPresentationTextLength = 4_000;/u,
    "MaximumPresentationTextLength = 4_000_000;",
  );
  assert.notEqual(
    injected,
    REAL["integrations/stardew/BridgeSession.cs"],
    "the fixture must really move the Mod's bound",
  );
  withFixtureRoot({ "integrations/stardew/BridgeSession.cs": injected }, (root) => {
    const reading = readDeliveryBounds(root);
    assert.ok(codes(reading).includes(BOUND_RULES.disagree.code), JSON.stringify(reading.violations));
  });
});

test("a Host declaration nothing reads is a finding, or the copy is prose", () => {
  const injected = REAL["host/src/protocol.ts"].replaceAll(TRANSPORT_CONSTANT, "4_000");
  assert.notEqual(injected, REAL["host/src/protocol.ts"], "the fixture must really restate the number beside it");
  withFixtureRoot({ "host/src/protocol.ts": injected }, (root) => {
    const reading = readDeliveryBounds(root);
    assert.ok(
      codes(reading).includes(BOUND_RULES.unread.code),
      `a second spelling of the transport's number in the validator is what this gate is for: ${JSON.stringify(reading.violations)}`,
    );
  });
});

test("a bubble that lost its clamp is a finding, because the `…` is what makes the delivery's cut pointless", () => {
  const injected = REAL[BUBBLE_CLAMP.path].replace('internal const string Ellipsis = "…";', "");
  assert.notEqual(injected, REAL[BUBBLE_CLAMP.path], "the fixture must really remove the clamp marker");
  withFixtureRoot({ [BUBBLE_CLAMP.path]: injected }, (root) => {
    const reading = readDeliveryBounds(root);
    assert.ok(
      codes(reading).includes(BOUND_RULES.clampMissing.code),
      `a bubble that stops marking its own overflow leaves the Host no reason to believe it clamps: ${JSON.stringify(reading.violations)}`,
    );
    assert.equal(reading.clamp.present, false);
  });
});

test("a tree whose delivery declares no bound blocks instead of passing on an empty population", () => {
  const injected = REAL[PACING].replace(
    `  lengthBudget: Object.freeze({ maxChars: ${TRANSPORT_CONSTANT} }),`,
    "  lengthBudget: null,",
  );
  assert.notEqual(injected, REAL[PACING], "the fixture must really declare no bound");
  withFixtureRoot({ [PACING]: injected }, (root) => {
    const reading = readDeliveryBounds(root);
    assert.ok(codes(reading).includes(BOUND_RULES.noBound.code), JSON.stringify(reading.violations));
    assert.equal(reading.examined, 0, "and the census says nothing was examined rather than reporting a clean zero");
  });
});

test("the transport module is where the delivery's number comes from, so the gate reads it as a producer", () => {
  const reading = readDeliveryBounds(REPOSITORY_ROOT);
  assert.deepEqual(
    reading.wire.readings.map((entry) => entry.producer).sort(),
    ["host", "mod", "schema"],
    "the three producers, read by name from the files that own them",
  );
  assert.equal(reading.wire.value, 4_000, "the wire's ceiling today, read from the producers rather than typed here");
  assert.ok(REAL[TRANSPORT_MODULE].includes(TRANSPORT_CONSTANT));
});
