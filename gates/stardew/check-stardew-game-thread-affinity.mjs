#!/usr/bin/env node
/**
 * Guard: nothing the Mod touches from a thread that is not the game loop reads or writes a `StardewValley` entity.
 *
 * WHY. `Game1.player`, `Game1.currentLocation`, `Game1.Date` and everything reachable from them are plain mutable
 * game state with no lock anywhere in the engine. The engine mutates them on its own update thread, and SMAPI runs a
 * mod's event callbacks on that same thread. A read or a write from anywhere else is a data race in the player's save
 * file, and the failure it produces is not a crash at the offending line - it is a corrupted or silently-stale world a
 * hundred ticks later, which is why no live run has ever named the site that caused it.
 *
 * WHAT PROTECTS IT TODAY, measured rather than assumed:
 *
 *   - `FarmhandActionRouter.IsOnOwnerThread` (`src/Core/Routing/FarmhandActionRouter.cs`) refuses an execution or a
 *     scene observation whose caller is not the thread the router was built on, with `game_thread_required`
 *     (`BridgeSession.TryObserveScene`, `TryRoute`). That guards the DISPATCH boundary: a frame that reaches a handler
 *     arrived on the loop. Two tests carry it - `FarmhandActionRouterTests` rejects a foreign thread and
 *     `ClearanceLeaseWiringTests` spends the lease on the loop - so the boundary is not merely declared.
 *   - Nothing guards the SITES. The router cannot stop a helper called from the pipe worker from reading
 *     `Game1.player`, because such a helper never passes through it. There is no analyzer, no `[RunsOnGameLoop]`
 *     marker, and no `Task.Run`/`ConfigureAwait` scan anywhere in this tree.
 *
 * So the property here is the other half: the Mod's own threads cannot REACH an entity.
 *
 * THE POPULATION IS DERIVED TWICE, FROM THE CODE, NEVER FROM A LIST:
 *
 *   1. The entity-touching members: every method, constructor or local function in `integrations/stardew` whose
 *      comment-stripped body names `Game1.` or a fully-qualified `StardewValley.` type. `Game1` is the engine's one
 *      static root for mutable game state and `StardewValley` is the engine namespace itself, so the token set is a
 *      token of the authority rather than an enumeration of the types somebody thought of.
 *   2. The thread hops: every expression that starts work elsewhere - `Task.Run`, `Task.Factory.StartNew`,
 *      `ThreadPool.QueueUserWorkItem`/`UnsafeQueueUserWorkItem`, `new Thread`, `.ContinueWith`, `new Timer(...)` (both
 *      of this Mod's timers are `System.Threading.Timer`), and `ConfigureAwait(false)`, whose continuation belongs to
 *      the method that wrote it but resumes on the pool.
 *
 * The verdict is the intersection: a member of (1) that a hop in (2) can reach by an in-repository call chain is
 * `game_entity_touched_off_the_game_thread`.
 *
 * CALL RESOLUTION, AND WHERE A DECLARATION IS REQUIRED. This is a source read, not a compile. A call is followed to a
 * Mod member only when exactly one candidate exists - the same file first, then the whole Mod by name. A call with
 * several candidates is not followed, and it is a finding ONLY when one of those candidates touches a game entity:
 * then the reading cannot rule out that the engine's own state is behind the edge. When no candidate touches one,
 * whichever member the call really is, it cannot reach an entity, so the edge cannot falsify the property -
 * reporting it would be the noise that makes a gate get ignored. (Measured while writing this: following every
 * multi-candidate call instead put `ExecutionEvidence.Write` inside the pipe worker's closure through a
 * `writer.Write(...)`, and following every single-candidate name put fourteen game-thread members there through
 * `Stream.Read`.) An entity-carrying ambiguity that a human has read and resolved is declared with its reason in
 * `tools/stardew-game-thread-affinity-declarations.json`; an undeclared one fails the run, so the gate names what it
 * could not decide instead of narrowing what it believes.
 *
 * The same file carries the `dispatched` list: a member the gate CAN reach off the loop, declared to hand off to the
 * game thread before touching anything. Nothing is on it today. An entry whose member no longer resolves is
 * `game_thread_declaration_stale`, because an exemption must not outlive what it excused.
 *
 * WHY A SOURCE READ AND NOT AN ANALYZER PACKAGE. The property is one call graph over one directory, and this tree
 * already answers that shape with `tools/check-*.mjs` scans. A Roslyn analyzer or ArchUnitNET would be a second
 * spelling of the same property AND would need the Mod's `StardewValley` reference to compile - which a checkout
 * without the game does not have - to answer what tree-sitter answers offline in two seconds. The cost is stated
 * rather than hidden: name resolution cannot follow interface dispatch or a delegate held in a field, so those sites
 * surface as unresolved rather than as passes.
 *
 * WHAT IS NOT IN THE POPULATION: a method that receives a `Farmer` from its caller and never names `Game1` or
 * `StardewValley` itself. It inherits its caller's thread and is one call from a method that does name the singleton;
 * seeing it would need a type checker, and a hand-written list of entity types would be a second authority for what
 * the engine owns.
 *
 * POPULATION AND THE INDEX. The files read are the Mod's tracked sources: a lane's untracked, half-written file is
 * published as `untracked_not_counted N` instead of being judged, because it is not yet anyone's. That exclusion is
 * skipped for `--root`, which reads a fixture tree this repository's index knows nothing about.
 *
 * OUTPUT. `files examined F · declarations D · entity-touching N · thread hops H · off-loop closure C`, then
 * `methods examined N · provably on the loop M · dispatched D · undeclared U`, then one line per finding. Exit 0
 * clean, 1 on a finding, 2 when there is no population to read (no C# file, or no hop at all - a run that found
 * nothing to examine is blocked, never green).
 *
 * Usage:
 *   node tools/check-stardew-game-thread-affinity.mjs              # the reading, exit 1 on a finding
 *   node tools/check-stardew-game-thread-affinity.mjs --json       # machine report
 *   node tools/check-stardew-game-thread-affinity.mjs --list       # the off-loop closure and the hop inventory
 *   node tools/check-stardew-game-thread-affinity.mjs --root DIR   # read another tree (the falsifier suite)
 *
 * red-proof: inject  `_ = Game1.player;` added to `LocalPipeBridge.FrameTypeOf` in a copy of the tree ->
 *                    `game_entity_touched_off_the_game_thread:integrations/stardew/LocalPipeBridge.cs:349:FrameTypeOf`,
 *                    exit 1; the same injection into `RecordRefusedOutboundFrame`, which the pipe worker cannot
 *                    reach, stays green - the reachability is the assertion, not the token
 *                    (tools/check-stardew-game-thread-affinity.test.mjs)
 */

