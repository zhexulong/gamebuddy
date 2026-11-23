#!/usr/bin/env node
/**
 * A Chat read is answered by the Chat half's own route - never by the composed aggregate.
 *
 * WHY THIS EXISTS. `dialogue-web/src/chat-snapshot-pair.ts` read `composedApi.readState()` whenever its
 * caller held no fresh root of its own, so four Chat paths - the fallback poll, the event stream's
 * recovery read, its confirmation read and the shell's authoritative reread - were answered by
 * `/api/composed-reference-game/v1/state`. The Host composes the Game projection INTO that document and
 * refuses the document when that half cannot be produced (`state_unavailable` /
 * `game_projection_failed`, `readComposedRoot` in `host/src/composed-reference-game-browser.ts`), so a
 * Game fault aborted a conversation read the game has no part in: measured on the mount as
 * `problem-view=1 chat-surface=0`, and in session as a Chat reread whose only retry was the same refusal.
 * The Chat half has a route of its own - `GET /api/tavern/v1/state`, the same `TavernStateSnapshotV1` the
 * root carries under `chat`, on the same broker session - and the seam now takes the Chat client instead
 * of the composed one, so the TYPE keeps that true for the seam itself: it has no aggregate to reach for.
 *
 * WHAT NO COMPILER CAN SAY, which is why this gate exists beside that type. `tavernApi.readState()` and
 * `composedApi.readState()` are one call shape on two types, and a module holding a composed client can
 * take the aggregate inline without touching the seam at all: `readProductWorldInfo`
 * (`dialogue-web/src/components/ComposedReferenceGameApp.tsx`) read the aggregate to learn two fields of
 * the Chat half, and a Game fault emptied the managed World Info library the Chat owns until it was
 * pointed at the Chat route. A type says which api a receiver IS; it cannot say which route a read takes.
 *
 * THE POPULATION, derived on every run and printed. Every module under `dialogue-web/src` is parsed
 * (`modules examined N`); test files are outside it, because `use-chat-event-stream.test.ts` hands the
 * stream a fake api and a fake is not a route. Inside it:
 *
 *   1. the api receivers are resolved from their own DECLARATIONS, never from a name list here: a
 *      variable initialised through `createComposedReferenceGameBrowserApi(...)`, or a variable,
 *      parameter or property typed `ComposedReferenceGameBrowserApi`, is a composed client; the same two
 *      shapes around `createReferencePipelineApi` / `ReferencePipelineApi` are the Chat client. A member
 *      declared in another module's type (`composedApiRef: RefObject<...>` in `ComposedBootstrap`) is
 *      resolved from that declaration, which is how the shell and the panels are judged.
 *   2. every `readState(...)` / `bootstrap(...)` call whose receiver resolves that way is a READ SITE,
 *      classified into an aggregate read or a Chat-route read. A receiver this gate cannot classify is
 *      `read_receiver_unresolved`, and one that resolves to both is `read_receiver_ambiguous`: a read
 *      that is neither of the two routes is not a read this gate may pass.
 *   3. the SESSION MINT is derived as the module holding a composed `bootstrap(...)` call - the read a
 *      one-time boot token is spent on, which is also the one read that adopts the session. It is
 *      printed by name, so the single exemption below is a measured fact and not an allow-list.
 *
 * THE PROPERTY. A composed aggregate read is allowed only in the session mint, because the Chat half's
 * own route answers on the session that read adopts: a refused `/bootstrap` retires it, and
 * `game-projection-failure-is-not-the-chats.spec.ts` measures `chatHalfReads=0` on that page. Everywhere
 * else - the seam, the stream, the poll, the shell, a panel - a Chat read takes the Chat route.
 * `chat_read_uses_the_composed_aggregate` names the file, the line, the receiver and the call, and fails
 * the run.
 *
 * WHAT IT DOES NOT ASSERT: that the Chat route has a producer (that is
 * `check-frontend-reads-have-producers`), and that its answer never composes a Game projection of its own
 * (the Host's `handleState` owns that fact). Here: which route the browser reads.
 *
 * ZERO IS NOT GREEN. No module under the scope, no read site, no Chat-route read, or no session mint
 * found are each `blocked` with the reason named - a reading that lost any of the four cannot tell the
 * two routes apart. Aggregate reads ARE allowed to be zero outside the mint; that is this gate's green
 * state, and it is printed as a number rather than inferred.
 *
 * Usage:
 *   node gates/product/check-chat-reads-the-chat-route.mjs              # the verdict; exit 1 on a violation, 2 blocked
 *   node gates/product/check-chat-reads-the-chat-route.mjs --json       # the same reading, machine-readable
 *   node gates/product/check-chat-reads-the-chat-route.mjs --root <dir> # the gate's own fixture
 *
 * red-proof: inject  `chat-snapshot-pair.ts` given back its fallback (a `read` parameter of the composed
 *   api and `read ?? (await composedApi.readState())`) -> `chat_read_uses_the_composed_aggregate` naming
 *   `dialogue-web/src/chat-snapshot-pair.ts` and its line, `1 aggregate read(s) outside the session mint`,
 *   exit 1; with the same call moved into the module that mints the session the run is green
 *   (gates/product/check-chat-reads-the-chat-route.test.mjs)
 * red-proof: history  the World Info read that shipped on the aggregate (`readProductWorldInfo`, fixed in
 *   the Chat-decoupling lane) -> `chat_read_uses_the_composed_aggregate` naming that file, because the
 *   shell mints no session (gates/product/check-chat-reads-the-chat-route.test.mjs)
 * red-proof: inject  a read whose receiver is neither client (`mystery.readState()`) ->
 *   `read_receiver_unresolved`, exit 1; a tree with no module at all -> `blocked`, exit 2
 *   (gates/product/check-chat-reads-the-chat-route.test.mjs)
 */

