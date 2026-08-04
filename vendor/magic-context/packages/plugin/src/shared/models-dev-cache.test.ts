import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearModelsDevCache,
    getModelsDevCacheState,
    getSdkContextLimit,
    getSdkInputLimit,
    refreshModelLimitsAfterAuthOnce,
    refreshModelLimitsFromApi,
    resetAuthRewarmLatchForTest,
} from "./models-dev-cache";

/**
 * Model context limits resolve from OpenCode's SDK only (`config.providers()`),
 * bounded to a sane [20k, 3M] range, with a persisted last-known-good cache for
 * cold start. We no longer read OpenCode's `models.json` file ourselves (a torn
 * read produced impossible limits and a stale copy out-voted the live cap).
 */
describe("models-dev-cache (SDK-only)", () => {
    let tempDir: string;
    let originalXdgData: string | undefined;

    function makeClient(providers: Array<unknown>) {
        return { config: { providers: async () => ({ data: { providers } }) } };
    }

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "mc-models-dev-"));
        // Isolate the persisted-cache file under a temp data dir so tests never
        // touch the real ~/.local/share/cortexkit/magic-context cache.
        originalXdgData = process.env.XDG_DATA_HOME;
        process.env.XDG_DATA_HOME = tempDir;
        clearModelsDevCache();
    });

    afterEach(() => {
        if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalXdgData;
        try {
            rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
        clearModelsDevCache();
    });

    test("resolves from the SDK and prefers limit.input over limit.context", async () => {
        // github-copilot / codex shape: input is the max prompt, context the total
        // window. Pressure math must use the input cap (OpenCode's own overflow.ts
        // does the same), so a 400k-context / 272k-input model resolves to 272k.
        await refreshModelLimitsFromApi(
            makeClient([
                {
                    id: "github-copilot",
                    models: {
                        "gpt-5.3-codex": { limit: { context: 400000, input: 272000 } },
                        "legacy-only-context": { limit: { context: 100000 } },
                    },
                },
            ]),
        );

        expect(getSdkContextLimit("github-copilot", "gpt-5.3-codex")).toBe(272000);
        expect(getSdkInputLimit("github-copilot", "gpt-5.3-codex")).toBe(272000);
        expect(getSdkContextLimit("github-copilot", "legacy-only-context")).toBe(100000);
        expect(getSdkInputLimit("github-copilot", "legacy-only-context")).toBeUndefined();
        expect(getSdkContextLimit("unknown", "unknown")).toBeUndefined();
    });

    test("Codex-OAuth cap is honored: a 400k/272k gpt-5.5 resolves to 272k (not the stale 922k)", async () => {
        // The bug we're fixing: the SDK reports the auth-resolved cap; nothing may
        // out-vote it with a larger stale value.
        await refreshModelLimitsFromApi(
            makeClient([
                {
                    id: "openai",
                    models: { "gpt-5.5": { limit: { context: 400000, input: 272000 } } },
                },
            ]),
        );
        expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(272000);
        expect(getSdkInputLimit("openai", "gpt-5.5")).toBe(272000);
    });

    test("derived experimental.modes inherit the effective (input) limit", async () => {
        await refreshModelLimitsFromApi(
            makeClient([
                {
                    id: "openai",
                    models: {
                        "gpt-5.4": {
                            limit: { context: 1050000, input: 922000 },
                            experimental: { modes: { fast: {}, mini: {} } },
                        },
                    },
                },
            ]),
        );
        expect(getSdkContextLimit("openai", "gpt-5.4")).toBe(922000);
        expect(getSdkContextLimit("openai", "gpt-5.4-fast")).toBe(922000);
        expect(getSdkContextLimit("openai", "gpt-5.4-mini")).toBe(922000);
    });

    test("matches a tagged ollama model against its tag-less SDK entry", async () => {
        await refreshModelLimitsFromApi(
            makeClient([
                {
                    id: "ollama-cloud",
                    models: {
                        "deepseek-v4-pro": { limit: { context: 1048576 } },
                        "gemma3:27b": { limit: { context: 131072 } },
                    },
                },
            ]),
        );
        // Tagged invocation falls back to the tag-less entry.
        expect(getSdkContextLimit("ollama-cloud", "deepseek-v4-pro:cloud")).toBe(1048576);
        // Exact tagged match still wins (no wrongful collapse).
        expect(getSdkContextLimit("ollama-cloud", "gemma3:27b")).toBe(131072);
        // Unknown tagged model with no tag-less base stays undefined.
        expect(getSdkContextLimit("ollama-cloud", "nonexistent:cloud")).toBeUndefined();
    });

    describe("sanity bounds [20k, 3M]", () => {
        test("rejects an implausibly small limit (torn-read garbage like 6748)", async () => {
            await refreshModelLimitsFromApi(
                makeClient([
                    {
                        id: "ollama-cloud",
                        // 6748 is smaller than a single system prompt — impossible
                        // as a real limit; must be rejected, not trusted.
                        models: { "deepseek-v4-pro": { limit: { context: 6748 } } },
                    },
                ]),
            );
            expect(getSdkContextLimit("ollama-cloud", "deepseek-v4-pro")).toBeUndefined();
        });

        test("rejects a below-floor 8192 num_ctx default", async () => {
            await refreshModelLimitsFromApi(
                makeClient([{ id: "p", models: { m: { limit: { context: 8192 } } } }]),
            );
            expect(getSdkContextLimit("p", "m")).toBeUndefined();
        });

        test("rejects an impossibly large limit (> 3M)", async () => {
            await refreshModelLimitsFromApi(
                makeClient([{ id: "p", models: { m: { limit: { context: 5_000_000 } } } }]),
            );
            expect(getSdkContextLimit("p", "m")).toBeUndefined();
        });

        test("accepts values exactly on the bounds", async () => {
            await refreshModelLimitsFromApi(
                makeClient([
                    {
                        id: "p",
                        models: {
                            lo: { limit: { context: 20000 } },
                            hi: { limit: { context: 3000000 } },
                        },
                    },
                ]),
            );
            expect(getSdkContextLimit("p", "lo")).toBe(20000);
            expect(getSdkContextLimit("p", "hi")).toBe(3000000);
        });
    });

    describe("persisted cache (cold start)", () => {
        test("seeds from the persisted file after a clear (restart simulation)", async () => {
            // First run: warm + persist.
            await refreshModelLimitsFromApi(
                makeClient([{ id: "openai", models: { "gpt-5.5": { limit: { input: 272000 } } } }]),
            );
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(272000);
            expect(getSdkInputLimit("openai", "gpt-5.5")).toBe(272000);

            // Simulate a restart: in-memory cache gone, but the persisted file
            // remains under XDG_DATA_HOME. The next lookup seeds from disk.
            clearModelsDevCache();
            expect(getModelsDevCacheState().apiLoaded).toBe(false);
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(272000);
            // Seeding populated the in-memory cache.
            expect(getModelsDevCacheState().apiLoaded).toBe(true);
        });

        test("does not persist or seed insane values", async () => {
            await refreshModelLimitsFromApi(
                makeClient([
                    {
                        id: "p",
                        models: {
                            good: { limit: { context: 200000 } },
                            bad: { limit: { context: 6748 } },
                        },
                    },
                ]),
            );
            clearModelsDevCache();
            expect(getSdkContextLimit("p", "good")).toBe(200000);
            expect(getSdkContextLimit("p", "bad")).toBeUndefined();
        });
    });

    describe("after-auth re-warm (once per process)", () => {
        // The startup warm can run before provider auth is loaded, caching a raw
        // pre-downshift limit (gpt-5.5 922k) that then survives restarts and is
        // never corrected by the too-low-only recovery. The first usage event
        // proves auth is live; one re-warm there overwrites the stale value.
        function makeCountingClient(input: number) {
            let calls = 0;
            return {
                client: {
                    config: {
                        providers: async () => {
                            calls++;
                            return {
                                data: {
                                    providers: [
                                        {
                                            id: "openai",
                                            models: { "gpt-5.5": { limit: { input } } },
                                        },
                                    ],
                                },
                            };
                        },
                    },
                },
                calls: () => calls,
            };
        }

        test("re-warm overwrites a stale pre-auth limit and runs only once per process", async () => {
            resetAuthRewarmLatchForTest();
            // Pre-auth startup warm cached the raw 922k.
            await refreshModelLimitsFromApi(
                makeClient([{ id: "openai", models: { "gpt-5.5": { limit: { input: 922000 } } } }]),
            );
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(922000);

            // First usage: auth is live, providers() now reports the 272k cap.
            const { client, calls } = makeCountingClient(272000);
            await refreshModelLimitsAfterAuthOnce(client);
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(272000);
            expect(calls()).toBe(1);

            // Subsequent usage events are a no-op (latch held).
            await refreshModelLimitsAfterAuthOnce(client);
            await refreshModelLimitsAfterAuthOnce(client);
            expect(calls()).toBe(1);
        });

        test("a failed re-warm resets the latch so a later usage event retries", async () => {
            resetAuthRewarmLatchForTest();
            let calls = 0;
            const flaky = {
                config: {
                    providers: async () => {
                        calls++;
                        // First attempt: empty payload (auth still settling) → no warm.
                        if (calls === 1) return { data: { providers: [] } };
                        return {
                            data: {
                                providers: [
                                    {
                                        id: "openai",
                                        models: { "gpt-5.5": { limit: { input: 272000 } } },
                                    },
                                ],
                            },
                        };
                    },
                },
            };
            await refreshModelLimitsAfterAuthOnce(flaky);
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBeUndefined();
            // Latch was reset on failure, so the next event retries and succeeds.
            await refreshModelLimitsAfterAuthOnce(flaky);
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(272000);
            expect(calls).toBe(2);
        });
    });

    describe("startup retry", () => {
        test("retries when the provider payload is empty, then succeeds", async () => {
            let calls = 0;
            const client = {
                config: {
                    providers: async () => {
                        calls++;
                        if (calls === 1) return { data: { providers: [] } };
                        return {
                            data: {
                                providers: [
                                    { id: "p", models: { m: { limit: { context: 200000 } } } },
                                ],
                            },
                        };
                    },
                },
            };
            await refreshModelLimitsFromApi(client, { retries: 2, retryDelayMs: 1 });
            expect(calls).toBe(2);
            expect(getSdkContextLimit("p", "m")).toBe(200000);
        });

        test("stops early on first successful load (no wasted retries)", async () => {
            let calls = 0;
            const client = {
                config: {
                    providers: async () => {
                        calls++;
                        return {
                            data: {
                                providers: [
                                    { id: "p", models: { m: { limit: { context: 200000 } } } },
                                ],
                            },
                        };
                    },
                },
            };
            await refreshModelLimitsFromApi(client, { retries: 3, retryDelayMs: 1 });
            expect(calls).toBe(1);
        });
    });

    test("tolerates empty / malformed / thrown responses without populating", async () => {
        await refreshModelLimitsFromApi({
            config: { providers: async () => ({ data: undefined }) },
        });
        expect(getModelsDevCacheState().apiLoaded).toBe(false);

        await refreshModelLimitsFromApi({
            config: { providers: async () => ({ data: { providers: "not an array" } }) },
        });
        expect(getModelsDevCacheState().apiLoaded).toBe(false);

        await refreshModelLimitsFromApi({
            config: {
                providers: async () => {
                    throw new Error("network error");
                },
            },
        });
        expect(getModelsDevCacheState().apiLoaded).toBe(false);
    });

    test("repeated refreshes replace cache state without corruption", async () => {
        const clientA = makeClient([
            {
                id: "p",
                models: {
                    m1: { limit: { context: 200000 } },
                    m2: { limit: { context: 200000 } },
                    m3: { limit: { context: 200000 } },
                },
            },
        ]);
        const clientB = makeClient([
            {
                id: "p",
                models: { m1: { limit: { context: 200000 } }, m2: { limit: { context: 200000 } } },
            },
        ]);

        await refreshModelLimitsFromApi(clientA);
        expect(getModelsDevCacheState().apiCount).toBe(3);
        await refreshModelLimitsFromApi(clientB);
        expect(getModelsDevCacheState().apiCount).toBe(2);
        await refreshModelLimitsFromApi(clientA);
        expect(getModelsDevCacheState().apiCount).toBe(3);

        expect(getSdkContextLimit("p", "m1")).toBe(200000);
        expect(getSdkContextLimit("p", "m3")).toBe(200000);
    });
});
