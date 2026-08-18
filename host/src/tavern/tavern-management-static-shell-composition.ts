import { createServer, type Server } from "node:http";

import {
  createTavernManagementDialogueWebRequestHandler,
  type TavernManagementDialogueWebOptions,
} from "../tavern-management-dialogue-web.js";
import type { WindowsReparseInspectorCapability } from "../windows-reparse-inspector/index.js";
import {
  TAVERN_BROWSER_CONTRACT,
  createTavernStaticArtifactRequestHandler,
  verifyTavernStaticArtifact,
  type TavernStaticArtifactIdentity,
} from "./static-artifact/index.js";

const LOOPBACK_HOST = "127.0.0.1";

/**
 * The immutable browser artifact is shared with the reference composition
 * (one static identity per shipped browser bundle); the management profile is
 * selected purely by its fragment marker.
 */
export const TAVERN_MANAGEMENT_BROWSER_ARTIFACT_IDENTITY: TavernStaticArtifactIdentity =
  Object.freeze({
    browserContract: TAVERN_BROWSER_CONTRACT,
    profileId: "gamebuddy.tavern.browser.v1",
  });

export type TavernManagementStaticShellCompositionOptions =
  TavernManagementDialogueWebOptions &
    Readonly<{
      artifactRoot: string;
      inspector?: WindowsReparseInspectorCapability;
    }>;

export type TavernManagementStaticShellComposition = Readonly<{
  origin: string;
  launchUrl: string;
  closeAllConnections(): void;
  /** Rejects new requests, drains service work, then closes the one listener. */
  close(): Promise<void>;
}>;

/**
 * One verified static browser shell and one tavern-management dispatcher on
 * one loopback listener. The management dispatcher owns the service drain;
 * this composer owns the listener only.
 */
export async function startTavernManagementStaticShellComposition(
  options: TavernManagementStaticShellCompositionOptions,
): Promise<TavernManagementStaticShellComposition> {
  const artifact = await verifyTavernStaticArtifact(
    options.artifactRoot,
    TAVERN_MANAGEMENT_BROWSER_ARTIFACT_IDENTITY,
    options.inspector,
  );
  const staticHandler = createTavernStaticArtifactRequestHandler(artifact);
  const apiHandler = createTavernManagementDialogueWebRequestHandler(options);
  let closed = false;
  const server = createServer((request, response) => {
    const port = (server.address() as { port: number }).port;
    const origin = `http://${LOOPBACK_HOST}:${port}`;
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", origin).pathname;
    } catch {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (pathname.startsWith("/api/")) apiHandler.handle(request, response, origin);
    else staticHandler.handle(request, response);
  });
  const port = await listenLoopback(server);
  const bootstrapToken = options.bootstrapToken;
  if (bootstrapToken === undefined) {
    await apiHandler.close();
    server.closeAllConnections();
    await closeServer(server);
    throw new Error("tavern_management_bootstrap_token_invalid");
  }
  const origin = `http://${LOOPBACK_HOST}:${port}`;
  return Object.freeze({
    origin,
    // The immutable shell selects the management browser surface through this
    // explicit fragment marker (the static handler rejects query strings);
    // the one-time bootstrap stays in the same fragment.
    launchUrl: `${origin}/#profile=management&boot=${bootstrapToken}`,
    closeAllConnections: () => server.closeAllConnections(),
    async close() {
      if (closed) return;
      closed = true;
      // Do not release the listener/lease until the request handler has
      // rejected future work and drained its service-owned continuation.
      const apiDrain = apiHandler.close();
      server.closeAllConnections();
      await closeServer(server);
      await apiDrain;
    },
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error === undefined ? resolveClose() : rejectClose())),
  );
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST)
    throw new Error("dialogue_loopback_bind_failed");
  return address.port;
}