export const gateDeclaration = {
  id: "check-chat-reads-the-chat-route",
  domain: "product",
  tier: "l0",
  kind: "contract",
};

// source-invariant: no compiler can require a read to take one route rather than another - `readState()`
//   typechecks identically on the composed client and on the Chat client - so this gate resolves each
//   receiver from its own declaration and requires the Chat half's reads to be the Chat route, with the
//   session mint as the one derived exemption.
// source-expiry: when the aggregate root's two halves are served by routes that cannot refuse each other
//   (a Host-side split of `/state`, or a composed `readChat()` that composes no Game projection), or when
//   the two clients collapse into one type, this reading has no subject and must be retired with that
//   change rather than kept as a green line.

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { blockedOnEmptyPopulation } from "../../tools/lib/gate-population.mjs";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

const REPOSITORY_ROOT = repositoryRoot(import.meta.url);

/** The browser shell: the only tree this repository reads either route from. */
export const WEB_SOURCES = "dialogue-web/src";

/** The Chat half's own route client and the composed aggregate's, as their own modules declare them. */
export const COMPOSED_API = Object.freeze({
  kind: "composed",
  type: "ComposedReferenceGameBrowserApi",
  factory: "createComposedReferenceGameBrowserApi",
});
export const CHAT_API = Object.freeze({
  kind: "chat",
  type: "ReferencePipelineApi",
  factory: "createReferencePipelineApi",
});

/** The two members that read a whole document. `readGameState` and the commands are neither. */
export const READ_MEMBERS = Object.freeze(["readState", "bootstrap"]);

/** The member whose call adopts the session: the one read a mount may take from the aggregate. */
export const SESSION_MINT_MEMBER = "bootstrap";

const TEST_FILE = /\.(?:test|spec)\.tsx?$/u;
const DECLARATION_FILE = /\.d\.ts$/u;
const TYPESCRIPT_EXTENSION = /\.tsx?$/u;

/** The TypeScript parser the web workspace compiles with, so this gate reads the tree the build reads. */
const typescript = createRequire(join(REPOSITORY_ROOT, "dialogue-web", "package.json"))("typescript");

/** Every module under the scope this gate examines, relative to `root` and sorted. */
export function sourceModules({ root, web = WEB_SOURCES } = {}) {
  const files = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(path);
        continue;
      }
      if (!entry.isFile() || !TYPESCRIPT_EXTENSION.test(entry.name)) continue;
      if (TEST_FILE.test(entry.name) || DECLARATION_FILE.test(entry.name)) continue;
      files.push(path.slice(root.length + 1).replace(/\\/gu, "/"));
    }
  };
  walk(join(root, web));
  return files.sort();
}

/** The closed set of api kinds a type's own text names, read as a name and never as an implementation. */
function kindsInTypeText(text) {
  const kinds = new Set();
  if (text === undefined || text === null) return kinds;
  for (const api of [COMPOSED_API, CHAT_API]) if (text.includes(api.type)) kinds.add(api.kind);
  return kinds;
}

