/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildFlags,
    buildFrame,
    CLIENT_AUTH_DOMAIN,
    computeProof,
    decodeHeader,
    type EnvelopeHeader,
    encodeFrame,
    FrameType,
    HEADER_LEN,
    PROTOCOL_VERSION,
    Priority,
    type RouteHandle,
    SERVER_PROOF_DOMAIN,
    StaleRouteHandleError,
    type SubcClient,
} from "@cortexkit/subc-client";

import { __moduleTransportTest, SubcModuleTransport } from "./module-transport";

class FakeServerReader {
    private buffered = Buffer.alloc(0);
    private readonly iterator: AsyncIterator<Uint8Array>;

    constructor(socket: Socket) {
        this.iterator = socket[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
    }

    async readExact(length: number): Promise<Buffer> {
        while (this.buffered.length < length) {
            const next = await this.iterator.next();
            if (next.done)
                throw new Error("fake subc peer closed before the expected bytes arrived");
            this.buffered = Buffer.concat([this.buffered, Buffer.from(next.value)]);
        }
        const value = this.buffered.subarray(0, length);
        this.buffered = this.buffered.subarray(length);
        return value;
    }
}

async function readAuthMessage(reader: FakeServerReader): Promise<Record<string, unknown>> {
    const length = (await reader.readExact(4)).readUInt32LE(0);
    return JSON.parse((await reader.readExact(length)).toString("utf8")) as Record<string, unknown>;
}

function writeAuthMessage(socket: Socket, value: unknown): void {
    const body = Buffer.from(JSON.stringify(value));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length, 0);
    socket.write(Buffer.concat([length, body]));
}

async function readFrame(
    reader: FakeServerReader,
): Promise<{ header: EnvelopeHeader; body: Uint8Array }> {
    const header = decodeHeader(await reader.readExact(HEADER_LEN));
    const body = header.len === 0 ? new Uint8Array(0) : await reader.readExact(header.len);
    return { header, body };
}

function writeJsonResponse(socket: Socket, request: EnvelopeHeader, body: unknown): void {
    const bytes = Buffer.from(JSON.stringify(body));
    socket.write(
        encodeFrame(
            buildFrame(
                FrameType.Response,
                buildFlags(false, Priority.Interactive, false),
                request.channel,
                request.epoch,
                request.corr,
                bytes,
            ),
        ),
    );
}

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("fake subc server has no TCP port");
    return address.port;
}

