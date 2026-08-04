import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
    _resetSynapseClientForTests,
    getSynapseLaneIdentity,
    SYNAPSE_MAX_INPUT_TOKENS,
    type SynapseClientLike,
    SynapseEmbeddingProvider,
} from "./embedding-synapse";

class MockSynapseClient implements SynapseClientLike {
    readonly requests: Array<{ method: string; params: unknown }> = [];
    private batchAttempts = 0;
    constructor(private readonly batchSize = 2) {}

    async call<Response = unknown>(
        _module: string,
        method: string,
        params?: unknown,
    ): Promise<Response> {
        this.requests.push({ method, params });
        if (method === "models.list") {
            return {
                models: [
                    {
                        model: "gte-modernbert-base-f16",
                        fingerprint: "fp-live",
                        table_epoch: 0,
                        dims: 3,
                        recommended_batch: this.batchSize,
                        provenance: { source: "fixture" },
                    },
                ],
            } as Response;
        }
        if (method === "embed.query") {
            return {
                vector: [1, 2, 3],
                fingerprint: "fp-live",
                table_epoch: 0,
            } as Response;
        }
        if (method === "embed.batch") {
            this.batchAttempts += 1;
            if (this.batchAttempts === 1) {
                const error = new Error("module is loading") as Error & {
                    code: string;
                    retry_after_ms: number;
                };
                error.code = "model_loading";
                error.retry_after_ms = 0;
                throw error;
            }
            const request = params as { items: Array<{ id: string; content_sha256: string }> };
            return {
                items: request.items.map((item) => ({
                    id: item.id,
                    embedding: [1, 2, 3],
                    content_sha256: item.content_sha256,
                    fingerprint: "fp-live",
                    table_epoch: 0,
                })),
            } as Response;
        }
        throw new Error(`unexpected method ${method}`);
    }

    close(): void {}
}

afterEach(() => {
    _resetSynapseClientForTests();
});

describe("SynapseEmbeddingProvider", () => {
    it("discovers a certified model and sends the required artifact constraints", async () => {
        const client = new MockSynapseClient();
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            clientFactory: async () => client,
        });

        expect(await provider.initialize()).toBe(true);
        expect(provider.maxInputTokens).toBe(SYNAPSE_MAX_INPUT_TOKENS);
        expect(provider.modelId).toBe(getSynapseLaneIdentity("gte-modernbert-base-f16", "fp-live"));

        const vector = await provider.embed("hello");
        expect(vector).toEqual(new Float32Array([1, 2, 3]));
        const request = client.requests.find((entry) => entry.method === "embed.query");
        expect(request?.params).toMatchObject({
            model: "gte-modernbert-base-f16",
            required_fingerprint: "fp-live",
            required_epoch: 0,
            allow_equivalent: false,
            accept_declared: false,
        });
    });

    it("honors the live recommended batch size and retries model loading with retry_after_ms", async () => {
        const client = new MockSynapseClient(1);
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            clientFactory: async () => client,
        });

        const vectors = await provider.embedItems([
            { id: "memory:1", text: "one", contentSha256: "a" },
            { id: "memory:2", text: "two", contentSha256: "b" },
        ]);

        expect(vectors.size).toBe(2);
        expect(client.requests.filter((entry) => entry.method === "embed.batch")).toHaveLength(3);
        const keys = client.requests
            .filter((entry) => entry.method === "embed.batch")
            .map((entry) => (entry.params as { request_key: string }).request_key);
        expect(keys[0]).toBe(keys[1]);
    });

    it("rejects served fingerprint substitution without adapting", async () => {
        const client = new MockSynapseClient();
        client.call = async <Response = unknown>(
            _module: string,
            method: string,
            params?: unknown,
        ) => {
            client.requests.push({ method, params });
            if (method === "models.list") {
                return {
                    models: [
                        {
                            model: "gte-modernbert-base-f16",
                            fingerprint: "fp-live",
                            table_epoch: 0,
                            dims: 3,
                        },
                    ],
                } as Response;
            }
            return { vector: [1, 2, 3], fingerprint: "fp-other", table_epoch: 0 } as Response;
        };
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            clientFactory: async () => client,
        });

        expect(await provider.embed("hello")).toBeNull();
        expect(await provider.embed("again")).toBeNull();
    });
});