export const gateDeclaration = {
  id: "check-stardew-game-thread-affinity",
  domain: "stardew",
  tier: "l0",
  kind: "totality",
};

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import { stripComments } from "./audit-stardew-test-shape.mjs";
import { describeUntracked, untrackedSources } from "../../tools/lib/indexed-sources.mjs";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

const require = createRequire(import.meta.url);

export const MARKER = "\u2716";

const ROOT = repositoryRoot(import.meta.url);

/** The Mod's sources: this directory minus build output and the test projects. */
export const SOURCE_ROOT = join(ROOT, "integrations", "stardew");

/** The one path a source read cannot decide, and the members it may hand off to the game thread. */
export const DECLARATIONS_PATH = join(ROOT, "tools", "stardew-game-thread-affinity-declarations.json");

const EXCLUDED_DIRECTORIES = new Set(["bin", "obj", "tests"]);

/**
 * A thread hop: an expression whose effect is to run code on a thread other than the game loop.
 *
 * `ConfigureAwait(false)` belongs here because its continuation is written in the calling method but resumed on the
 * pool - the same write as a `Task.Run`, spelled one await earlier.
 */
export const THREAD_HOP =
  /(?:^|[^\w$])(?:Task\.Run|Task\.Factory\.StartNew|ThreadPool\.(?:Unsafe)?QueueUserWorkItem|new\s+(?:System\.Threading\.)?Timer|new\s+(?:System\.Threading\.)?Thread|\.ContinueWith|\.ConfigureAwait\s*\(\s*false\s*\))(?![A-Za-z0-9_])/u;