/** The api kinds a value's initializer takes its client from (`useRef(createComposedReferenceGameBrowserApi())`). */
function kindsInInitializer(node) {
  const kinds = new Set();
  if (node === undefined) return kinds;
  const visit = (inner) => {
    if (typescript.isCallExpression(inner) && typescript.isIdentifier(inner.expression)) {
      for (const api of [COMPOSED_API, CHAT_API]) if (inner.expression.text === api.factory) kinds.add(api.kind);
    }
    typescript.forEachChild(inner, visit);
  };
  visit(node);
  return kinds;
}

/**
 * The api receivers one module declares, split by where the declaration is visible.
 *
 * `local` is what this module binds itself - a variable, a parameter, a class property - so a parameter
 * called `api` classifies reads in its own module and nowhere near another one. `shared` is a member
 * declared in a type (`composedApiRef: RefObject<...>` in `ComposedBootstrap`), which is how a prop
 * handed to the shell or a panel is resolved from the declaration that owns it rather than from its name.
 */
function declareReceivers(sourceFile) {
  const local = new Map();
  const shared = new Map();
  const remember = (map, name, kinds) => {
    if (kinds.size === 0) return;
    if (!map.has(name)) map.set(name, new Set());
    for (const kind of kinds) map.get(name).add(kind);
  };
  const typeText = (node) => (node === undefined || node === null ? undefined : node.getText(sourceFile));
  const visit = (node) => {
    if (typescript.isVariableDeclaration(node) && typescript.isIdentifier(node.name)) {
      const kinds = kindsInTypeText(typeText(node.type));
      for (const kind of kindsInInitializer(node.initializer)) kinds.add(kind);
      remember(local, node.name.text, kinds);
    } else if (typescript.isParameter(node) && typescript.isIdentifier(node.name)) {
      remember(local, node.name.text, kindsInTypeText(typeText(node.type)));
    } else if (typescript.isPropertyDeclaration(node) && typescript.isIdentifier(node.name)) {
      remember(local, node.name.text, kindsInTypeText(typeText(node.type)));
    } else if (typescript.isPropertySignature(node) && typescript.isIdentifier(node.name)) {
      remember(shared, node.name.text, kindsInTypeText(typeText(node.type)));
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { local, shared };
}

/**
 * The names a receiver expression can be resolved by, most specific first.
 *
 * `composedApiRef.current` offers its root (`composedApiRef`) and then the members it passes through, so
 * a client reached as `bootstrap.composedApiRef.current` is still resolved - from the member the type
 * declares (`composedApiRef: RefObject<ComposedReferenceGameBrowserApi>`) rather than from the name of
 * whatever holds it. `null` when the expression is not a name at all (`(await make()).readState()`).
 */
function receiverNames(node) {
  const members = [];
  let current = node;
  while (current !== undefined && current !== null) {
    if (typescript.isIdentifier(current)) return [current.text, ...members];
    if (typescript.isPropertyAccessExpression(current)) {
      members.push(current.name.text);
      current = current.expression;
      continue;
    }
    if (
      typescript.isElementAccessExpression(current) ||
      typescript.isNonNullExpression(current) ||
      typescript.isParenthesizedExpression(current) ||
      typescript.isAwaitExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return members.length === 0 ? null : members;
  }
  return members.length === 0 ? null : members;
}

/** Every `readState(...)` / `bootstrap(...)` call in one module, with the receiver it is called on. */
function readSitesIn(sourceFile) {
  const sites = [];
  const visit = (node) => {
    if (typescript.isCallExpression(node)) {
      const callee = node.expression;
      let member = null;
      let receiver = null;
      if (typescript.isPropertyAccessExpression(callee)) {
        member = callee.name.text;
        receiver = callee.expression;
      } else if (
        typescript.isElementAccessExpression(callee) &&
        typescript.isStringLiteralLike(callee.argumentExpression)
      ) {
        member = callee.argumentExpression.text;
        receiver = callee.expression;
      }
      if (member !== null && READ_MEMBERS.includes(member)) {
        sites.push({
          member,
          receiverNames: receiverNames(receiver),
          receiver: receiver.getText(sourceFile).replace(/\s+/gu, " "),
          call: callee.getText(sourceFile).replace(/\s+/gu, " "),
          position: node.getStart(sourceFile),
        });
      }
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/**
 * The whole reading: the receivers, the read sites, the session mint, and what each site takes.
 *
 * Returns `{ status, population, readSites, aggregateReads, chatRouteReads, sessionMint, violations,
 * unparsed, checks }`. `population` is the module count, because a scan that parsed no module has not
 * compared anything.
 */
export function checkChatReadsTheChatRoute({ root = REPOSITORY_ROOT, web = WEB_SOURCES } = {}) {
  const modules = sourceModules({ root, web });
  const reading = {
    gate: "chat-reads-the-chat-route",
    web,
    population: modules.length,
    readSites: 0,
    aggregateReads: 0,
    chatRouteReads: 0,
    composedReceivers: [],
    sessionMint: [],
    violations: [],
    unparsed: [],
    allowEmpty: null,
  };
  if (modules.length === 0)
    return {
      ...reading,
      status: "blocked",
      blocked: `chat_route_population_empty: no module under ${web}`,
    };

  const parsed = [];
  const shared = new Map();
  for (const file of modules) {
    const source = readFileSync(join(root, file), "utf8");
    const sourceFile = typescript.createSourceFile(
      file,
      source,
      typescript.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? typescript.ScriptKind.TSX : typescript.ScriptKind.TS,
    );
    if (sourceFile.parseDiagnostics !== undefined && sourceFile.parseDiagnostics.length > 0) {
      reading.unparsed.push(`${file}: ${String(sourceFile.parseDiagnostics[0].messageText)}`);
      continue;
    }
    const { local, shared: published } = declareReceivers(sourceFile);
    for (const [name, kinds] of published) {
      if (!shared.has(name)) shared.set(name, new Set());
      for (const kind of kinds) shared.get(name).add(kind);
    }
    parsed.push({ file, sourceFile, local, sites: readSitesIn(sourceFile) });
  }

  const composed = new Set();
  const classified = [];
  for (const entry of parsed) {
    for (const site of entry.sites) {
      reading.readSites += 1;
      const kinds =
        site.receiverNames === null
          ? null
          : (site.receiverNames
              .map((name) => entry.local.get(name) ?? shared.get(name))
              .find((found) => found !== undefined) ?? null);
      const line = entry.sourceFile.getLineAndCharacterOfPosition(site.position).line + 1;
      if (kinds === null) {
        reading.violations.push({
          code: "read_receiver_unresolved",
          at: `${entry.file}:${line}`,
          detail:
            `\`${site.call}\` is a read whose receiver \`${site.receiver}\` this gate cannot resolve ` +
            "to either client; declare it as one of them, or the route it takes is unjudged",
        });
        continue;
      }
      if (kinds.size > 1) {
        reading.violations.push({
          code: "read_receiver_ambiguous",
          at: `${entry.file}:${line}`,
          detail: `\`${site.call}\` resolves to both a composed and a Chat client in this tree, so its route is unjudged`,
        });
        continue;
      }
      const kind = [...kinds][0];
      if (kind === CHAT_API.kind) {
        reading.chatRouteReads += 1;
        continue;
      }
      reading.aggregateReads += 1;
      for (const name of site.receiverNames) {
        if (entry.local.has(name) || shared.has(name)) {
          composed.add(name);
          break;
        }
      }
      if (site.member === SESSION_MINT_MEMBER) reading.sessionMint.push(entry.file);
      classified.push({ file: entry.file, line, site });
    }
  }
  reading.composedReceivers = [...composed].sort();
  reading.sessionMint = [...new Set(reading.sessionMint)].sort();

  if (reading.readSites === 0)
    return {
      ...reading,
      status: "blocked",
      blocked:
        `chat_route_read_sites_empty: ${reading.population} module(s) under ${web} name neither \`readState\` nor ` +
        "`bootstrap`, so this scan lost its reader instead of finding the tree clean",
    };
  if (reading.chatRouteReads === 0)
    return {
      ...reading,
      status: "blocked",
      blocked:
        "chat_route_never_read: no module reads the Chat half's own route, so a green verdict here could not " +
        "tell the two routes apart",
    };
  if (reading.sessionMint.length === 0)
    return {
      ...reading,
      status: "blocked",
      blocked:
        "session_mint_not_found: no module reads the composed aggregate through `bootstrap`, so there is no " +
        "derived exemption and every aggregate read below is unjudged",
    };

  const mint = new Set(reading.sessionMint);
  for (const { file, line, site } of classified) {
    if (site.member === SESSION_MINT_MEMBER) continue;
    if (mint.has(file)) continue;
    reading.violations.push({
      code: "chat_read_uses_the_composed_aggregate",
      at: `${file}:${line}`,
      detail:
        `\`${site.call}\` reads the composed aggregate outside the session mint (${reading.sessionMint.join(", ")}); ` +
        "a Chat read takes the Chat half's own route, or a Game fault refuses this one whole",
    });
  }

  if (reading.aggregateReads === 0)
    reading.allowEmpty = "no module reads the composed aggregate at all, which is this gate's green state";

  const checks = [
    {
      id: "every_read_receiver_resolved",
      status: reading.violations.some(
        (violation) => violation.code === "read_receiver_unresolved" || violation.code === "read_receiver_ambiguous",
      )
        ? "failed"
        : "passed",
      detail: `${reading.readSites} read site(s), ${reading.composedReceivers.length} composed receiver(s)`,
    },
    {
      id: "chat_reads_take_the_chat_route",
      status: reading.violations.some((violation) => violation.code === "chat_read_uses_the_composed_aggregate")
        ? "failed"
        : "passed",
      detail: `${reading.aggregateReads} aggregate read(s), ${reading.chatRouteReads} Chat-route read(s)`,
    },
    {
      id: "the_chat_route_is_read",
      status: reading.chatRouteReads === 0 ? "blocked" : "passed",
      detail: `${reading.chatRouteReads} read(s) of the Chat client`,
    },
    {
      id: "the_session_mint_is_identified",
      status: reading.sessionMint.length === 0 ? "blocked" : "passed",
      detail: reading.sessionMint.join(", "),
    },
    {
      id: "every_module_parsed",
      status: reading.unparsed.length === 0 ? "passed" : "failed",
      detail: `${reading.unparsed.length} unparsed module(s)`,
    },
  ];
  const failed = reading.violations.length > 0;
  return {
    ...reading,
    status: failed ? "failed" : "passed",
    blocked: null,
    checks,
  };
}

/** The reading as the lines a reader needs: the population first, then the violations, then the report. */
export function renderChatRouteReport(result, out = process.stdout) {
  out.write(
    `modules examined ${result.population} under ${result.web} · ${result.readSites} read site(s): ` +
      `${result.aggregateReads} on the composed aggregate, ${result.chatRouteReads} on the Chat route\n`,
  );
  out.write(
    `  composed receiver(s): ${result.composedReceivers.join(", ") || "none"} · session mint: ` +
      `${result.sessionMint.join(", ") || "not found"}\n`,
  );
  for (const violation of result.violations) out.write(`${violation.code}: ${violation.at} - ${violation.detail}\n`);
  for (const entry of result.unparsed) out.write(`module_unparsed: ${entry}\n`);
  if (result.blocked !== null && result.blocked !== undefined) out.write(`blocked: ${result.blocked}\n`);
  if (result.allowEmpty !== null && result.allowEmpty !== undefined) out.write(`allow_empty: ${result.allowEmpty}\n`);
  if (result.status === "passed") out.write("chat_reads_the_chat_route: passed\n");
  out.write(
    `${JSON.stringify({
      gate: result.gate,
      status: result.status,
      population: result.population,
      readSites: result.readSites,
      aggregateReads: result.aggregateReads,
      chatRouteReads: result.chatRouteReads,
      composedReceivers: result.composedReceivers,
      sessionMint: result.sessionMint,
      violations: result.violations,
      unparsed: result.unparsed,
      ...(result.allowEmpty === null || result.allowEmpty === undefined ? {} : { allowEmpty: result.allowEmpty }),
      checks: result.checks ?? [],
    })}\n`,
  );
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex < 0 ? REPOSITORY_ROOT : argv[rootIndex + 1];
  if (root === undefined || root === "")
    return blockedOnEmptyPopulation("chat_reads_the_chat_route", "--root was named with no directory");
  const result = checkChatReadsTheChatRoute({ root });
  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(result)}\n`);
  else renderChatRouteReport(result, process.stdout);
  if (result.status === "passed") return 0;
  return result.status === "blocked" ? 2 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  process.exitCode = main(process.argv.slice(2));
