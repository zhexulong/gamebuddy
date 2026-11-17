import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * `liveness_measured_by_fact_traffic:<site>` - is an execution still alive, answered by the wrong clock?
 *
 * <p>
 * THE DEFECT, AND WHY IT IS A CLASS. `EXECUTION_STALL_BOUND_MS` decided "this execution is stalled" from
 * `Date.now() - lastFactAtMs`: a wall-clock scalar answering a question with four answers - running, waiting for the
 * engine, stalled, gone. Every one of those has an owner that can state it: the programme's own journal says what is
 * still running (`readInFlightProgrammes`), and the body controller says what it is waiting for (its `stalled_waiting`
 * verdict, with `reason` and `stalled_ticks` beside it). A distance since the last fact has no owner, so it answers all
 * four with the only thing it can see.
 * </p>
 * <p>
 * MEASURED 2026-11-17: the Mod stopped emitting body traces, so the traffic that re-armed that bound thinned out - and the
 * same bound that had read silence as "stalled" then read ordinary work as "stalled" on its next re-arm. That is the tell
 * of the wrong authority: the same scalar was loudly right and loudly wrong in two consecutive runs with the product
 * unchanged.
 * </p>
 * <p>
 * THE POPULATION IS THE SOURCE, parsed by the compiler (not grep): every declaration in `event-pump.ts` and
 * `host-service.ts` that NAMES a stall or a liveness, or whose body measures a wall-clock distance from a recorded
 * arrival while speaking about an execution. Each one must DECLARE which authority answers it, and there is no "traffic"
 * declaration to make - the two authorities are the only two that exist, so a member that reads neither fails here by
 * name. A declaration that outlives its member fails too: an exemption that has stopped applying must be removed.
 * </p>
 */

const HOST_SRC = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "src");

/** The two files this class has been measured in; a third would be named here rather than scanned for. */
const SOURCES = ["event-pump.ts", "host-service.ts"] as const;

/** What a declaration must READ to answer with the programme's own state: the journal ledger. */
const JOURNAL_READ = /readInFlightProgrammes|#readInFlight/u;

/**
 * What a declaration must read to answer with a statement the MOD made about the body.
 *
 * Three spellings of one thing, and every one of them is authored by the Mod: its `stalled_waiting` verdict (and the
 * constant that names it), the standing verdict record the pump keeps of it, the pump's relay of that record
 * (`takeStallFact`), and its `body_owned_by_*` refusal - which is the Mod saying who holds the body, and therefore what
 * would release it.
 */
const MOD_STATEMENT_READ =
  /stalled_waiting|MOD_STALL_VERDICT_CODE|#stallVerdicts|modStallVerdictOf|takeStallFact|#worldTransition/u;
type LivenessAuthority = "state" | "verdict";

/** The authority behind one declaration, and why reading it is the answer. */
type LivenessDeclaration = Readonly<{ authority: LivenessAuthority; why: string }>;

/**
 * The declarations of this class, keyed `file:name`, each with the authority it reads.
 *
 * `state`   - it asks the programme's own journal what is still running (`readInFlightProgrammes`).
 * `verdict` - it relays the Mod's own verdict, with the reason and the wait the body controller measured.
 *
 * The assertion below checks the DECLARATION against the code (a `state` member must call the journal, a `verdict` member
 * must read the Mod's verdict), so a declaration cannot be a label someone typed: it is a claim the source has to support.
 */
const LIVENESS_AUTHORITY: Readonly<Record<string, LivenessDeclaration>> = Object.freeze({
  "event-pump.ts:MOD_STALL_VERDICT_CODE": {
    authority: "verdict",
    why: "the Mod's own token for `this execution is waiting` (`StalledWaiting` on its body controller), not a duration",
  },
  "event-pump.ts:EXECUTION_STALL_SEMANTIC_KIND": {
    authority: "verdict",
    why: "the kind of the fact the Host mints FROM that verdict; the decision is the body controller's",
  },
  "event-pump.ts:ModStallVerdict": {
    authority: "verdict",
    why: "the shape of one standing verdict: the Mod's reason and the Mod's wait, converted once from its own ticks",
  },
  "event-pump.ts:StandingStallVerdict": {
    authority: "verdict",
    why: "the record of one standing verdict, with the identity of the Mod statement that stated it",
  },
  "event-pump.ts:ExecutionLivenessReading": {
    authority: "state",
    why: "the reading: the journal's in-flight programmes beside the Mod's standing verdicts, and no clock at all",
  },
  "event-pump.ts:#stallVerdicts": {
    authority: "verdict",
    why: "the verdicts standing now, drained by each execution's terminal receipt rather than by a timer",
  },
  "event-pump.ts:#stallFacts": {
    authority: "verdict",
    why: "how many stall facts were minted from verdicts: the account's `stalled N`",
  },
  "event-pump.ts:#stallReasons": {
    authority: "verdict",
    why: "those facts by the Mod's own reason (`entity_block`): the account's `{reason: count}`",
  },
  "event-pump.ts:STALLED": {
    authority: "verdict",
    why: "the account label of that reading, named once so the printer and a reader of the line cannot disagree",
  },
  "event-pump.ts:executionLiveness": {
    authority: "state",
    why: "the reading itself: it asks the journal what is running and reports the verdicts that are standing",
  },
  "event-pump.ts:takeStallFact": {
    authority: "verdict",
    why: "it announces the Mod's verdict once, and only while the journal still shows that programme in flight",
  },
  "event-pump.ts:#observeExecutionLiveness": {
    authority: "verdict",
    why: "the one place the verdict is recorded and drained on the execution's terminal receipt; it reads no clock",
  },
  "event-pump.ts:#stallEndsOwnershipWith": {
    authority: "verdict",
    why: "what the Mod's own refusal named as holding the body (`owner_action`), never a Host guess",
  },
  "event-pump.ts:modStallVerdictOf": {
    authority: "verdict",
    why: "the one reader of the Mod's `stalled_waiting` receipt: its reason and its ticks, in its own words",
  },
  "host-service.ts:#publishStallFact": {
    authority: "verdict",
    why: "it asks the pump for the verdict the receipt just carried and hands it to the one delivery path",
  },
});