/**
 * A read or write of engine state: the engine's one static root, or the engine namespace named directly.
 */
export const GAME_ENTITY = /(?:^|[^\w$])(?:Game1\s*\.|StardewValley\s*\.)/u;

const DECLARATION_KINDS = new Set([
  "method_declaration",
  "constructor_declaration",
  "operator_declaration",
  "local_function_statement",
]);
const LAMBDA_KINDS = new Set(["lambda_expression", "anonymous_method_expression"]);

let parserPromise;

async function csharpParser() {
  parserPromise ??= (async () => {
    await Parser.init();
    const parser = new Parser();
    parser.setLanguage(await Language.load(require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm")));
    return parser;
  })();
  return parserPromise;
}

/** Every tracked C# file of the Mod, relative to the tree being read. */
export function sourceFiles(root = SOURCE_ROOT, { exclude = new Set() } = {}) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        walk(full);
      } else if (entry.name.endsWith(".cs") && !exclude.has(full.split("\\").join("/"))) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

/** The last identifier of a callee expression: `this.Helper.Thing<T>(` -> `Thing`. */
function calleeName(text) {
  return text
    .replace(/<[^<>]*>/gu, "")
    .split(".")
    .pop()
    .trim();
}

/**
 * The methods a hop hands work to: the method group each argument names, and every call inside a lambda argument.
 *
 * `Task.Run(this.RunAsync)` names one; `new Timer(_ => this.Flush(), ...)` names the lambda's calls. A period, a
 * `null` or a cancellation token names nothing the Mod declares, and resolves to nothing.
 */
function hopRoots(argumentList, source) {
  const roots = [];
  const visit = (node) => {
    if (node.type === "invocation_expression") {
      const fn = node.childForFieldName("function");
      if (fn)
        roots.push({ name: calleeName(source.slice(fn.startIndex, fn.endIndex)), line: node.startPosition.row + 1 });
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  for (const argument of argumentList.namedChildren) {
    const expression = argument.type === "argument" ? argument.namedChildren[0] : argument;
    if (expression === undefined || expression === null) continue;
    if (LAMBDA_KINDS.has(expression.type)) {
      visit(expression);
      continue;
    }
    if (expression.type === "object_creation_expression") {
      const type = expression.childForFieldName("type");
      if (type)
        roots.push({
          name: calleeName(source.slice(type.startIndex, type.endIndex)),
          line: expression.startPosition.row + 1,
        });
      continue;
    }
    const text = source.slice(expression.startIndex, expression.endIndex).trim();
    if (/^(?:this\.)?[A-Za-z_]\w*$/u.test(text))
      roots.push({ name: calleeName(text), line: expression.startPosition.row + 1 });
  }
  return roots;
}

export async function readMod({ root = SOURCE_ROOT, exclude = new Set() } = {}) {
  const parser = await csharpParser();
  const files = sourceFiles(root, { exclude });
  const declarations = [];
  const hops = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const relativePath = relative(resolve(root, "..", ".."), file)
      .split("\\")
      .join("/");
    collectFile(parser.parse(source).rootNode, source, relativePath, declarations, hops);
  }
  return { files: files.length, declarations, hops };
}

const sliceOf = (source, node) => (node === null ? "" : source.slice(node.startIndex, node.endIndex));

/** The declaration a node opens, or `null` when it opens none. */
function openedDeclaration(node, source, relativePath) {
  if (!DECLARATION_KINDS.has(node.type)) return null;
  const nameNode = node.childForFieldName("name");
  const bodyNode = node.childForFieldName("body");
  return {
    name: nameNode === null ? "(anonymous)" : sliceOf(source, nameNode),
    file: relativePath,
    line: node.startPosition.row + 1,
    body: bodyNode === null ? "" : stripComments(sliceOf(source, bodyNode)),
    calls: [],
  };
}

/** The callee of an invocation or the type of a construction: the only two shapes a thread hop can take. */
function hopHead(node) {
  if (node.type === "invocation_expression") return node.childForFieldName("function");
  if (node.type === "object_creation_expression") return node.childForFieldName("type");
  return null;
}

/** One call, or `null` for a node that makes none. */
function recordedCall(node, source) {
  if (node.type !== "invocation_expression") return null;
  const fn = node.childForFieldName("function");
  if (fn === null) return null;
  return { name: calleeName(sliceOf(source, fn)), line: node.startPosition.row + 1 };
}

/** One thread hop, or `null` for a node that starts no thread. */
function recordedHop(node, source, relativePath, owner) {
  const head = hopHead(node);
  if (head === null) return null;
  const headText = sliceOf(source, head);
  const power = node.type === "object_creation_expression" ? `new ${headText}` : headText;
  if (!THREAD_HOP.test(power)) return null;
  const argumentList = node.namedChildren.find((child) => child.type === "argument_list") ?? null;
  return {
    file: relativePath,
    line: node.startPosition.row + 1,
    owner,
    head: power,
    roots: argumentList === null ? [] : hopRoots(argumentList, source),
    configureAwait: /\.ConfigureAwait\s*\(\s*false\s*\)/u.test(headText),
  };
}

/** One file's declarations, calls and hops. A hop outside any declaration (a field initializer) is still a hop. */
function collectFile(rootNode, source, relativePath, declarations, hops) {
  const stack = [];
  const walk = (node) => {
    const record = openedDeclaration(node, source, relativePath);
    if (record !== null) {
      declarations.push(record);
      stack.push(record);
    }
    if (stack.length > 0) {
      const call = recordedCall(node, source);
      if (call !== null) stack.at(-1).calls.push(call);
    }
    const hop = recordedHop(node, source, relativePath, stack.at(-1) ?? null);
    if (hop !== null) hops.push(hop);
    for (const child of node.namedChildren) walk(child);
    if (record !== null) stack.pop();
  };
  walk(rootNode);
}

/**
 * Resolve a callee to Mod declarations: the same file first, then the whole Mod by name.
 *
 * `edge` needs exactly one candidate. Two or more is `ambiguous` and is NOT followed - see CALL RESOLUTION.
 */
export function resolveCallee(name, from, byName) {
  const candidates = byName.get(name) ?? [];
  if (candidates.length === 0) return { kind: "external", candidates };
  const sameFile = candidates.filter((candidate) => candidate.file === from.file);
  if (sameFile.length === 1) return { kind: "edge", candidates: sameFile };
  if (sameFile.length > 1) return { kind: "ambiguous", candidates: sameFile };
  if (candidates.length === 1) return { kind: "edge", candidates };
  return { kind: "ambiguous", candidates };
}

/**
 * Everything a hop can reach, and every ambiguity that could still be an entity path.
 *
 * An ambiguity is reported only when one of its candidates touches an entity: otherwise the edge cannot falsify the
 * property whatever it resolves to, and a report of it is noise. See CALL RESOLUTION above.
 */
export function offLoopClosure({ declarations, hops }) {
  const byName = indexByName(declarations);
  const reached = new Set();
  const unresolved = [];
  const queue = [];
  for (const hop of hops) {
    if (hop.configureAwait && hop.owner) queue.push(hop.owner);
    for (const root of hop.roots) for (const declaration of byName.get(root.name) ?? []) queue.push(declaration);
  }
  followCalls(queue, byName, reached, unresolved);
  return {
    reached,
    unresolved,
    members: declarations.filter((declaration) => reached.has(`${declaration.file}:${declaration.line}`)),
  };
}

function indexByName(declarations) {
  const byName = new Map();
  for (const declaration of declarations) {
    if (!byName.has(declaration.name)) byName.set(declaration.name, []);
    byName.get(declaration.name).push(declaration);
  }
  return byName;
}

/** Breadth-first over resolvable calls, recording the ambiguities that could still be an entity path. */
function followCalls(queue, byName, reached, unresolved) {
  const touchesEntity = (declaration) => GAME_ENTITY.test(declaration.body);
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) continue;
    const key = `${current.file}:${current.line}`;
    if (reached.has(key)) continue;
    reached.add(key);
    for (const call of current.calls) {
      const resolution = resolveCallee(call.name, current, byName);
      if (resolution.kind === "edge") {
        for (const next of resolution.candidates) queue.push(next);
        continue;
      }
      if (resolution.kind === "ambiguous" && resolution.candidates.some(touchesEntity))
        unresolved.push({
          file: current.file,
          line: call.line,
          callee: call.name,
          candidates: resolution.candidates.length,
        });
    }
  }
}