describe("SubcModuleTransport", () => {
    it("uses the shared v2 client while preserving route identity and flat request bytes", async () => {
        const tempDir = mkdtempSync(join(tmpdir(), "module-subc-v2-"));
        const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
        const daemonId = Uint8Array.from({ length: 16 }, (_, index) => 100 + index);
        const serverNonce = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
        let acceptedSocket: Socket | null = null;
        let routeOpenBody: unknown;
        let requestBody: unknown;
        let routeHeader: EnvelopeHeader | null = null;
        let requestHeader: EnvelopeHeader | null = null;
        let goodbyeHeader: EnvelopeHeader | null = null;
        let resolveServer: (() => void) | undefined;
        let rejectServer: ((error: unknown) => void) | undefined;
        const serverWork = new Promise<void>((resolve, reject) => {
            resolveServer = resolve;
            rejectServer = reject;
        });
        const server = createServer((socket) => {
            acceptedSocket = socket;
            void (async () => {
                const reader = new FakeServerReader(socket);
                const hello = await readAuthMessage(reader);
                const clientNonce = Uint8Array.from(hello.client_nonce as number[]);
                writeAuthMessage(socket, {
                    server_nonce: [...serverNonce],
                    daemon_id: [...daemonId],
                    server_proof: [
                        ...computeProof(
                            key,
                            SERVER_PROOF_DOMAIN,
                            clientNonce,
                            serverNonce,
                            daemonId,
                        ),
                    ],
                });
                const auth = await readAuthMessage(reader);
                expect(auth.client_auth).toEqual([
                    ...computeProof(key, CLIENT_AUTH_DOMAIN, clientNonce, serverNonce, daemonId),
                ]);

                const routeOpen = await readFrame(reader);
                routeHeader = routeOpen.header;
                routeOpenBody = JSON.parse(Buffer.from(routeOpen.body).toString("utf8"));
                writeJsonResponse(socket, routeOpen.header, {
                    route_channel: 7,
                    route_epoch: 77,
                });

                const request = await readFrame(reader);
                requestHeader = request.header;
                requestBody = JSON.parse(Buffer.from(request.body).toString("utf8"));
                writeJsonResponse(socket, request.header, { result: { ok: true } });

                const goodbye = await readFrame(reader);
                goodbyeHeader = goodbye.header;
                socket.destroy();
                resolveServer?.();
            })().catch((error: unknown) => rejectServer?.(error));
        });

        try {
            const port = await listen(server);
            const connectionFile = join(tempDir, "subc-connection.json");
            writeFileSync(
                connectionFile,
                JSON.stringify({
                    schema: 1,
                    endpoints: [{ host: "127.0.0.1", port }],
                    key: [...key],
                    daemon_id: [...daemonId],
                    pid: process.pid,
                    daemon_ver: "fake-v2",
                }),
            );
            chmodSync(connectionFile, 0o600);

            const transport = new SubcModuleTransport(connectionFile, "magic-context", 1_000);
            const flatBody = {
                method: "transform",
                v: 1,
                input: [{ id: "m1" }],
            };
            await expect(
                transport.call({
                    sessionId: "session-1",
                    projectRoot: "/workspace/project",
                    method: "transform",
                    body: flatBody,
                }),
            ).resolves.toEqual({ result: { ok: true } });
            transport.closeSession("session-1");
            await serverWork;

            const consumerIdentity =
                process.env.SUBC_MODULE_ID && process.env.SUBC_LAUNCH_NONCE
                    ? {
                          consumer_identity: {
                              module_id: process.env.SUBC_MODULE_ID,
                              launch_nonce: process.env.SUBC_LAUNCH_NONCE,
                          },
                      }
                    : {};
            expect(routeOpenBody).toEqual({
                op: "route.open",
                target: { kind: "tool_provider", module_id: "magic-context" },
                identity: {
                    project_root: "/workspace/project",
                    harness: "opencode",
                    session: "session-1",
                },
                ...consumerIdentity,
            });
            expect(requestBody).toEqual(flatBody);
            expect(routeHeader).toEqual(
                expect.objectContaining({
                    ver: PROTOCOL_VERSION,
                    ty: FrameType.Request,
                    channel: 0,
                    epoch: 0,
                }),
            );
            expect(requestHeader).toEqual(
                expect.objectContaining({
                    ver: PROTOCOL_VERSION,
                    ty: FrameType.Request,
                    channel: 7,
                    epoch: 77,
                }),
            );
            expect(goodbyeHeader).toEqual(
                expect.objectContaining({
                    ver: PROTOCOL_VERSION,
                    ty: FrameType.Goodbye,
                    channel: 7,
                    epoch: 77,
                }),
            );
        } finally {
            acceptedSocket?.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("recognizes a stale route error from a foreign subc-client prototype", () => {
        const foreignStaleRouteError = Object.assign(Object.create(null), {
            name: "StaleRouteHandleError",
            message: "route handle (1, 1) is not live on the current connection",
        });

        expect(foreignStaleRouteError).not.toBeInstanceOf(StaleRouteHandleError);
        expect(__moduleTransportTest.isConnectionFailure(foreignStaleRouteError)).toBe(true);
    });

    it("reopens a route and retries when a restarted module leaves a stale route token", async () => {
        const tempDir = mkdtempSync(join(tmpdir(), "module-subc-restart-"));
        const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
        const daemonId = Uint8Array.from({ length: 16 }, (_, index) => 100 + index);
        const serverNonce = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
        const sockets = new Set<Socket>();
        let routeOpenCount = 0;
        let requestCount = 0;
        let serverError: unknown;
        let transport: SubcModuleTransport | null = null;
        const server = createServer((socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            void (async () => {
                const reader = new FakeServerReader(socket);
                const hello = await readAuthMessage(reader);
                const clientNonce = Uint8Array.from(hello.client_nonce as number[]);
                writeAuthMessage(socket, {
                    server_nonce: [...serverNonce],
                    daemon_id: [...daemonId],
                    server_proof: [
                        ...computeProof(
                            key,
                            SERVER_PROOF_DOMAIN,
                            clientNonce,
                            serverNonce,
                            daemonId,
                        ),
                    ],
                });
                const auth = await readAuthMessage(reader);
                expect(auth.client_auth).toEqual([
                    ...computeProof(key, CLIENT_AUTH_DOMAIN, clientNonce, serverNonce, daemonId),
                ]);

                const routeOpen = await readFrame(reader);
                routeOpenCount += 1;
                writeJsonResponse(socket, routeOpen.header, {
                    route_channel: 6 + routeOpenCount,
                    route_epoch: 76 + routeOpenCount,
                });

                const request = await readFrame(reader);
                requestCount += 1;
                writeJsonResponse(socket, request.header, { result: { requestCount } });
            })().catch((error: unknown) => {
                serverError = error;
                socket.destroy();
            });
        });

        try {
            const port = await listen(server);
            const connectionFile = join(tempDir, "subc-connection.json");
            writeFileSync(
                connectionFile,
                JSON.stringify({
                    schema: 1,
                    endpoints: [{ host: "127.0.0.1", port }],
                    key: [...key],
                    daemon_id: [...daemonId],
                    pid: process.pid,
                    daemon_ver: "fake-v2",
                }),
            );
            chmodSync(connectionFile, 0o600);

            transport = new SubcModuleTransport(connectionFile, "magic-context", 1_000);
            const args = {
                sessionId: "session-restart",
                projectRoot: "/workspace/project",
                method: "transform" as const,
                body: { method: "transform", v: 1 },
            };
            await expect(transport.call(args)).resolves.toEqual({ result: { requestCount: 1 } });

            const internals = transport as unknown as {
                client: { connectionToken: object } | null;
            };
            if (!internals.client) throw new Error("transport did not retain its first connection");
            // Replacing the token emulates a module restart that invalidated the daemon route.
            internals.client.connectionToken = Object.freeze({});

            await expect(transport.call(args)).resolves.toEqual({ result: { requestCount: 2 } });
            expect(routeOpenCount).toBe(2);
            expect(requestCount).toBe(2);
            expect(serverError).toBeUndefined();
        } finally {
            transport?.closeSession("session-restart");
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("bounds canonical-root entries with least-recently-used eviction", () => {
        const transport = new SubcModuleTransport("unused-connection-file");
        const internals = transport as unknown as {
            canonicalRoot(root: string): string;
            canonicalRootCache: Map<string, string>;
        };
        for (let index = 0; index < 256; index += 1) {
            internals.canonicalRoot(`/missing-canonical-root-${index}`);
        }
        // A cache hit refreshes its recency before the next insert evicts an entry.
        internals.canonicalRoot("/missing-canonical-root-0");
        internals.canonicalRoot("/missing-canonical-root-256");

        expect(internals.canonicalRootCache.size).toBe(256);
        expect(internals.canonicalRootCache.has("/missing-canonical-root-0")).toBe(true);
        expect(internals.canonicalRootCache.has("/missing-canonical-root-1")).toBe(false);
    });

    it("does not reuse a route cached under an earlier connection generation", async () => {
        const transport = new SubcModuleTransport("unused-connection-file");
        const oldRoute = { channel: 7, epoch: 77 } as RouteHandle;
        const newRoute = { channel: 8, epoch: 88 } as RouteHandle;
        let routeOpenCount = 0;
        const client = {
            routeOpen: async () => {
                routeOpenCount += 1;
                return newRoute;
            },
        } as unknown as SubcClient;
        const projectRoot = "/module-transport-generation-test-root";
        const routeKey = `session-generation\0${projectRoot}`;
        const internals = transport as unknown as {
            client: SubcClient | null;
            connectionGeneration: number;
            routes: Map<string, { route: RouteHandle; generation: number }>;
            ensureRoute: (
                sessionId: string,
                rawProjectRoot: string,
            ) => Promise<{ route: RouteHandle; generation: number }>;
        };
        internals.client = client;
        internals.connectionGeneration = 1;
        internals.routes.set(routeKey, { route: oldRoute, generation: 0 });

        const ensured = await internals.ensureRoute("session-generation", projectRoot);

        expect(routeOpenCount).toBe(1);
        expect(ensured.route).toBe(newRoute);
        expect(ensured.generation).toBe(1);
        expect(internals.routes.get(routeKey)).toEqual({ route: newRoute, generation: 1 });
    });
});