describe("recommended batch policy", () => {
    it("object-form recommended_batch {rows, token_budget} sets both limits and pages split on the token budget", async () => {
        const calls: number[][] = [];
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "/tmp/unused",
            projectRoot: "/tmp/p",
            session: "s",
            clientFactory: async () =>
                ({
                    async call(_m: string, method: string, params?: unknown) {
                        if (method === "models.list") {
                            return {
                                result: {
                                    table_epoch: 0,
                                    models: [
                                        {
                                            model_id: "gte-modernbert-base-f16",
                                            fingerprints: ["fp1"],
                                            state: "ready",
                                            recommended_batch: { rows: 3, token_budget: 100 },
                                        },
                                    ],
                                },
                            };
                        }
                        const items = (params as { items: { id: string; text: string }[] }).items;
                        calls.push(items.map((item) => item.text.length));
                        return {
                            items: items.map((item) => ({
                                id: item.id,
                                embedding: [0.5, 0.5],
                                content_sha256: createHash("sha256")
                                    .update(item.text)
                                    .digest("hex"),
                                fingerprint: "fp1",
                                table_epoch: 0,
                            })),
                        };
                    },
                    close() {},
                }) as SynapseClientLike,
        });
        // 4 items of ~200 chars = ~50 estimated tokens each against a 100-token
        // budget: pages must split at 2 items even though the row limit is 3.
        const text = "x".repeat(200);
        const items = ["a", "b", "c", "d"].map((id) => ({
            id,
            text,
            contentSha256: createHash("sha256").update(text).digest("hex"),
        }));
        const vectors = await provider.embedItems(items);
        expect(vectors.size).toBe(4);
        expect(calls.map((page) => page.length)).toEqual([2, 2]);
    });

    it("bare-number recommended_batch still sets the row limit (legacy wire shape)", async () => {
        const calls: number[] = [];
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "/tmp/unused",
            projectRoot: "/tmp/p",
            session: "s",
            clientFactory: async () =>
                ({
                    async call(_m: string, method: string, params?: unknown) {
                        if (method === "models.list") {
                            return {
                                result: {
                                    table_epoch: 0,
                                    models: [
                                        {
                                            model_id: "gte-modernbert-base-f16",
                                            fingerprints: ["fp1"],
                                            state: "ready",
                                            recommended_batch: 2,
                                        },
                                    ],
                                },
                            };
                        }
                        const items = (params as { items: { id: string; text: string }[] }).items;
                        calls.push(items.length);
                        return {
                            items: items.map((item) => ({
                                id: item.id,
                                embedding: [0.5, 0.5],
                                content_sha256: createHash("sha256")
                                    .update(item.text)
                                    .digest("hex"),
                                fingerprint: "fp1",
                                table_epoch: 0,
                            })),
                        };
                    },
                    close() {},
                }) as SynapseClientLike,
        });
        const items = ["a", "b", "c"].map((id) => ({
            id,
            text: "hello",
            contentSha256: createHash("sha256").update("hello").digest("hex"),
        }));
        const vectors = await provider.embedItems(items);
        expect(vectors.size).toBe(3);
        expect(calls).toEqual([2, 1]);
    });

    it("single item over the token budget still ships alone", async () => {
        const calls: number[] = [];
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "/tmp/unused",
            projectRoot: "/tmp/p",
            session: "s",
            clientFactory: async () =>
                ({
                    async call(_m: string, method: string, params?: unknown) {
                        if (method === "models.list") {
                            return {
                                result: {
                                    table_epoch: 0,
                                    models: [
                                        {
                                            model_id: "gte-modernbert-base-f16",
                                            fingerprints: ["fp1"],
                                            state: "ready",
                                            recommended_batch: { rows: 8, token_budget: 10 },
                                        },
                                    ],
                                },
                            };
                        }
                        const items = (params as { items: { id: string; text: string }[] }).items;
                        calls.push(items.length);
                        return {
                            items: items.map((item) => ({
                                id: item.id,
                                embedding: [0.5, 0.5],
                                content_sha256: createHash("sha256")
                                    .update(item.text)
                                    .digest("hex"),
                                fingerprint: "fp1",
                                table_epoch: 0,
                            })),
                        };
                    },
                    close() {},
                }) as SynapseClientLike,
        });
        const big = "y".repeat(400);
        const items = [
            {
                id: "big1",
                text: big,
                contentSha256: createHash("sha256").update(big).digest("hex"),
            },
            {
                id: "big2",
                text: big,
                contentSha256: createHash("sha256").update(big).digest("hex"),
            },
        ];
        const vectors = await provider.embedItems(items);
        expect(vectors.size).toBe(2);
        expect(calls).toEqual([1, 1]);
    });
});