/** The declarations file, or an empty one when the tree under test has none. */
export function readDeclarations(path = DECLARATIONS_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { unresolved: [], dispatched: [] };
  }
  const parsed = JSON.parse(raw);
  return {
    unresolved: Array.isArray(parsed.unresolved) ? parsed.unresolved : [],
    dispatched: Array.isArray(parsed.dispatched) ? parsed.dispatched : [],
  };
}

/** The reading: the population, the closure, and every finding. */
export async function readAffinity({ root = SOURCE_ROOT, declarationsPath = DECLARATIONS_PATH } = {}) {
  const untracked =
    root === SOURCE_ROOT ? untrackedSources({ roots: ["integrations/stardew"], root: ROOT }) : new Set();
  const exclude = new Set([...untracked].map((path) => join(ROOT, path).split("\\").join("/")));
  const measured = await readMod({ root, exclude });
  const closure = offLoopClosure(measured);
  const touching = measured.declarations.filter((declaration) => GAME_ENTITY.test(declaration.body));
  const declared = readDeclarations(declarationsPath);
  const declaredUnresolved = new Set(declared.unresolved.map((entry) => `${entry.file}:${entry.callee}`));
  const declaredDispatched = new Set(declared.dispatched.map((entry) => `${entry.file}:${entry.member}`));
  const findings = [];

  const offLoop = touching.filter((declaration) => closure.reached.has(`${declaration.file}:${declaration.line}`));
  const dispatched = offLoop.filter((declaration) => declaredDispatched.has(`${declaration.file}:${declaration.name}`));
  for (const declaration of offLoop) {
    if (declaredDispatched.has(`${declaration.file}:${declaration.name}`)) continue;
    findings.push({
      code: "game_entity_touched_off_the_game_thread",
      detail: `${declaration.file}:${declaration.line}:${declaration.name}`,
    });
  }

  const unresolvedUndeclared = closure.unresolved.filter(
    (site) => !declaredUnresolved.has(`${site.file}:${site.callee}`),
  );
  for (const site of unresolvedUndeclared)
    findings.push({ code: "game_thread_unresolved_call", detail: `${site.file}:${site.line}:${site.callee}` });

  for (const entry of declared.unresolved) {
    const live = closure.unresolved.some((site) => site.file === entry.file && site.callee === entry.callee);
    if (!live) findings.push({ code: "game_thread_declaration_stale", detail: `${entry.file}:${entry.callee}` });
  }
  for (const entry of declared.dispatched) {
    const live = offLoop.some((declaration) => declaration.file === entry.file && declaration.name === entry.member);
    if (!live) findings.push({ code: "game_thread_declaration_stale", detail: `${entry.file}:${entry.member}` });
  }

  return {
    files: measured.files,
    declarations: measured.declarations.length,
    hops: measured.hops,
    closure: closure.members,
    touching: touching.length,
    onLoop: touching.length - offLoop.length,
    dispatched: dispatched.length,
    undeclared: unresolvedUndeclared.length + (offLoop.length - dispatched.length),
    untracked: [...untracked],
    findings,
  };
}

