import { createServer, type Server } from "node:http";

import { createP3DialogueWebRequestHandler, type DialogueWebOptions } from "../dialogue-web.js";
import type { WindowsReparseInspectorCapability } from "../windows-reparse-inspector/index.js";
import {
  createTavernStaticArtifactRequestHandler,
  TAVERN_BROWSER_CONTRACT,
  type TavernStaticArtifactIdentity,
  verifyTavernStaticArtifact,
} from "./static-artifact/index.js";

const LOOPBACK_HOST = "127.0.0.1";
export const P3_BROWSER_ARTIFACT_IDENTITY: TavernStaticArtifactIdentity = Object.freeze({
  browserContract: TAVERN_BROWSER_CONTRACT,
  profileId: "gamebuddy.tavern.browser.v1",
});

export type P3StaticShellCompositionOptions = DialogueWebOptions &
  Readonly<{
    artifactRoot: string;
    inspector?: WindowsReparseInspectorCapability;
  }>;
export type P3StaticShellComposition = Readonly<{
  origin: string;
  launchUrl: string;
  closeAllConnections(): void;
  close(): Promise<void>;
}>;

/**
 * Serial P3 composition: one verified immutable browser shell and one closed
 * P3 API dispatcher share the same loopback listener. Neither constituent can
 * discover paths or bind a second listener through this boundary.
 */
export async function startP3StaticShellComposition(
  options: P3StaticShellCompositionOptions,
): Promise<P3StaticShellComposition> {
  const artifact = await verifyTavernStaticArtifact(
    options.artifactRoot,
    P3_BROWSER_ARTIFACT_IDENTITY,
    options.inspector,
  );
  const staticHandler = createTavernStaticArtifactRequestHandler(artifact);
  const apiHandler = createP3DialogueWebRequestHandler(options);
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
  const origin = `http://${LOOPBACK_HOST}:${port}`;
  const bootstrapToken = options.bootstrapToken;
  if (bootstrapToken === undefined) {
    await apiHandler.close();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error("p3_bootstrap_token_invalid");
  }
  return Object.freeze({
    origin,
    launchUrl: `${origin}/#boot=${bootstrapToken}`,
    closeAllConnections: () => server.closeAllConnections(),
    async close() {
      if (closed) return;
      closed = true;
      // Make every future API request fail before severing existing HTTP work.
      const apiDrain = apiHandler.close();
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await apiDrain;
    },
  });
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
