/**
 * The production management profile advertises EXACTLY the routes the mounted surface answers.
 *
 * Both directions of the same lie are reachable, and both have already happened in this tree:
 * a route can be declared in the profile and served by no branch (`chat.fork` was in the
 * reference mutation group before its handler existed, and the surface would have answered
 * `profile_operation_unavailable` to a control it had just told the browser to draw), and a
 * branch can exist for a route no profile advertises, which no player can ever reach.
 *
 * The populations are derived, never listed:
 *  - what is ADVERTISED is `composeTavernManagementProfile().routeIds` - the one production
 *    declaration - resolved through the contract's own route table for each path and method.
 *  - what is ANSWERED is measured: a session-less request to every advertised route must not
 *    come back as the dispatcher's own "this operation is not declared" answer. A branch that
 *    exists stops before any service (admission refuses the request first), so the surface
 *    needs no durable store and no real service to answer "yes, this route is mine".
 *  - the REVERSE direction reads the guards in the dispatcher's own source: a route named in
 *    a `profile.routeIds.includes("<id>")` guard is a route with a branch, so a guard for a
 *    route the production profile does not advertise is a dead branch.
 *
 * The failure names the route and which side it is missing from, because the two remedies are
 * opposite: "add the handler" and "stop advertising it" are different changes to different
 * files.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { composeTavernManagementProfile } from "./desktop-presentation-admission-owner.js";
import { TavernBrowserContractV1 } from "../tavern/browser-contract/index.js";
import { startTavernManagementDialogueWebServer } from "../tavern-management-dialogue-web.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * The dispatcher's own source, found by walking up from this file: the suite runs BOTH from
 * `src/` (typecheck and a source runner) and from `dist-test/` (the compiled runner), so the
 * depth of the source root is not a constant here.
 */
function dispatcherSourcePath(): string {
  let directory = HERE;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, "src", "tavern-management-dialogue-web.ts");
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  throw new Error(`management_dispatch_source_not_found:${HERE}`);
}
const BOOTSTRAP_TOKEN = "A".repeat(43);
/** One legal opaque handle for every `:param` a contract path carries. */
const PATH_HANDLE = "A".repeat(43);

type ServerOptions = Parameters<typeof startTavernManagementDialogueWebServer>[0];

/**
 * The one injected service these probes never reach: a session-less request is refused at
 * admission, so no branch gets as far as a store. `close` is the exception - the listener
 * drains its services on the way down - so it resolves instead of complaining.
 */
const unusedService = new Proxy(
  function unusedManagementService() {
    // A function target, so the same shell satisfies the options checked as objects and the
    // ones checked as functions (`readGameState`, `confirmStCardImport`).
  },
  {
    get: (_target, property) => {
      if (property === "then") return undefined;
      if (property === "close") return async () => undefined;
      return async () => {
        throw new Error(`management_service_reached:${String(property)}`);
      };
    },
  },
);

/**
 * The production surface, mounted over the production declaration and nothing else: every
 * injected service is that inert shell, because this gate asks each route whether it is
 * ANSWERED, not what it answers.
 */
async function withProductionSurface(run: (origin: string) => Promise<void>): Promise<void> {
  const options = {
    profile: composeTavernManagementProfile(),
    bootstrapToken: BOOTSTRAP_TOKEN,
    managementStateFacade: unusedService,
    managementService: unusedService,
    memoryService: unusedService,
    worldInfoService: unusedService,
    playerPreferenceStore: unusedService,
    listVoiceOutputDevices: unusedService,
    connectionService: unusedService,
    modelProfileStore: unusedService,
    libraryService: unusedService,
    companionVoiceService: unusedService,
    companionExamplesService: unusedService,
    companionWorldBookService: unusedService,
    companionProfileService: unusedService,
    companionCardExportService: unusedService,
    profileBackupService: unusedService,
    presetAssemblyRead: unusedService,
    companionAvatarService: unusedService,
    companionDeletionService: unusedService,
    companionActivationService: unusedService,
    readGameState: unusedService,
    newCompanionProvisioner: unusedService,
    newChatProvisioner: unusedService,
    chatSelectProvisioner: unusedService,
    chatForkService: unusedService,
    personaService: unusedService,
    scenarioService: unusedService,
    greetingService: unusedService,
    stCardImportService: unusedService,
    confirmStCardImport: unusedService,
    stCardImportHistoryService: unusedService,
  } as unknown as ServerOptions;
  const server = await startTavernManagementDialogueWebServer(options);
  try {
    await run(server.origin);
  } finally {
    await server.close();
  }
}

/** The contract's path with each `:param` replaced by a handle its own schema accepts. */
function probePath(template: string): string {
  return template.replace(/:[A-Za-z0-9_]+/g, PATH_HANDLE);
}

test("the mounted surface answers every route the production profile advertises", async () => {
  const profile = composeTavernManagementProfile();
  const advertised = [...profile.routeIds];
  assert.ok(advertised.length > 0, "examined 0 advertised route(s): the production declaration is empty");
  const routes = new Map(TavernBrowserContractV1.routes.map((route) => [route.routeId, route]));

  const unanswered: string[] = [];
  await withProductionSurface(async (origin) => {
    for (const routeId of advertised) {
      const route = routes.get(routeId);
      assert.ok(
        route !== undefined,
        `${routeId}: advertised by the production profile and declared by no route in tavern_browser_api/v1`,
      );
      const response = await fetch(`${origin}${probePath(route.path)}`, {
        method: route.method,
        headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" },
      });
      const body = await response.text();
      // The dispatcher's own fall-through, and the answer a branch gives when its route is not
      // in the profile: the same code, which is why a route that is advertised must never get it.
      if (response.status === 404 && body.includes("profile_operation_unavailable"))
        unanswered.push(`${routeId} (${route.method} ${route.path})`);
    }
  });

  assert.deepEqual(
    unanswered,
    [],
    `advertised by the production profile and NOT answered by the mounted surface:\n  ${unanswered.join(
      "\n  ",
    )}\nThe browser draws a control for each of these and the surface would answer "this operation is not declared": serve the route, or stop advertising it`,
  );
});

test("the dispatcher serves no management route the production profile does not advertise", () => {
  const source = readFileSync(dispatcherSourcePath(), "utf8");
  // A branch decides whether its own route is in the profile by naming it, so the guards are
  // the dispatcher's own statement of which routes it serves - read from the source because the
  // handler has no table to ask at runtime, and derived rather than listed for that reason.
  const guarded = new Set<string>();
  for (const match of source.matchAll(/profile\.(?:routeIds|operationIds)\.includes\("([a-zA-Z][a-zA-Z0-9.-]+)"\)/g))
    guarded.add(match[1]!);
  assert.ok(
    guarded.size > 0,
    "examined 0 guarded route(s): the dispatch guards no longer name their route ids, so this gate cannot see them",
  );

  const advertised = new Set<string>(composeTavernManagementProfile().routeIds);
  const dead = [...guarded].filter((routeId) => !advertised.has(routeId)).sort();
  assert.deepEqual(
    dead,
    [],
    `served by the mounted dispatcher and NOT advertised by the production profile:\n  ${dead.join(
      "\n  ",
    )}\nEach of these branches is dead: no browser is told the route exists. Declare it in the profile's slice, or delete the branch`,
  );
});