/** The self-verification report, built from the reading so two spellings of one number cannot disagree. */
export function report(reading) {
  const count = (code) => reading.findings.filter((finding) => finding.code === code).length;
  const outcome = (code) => (count(code) === 0 ? "passed" : "failed");
  return {
    gate: "check-stardew-game-thread-affinity",
    status: reading.findings.length === 0 ? "passed" : "failed",
    examined: reading.touching,
    files: reading.files,
    declarations: reading.declarations,
    hops: reading.hops.length,
    offLoop: reading.closure.length,
    provablyOnTheLoop: reading.onLoop,
    dispatched: reading.dispatched,
    undeclared: reading.undeclared,
    untrackedNotCounted: reading.untracked.length,
    checks: [
      {
        id: "game_entity_touched_off_the_game_thread",
        status: outcome("game_entity_touched_off_the_game_thread"),
        detail: `${count("game_entity_touched_off_the_game_thread")} entity-touching member(s) a thread hop can reach`,
      },
      {
        id: "game_thread_unresolved_call",
        status: outcome("game_thread_unresolved_call"),
        detail: `${count("game_thread_unresolved_call")} ambiguity(ies) inside the off-loop closure with an entity-touching candidate`,
      },
      {
        id: "game_thread_declaration_stale",
        status: outcome("game_thread_declaration_stale"),
        detail: `${count("game_thread_declaration_stale")} declaration(s) that no longer describe a live site`,
      },
    ],
    findings: reading.findings,
  };
}