/** A declaration, its line, its own text, and whether it has a body to read anything with. */
type Declaration = Readonly<{ site: string; name: string; line: number; text: string; behavioural: boolean }>;

/** A declaration whose name is about a stall or a liveness. */
const STALL_NAME = /(?:stall|liveness)/iu;

/**
 * The three spellings of "measured from the last fact": the arrival-time record, a bound derived from it, and the
 * subtraction itself.
 */
const TRAFFIC_SPELLING =
  /(?:lastFactAtMs|lastArrivalAtMs|arrivedAtMs|stallThreshold|Date\.now\(\)\s*-\s*[\w.#[\]]*(?:AtMs|timestampMs))/u;

/**
 * Whose liveness a declaration is about: an execution's own identity, named. A passing mention of "an execution" is not a
 * subject - the narration reading counts TURNS and merely asks whether anything is in flight beside them, and that question
 * belongs to `executionLiveness`.
 */
const EXECUTION_SUBJECT = /\bexecutionId\b/u;

/** Every declaration the compiler sees in one source, with class members as members rather than as their class. */
function declarationsOf(file: string, text: string): Declaration[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const found: Declaration[] = [];
  const record = (node: ts.Node, name: string, behavioural: boolean): void => {
    found.push({
      site: `${file}:${name}`,
      name,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      text: node.getText(source),
      behavioural,
    });
  };
  const hasFunctionBody = (node: ts.Node | undefined): boolean =>
    node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      for (const member of node.members) {
        if (member.name === undefined) continue;
        if (!ts.isIdentifier(member.name) && !ts.isPrivateIdentifier(member.name)) continue;
        const behavioural =
          ts.isMethodDeclaration(member) ||
          ts.isGetAccessor(member) ||
          ts.isSetAccessor(member) ||
          (ts.isPropertyDeclaration(member) && hasFunctionBody(member.initializer));
        record(member, member.name.getText(source), behavioural);
      }
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      record(node, node.name.text, true);
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations)
        if (ts.isIdentifier(declaration.name))
          record(declaration, declaration.name.text, hasFunctionBody(declaration.initializer));
      return;
    }
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      record(node, node.name.text, false);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

function inPopulation(declaration: Declaration): boolean {
  if (STALL_NAME.test(declaration.name)) return true;
  return TRAFFIC_SPELLING.test(declaration.text) && EXECUTION_SUBJECT.test(declaration.text);
}

type LivenessFinding = Readonly<{
  examined: number;
  answered: number;
  traffic: readonly string[];
  expired: readonly string[];
  unsupported: readonly string[];
  blocked: string | null;
}>;

/**
 * The gate. `authority` is `LIVENESS_AUTHORITY` in the tree, and a falsifier may hand it one entry more or one less.
 */
function livenessGate(
  sources: ReadonlyMap<string, string>,
  authority: Readonly<Record<string, LivenessDeclaration>>,
): LivenessFinding {
  if (sources.size === 0)
    return { examined: 0, answered: 0, traffic: [], expired: [], unsupported: [], blocked: "zero_population" };
  const population = [...sources].flatMap(([file, text]) => declarationsOf(file, text).filter(inPopulation));
  const traffic: string[] = [];
  const unsupported: string[] = [];
  let answered = 0;
  for (const declaration of population) {
    const site = `${declaration.site} (line ${String(declaration.line)})`;
    const entry = authority[declaration.site];
    if (entry === undefined) {
      traffic.push(site);
      continue;
    }
    answered += 1;
    // A DECLARATION WITHOUT A BODY cannot read anything: a token or a type says what it NAMES. Only a member that could
    // have read an authority is checked against the one it claims.
    if (!declaration.behavioural) continue;
    const readsJournal = JOURNAL_READ.test(declaration.text);
    const readsVerdict = MOD_STATEMENT_READ.test(declaration.text);
    if (entry.authority === "state" ? !readsJournal : !readsVerdict) unsupported.push(site);
  }
  const expired = Object.keys(authority).filter((site) => !population.some((entry) => entry.site === site));
  return { examined: population.length, answered, traffic, expired, unsupported, blocked: null };
}

function findingLine(finding: LivenessFinding): string {
  return (
    `liveness_measured_by_fact_traffic: predicates examined ${String(finding.examined)} · state or verdict ` +
    `${String(finding.answered)} · traffic ${String(finding.traffic.length)}`
  );
}

test("liveness_measured_by_fact_traffic: an execution's liveness comes from its programme's state or the Mod's verdict", () => {
  const sources = new Map(SOURCES.map((file) => [file, readFileSync(join(HOST_SRC, file), "utf8")]));
  const finding = livenessGate(sources, LIVENESS_AUTHORITY);
  console.log(findingLine(finding));

  assert.equal(
    finding.blocked,
    null,
    "the scan recognised no source at all, so this reading is blocked rather than green",
  );
  assert.ok(
    finding.examined > 0,
    "the scan recognised no liveness predicate, so this reading is blocked rather than green",
  );
  assert.deepEqual(
    finding.traffic,
    [],
    `these declarations decide an execution's liveness from fact traffic - a wall-clock distance since the last fact, a ` +
      `record of when one arrived, or a bound derived from either. The verdict must come from the programme's own state ` +
      `(readInFlightProgrammes) or from the Mod's verdict (its stalled_waiting receipt, with reason and wait)`,
  );
  assert.deepEqual(
    finding.expired,
    [],
    "these entries declare an authority for a declaration that no longer exists, so the exemption has stopped applying",
  );
  assert.deepEqual(
    finding.unsupported,
    [],
    "these declarations are annotated with an authority their own code does not read - the annotation is a claim the " +
      "source has to support",
  );
  const reasons = Object.entries(LIVENESS_AUTHORITY).filter(([, entry]) => entry.why.trim().length <= 20);
  assert.deepEqual(
    reasons.map(([site]) => site),
    [],
    "every declaration must say why its authority is the answer, in more than a word",
  );
});

/**
 * THE FALSIFIER: a synthetic tree with one traffic predicate in it - the exact shape of the defect this gate replaced -
 * and a verdict copy of the annotation set. It must go red and name the injected site.
 *
 * The injected declaration is what the deleted bound looked like: an identifier named for a stall, whose value is a
 * duration compared against a distance since the last fact.
 */
test("falsifier: an injected wall-clock stall bound is named as traffic", () => {
  const injected = [
    "export const EXECUTION_LIVENESS_BOUND_MS = 120_000;",
    "",
    "function stallVerdictOf(executionId: string, lastFactAtMs: number): boolean {",
    "  return Date.now() - lastFactAtMs < EXECUTION_LIVENESS_BOUND_MS;",
    "}",
    "",
  ].join("\n");
  const finding = livenessGate(new Map([["event-pump.ts", injected]]), {});
  console.log(findingLine(finding));
  assert.equal(finding.examined, 2, "both the bound and the predicate that reads it are in the population");
  assert.deepEqual(
    finding.traffic.map((site) => site.split(" ")[0]),
    ["event-pump.ts:EXECUTION_LIVENESS_BOUND_MS", "event-pump.ts:stallVerdictOf"],
    "and each is named with its own line, so the next reader knows the site and not only the class of defect",
  );
});

test("falsifier: a declaration that outlives its code fails, and one that claims the wrong authority fails", () => {
  const tree = "function stallSomething(): boolean {\n  return readInFlightProgrammes().programmes.length > 0;\n}\n";
  const expired = livenessGate(new Map([["event-pump.ts", tree]]), {
    "event-pump.ts:stallSomething": {
      authority: "state",
      why: "reads the programme journal for what is still running",
    },
    "event-pump.ts:goneStallThing": { authority: "verdict", why: "a declaration that no longer exists in the source" },
  });
  assert.deepEqual(expired.traffic, [], "the live declaration is annotated, so it is not traffic");
  assert.deepEqual(
    expired.expired,
    ["event-pump.ts:goneStallThing"],
    "the stale entry is named, not silently tolerated",
  );

  const mislabelled = livenessGate(new Map([["event-pump.ts", tree]]), {
    "event-pump.ts:stallSomething": { authority: "verdict", why: "claims the Mod's verdict while reading the journal" },
  });
  assert.deepEqual(
    mislabelled.unsupported,
    ["event-pump.ts:stallSomething (line 1)"],
    "a declaration may not be labelled with an authority its code does not read",
  );
});
