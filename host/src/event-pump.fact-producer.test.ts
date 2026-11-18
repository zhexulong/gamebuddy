import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  CompanionEventPump,
  FACT_PRODUCER,
  FACT_PRODUCERS,
  TURN_OPENING,
  NOT_OWED,
  type WorldFact,
} from "./event-pump.js";

/**
 * `fact_producer_is_declared`: the producer of a fact is a DECLARED name, and the declaration is the call sites.
 *
 * <p>
 * THE DEFECT THIS EXISTS FOR. `GAME_TURN_ACCOUNT` counted turns by REASON, so `round56` printed `world_fact: 28` of 31
 * turns and could not say which of the eleven ways a fact reaches this pump produced one of them; `flushes examined 655`
 * had no cause field at all. Both readings were answered by opening `event-pump.ts` and following `enqueueFact`, which is
 * the shape four other defects closed today: a fact with no single declared origin.
 * </p>
 * <p>
 * THE POPULATION IS THE PRODUCTION SOURCE TREE, scanned for `enqueueFact(` and `acceptHostMintedFact(` - the two doors a
 * fact comes in by. A call must name `FACT_PRODUCER.<member>`, or forward the ONE declared parameter `producedBy` from a
 * route that carries several producers (`acceptHostMintedFact`). Everything else is named: a call with no producer, a call
 * forwarding some other identifier, and a declared producer no call site states.
 * </p>
 * <p>
 * THE COMPILER ALREADY REFUSES THE FIRST OF THOSE (`enqueueFact` demands a `FactProducer`), and that is not a reason to
 * skip it here: the scan is what proves the SPACE of entrances is the declared list rather than whatever compiles, and it
 * is the half of the gate the compiler cannot see - a producer declared and never used is perfectly legal TypeScript and
 * a dead entry in a closed set.
 * </p>
 */

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Files that are not production: a test's pump is driven by a fixture, not by an ingress. */
function isProductionSource(path: string): boolean {
  if (path.endsWith(".test.ts") || path.endsWith(".test-support.ts") || path.endsWith(".test-fixtures.ts"))
    return false;
  if (path.includes("/test-fixtures/") || path.includes("\\test-fixtures\\")) return false;
  if (path.includes("/test-fixtures") && !path.endsWith(".ts")) return false;
  return path.endsWith(".ts");
}

/** Every production source under `host/src`, keyed by its repo-relative path. */
function productionSources(root: string): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  for (const entry of readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })) {
    const path = join(root, "src", entry);
    if (!isProductionSource(entry)) continue;
    sources.set(`src/${entry.replaceAll("\\", "/")}`, readFileSync(path, "utf8"));
  }
  return sources;
}

/**
 * The routes a fact travels on its way to the pump: one hop each, and each hop's signature demands the producer.
 *
 * `enqueueFact` is the pump's own entrance, `acceptHostMintedFact` the Host's route for the facts it mints itself, and
 * `announceHostFact` the materializer's late-bound alias for it (the Host service does not exist when the tools and the
 * refresh port are built). A call to any of the three without a producer is `fact_without_a_declared_producer`, and the
 * signature of each hop is what makes a missing producer a compile error rather than only a finding.
 */
const FACT_DOORS = new Set(["enqueueFact", "acceptHostMintedFact", "announceHostFact"]);

/** Whether a call forwards the one allowed parameter instead of naming a producer. */
function forwardsDeclaredParameter(site: ts.CallExpression, sources: ts.SourceFile): boolean {
  const forwarded = site.arguments[1];
  if (forwarded === undefined || !ts.isIdentifier(forwarded) || forwarded.text !== "producedBy") return false;
  for (let node: ts.Node | undefined = site.parent; node !== undefined; node = node.parent) {
    if (
      ts.isMethodDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    )
      return node.parameters.some(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === "producedBy",
      );
  }
  void sources;
  return false;
}

type FactProducerFinding = Readonly<{
  examined: number;
  sites: number;
  forwarding: number;
  violations: readonly string[];
  blocked: string | null;
}>;