/** The two derived populations, on separate lines, so each can be read as the count it is. */
function describe(reading) {
  const hops = reading.hops.map((hop) => `${hop.file}:${hop.line}:${hop.head.trim()}`).join(" · ");
  return [
    `files examined ${reading.files} · declarations ${reading.declarations} · entity-touching ${reading.touching} · thread hops ${reading.hops.length} · off-loop closure ${reading.closure.length}`,
    `methods examined ${reading.touching} · provably on the loop ${reading.onLoop} · dispatched ${reading.dispatched} · undeclared ${reading.undeclared}`,
    `hops derived from ${hops}`,
    `untracked_not_counted ${reading.untracked.length}${reading.untracked.length === 0 ? "" : `: ${describeUntracked(new Set(reading.untracked))}`}`,
  ].join("\n");
}

async function main(argv) {
  const option = (name, fallback) => {
    const at = argv.indexOf(name);
    return at === -1 ? fallback : argv[at + 1];
  };
  const root = resolve(option("--root", SOURCE_ROOT));
  const declarationsPath = resolve(option("--declarations", DECLARATIONS_PATH));
  const reading = await readAffinity({ root, declarationsPath });

  if (reading.files === 0) throw new Error(`stardew_game_thread_affinity_no_population:${root}`);
  if (reading.hops.length === 0) throw new Error(`stardew_game_thread_affinity_no_hop_found:${root}`);

  const summary = report(reading);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary.status === "passed" ? 0 : 1;
  }
  console.log(describe(reading));
  if (argv.includes("--list"))
    console.log(
      `off-loop closure: ${reading.closure.map((member) => `${member.file}:${member.line}:${member.name}`).join(", ")}`,
    );
  for (const finding of summary.findings) console.log(`${MARKER} ${finding.code}:${finding.detail}`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary.status === "passed" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`${MARKER} ${error.message}`);
      process.exitCode = 2;
    },
  );
}