/** The gate. `declared` is `FACT_PRODUCER`; a falsifier may hand it one member more than the tree states. */
function factProducerGate(
  sources: ReadonlyMap<string, string>,
  declared: Readonly<Record<string, string>>,
): FactProducerFinding {
  if (sources.size === 0) return { examined: 0, sites: 0, forwarding: 0, violations: [], blocked: "zero_population" };
  const violations: string[] = [];
  const stated = new Set<string>();
  let sites = 0;
  let forwarding = 0;
  for (const [path, text] of sources) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : ts.isIdentifier(node.expression)
            ? node.expression.text
            : "";
        if (FACT_DOORS.has(callee)) {
          sites += 1;
          const named = node.arguments[1];
          const producer = named !== undefined && ts.isPropertyAccessExpression(named) ? named.getText(source) : "";
          if (named !== undefined && /^FACT_PRODUCER\.\w+$/u.test(producer)) {
            stated.add(producer.slice("FACT_PRODUCER.".length));
          } else if (forwardsDeclaredParameter(node, source)) {
            forwarding += 1;
          } else {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            violations.push(`fact_without_a_declared_producer:${path}:${String(line + 1)}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const [member, value] of Object.entries(declared))
    if (!stated.has(member)) violations.push(`producer_without_a_caller:${value}`);
  return { examined: sources.size, sites, forwarding, violations: Object.freeze(violations), blocked: null };
}

test("fact_producer_is_declared: every fact entrance names a declared producer, and every producer has one", () => {
  const sources = productionSources(hostRoot);
  const finding = factProducerGate(sources, FACT_PRODUCER);
  assert.equal(finding.blocked, null, "a gate that examined nothing agrees with itself");
  assert.deepEqual(finding.violations, [], "a fact with no declared producer, or a producer with no call site");
  assert.equal(
    finding.sites,
    FACT_PRODUCERS.length + finding.forwarding,
    "the declared producers ARE the leaf entrances: every member of the closed set is stated by exactly one call site, " +
      "and the only entrance that does not name one is the route that carries several",
  );
  console.log(
    `fact producer gate: examined ${String(finding.examined)} production sources · ${String(finding.sites)} entrances ` +
      `(${String(finding.forwarding)} forwarding) · ${String(FACT_PRODUCERS.length)} declared producers: ${FACT_PRODUCERS.join(", ")}`,
  );
});

test("fact_producer_is_declared: a call site that states no producer is named, and the gate is red on it", () => {
  // THE FALSIFIER, on the real tree: one planted entrance, and the finding names the file and the line rather than the
  // count. This is the defect a `pump.enqueueFact(fact)` would be if the compiler's half were ever bypassed.
  const sources = new Map(productionSources(hostRoot));
  sources.set(
    "src/planted-entrance.ts",
    `export function planted(pump: CompanionEventPump, fact: WorldFact): void {\n  pump.enqueueFact(fact);\n}\n`,
  );
  const finding = factProducerGate(sources, FACT_PRODUCER);

  assert.deepEqual(finding.violations, ["fact_without_a_declared_producer:src/planted-entrance.ts:2"]);
});

test("fact_producer_is_declared: a producer with no caller is named, and the gate is red on it", () => {
  // The other half, and the half no compiler can see: a member of the closed set that no call site states is a dead
  // entrance, and a run whose reading said `six producers` would be counting a list rather than a tree.
  const finding = factProducerGate(productionSources(hostRoot), {
    ...FACT_PRODUCER,
    imaginedEntrance: "imagined_entrance",
  });

  assert.deepEqual(finding.violations, ["producer_without_a_caller:imagined_entrance"]);
});

test("fact_producer_is_declared: forwarding is allowed only for the one declared parameter", () => {
  const sources = new Map(productionSources(hostRoot));
  sources.set(
    "src/planted-forward.ts",
    `export function planted(pump: CompanionEventPump, fact: WorldFact, other: string): void {\n` +
      `  pump.enqueueFact(fact, other as never);\n` +
      `}\n`,
  );
  const finding = factProducerGate(sources, FACT_PRODUCER);

  assert.deepEqual(
    finding.violations,
    ["fact_without_a_declared_producer:src/planted-forward.ts:2"],
    "an identifier that is not a `producedBy` parameter of the enclosing route is not a statement of who produced the fact",
  );
});

test("fact_producer_is_declared: zero population is blocked, never green", () => {
  const finding = factProducerGate(new Map(), FACT_PRODUCER);
  assert.equal(finding.blocked, "zero_population");
  assert.deepEqual(finding.violations, [], "nothing examined is not nothing wrong");
});

/** A world fact as the Mod publishes one, so the entry beside it is the only thing under test. */
function milestone(at: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: `milestone_${String(at)}`,
    sourceEventId: `milestone_${String(at)}`,
    correlationId: `milestone_${String(at)}`,
    revision: 1,
    occurredAtMs: at,
    semanticKind: "time_milestone",
    payload: Object.freeze({ milestone: at }),
  });
}

function reading(revision: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot" as const,
    correlationId: `snapshot_${String(revision)}`,
    revision,
    payload: Object.freeze({ location: "Farm", timeOfDay: 600, revision }),
  });
}

function recordingSink(): { deliver(batch: unknown): Promise<void> } {
  return { async deliver() {} };
}

test("the account says WHICH entrance opened a turn, not only that a fact did", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact(milestone(600), FACT_PRODUCER.adapterIngress);
  await pump.flush(recordingSink());

  const account = pump.turnAccount;
  assert.equal(account.byReason[TURN_OPENING.worldFact], 1);
  assert.equal(
    account.openedByProducer[TURN_OPENING.worldFact][FACT_PRODUCER.adapterIngress],
    1,
    "a turn opened by the Mod's own milestone is attributed to the adapter's ingress",
  );
  assert.equal(
    account.openedByProducer[TURN_OPENING.worldFact][FACT_PRODUCER.snapshotRestate],
    0,
    "and not to the Host re-stating a reading it already had, which is the distinction `world_fact: 28` could not make",
  );
});

test("the account says WHICH entrance a suppressed flush was suppressed for", async () => {
  const pump = new CompanionEventPump();
  // The reading arrives from the adapter and decides nothing on its own: it is standing state, and it is the pump's first
  // reading, so the reason names a reading that moved (`observation_moved`).
  pump.enqueueFact(reading(14), FACT_PRODUCER.adapterIngress);
  await pump.flush(recordingSink());

  const held = pump.turnAccount;
  assert.equal(held.notOwed[NOT_OWED.observationMoved], 1);
  assert.equal(
    held.notOwedByProducer[NOT_OWED.observationMoved][FACT_PRODUCER.adapterIngress],
    1,
    "the flush that held the adapter's reading names the adapter as the producer of the reading it held",
  );

  // The Host re-states the same reading before every batch it composes; that copy is the one a run has to be able to
  // count, because it is the copy the Host, not the world, put there. A copy is a RE-STATEMENT only of something she was
  // given, so one turn has to hand the reading over first: a reading nobody was shown is standing state she has not
  // received, and `observation_moved` is the honest member for it.
  pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_restate",
    text: "嗯。",
    locale: "zh-CN",
    timestampMs: 2,
  });
  await pump.flush(recordingSink());
  pump.enqueueFact(reading(14), FACT_PRODUCER.snapshotRestate);
  await pump.flush(recordingSink());

  const restated = pump.turnAccount;
  assert.equal(restated.notOwed[NOT_OWED.observationRestated], 1);
  assert.equal(
    restated.notOwedByProducer[NOT_OWED.observationRestated][FACT_PRODUCER.snapshotRestate],
    1,
    "and the re-stated copy is attributed to the Host's own refresh, not to the world it copied",
  );
});

test("a decision no fact made carries no producer, and the account says so rather than inventing one", async () => {
  const pump = new CompanionEventPump();
  pump.enqueuePlayerInput({ source: "player_text", inputId: "input_1", text: "hello", locale: "en", timestampMs: 1 });
  await pump.flush(recordingSink());

  const asked = pump.turnAccount;
  assert.equal(asked.byReason[TURN_OPENING.playerInput], 1);
  assert.deepEqual(
    Object.values(asked.openedByProducer[TURN_OPENING.playerInput]).filter((count) => count > 0),
    [],
    "a person's word is not a fact: no entrance is credited with the turn it opened",
  );

  const empty = new CompanionEventPump();
  await empty.flush(recordingSink());
  assert.equal(empty.turnAccount.notOwed[NOT_OWED.nothingPending], 1);
  assert.deepEqual(
    Object.values(empty.turnAccount.notOwedByProducer[NOT_OWED.nothingPending]).filter((count) => count > 0),
    [],
    "and an empty window names no producer either - the reason's own count is the whole reading",
  );
});
